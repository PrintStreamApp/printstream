/**
 * Re-print orchestration for finished history jobs.
 *
 * Owns the per-kind branch that turns a finished `PrintJob` row back into a
 * fresh dispatch: it asserts the caller's per-kind permission (via the
 * supplied callback, so request coupling stays in the route), validates the
 * stored job details, evaluates plugin print guards, reconstructs the print
 * options, and dispatches through `startCalibrationJob` / `enqueueLibraryPrint`.
 *
 * The function returns a discriminated result describing the dispatch so the
 * route handler can write the audit-log annotation and HTTP response without
 * needing the orchestration internals. Two rejections are deliberately distinct:
 * a genuinely external job cannot be restarted at all, while a library job whose
 * retained copy was reclaimed is refused as unavailable. They used to collapse
 * into the first, which blamed the wrong thing.
 *
 * Print-start options come from `print-job-options.ts`, which the jobs DTO also
 * reads, so this path and the print dialog restore the same job identically. The
 * consent flags (`allow*`) are the exception and are never restored: see the note
 * at the call site.
 */
import { printFromLibrarySchema } from '@printstream/shared'
import type { PrintDispatchJob, PrintFromLibrary } from '@printstream/shared'
import { badRequest, conflict, notFound } from './http-error.js'
import { readRecordedPrintStartOptions } from './print-job-options.js'
import { prisma } from './prisma.js'
import { printerManager } from './printer-manager.js'
import { printGuards } from './print-guards.js'
import { startCalibrationJob } from './calibration-jobs.js'
import { enqueueLibraryPrint } from './library-printing.js'

export type ReprintJobKind = 'file' | 'calibration' | 'external'

/** The stored history row a re-print is reconstructed from. */
export interface ReprintJobRow {
  id: string
  printerId: string
  sourceType: string | null
  fileId: string | null
  calibrationOption: number | null
  useAms: boolean | null
  bedLevel: boolean | null
  plate: number | null
  amsMapping: string | null
  /** Serialized print-start selection; see {@link readRecordedPrintStartOptions}. */
  printOptionsJson?: string | null
}

/**
 * The optional re-print overrides parsed from the request body. Mirrors
 * `printFromLibrarySchema` without `fileId`/`printerId`, all partial, plus an
 * optional `printerId` string.
 */
export type ReprintJobInput = Partial<Omit<PrintFromLibrary, 'fileId' | 'printerId'>> & {
  printerId?: string
}

interface CalibrationReprintResult {
  kind: 'calibration'
  /** The newly started calibration job id. */
  jobId: string
  printerId: string
  printerName: string
}

interface FileReprintResult {
  kind: 'file'
  job: PrintDispatchJob
}

export type ReprintResult = CalibrationReprintResult | FileReprintResult

/**
 * Maps a stored job's source type to its re-print kind.
 *
 * PROVENANCE only. Whether the artifact is still on hand is a separate question, answered by
 * `fileId`, and the two must not be folded together: a library job with no `fileId` used to
 * resolve to 'external', which made history label a print we dispatched "Started outside
 * PrintStream" and made the re-print route refuse it for a reason that was not true. A row
 * arrives here without a `fileId` when its retained snapshot was reclaimed, so it is a file job
 * with a MISSING file, never a foreign one. Callers that need the artifact check `fileId`.
 */
export function toPrintJobKind(sourceType: string | null | undefined): ReprintJobKind {
  if (sourceType === 'calibration') return 'calibration'
  if (sourceType === 'external') return 'external'
  return 'file'
}

/** Parse the persisted JSON AMS mapping back into a tray-index array. */
export function parseAmsMapping(value: string | null): number[] | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((entry) => Number.isInteger(entry)) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Rebuild the dispatch options for a re-print of `row`.
 *
 * Each knob resolves in one order: request override -> what the row RECORDED -> the schema
 * default. The middle step is the point: before it existed, an override-less re-print
 * dropped to the defaults and silently changed the print (issue #97: an Auto bed-leveling
 * job came back as On, and other options came back as their defaults). A field the row
 * never recorded is absent rather than guessed, which is what lets `??` chain straight
 * through to the schema.
 *
 * The six `allow*` consent flags are deliberately NOT restored: each means "I accept this
 * risk right now", so replaying one would re-grant a safety bypass nobody was shown. They
 * are not recorded on the row at all, so this cannot later regress into reading them.
 *
 * Pure, and exported for its tests: the option reconstruction is the whole behavior worth
 * pinning, and `reprintJobFromRow` around it is I/O.
 */
export function buildReprintOptions(
  row: ReprintJobRow,
  overrides: ReprintJobInput
): Omit<PrintFromLibrary, 'fileId'> {
  const recorded = readRecordedPrintStartOptions(row) ?? {}
  return printFromLibrarySchema.omit({ fileId: true }).parse({
    printerId: overrides.printerId ?? row.printerId,
    useAms: overrides.useAms ?? row.useAms ?? true,
    bedLevel: overrides.bedLevel ?? recorded.bedLevel,
    vibrationCompensation: overrides.vibrationCompensation ?? recorded.vibrationCompensation,
    flowCalibration: overrides.flowCalibration ?? recorded.flowCalibration,
    firstLayerInspection: overrides.firstLayerInspection ?? recorded.firstLayerInspection,
    timelapse: overrides.timelapse ?? recorded.timelapse,
    timelapseStorage: overrides.timelapseStorage ?? recorded.timelapseStorage,
    externalFilamentChangeAssist:
      overrides.externalFilamentChangeAssist ?? recorded.externalFilamentChangeAssist,
    filamentDynamicsCalibration: overrides.filamentDynamicsCalibration ?? recorded.filamentDynamicsCalibration,
    nozzleOffsetCalibration: overrides.nozzleOffsetCalibration ?? recorded.nozzleOffsetCalibration,
    allowIncompatibleFilament: overrides.allowIncompatibleFilament,
    allowPlateTypeMismatch: overrides.allowPlateTypeMismatch,
    allowPrinterModelMismatch: overrides.allowPrinterModelMismatch,
    allowFilamentTrackSwitchMismatch: overrides.allowFilamentTrackSwitchMismatch,
    allowInsufficientFilament: overrides.allowInsufficientFilament,
    allowBlacklistedFilament: overrides.allowBlacklistedFilament,
    currentPlateType: overrides.currentPlateType,
    currentNozzleDiameters: overrides.currentNozzleDiameters,
    plate: overrides.plate ?? row.plate ?? 1,
    // `?? undefined`, not the raw parse: `amsMapping` is optional on the wire but NOT
    // nullable, so handing it an explicit null makes the whole parse throw. The browser
    // always sends its own mapping and so never hit this; an override-less API re-print of
    // a job that recorded no mapping did, and failed before it could dispatch.
    amsMapping: overrides.amsMapping ?? parseAmsMapping(row.amsMapping) ?? undefined
  })
}

/**
 * Re-dispatch a finished history job.
 *
 * `assertPermission` is invoked with the resolved job kind at the same point
 * the route previously asserted permission, before any per-kind validation or
 * side effect, so the caller can enforce request-scoped authorization. It
 * should throw on failure.
 */
export async function reprintJobFromRow(input: {
  row: ReprintJobRow
  overrides: ReprintJobInput
  workspaceId: string
  assertPermission: (kind: ReprintJobKind) => void
}): Promise<ReprintResult> {
  const { row, overrides, workspaceId, assertPermission } = input
  const jobKind = toPrintJobKind(row.sourceType)

  if (jobKind === 'calibration') {
    assertPermission(jobKind)
    if (row.calibrationOption == null) throw badRequest('Calibration details are missing for this job')

    const targetPrinterId = overrides.printerId ?? row.printerId
    const printer = await prisma.printer.findFirst({ where: { id: targetPrinterId, workspaceId } })
    if (!printer) throw notFound('Printer not found')
    if (!printerManager.getPrinter(printer.id)) throw badRequest('Printer is not connected: command was not delivered')

    const blocked = printGuards.evaluate({ printerId: printer.id, source: 'calibration' })
    if (blocked) throw conflict(blocked.reason ?? 'Calibration blocked by a plugin')

    const started = await startCalibrationJob({
      printerId: printer.id,
      printerName: printer.name,
      option: row.calibrationOption
    })
    if (!started) throw badRequest('Printer is not connected: command was not delivered')

    return {
      kind: 'calibration',
      jobId: started,
      printerId: printer.id,
      printerName: printer.name
    }
  }

  if (jobKind === 'file') {
    assertPermission(jobKind)
    // Reached when the retained copy was reclaimed. Says what is actually wrong: this used to
    // fall through to the external rejection, which blamed the wrong thing entirely.
    if (!row.fileId) throw badRequest('The stored copy of this print is no longer available, so it cannot be reprinted')

    const restartOptions = buildReprintOptions(row, overrides)

    const job = await enqueueLibraryPrint({
      fileId: row.fileId,
      ...restartOptions
    }, workspaceId)

    return { kind: 'file', job }
  }

  throw badRequest('Externally started jobs cannot be restarted from history')
}
