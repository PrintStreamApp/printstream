/**
 * Calibration run orchestration: the state machine that turns a wizard request
 * into a printed test and, finally, a saved value. It reuses the normal pipeline
 * end to end — geometry → hidden library 3MF → the slicing job queue → the print
 * dispatcher — so a calibration print behaves like any other job.
 *
 * Lifecycle: `startRun` builds + slices (status `slicing`); `syncSliceStatus`
 * lazily advances to `readyToPrint`/`failed` when the slice finishes; `printRun`
 * dispatches (`printing`); the `print-job.finished` listener advances to
 * `awaitingResult`; `submitMeasurement` computes the value; `saveRunResult`
 * persists it (and, for pressure advance, can push it to the printer).
 *
 * Cross-entity links on the run are soft references, and slice status is polled
 * (the slicing queue emits no events), so nothing here holds long-lived state.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  flowRatioFromOffset,
  pressureAdvanceFromHeight,
  type CalibrationMeasurement,
  type CreateCalibrationRun,
  type SaveCalibrationResult
} from '@printstream/shared'
import type { CalibrationRun as CalibrationRunRow } from '@prisma/client'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import type { RequestTenantSummary } from '../../lib/tenant-context.js'
import { persistLibraryFileFromLocalPath } from '../../lib/library-files.js'
import { resolveLibraryFileToLocalPath } from '../../lib/bridge-library-files.js'
import { resolveSlicingProfileFiles } from '../../lib/slicing-profiles.js'
import { slicingJobs } from '../../lib/slicing-jobs.js'
import { enqueueLibraryPrint } from '../../lib/library-printing.js'
import { buildFlowRatioThreeMf, buildPressureAdvanceThreeMf } from './build-3mf.js'
import { renderCalibrationCover } from './cover.js'
import { createRun, findResolvableResults, getRun, saveResult, updateRun, type FilamentIdentity } from './store.js'

/**
 * Process overrides for the flow-ratio plate: a solid, readable top surface at a
 * neutral base flow so each patch's own `print_flow_ratio` is what varies
 * (mirrors BambuStudio's flow-test recipe). Whole-plate, applied at slice time.
 */
const FLOW_PROCESS_OVERRIDES: Record<string, string> = {
  wall_loops: '3',
  top_shell_layers: '5',
  bottom_shell_layers: '1',
  sparse_infill_density: '35%',
  top_surface_pattern: 'monotonic',
  ironing_type: 'no ironing',
  infill_direction: '45'
}

/**
 * Process overrides for the pressure-advance tower. The read-face settings follow BambuStudio's
 * PA-tower recipe (`Plater::_calib_pa_tower`): rear seam so the read faces stay clean, 2 walls with
 * no top/infill so only the signal-carrying outer wall prints (cheap + readable). The matching
 * geometry is the tower footprint (see `pressureAdvanceTower`).
 *
 * The brim is our own addition to anchor the tall, narrow tower on low-tack plates / stringy
 * materials (BambuStudio's recipe sets no brim). It must be `outer_only`, a full automatic
 * perimeter brim: `brim_ears` is the *painted* brim type in this fork and emits nothing unless
 * manual ear points are painted into `Metadata/brim_ear_points.txt`, which the tower has none of.
 */
const PA_TOWER_PROCESS_OVERRIDES: Record<string, string> = {
  seam_position: 'back',
  wall_loops: '2',
  top_shell_layers: '0',
  bottom_shell_layers: '0',
  sparse_infill_density: '0%',
  brim_type: 'outer_only',
  brim_width: '3',
  brim_object_gap: '0',
  alternate_extra_wall: '0'
}

export interface CalibrationRunManagerDeps {
  /** Resolve a printer to the fields the run needs; throws `notFound` if missing. */
  resolvePrinter(db: AnyPrismaClient, tenantId: string, printerId: string): Promise<{
    id: string
    model: string
    bridgeId: string | null
    nozzleDiameter: string
    /** The plate type currently installed on the printer, so the calibration slices for it. */
    currentPlateType: string | null
  }>
  /** Resolve the identity of the filament loaded in an AMS slot (for the result's defaults). */
  resolveSlotFilament(db: AnyPrismaClient, tenantId: string, printerId: string, amsId: number, slotId: number): Promise<
    FilamentIdentity & { spoolId: string | null }
  >
  /** Push a pressure-advance K value to the printer's own profile for a tray (optional). */
  applyPrinterKValue?(input: { printerId: string; printerModel: string; amsId: number; slotId: number; kValue: number; nozzleDiameter: string; identity: FilamentIdentity }): Promise<void>
  /** The K value the printer currently reports for a slot, if known (to skip a redundant push). */
  getSlotK?(printerId: string, amsId: number, slotId: number): number | null
  /**
   * The printer's global AMS tray index for a slot (unit-type aware), used to pin the calibration
   * print to the selected tray. Returns null when the printer/slot is not in live status, in which
   * case dispatch falls back to the printer's own default tray.
   */
  resolveTrayIndex?(printerId: string, amsId: number, slotId: number): number | null
}

/**
 * The `amsMapping` for a single-filament calibration print pinned to a resolved global tray index,
 * or `undefined` to omit `ams_mapping` and let the printer use its own default tray (e.g. when the
 * slot is not in live status). The tower/plate always has exactly one filament (project id 1), so a
 * present mapping is a single-element array.
 */
export function calibrationAmsMapping(trayIndex: number | null): number[] | undefined {
  return trayIndex != null ? [trayIndex] : undefined
}

/** Whether to push a saved K: only when one resolved and it differs from what the slot already has. */
export function shouldApplyKValue(saved: number | null, currentK: number | null): boolean {
  if (saved == null) return false
  if (currentK == null) return true
  return Math.abs(currentK - saved) > 1e-4
}

/**
 * When a filament is loaded into a slot, apply its saved pressure-advance value
 * to the printer (if one resolves and differs from the slot's current K). Called
 * from the `ams-slot.filament-loaded` bus listener; best-effort and idempotent.
 */
export async function autoApplyOnLoad(
  deps: CalibrationRunManagerDeps,
  db: AnyPrismaClient,
  event: { tenantId: string; printerId: string; amsId: number; slotId: number; spoolId: string; brand: string | null; filamentType: string | null; materialSubtype: string | null; colorName: string | null }
): Promise<void> {
  let printer
  try {
    printer = await deps.resolvePrinter(db, event.tenantId, event.printerId)
  } catch {
    return
  }
  // When the spool carries no colour name, fall back to the same slot-derived colour label
  // used at run creation (resolveSlotFilament), so identity matching on colour stays
  // symmetric between save time and apply time.
  let colorName = event.colorName
  if (colorName == null) {
    try {
      colorName = (await deps.resolveSlotFilament(db, event.tenantId, event.printerId, event.amsId, event.slotId)).colorName
    } catch {
      // keep null — colour simply doesn't constrain the match
    }
  }
  const identity: FilamentIdentity & { spoolId: string | null } = {
    spoolId: event.spoolId,
    brand: event.brand,
    filamentType: event.filamentType,
    materialSubtype: event.materialSubtype,
    colorName
  }
  const saved = await resolveSavedValue(db, event.tenantId, 'pressureAdvance', printer.model, printer.nozzleDiameter, identity)
  const currentK = deps.getSlotK?.(event.printerId, event.amsId, event.slotId) ?? null
  if (!deps.applyPrinterKValue || !shouldApplyKValue(saved, currentK)) return
  await deps.applyPrinterKValue({
    printerId: event.printerId,
    printerModel: printer.model,
    amsId: event.amsId,
    slotId: event.slotId,
    kValue: saved as number,
    nozzleDiameter: printer.nozzleDiameter,
    identity: { brand: event.brand, filamentType: event.filamentType, materialSubtype: event.materialSubtype, colorName: event.colorName }
  })
}

export async function startRun(
  deps: CalibrationRunManagerDeps,
  db: AnyPrismaClient,
  tenantId: string,
  tenant: RequestTenantSummary,
  input: CreateCalibrationRun
): Promise<CalibrationRunRow> {
  const printer = await deps.resolvePrinter(db, tenantId, input.printerId)
  if (!printer.bridgeId) throw badRequest('The target printer is not attached to a bridge; a calibration print needs one to store the sliced file.')
  // The web supplies what it knows about the loaded filament; the printer's live AMS status fills gaps.
  const observed = await deps.resolveSlotFilament(db, tenantId, input.printerId, input.amsId, input.slotId)
  const filament = {
    spoolId: input.spoolId ?? observed.spoolId,
    brand: input.brand ?? observed.brand,
    filamentType: input.filamentType ?? observed.filamentType,
    materialSubtype: input.materialSubtype ?? observed.materialSubtype,
    colorName: input.colorName ?? observed.colorName
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'calibration-run-'))
  const threeMfPath = path.join(workDir, 'calibration.3mf')
  try {
    const kind = input.parameters.kind
    const label = kind === 'flowRatio'
      ? `Flow calibration pass ${input.parameters.pass}`
      : 'Pressure advance tower'
    // Slice for the plate the web chose, defaulting to the one installed on the printer, so the
    // gcode's bed temperature matches the actual plate (a mismatched plate = wrong temp = poor
    // adhesion). `curr_bed_type` is picked up by the --export-settings project-settings synthesis.
    const plateType = input.plateType ?? printer.currentPlateType ?? null
    const overrides: Record<string, string> = {
      ...(kind === 'flowRatio' ? FLOW_PROCESS_OVERRIDES : PA_TOWER_PROCESS_OVERRIDES),
      ...(plateType ? { curr_bed_type: plateType } : {})
    }
    const processSettingOverrides = Object.keys(overrides).length > 0 ? overrides : undefined

    if (input.parameters.kind === 'flowRatio') {
      await buildFlowRatioThreeMf({
        outputPath: threeMfPath,
        printerModel: printer.model,
        currentFlowRatio: input.parameters.currentFlowRatio,
        offsets: input.parameters.offsets
      })
    } else {
      await buildPressureAdvanceThreeMf({
        outputPath: threeMfPath,
        printerModel: printer.model,
        parameters: input.parameters
      })
    }

    const sizeBytes = (await stat(threeMfPath)).size
    const { file: sourceFile } = await persistLibraryFileFromLocalPath({
      tenantId,
      sourcePath: threeMfPath,
      fileName: `${label}.3mf`,
      sizeBytes,
      folderId: null,
      bridgeId: printer.bridgeId,
      hidden: true,
      origin: 'scaffold'
    })

    const request = {
      sourceFileId: sourceFile.id,
      target: {
        mode: 'realPrinter' as const,
        printerId: input.printerId,
        printerProfileId: input.printerProfileId,
        processProfileId: input.processProfileId,
        filamentMappings: [{ projectFilamentId: 1, source: 'manual' as const, profileId: input.filamentProfileId }],
        ...(processSettingOverrides ? { processSettingOverrides } : {})
      },
      plate: 1,
      hiddenOutput: true,
      outputFileName: `${label} (sliced).gcode.3mf`,
      // BambuStudio's CLI renders no useful preview for the procedural calibration geometry, so embed
      // a recognizable per-kind cover as the plate thumbnail (jobs/history/printer card read it).
      plateThumbnails: [{ plateIndex: 1, png: renderCalibrationCover(kind).toString('base64') }]
    }
    const profileFiles = await resolveSlicingProfileFiles(tenantId, [
      { id: input.printerProfileId, kind: 'machine' },
      { id: input.processProfileId, kind: 'process' },
      { id: input.filamentProfileId, kind: 'filament' }
    ])

    const job = slicingJobs.enqueue({
      tenantId,
      tenant,
      sourceFileId: sourceFile.id,
      sourceFileName: sourceFile.name,
      sourcePath: await resolveLibraryFileToLocalPath(sourceFile),
      targetBridgeId: printer.bridgeId,
      request,
      profileFiles
    })

    const run = await createRun(db, tenantId, {
      kind,
      printerId: printer.id,
      printerModel: printer.model,
      nozzleDiameter: printer.nozzleDiameter,
      amsId: input.amsId,
      slotId: input.slotId,
      spoolId: filament.spoolId,
      brand: filament.brand,
      filamentType: filament.filamentType,
      materialSubtype: filament.materialSubtype,
      colorName: filament.colorName,
      parameters: input.parameters
    })
    await updateRun(db, tenantId, run.id, { slicingJobId: job.id })
    return { ...run, slicingJobId: job.id }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Lazily reconcile a `slicing` run with its slice job (the queue emits no events):
 * advance to `readyToPrint` with the output file id when ready, or `failed`.
 * Returns the possibly-updated row. A no-op for runs not in `slicing`.
 */
export async function syncSliceStatus(db: AnyPrismaClient, tenantId: string, run: CalibrationRunRow): Promise<CalibrationRunRow> {
  if (run.status !== 'slicing' || !run.slicingJobId) return run
  let job
  try {
    job = slicingJobs.get(tenantId, run.slicingJobId)
  } catch {
    return run
  }
  if (job.status === 'ready' && job.outputFileId) {
    await updateRun(db, tenantId, run.id, { status: 'readyToPrint', outputFileId: job.outputFileId })
    return { ...run, status: 'readyToPrint', outputFileId: job.outputFileId }
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    const errorMessage = job.error ?? 'Slicing failed'
    await updateRun(db, tenantId, run.id, { status: 'failed', errorMessage })
    return { ...run, status: 'failed', errorMessage }
  }
  return run
}

/** Dispatch a sliced calibration run to its printer. */
export async function printRun(deps: CalibrationRunManagerDeps, db: AnyPrismaClient, tenantId: string, runId: string): Promise<void> {
  const run = await getRun(db, tenantId, runId)
  if (!run) throw notFound('Calibration run not found')
  const synced = await syncSliceStatus(db, tenantId, run)
  if (synced.status !== 'readyToPrint' || !synced.outputFileId || !synced.printerId) {
    throw conflict('This calibration run is not ready to print yet.')
  }
  // Pin the single calibration filament to the exact AMS tray the user chose. Without an explicit
  // ams_mapping the printer picks its own default tray (slot 1), so the test would print from the
  // wrong slot. amsMapping is indexed by (projectFilamentId - 1); the tower/plate has one filament.
  const trayIndex = synced.amsId != null && synced.slotId != null
    ? deps.resolveTrayIndex?.(synced.printerId, synced.amsId, synced.slotId) ?? null
    : null
  const amsMapping = calibrationAmsMapping(trayIndex)
  await enqueueLibraryPrint({
    fileId: synced.outputFileId,
    printerId: synced.printerId,
    plate: 1,
    useAms: true,
    ...(amsMapping ? { amsMapping } : {}),
    // Do not let the printer's own flow / dynamics calibration override the test.
    flowCalibration: 'off',
    filamentDynamicsCalibration: false,
    bedLevel: 'on',
    vibrationCompensation: false,
    firstLayerInspection: true,
    timelapse: false,
    nozzleOffsetCalibration: 'auto',
    allowIncompatibleFilament: true,
    // The run was sliced for the plate the user chose (defaulting to the installed one), so the
    // plate is already deliberate — don't re-block at dispatch. If they overrode to a plate that is
    // not installed, that was their explicit choice.
    allowPlateTypeMismatch: true
  }, tenantId)
  await updateRun(db, tenantId, runId, { status: 'printing' })
}

/**
 * Advance any `printing` run for this printer whose sliced output matches the
 * finished job to `awaitingResult`. Called from the `print-job.finished` bus
 * listener (best-effort — the user can also enter a result manually).
 */
export async function handlePrintFinished(db: AnyPrismaClient, tenantId: string, printerId: string, outputFileId: string | null): Promise<void> {
  const runs = await db.calibrationRun.findMany({ where: { tenantId, printerId, status: 'printing' } })
  for (const run of runs) {
    if (outputFileId && run.outputFileId && run.outputFileId !== outputFileId) continue
    await updateRun(db, tenantId, run.id, { status: 'awaitingResult' })
  }
}

/** Compute and store the value from the user's measurement; run stays `awaitingResult`. */
export async function submitMeasurement(
  db: AnyPrismaClient,
  tenantId: string,
  runId: string,
  measurement: CalibrationMeasurement,
  parameters: CreateCalibrationRun['parameters']
): Promise<number> {
  const run = await getRun(db, tenantId, runId)
  if (!run) throw notFound('Calibration run not found')
  if (measurement.kind !== parameters.kind) throw badRequest('Measurement does not match the calibration kind')

  let value: number
  if (measurement.kind === 'flowRatio' && parameters.kind === 'flowRatio') {
    value = flowRatioFromOffset(parameters.currentFlowRatio, measurement.selectedOffset)
  } else if (measurement.kind === 'pressureAdvance' && parameters.kind === 'pressureAdvance') {
    value = pressureAdvanceFromHeight(parameters.startK, parameters.step, measurement.bestHeightMm)
  } else {
    throw badRequest('Measurement does not match the calibration kind')
  }
  await updateRun(db, tenantId, runId, { measurement, resultValue: value })
  return value
}

/** Persist a run's computed result to the store (and optionally to the printer). */
export async function saveRunResult(
  deps: CalibrationRunManagerDeps,
  db: AnyPrismaClient,
  tenantId: string,
  runId: string,
  options: SaveCalibrationResult
): Promise<void> {
  const run = await getRun(db, tenantId, runId)
  if (!run) throw notFound('Calibration run not found')
  if (run.resultValue == null) throw conflict('Enter a measurement before saving this calibration.')

  const identity: FilamentIdentity = {
    brand: options.scope === 'identity' && options.match?.brand ? run.brand : null,
    filamentType: options.scope === 'identity' && options.match?.filamentType ? run.filamentType : null,
    materialSubtype: options.scope === 'identity' && options.match?.materialSubtype ? run.materialSubtype : null,
    colorName: options.scope === 'identity' && options.match?.colorName ? run.colorName : null
  }
  await saveResult(db, tenantId, {
    kind: run.kind as CreateCalibrationRun['parameters']['kind'],
    value: run.resultValue,
    printerModel: run.printerModel,
    nozzleDiameter: run.nozzleDiameter,
    scope: options.scope,
    spoolId: options.scope === 'spool' ? run.spoolId : null,
    runId: run.id,
    ...identity
  })

  if (options.applyToPrinter && run.kind === 'pressureAdvance' && deps.applyPrinterKValue && run.printerId != null && run.amsId != null && run.slotId != null) {
    // Best-effort: the result is already saved to the store; pushing to the printer's own K profile
    // needs the printer online and responsive, so a failure here must not fail the save.
    try {
      await deps.applyPrinterKValue({
        printerId: run.printerId,
        printerModel: run.printerModel,
        amsId: run.amsId,
        slotId: run.slotId,
        kValue: run.resultValue,
        nozzleDiameter: run.nozzleDiameter,
        identity: { brand: run.brand, filamentType: run.filamentType, materialSubtype: run.materialSubtype, colorName: run.colorName }
      })
    } catch (error) {
      console.warn('[calibration] saved the result but could not push the K value to the printer', error instanceof Error ? error.message : error)
    }
  }

  await updateRun(db, tenantId, runId, { status: 'saved' })
}

/** Resolve the best saved value for a filament on a printer model + nozzle (auto-apply). */
export async function resolveSavedValue(
  db: AnyPrismaClient,
  tenantId: string,
  kind: CreateCalibrationRun['parameters']['kind'],
  printerModel: string,
  nozzleDiameter: string,
  filament: FilamentIdentity & { spoolId: string | null }
): Promise<number | null> {
  const candidates = await findResolvableResults(db, tenantId, kind, printerModel, nozzleDiameter)
  const { resolveCalibrationValue } = await import('./resolution.js')
  return resolveCalibrationValue(candidates, filament)?.value ?? null
}
