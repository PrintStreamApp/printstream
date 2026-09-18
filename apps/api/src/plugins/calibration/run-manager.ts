/**
 * Calibration run orchestration: the state machine that turns a wizard request
 * into a printed test and, finally, a saved value. It reuses the normal pipeline
 * end to end, geometry → hidden library 3MF → the slicing job queue → the print
 * dispatcher, so a calibration print behaves like any other job.
 *
 * Lifecycle: `startRun` builds + slices (status `slicing`); `syncSliceStatus`
 * lazily advances to `readyToPrint`/`failed` when the slice finishes; `printRun`
 * dispatches (`printing`); the `print-job.finished` listener advances to
 * `awaitingResult`; `submitMeasurement` computes the value; `saveRunResult`
 * persists it in PrintStream. Printer profiles are a separate AMS workflow.
 *
 * Cross-entity links on the run are soft references, and slice status is polled
 * (the slicing queue emits no events), so nothing here holds long-lived state.
 */
import { captureJobTags } from '../../lib/job-tag-snapshots.js'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  flowRatioFromOffset,
  isAutomaticPressureAdvance,
  calibrationSavedValueSchema,
  calibrationPrinterTargetSchema,
  pressureAdvanceFromHeight,
  directCalibrationMeasurementValue,
  type CalibrationMeasurement,
  type CreateCalibrationRun,
  type SaveCalibrationResult
} from '@printstream/shared'
import type { CalibrationRun as CalibrationRunRow } from '@prisma/client'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import type { RequestWorkspaceSummary } from '../../lib/workspace-context.js'
import { persistLibraryFileFromLocalPath } from '../../lib/library-files.js'
import { resolveLibraryFileToLocalPath } from '../../lib/bridge-library-files.js'
import { resolveSlicingPresetFiles } from '../../lib/slicing-presets.js'
import { slicingJobs } from '../../lib/slicing-jobs.js'
import { enqueueLibraryPrint } from '../../lib/library-printing.js'
import {
  buildFlowRatioThreeMf,
  buildMaxVolumetricSpeedThreeMf,
  buildPressureAdvanceThreeMf,
  buildTemperatureThreeMf,
  buildVfaThreeMf,
  buildRetractionThreeMf
} from './build-3mf.js'
import { createRun, deleteResultsForRun, getRun, saveResult, updateRun, type FilamentIdentity } from './store.js'
import { toCalibrationRunParameters } from './dto.js'
import { validateCalibrationPrinterTarget } from './printer-target.js'

/**
 * Process overrides for the flow-ratio plate: a solid, readable top surface. Each
 * patch's `print_flow_ratio` varies as a multiplier over the selected filament
 * preset's baseline (mirrors BambuStudio's flow-test recipe). Whole-plate,
 * applied at slice time.
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

const VASE_TOWER_PROCESS_OVERRIDES: Record<string, string> = {
  enable_overhang_speed: '0',
  enable_height_slowdown: '0',
  wall_loops: '1',
  top_shell_layers: '0',
  bottom_shell_layers: '1',
  sparse_infill_density: '0%',
  spiral_mode: '1',
  outer_wall_speed: '100',
  brim_type: 'outer_only',
  brim_width: '3',
  brim_object_gap: '0'
}

function calibrationRunLabel(parameters: CreateCalibrationRun['parameters']): string {
  switch (parameters.kind) {
    case 'flowRatio': return `Flow calibration pass ${parameters.pass}`
    case 'pressureAdvance': return 'Pressure advance tower'
    case 'temperature': return 'Temperature tower'
    case 'maxVolumetricSpeed': return 'Max volumetric speed tower'
    case 'vfa': return 'VFA tower'
    case 'retraction': return 'Retraction tower'
  }
}

export interface CalibrationRunManagerDeps {
  /** Resolve a printer to the fields the run needs; throws `notFound` if missing. */
  resolvePrinter(db: AnyPrismaClient, workspaceId: string, printerId: string): Promise<{
    id: string
    model: string
    bridgeId: string | null
    nozzleDiameter: string
    /** The plate type currently installed on the printer, so the calibration slices for it. */
    currentPlateType: string | null
  }>
  /** Resolve the identity of the filament loaded in an AMS slot (for the result's defaults). */
  resolveSlotFilament(db: AnyPrismaClient, workspaceId: string, printerId: string, amsId: number, slotId: number): Promise<
    FilamentIdentity & { spoolId: string | null }
  >
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

export async function startRun(
  deps: CalibrationRunManagerDeps,
  db: AnyPrismaClient,
  workspaceId: string,
  workspace: RequestWorkspaceSummary,
  input: CreateCalibrationRun
): Promise<CalibrationRunRow> {
  // Freeze the mode used by newly generated towers. Old runs without it stay native.
  if (input.parameters.kind === 'pressureAdvance') {
    input = { ...input, parameters: { ...input.parameters, pressureAdvanceMode: 'linear' } }
  }
  const printer = await deps.resolvePrinter(db, workspaceId, input.printerId)
  if (!printer.bridgeId) throw badRequest('The target printer is not attached to a bridge; a calibration print needs one to store the sliced file.')
  // The web supplies what it knows about the loaded filament; the printer's live AMS status fills gaps.
  const observed = await deps.resolveSlotFilament(db, workspaceId, input.printerId, input.amsId, input.slotId)
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
    const label = calibrationRunLabel(input.parameters)
    // Slice for the plate the web chose, defaulting to the one installed on the printer, so the
    // gcode's bed temperature matches the actual plate (a mismatched plate = wrong temp = poor
    // adhesion). `curr_bed_type` is picked up by the --export-settings project-settings synthesis.
    const plateType = input.plateType ?? printer.currentPlateType ?? null
    const overrides: Record<string, string> = {
      ...(kind === 'flowRatio'
        ? FLOW_PROCESS_OVERRIDES
        : kind === 'pressureAdvance' || kind === 'temperature' || kind === 'retraction'
          ? PA_TOWER_PROCESS_OVERRIDES
          : VASE_TOWER_PROCESS_OVERRIDES),
      ...(plateType ? { curr_bed_type: plateType } : {})
    }
    if (kind === 'maxVolumetricSpeed') {
      const nozzleDiameter = Number(printer.nozzleDiameter)
      overrides.outer_wall_line_width = String(nozzleDiameter * 1.75)
      overrides.initial_layer_print_height = String(nozzleDiameter * 0.8)
      overrides.layer_height = String(nozzleDiameter * 0.8)
    }
    const processSettingOverrides = Object.keys(overrides).length > 0 ? overrides : undefined

    switch (input.parameters.kind) {
      case 'flowRatio':
        await buildFlowRatioThreeMf({ outputPath: threeMfPath, printerModel: printer.model, currentFlowRatio: input.parameters.currentFlowRatio, offsets: input.parameters.offsets })
        break
      case 'pressureAdvance':
        await buildPressureAdvanceThreeMf({ outputPath: threeMfPath, printerModel: printer.model, parameters: input.parameters })
        break
      case 'temperature':
        await buildTemperatureThreeMf({ outputPath: threeMfPath, printerModel: printer.model, parameters: input.parameters })
        break
      case 'maxVolumetricSpeed':
        await buildMaxVolumetricSpeedThreeMf({
          outputPath: threeMfPath,
          printerModel: printer.model,
          nozzleDiameter: Number(printer.nozzleDiameter),
          flowRatio: input.parameters.currentFlowRatio,
          parameters: input.parameters
        })
        break
      case 'vfa':
        await buildVfaThreeMf({ outputPath: threeMfPath, printerModel: printer.model, parameters: input.parameters })
        break
      case 'retraction':
        await buildRetractionThreeMf({ outputPath: threeMfPath, printerModel: printer.model, parameters: input.parameters })
        break
    }

    const filamentSettingOverrides: Record<string, string> = kind === 'temperature'
      ? {
          nozzle_temperature: String(input.parameters.startTemperature),
          nozzle_temperature_initial_layer: String(input.parameters.startTemperature)
        }
      : kind === 'maxVolumetricSpeed'
        ? { filament_max_volumetric_speed: '60', slow_down_layer_time: '0' }
        : kind === 'vfa'
          ? { filament_max_volumetric_speed: '200', slow_down_layer_time: '0' }
          : {}

    // Both tests compute their result from this baseline. Freeze it into the slice,
    // even when the user changed it from the selected preset's flow ratio.
    if (input.parameters.kind === 'flowRatio' || input.parameters.kind === 'maxVolumetricSpeed') {
      filamentSettingOverrides.filament_flow_ratio = String(input.parameters.currentFlowRatio)
    }
    if (kind === 'retraction') {
      // A fixed nonzero baseline guarantees a retract/unretract pair even in the
      // zero-length band. No wipe or extra restart extrusion may obscure that pair.
      Object.assign(filamentSettingOverrides, {
        filament_retraction_length: '0.8', filament_retract_restart_extra: '0',
        filament_wipe: '0', filament_retract_before_wipe: '0',
        filament_retraction_minimum_travel: '1', filament_retract_when_changing_layer: '1'
      })
      Object.assign(overrides, { layer_height: '0.2', initial_layer_print_height: '0.2', spiral_mode: '0' })
    }

    const sizeBytes = (await stat(threeMfPath)).size
    const { file: sourceFile } = await persistLibraryFileFromLocalPath({
      workspaceId,
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
        ...(kind === 'retraction' ? { machineSettingOverrides: { use_relative_e_distances: '1', use_firmware_retraction: '0' } } : {}),
        filamentMappings: [{
          projectFilamentId: 1,
          source: 'manual' as const,
          profileId: input.filamentProfileId,
          ...(Object.keys(filamentSettingOverrides).length > 0 ? { settingOverrides: filamentSettingOverrides } : {})
        }],
        ...(processSettingOverrides ? { processSettingOverrides } : {})
      },
      plate: 1,
      hiddenOutput: true,
      outputFileName: `${label} (sliced).gcode.3mf`
    }
    const profileFiles = await resolveSlicingPresetFiles(workspaceId, [
      { id: input.printerProfileId, kind: 'machine' },
      { id: input.processProfileId, kind: 'process' },
      { id: input.filamentProfileId, kind: 'filament' }
    ])

    const job = slicingJobs.enqueue({
    tagSnapshot: await captureJobTags(db, workspaceId, { printerId: printer.id, fileIds: [sourceFile.id] }),
      workspaceId,
      workspace,
      sourceFileId: sourceFile.id,
      sourceFileName: sourceFile.name,
      sourcePath: await resolveLibraryFileToLocalPath(sourceFile),
      targetBridgeId: printer.bridgeId,
      request,
      profileFiles
    })

    const run = await createRun(db, workspaceId, {
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
    await updateRun(db, workspaceId, run.id, { slicingJobId: job.id })
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
export async function syncSliceStatus(db: AnyPrismaClient, workspaceId: string, run: CalibrationRunRow): Promise<CalibrationRunRow> {
  if (run.status !== 'slicing' || !run.slicingJobId) return run
  let job
  try {
    job = slicingJobs.get(workspaceId, run.slicingJobId)
  } catch {
    return run
  }
  if (job.status === 'ready' && job.outputFileId) {
    await updateRun(db, workspaceId, run.id, { status: 'readyToPrint', outputFileId: job.outputFileId })
    return { ...run, status: 'readyToPrint', outputFileId: job.outputFileId }
  }
  if (job.status === 'failed' || job.status === 'cancelled') {
    const errorMessage = job.error ?? 'Slicing failed'
    await updateRun(db, workspaceId, run.id, { status: 'failed', errorMessage })
    return { ...run, status: 'failed', errorMessage }
  }
  return run
}

/** Dispatch a sliced calibration run to its printer. */
export async function printRun(deps: CalibrationRunManagerDeps, db: AnyPrismaClient, workspaceId: string, runId: string): Promise<void> {
  const run = await getRun(db, workspaceId, runId)
  if (!run) throw notFound('Calibration run not found')
  const synced = await syncSliceStatus(db, workspaceId, run)
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
    timelapseStorage: 'external',
    externalFilamentChangeAssist: false,
    nozzleOffsetCalibration: 'auto',
    allowIncompatibleFilament: true,
    // The run was sliced for the plate the user chose (defaulting to the installed one), so the
    // plate is already deliberate: don't re-block at dispatch. If they overrode to a plate that is
    // not installed, that was their explicit choice.
    allowPlateTypeMismatch: true,
    // The output was sliced for this exact printer in the immediately preceding step.
    allowPrinterModelMismatch: false,
    // NOT waived, unlike the two above. A calibration plate is sliced by us, for this printer, moments
    // earlier, so its Filament Track Switch flag already matches the machine. A mismatch here would
    // mean the switch was fitted or removed mid-run, which is worth stopping for rather than printing
    // a calibration whose results would be meaningless.
    allowFilamentTrackSwitchMismatch: false,
    allowInsufficientFilament: false,
    // Also NOT waived, and this one matters most of the three. BambuStudio runs the same blacklist
    // on its own calibration wizard and refuses a prohibited material there, because a calibration
    // is exactly when someone puts an unfamiliar filament in an unfamiliar slot. Waiving it would
    // make the one flow that damages a nozzle the one flow with no guard.
    allowBlacklistedFilament: false
  }, workspaceId)
  await updateRun(db, workspaceId, runId, { status: 'printing' })
}

/**
 * Advance any `printing` run for this printer whose sliced output matches the
 * finished job to `awaitingResult`. Called from the `print-job.finished` bus
 * listener (best-effort: the user can also enter a result manually).
 */
export async function handlePrintFinished(db: AnyPrismaClient, workspaceId: string, printerId: string, outputFileId: string | null): Promise<void> {
  const runs = await db.calibrationRun.findMany({ where: { workspaceId, printerId, status: 'printing' } })
  for (const run of runs) {
    if (isAutomaticPressureAdvance(toCalibrationRunParameters(run))) continue
    if (outputFileId && run.outputFileId && run.outputFileId !== outputFileId) continue
    await updateRun(db, workspaceId, run.id, { status: 'awaitingResult' })
  }
}

/** Compute and store the value from the user's measurement; run stays `awaitingResult`. */
export async function submitMeasurement(
  db: AnyPrismaClient,
  workspaceId: string,
  runId: string,
  measurement: CalibrationMeasurement,
  parameters: CreateCalibrationRun['parameters']
): Promise<number> {
  const run = await getRun(db, workspaceId, runId)
  if (!run) throw notFound('Calibration run not found')
  if (isAutomaticPressureAdvance(toCalibrationRunParameters(run))) {
    throw conflict('Automatic calibration uses the printer measurement, not a manually entered band.')
  }
  if (measurement.kind !== parameters.kind) throw badRequest('Measurement does not match the calibration kind')

  let value: number
  if (measurement.kind === 'flowRatio' && parameters.kind === 'flowRatio') {
    value = flowRatioFromOffset(parameters.currentFlowRatio, measurement.selectedOffset)
  } else if (measurement.kind === 'pressureAdvance' && parameters.kind === 'pressureAdvance') {
    value = pressureAdvanceFromHeight(parameters.startK, parameters.step, measurement.bestHeightMm)
  } else {
    if (measurement.kind !== parameters.kind) {
      throw badRequest('Measurement does not match the calibration kind')
    }
    const directValue = directCalibrationMeasurementValue(measurement)
    if (directValue == null) throw badRequest('Measurement does not match the calibration kind')
    value = directValue
  }
  await updateRun(db, workspaceId, runId, { measurement, resultValue: value })
  return value
}

/** Persist a run's computed result in PrintStream; never writes a printer profile. */
export async function saveRunResult(
  deps: CalibrationRunManagerDeps,
  db: AnyPrismaClient,
  workspaceId: string,
  runId: string,
  options: SaveCalibrationResult
): Promise<void> {
  const run = await getRun(db, workspaceId, runId)
  if (!run) throw notFound('Calibration run not found')
  if (run.resultValue == null) throw conflict('Enter a measurement before saving this calibration.')
  if (options.value !== undefined && run.status !== 'saved') {
    throw conflict('Record the printed measurement before editing a saved value.')
  }
  const value = options.value ?? run.resultValue
  const parameters = run.kind === 'pressureAdvance' ? toCalibrationRunParameters(run) : null
  if (parameters && isAutomaticPressureAdvance(parameters) && !['awaitingResult', 'saved'].includes(run.status)) {
    throw conflict('Wait for a successful automatic measurement before saving.')
  }
  const pressureAdvanceMode = parameters?.kind === 'pressureAdvance' ? parameters.pressureAdvanceMode ?? 'native' : 'native'
  if (options.applyToPrinter) {
    throw badRequest('Save this value in PrintStream, or enter it manually in an AMS printer profile.')
  }
  if (!calibrationSavedValueSchema.safeParse({ kind: run.kind, value }).success) {
    throw badRequest('The calibration value is outside the allowed range for this test.')
  }

  const correctedIdentity: FilamentIdentity = {
    brand: options.identity?.brand !== undefined ? options.identity.brand : run.brand,
    filamentType: options.identity?.filamentType !== undefined ? options.identity.filamentType : run.filamentType,
    materialSubtype: options.identity?.materialSubtype !== undefined ? options.identity.materialSubtype : run.materialSubtype,
    colorName: options.identity?.colorName !== undefined ? options.identity.colorName : run.colorName
  }
  const identity: FilamentIdentity = {
    brand: options.scope === 'identity' && options.match?.brand ? correctedIdentity.brand : null,
    filamentType: options.scope === 'identity' && options.match?.filamentType ? correctedIdentity.filamentType : null,
    materialSubtype: options.scope === 'identity' && options.match?.materialSubtype ? correctedIdentity.materialSubtype : null,
    colorName: options.scope === 'identity' && options.match?.colorName ? correctedIdentity.colorName : null
  }
  if (options.scope === 'identity' && (Object.keys(identity) as Array<keyof FilamentIdentity>)
    .some((field) => options.match?.[field] && !identity[field]?.trim())) {
    throw badRequest('Enter a value for every checked filament detail')
  }
  const spoolIds = options.scope === 'spool'
    ? [...new Set(options.spoolIds ?? (run.spoolId ? [run.spoolId] : []))]
    : []
  if (options.scope === 'spool' && spoolIds.length === 0) {
    throw conflict('Choose at least one filament-library spool for this calibration.')
  }
  if (options.scope === 'identity' && Object.values(identity).every((value) => value == null || value.trim() === '')) {
    throw conflict('Enter and select at least one filament detail for this calibration.')
  }

  // Roll back every target and the run state if any replacement fails.
  await db.$transaction(async (transaction) => {
    let requestedTarget = options.printerTarget
    if (!requestedTarget && run.status === 'saved') {
      const existing = await transaction.calibrationResult.findFirst({ where: { workspaceId, runId: run.id } })
      if (existing) {
        requestedTarget = existing.printerTargetJson == null
          ? { scope: 'models', models: [existing.printerModel] }
          : calibrationPrinterTargetSchema.parse(existing.printerTargetJson)
      }
    }
    const printerTarget = await validateCalibrationPrinterTarget(transaction as AnyPrismaClient, workspaceId, requestedTarget, run.printerModel)

    // Preserve corrected identity together with the saved results.
    if (options.identity) {
      await updateRun(transaction as AnyPrismaClient, workspaceId, run.id, correctedIdentity)
    }

    // A saved run is editable. Replace only rows still attributed to this run so
    // changing its scope or selected spool set cannot leave invisible stale rules.
    await deleteResultsForRun(transaction as AnyPrismaClient, workspaceId, run.id)
    const targets = options.scope === 'spool' ? spoolIds : [null]
    for (const spoolId of targets) {
      await saveResult(transaction as AnyPrismaClient, workspaceId, {
        kind: run.kind as CreateCalibrationRun['parameters']['kind'],
        value,
        printerModel: run.printerModel,
        printerTarget,
        pressureAdvanceMode,
        nozzleDiameter: run.nozzleDiameter,
        scope: options.scope,
        spoolId,
        runId: run.id,
        ...identity
      })
    }

    await updateRun(transaction as AnyPrismaClient, workspaceId, runId, {
      status: 'saved',
      ...(options.value !== undefined ? { resultValue: value } : {})
    })
  })
}
