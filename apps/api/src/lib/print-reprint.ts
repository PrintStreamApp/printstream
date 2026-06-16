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
 * needing the orchestration internals. External-started jobs are rejected the
 * same way the route previously rejected them. Behavior — including error
 * messages, side-effect ordering, and audit metadata — mirrors the original
 * inline route handler exactly.
 */
import { printFromLibrarySchema } from '@printstream/shared'
import type { PrintDispatchJob, PrintFromLibrary } from '@printstream/shared'
import { badRequest, conflict, notFound } from './http-error.js'
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
 * Maps a stored job's source type + file id to its re-print kind. Externally
 * started jobs and library jobs that lost their file id resolve to 'external'.
 */
export function toPrintJobKind(sourceType: string | null | undefined, fileId: string | null): ReprintJobKind {
  if (sourceType === 'calibration') return 'calibration'
  if (sourceType === 'external') return 'external'
  return fileId ? 'file' : 'external'
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
 * Re-dispatch a finished history job.
 *
 * `assertPermission` is invoked with the resolved job kind at the same point
 * the route previously asserted permission — before any per-kind validation or
 * side effect — so the caller can enforce request-scoped authorization. It
 * should throw on failure.
 */
export async function reprintJobFromRow(input: {
  row: ReprintJobRow
  overrides: ReprintJobInput
  tenantId: string
  assertPermission: (kind: ReprintJobKind) => void
}): Promise<ReprintResult> {
  const { row, overrides, tenantId, assertPermission } = input
  const jobKind = toPrintJobKind(row.sourceType, row.fileId)

  if (jobKind === 'calibration') {
    assertPermission(jobKind)
    if (row.calibrationOption == null) throw badRequest('Calibration details are missing for this job')

    const targetPrinterId = overrides.printerId ?? row.printerId
    const printer = await prisma.printer.findFirst({ where: { id: targetPrinterId, tenantId } })
    if (!printer) throw notFound('Printer not found')
    if (!printerManager.getPrinter(printer.id)) throw badRequest('Printer is not connected — command was not delivered')

    const blocked = printGuards.evaluate({ printerId: printer.id, source: 'calibration' })
    if (blocked) throw conflict(blocked.reason ?? 'Calibration blocked by a plugin')

    const started = await startCalibrationJob({
      printerId: printer.id,
      printerName: printer.name,
      option: row.calibrationOption
    })
    if (!started) throw badRequest('Printer is not connected — command was not delivered')

    return {
      kind: 'calibration',
      jobId: started,
      printerId: printer.id,
      printerName: printer.name
    }
  }

  if (jobKind === 'file') {
    assertPermission(jobKind)
    if (!row.fileId) throw badRequest('File details are missing for this job')

    const targetPrinterId = overrides.printerId ?? row.printerId
    const restartOptions = printFromLibrarySchema.omit({ fileId: true }).parse({
      printerId: targetPrinterId,
      useAms: overrides.useAms ?? row.useAms ?? true,
      bedLevel: overrides.bedLevel ?? (row.bedLevel === false ? 'off' : 'on'),
      vibrationCompensation: overrides.vibrationCompensation,
      flowCalibration: overrides.flowCalibration,
      firstLayerInspection: overrides.firstLayerInspection,
      timelapse: overrides.timelapse,
      filamentDynamicsCalibration: overrides.filamentDynamicsCalibration,
      nozzleOffsetCalibration: overrides.nozzleOffsetCalibration,
      allowIncompatibleFilament: overrides.allowIncompatibleFilament,
      allowPlateTypeMismatch: overrides.allowPlateTypeMismatch,
      currentPlateType: overrides.currentPlateType,
      currentNozzleDiameters: overrides.currentNozzleDiameters,
      plate: overrides.plate ?? row.plate ?? 1,
      amsMapping: overrides.amsMapping ?? parseAmsMapping(row.amsMapping)
    })

    const job = await enqueueLibraryPrint({
      fileId: row.fileId,
      ...restartOptions
    }, tenantId)

    return { kind: 'file', job }
  }

  throw badRequest('Externally started jobs cannot be restarted from history')
}
