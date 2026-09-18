/**
 * Calibration contracts shared by the API and web client (the `calibration`
 * plugin): slicer-generated pressure-advance (K-value tower) and flow-ratio
 * (patch plate) calibrations, the run state machine, and the saved results that
 * are applied automatically when their filament is used.
 *
 * A {@link CalibrationRun} is the wizard's lifecycle: we generate a test 3MF,
 * slice it as a hidden library artifact, print it, then the user enters a
 * measurement we turn into a value. A {@link CalibrationResult} is that value,
 * keyed by printer model + nozzle size (portable across printers of the same
 * model) and scoped to one spool or to a filament identity (brand/type/subtype/
 * color). Dates are ISO strings on the wire; `parameters`/`measurement` are typed
 * per `kind`.
 *
 * Value bounds mirror BambuStudio (`Calib.hpp`/`CalibUtils.cpp`): pressure
 * advance K in [0, 2] with a minimum step of 0.001, flow ratio strictly within
 * (0, 2). The flow-result formula is likewise BambuStudio's: a chosen patch at
 * offset `o` percent yields `newFlowRatio = currentFlowRatio * (100 + o) / 100`.
 */
import { z } from 'zod'
import { resolveFilamentIdentity, type FilamentColorInput, type FilamentSpoolIdentityInput } from './filament-identity.js'

/** Which quantity a calibration measures. */
export const calibrationKindSchema = z.enum([
  'pressureAdvance',
  'flowRatio',
  'temperature',
  'maxVolumetricSpeed',
  'vfa',
  'retraction'
])
export type CalibrationKind = z.infer<typeof calibrationKindSchema>

/**
 * Run lifecycle: `slicing` (generating + slicing the test) -> `readyToPrint`
 * (sliced artifact ready) -> `printing` (dispatched to the printer) ->
 * `awaitingResult` (print finished, waiting for the user's measurement) ->
 * `saved`; `failed` is any terminal error.
 *
 * There is deliberately no `discarded` state: discarding a run is
 * `DELETE /runs/:id`, which removes the row rather than parking it. A run that
 * is abandoned mid-flight simply stays in whatever state it reached.
 */
export const calibrationRunStatusSchema = z.enum([
  'slicing',
  'readyToPrint',
  'printing',
  'awaitingResult',
  'saved',
  'failed'
])
export type CalibrationRunStatus = z.infer<typeof calibrationRunStatusSchema>

/** How a saved result is matched to filament: one specific spool, or an identity. */
export const calibrationScopeSchema = z.enum(['spool', 'identity'])
export type CalibrationScope = z.infer<typeof calibrationScopeSchema>

/** Hardware applicability is independent of filament scope; nozzle size must still match. */
export const calibrationPrinterTargetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('models'), models: z.array(z.string().trim().min(1).max(120)).min(1).max(100) }),
  z.object({ scope: z.literal('printers'), printerIds: z.array(z.string().trim().min(1)).min(1).max(100) })
])
export type CalibrationPrinterTarget = z.infer<typeof calibrationPrinterTargetSchema>

// Value bounds (BambuStudio parity).
export const MIN_PA_K_VALUE = 0
export const MAX_PA_K_VALUE = 2
export const MIN_PA_K_STEP = 0.001
export const MIN_FLOW_RATIO = 0
export const MAX_FLOW_RATIO = 2

// Sensible defaults surfaced by the wizard (direct-drive Bambu tower + Orca flow sweep).
export const DEFAULT_PA_TOWER = { startK: 0, endK: 0.1, step: 0.002 } as const
export const FLOW_PASS_1_OFFSETS = [-20, -15, -10, -5, 0, 5, 10, 15, 20] as const
export const FLOW_PASS_2_OFFSETS = [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0] as const

/** Column count shared by the printed flow plate and its top-down result picker. */
export function flowCalibrationColumns(patchCount: number): number {
  return Math.min(patchCount, Math.ceil(Math.sqrt(patchCount)))
}
export const DEFAULT_TEMPERATURE_TOWER = { startTemperature: 230, endTemperature: 190, step: 5 } as const
export const DEFAULT_MAX_VOLUMETRIC_SPEED_TOWER = { startSpeed: 5, endSpeed: 40, step: 5 } as const
export const DEFAULT_VFA_TOWER = { startSpeed: 40, endSpeed: 200, step: 10 } as const
export const DEFAULT_RETRACTION_TOWER = { startLength: 0, endLength: 2, step: 0.1 } as const

const kValueSchema = z.number().min(MIN_PA_K_VALUE).max(MAX_PA_K_VALUE)
/** Missing mode preserves legacy/native K behaviour; linear values require explicit firmware mode. */
export const pressureAdvanceModeSchema = z.enum(['native', 'linear'])
export type PressureAdvanceMode = z.infer<typeof pressureAdvanceModeSchema>
const flowRatioSchema = z.number().gt(MIN_FLOW_RATIO).lt(MAX_FLOW_RATIO)

/** Server-resolved thermal recipe and loaded-tray snapshot for an X1 automatic run. */
export const automaticPaSetupSchema = z.object({
  nozzleTemperature: z.number().int().min(170).max(300),
  bedTemperature: z.number().int().min(0).max(120),
  maxVolumetricSpeed: z.number().positive().max(60),
  filamentId: z.string().min(1),
  settingId: z.string(),
  trayIndex: z.number().int().min(0).max(15),
  trayUuid: z.string().nullable().optional(),
  trayInfoIdx: z.string().nullable().optional(),
  filamentType: z.string().optional(),
  /** Server-observed identity, independent of editable result labels. Missing snapshots cannot start. */
  observedFilament: z.object({
    spoolId: z.string().nullable(),
    brand: z.string().nullable(),
    filamentType: z.string().nullable(),
    materialSubtype: z.string().nullable(),
    colorName: z.string().nullable(),
    color: z.string().nullable(),
    colors: z.array(z.string())
  }).optional()
})

const pressureAdvanceShape = {
  /** Automatic runs use printer measurements and retain native compensation. */
  method: z.enum(['tower', 'automatic']).optional(),
  /** Server-resolved recipe frozen when preparing an automatic run. */
  automaticSetup: automaticPaSetupSchema.optional(),
  /** Firmware's extra native coefficient, retained as measurement provenance. */
  automaticNCoefficient: z.number().finite().optional(),
  pressureAdvanceMode: pressureAdvanceModeSchema.optional(),
  startK: kValueSchema,
  endK: kValueSchema,
  step: z.number().min(MIN_PA_K_STEP).max(MAX_PA_K_VALUE)
}
const flowRatioShape = {
  pass: z.union([z.literal(1), z.literal(2)]),
  currentFlowRatio: flowRatioSchema,
  offsets: z.array(z.number().min(-50).max(50)).min(2).max(25)
}
const temperatureShape = {
  startTemperature: z.number().int().min(180).max(350),
  endTemperature: z.number().int().min(180).max(350),
  step: z.literal(5)
}
const maxVolumetricSpeedShape = {
  startSpeed: z.number().min(0).max(60),
  endSpeed: z.number().min(0).max(60),
  step: z.number().gt(0).max(60),
  currentFlowRatio: flowRatioSchema.default(1)
}
const vfaShape = {
  startSpeed: z.number().min(10).max(300),
  endSpeed: z.number().min(10).max(300),
  step: z.number().gt(0).max(100)
}
const retractionShape = {
  startLength: z.number().min(0).max(10),
  endLength: z.number().min(0).max(10),
  step: z.number().gt(0).max(2)
}

/**
 * Pressure-advance tower parameters. K is stepped once per mm of Z from `startK`
 * to `endK`; the tower height is derived as `(endK - startK) / step` mm.
 */
export const pressureAdvanceParametersSchema = z
  .object(pressureAdvanceShape)
  .refine((value) => value.endK >= value.startK + value.step, {
    message: 'End K must be at least one step above start K'
  })
export type PressureAdvanceParameters = z.infer<typeof pressureAdvanceParametersSchema>

/**
 * Flow-ratio patch parameters. `currentFlowRatio` is the filament profile's
 * present value; each patch prints at `currentFlowRatio * (100 + offset) / 100`.
 * Pass 1 is a coarse sweep, pass 2 a fine refinement centred on pass 1's pick.
 */
export const flowRatioParametersSchema = z.object(flowRatioShape)
export type FlowRatioParameters = z.infer<typeof flowRatioParametersSchema>

/** Typed test parameters, discriminated by calibration kind. */
export const calibrationParametersSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('pressureAdvance'), ...pressureAdvanceShape }),
    z.object({ kind: z.literal('flowRatio'), ...flowRatioShape }),
    z.object({ kind: z.literal('temperature'), ...temperatureShape }),
    z.object({ kind: z.literal('maxVolumetricSpeed'), ...maxVolumetricSpeedShape }),
    z.object({ kind: z.literal('vfa'), ...vfaShape }),
    z.object({ kind: z.literal('retraction'), ...retractionShape })
  ])
  .superRefine((value, ctx) => {
    if (value.kind === 'pressureAdvance' && value.endK < value.startK + value.step) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End K must be at least one step above start K', path: ['endK'] })
    }
    if (value.kind === 'temperature' && value.startTemperature < value.endTemperature + value.step) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Start temperature must be at least 5 C above end temperature', path: ['startTemperature'] })
    }
    if (value.kind === 'maxVolumetricSpeed' && value.endSpeed < value.startSpeed + value.step) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End speed must be at least one step above start speed', path: ['endSpeed'] })
    }
    if (value.kind === 'vfa' && value.endSpeed < value.startSpeed + value.step) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End speed must be at least one step above start speed', path: ['endSpeed'] })
    }
    if (value.kind === 'retraction' && value.endLength < value.startLength + value.step) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End length must be at least one step above start length', path: ['endLength'] })
    }
    if (value.kind === 'retraction' && (value.endLength - value.startLength) / value.step > 150) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose at most 150 retraction steps so the tower fits the printer', path: ['step'] })
    }
  })
export type CalibrationParameters = z.infer<typeof calibrationParametersSchema>

/** The standalone Micro Lidar workflow is supported only by the X1 family. */
export function supportsAutomaticPressureAdvance(model: string): boolean {
  return model === 'X1' || model === 'X1C' || model === 'X1E'
}

/** Distinguishes printer-measured runs from printed towers without adding a second result kind. */
export function isAutomaticPressureAdvance(parameters: CalibrationParameters): boolean {
  return parameters.kind === 'pressureAdvance' && parameters.method === 'automatic'
}

/**
 * The user's raw measurement of a printed test, discriminated by kind. For a PA
 * tower it is the Z height (mm) of the best-looking band; for a flow plate it is
 * the offset (percent) of the smoothest patch.
 */
export const calibrationMeasurementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pressureAdvance'), bestHeightMm: z.number().min(0).max(1000) }),
  z.object({ kind: z.literal('flowRatio'), selectedOffset: z.number().min(-50).max(50) }),
  z.object({ kind: z.literal('temperature'), selectedTemperature: z.number().int().min(180).max(350) }),
  z.object({ kind: z.literal('maxVolumetricSpeed'), selectedSpeed: z.number().min(0).max(60) }),
  z.object({ kind: z.literal('vfa'), selectedSpeed: z.number().min(10).max(300) }),
  z.object({ kind: z.literal('retraction'), selectedLength: z.number().min(0).max(10) })
])
export type CalibrationMeasurement = z.infer<typeof calibrationMeasurementSchema>

/** Absolute saved values, independent of the original printed patch or band. */
export const calibrationSavedValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('flowRatio'), value: flowRatioSchema }),
  z.object({ kind: z.literal('pressureAdvance'), value: kValueSchema, pressureAdvanceMode: pressureAdvanceModeSchema.optional() }),
  z.object({ kind: z.literal('temperature'), value: z.number().int().min(180).max(350) }),
  z.object({ kind: z.literal('maxVolumetricSpeed'), value: z.number().gt(0).max(60) }),
  z.object({ kind: z.literal('vfa'), value: z.number().min(10).max(300) }),
  z.object({ kind: z.literal('retraction'), value: z.number().min(0).max(10) })
])

/** A spool/filament identity snapshot used both on runs and identity-scoped results. */
const filamentIdentityShape = {
  brand: z.string().trim().max(120).nullable(),
  filamentType: z.string().trim().max(60).nullable(),
  materialSubtype: z.string().trim().max(120).nullable(),
  colorName: z.string().trim().max(120).nullable()
}

/** A calibration run DTO (wire shape). */
export const calibrationRunSchema = z.object({
  id: z.string(),
  kind: calibrationKindSchema,
  status: calibrationRunStatusSchema,
  printerId: z.string().nullable(),
  printerModel: z.string(),
  nozzleDiameter: z.string(),
  amsId: z.number().int().nullable(),
  slotId: z.number().int().nullable(),
  spoolId: z.string().nullable(),
  ...filamentIdentityShape,
  parameters: calibrationParametersSchema,
  slicingJobId: z.string().nullable(),
  outputFileId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  measurement: calibrationMeasurementSchema.nullable(),
  resultValue: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type CalibrationRun = z.infer<typeof calibrationRunSchema>

/** A saved calibration result DTO (wire shape). */
export const calibrationResultSchema = z.object({
  /** Absent on older servers: applies to printerModel only. */
  printerTarget: calibrationPrinterTargetSchema.optional(),
  pressureAdvanceMode: pressureAdvanceModeSchema.optional(),
  id: z.string(),
  kind: calibrationKindSchema,
  value: z.number(),
  printerModel: z.string(),
  nozzleDiameter: z.string(),
  scope: calibrationScopeSchema,
  spoolId: z.string().nullable(),
  ...filamentIdentityShape,
  runId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type CalibrationResult = z.infer<typeof calibrationResultSchema>

/** Filament identity used to resolve a saved calibration value. */
export interface CalibrationFilamentIdentity {
  spoolId: string | null
  brand: string | null
  filamentType: string | null
  materialSubtype: string | null
  colorName: string | null
}

/** Resolve the same physical filament identity for calibration capture and matching on either host. */
export function calibrationFilamentIdentityFromTray(
  tray: FilamentColorInput | null | undefined,
  spool?: (FilamentSpoolIdentityInput & { spoolId: string | null }) | null
): CalibrationFilamentIdentity {
  const identity = resolveFilamentIdentity({
    color: null, trayName: null, filamentType: null, ...tray, spool
  })
  return {
    spoolId: tray?.materialIdentity ? null : spool?.spoolId ?? null,
    brand: identity.brand,
    filamentType: identity.type,
    materialSubtype: identity.subtype,
    colorName: identity.colorName
  }
}

/** Minimum saved-result shape needed by the cross-host calibration matcher. */
export interface CalibrationValueCandidate extends CalibrationFilamentIdentity {
  scope: CalibrationScope
  value: number
}

/** Hardware matching fails closed for named-printer rules when slicing for a model only. */
export function calibrationMatchesPrinter(
  candidate: { printerModel: string; nozzleDiameter: string; printerTarget?: CalibrationPrinterTarget },
  target: { printerId?: string | null; printerModel: string; nozzleDiameter: string }
): boolean {
  if (candidate.nozzleDiameter !== target.nozzleDiameter) return false
  const rule = candidate.printerTarget
  if (!rule) return candidate.printerModel === target.printerModel
  if (rule.scope === 'models') return rule.models.includes(target.printerModel)
  return Boolean(target.printerId && rule.printerIds.includes(target.printerId))
}

/** Exact-printer rules take priority, then the usual spool/identity specificity within that tier. */
export function resolveTargetedCalibrationValue<T extends CalibrationValueCandidate & {
  printerModel: string; nozzleDiameter: string; printerTarget?: CalibrationPrinterTarget
}>(candidates: readonly T[], filament: CalibrationFilamentIdentity, target: {
  printerId?: string | null; printerModel: string; nozzleDiameter: string
}): T | null {
  const matching = candidates.filter((candidate) => calibrationMatchesPrinter(candidate, target))
  return resolveBestCalibrationValue(matching.filter((candidate) => candidate.printerTarget?.scope === 'printers'), filament)
    ?? resolveBestCalibrationValue(matching.filter((candidate) => candidate.printerTarget?.scope !== 'printers'), filament)
}

const CALIBRATION_IDENTITY_FIELDS = ['brand', 'filamentType', 'materialSubtype', 'colorName'] as const

/**
 * Pick the saved calibration value that applies to a filament. A spool-scoped value wins;
 * otherwise the identity result constraining the most fields wins. Callers must first narrow
 * candidates to one calibration kind, printer model, and nozzle diameter.
 */
export function resolveBestCalibrationValue<T extends CalibrationValueCandidate>(
  candidates: readonly T[],
  filament: CalibrationFilamentIdentity
): T | null {
  if (filament.spoolId != null) {
    const spoolMatch = candidates.find(
      (candidate) => candidate.scope === 'spool' && candidate.spoolId === filament.spoolId
    )
    if (spoolMatch) return spoolMatch
  }

  let best: T | null = null
  let bestSpecificity = -1
  for (const candidate of candidates) {
    if (candidate.scope !== 'identity') continue
    const matches = CALIBRATION_IDENTITY_FIELDS.every(
      (field) => candidate[field] == null || candidate[field] === filament[field]
    )
    if (!matches) continue

    const specificity = CALIBRATION_IDENTITY_FIELDS.reduce(
      (count, field) => count + (candidate[field] != null ? 1 : 0),
      0
    )
    if (specificity > bestSpecificity) {
      best = candidate
      bestSpecificity = specificity
    }
  }
  return best
}

/**
 * Create a calibration run: pick the printer + the AMS slot the test filament is
 * loaded in, the test parameters, and the slicing profiles to slice against. The
 * API snapshots the slot's filament identity and nozzle size onto the run.
 */
export const createCalibrationRunSchema = z.object({
  printerId: z.string().trim().min(1),
  amsId: z.number().int().min(0),
  slotId: z.number().int().min(0),
  parameters: calibrationParametersSchema,
  /** Slicing profile ids, as in a normal slice; the API defaults from the printer when omitted. */
  printerProfileId: z.string().trim().min(1).optional(),
  processProfileId: z.string().trim().min(1).optional(),
  filamentProfileId: z.string().trim().min(1).optional(),
  /** Plate/bed type to slice for (e.g. "Textured PEI Plate"). Defaults to the printer's installed
   *  plate so bed temps match; the web can override it. */
  plateType: z.string().trim().min(1).nullable().optional(),
  /**
   * The loaded filament this run calibrates, supplied by the web from what it knows about the
   * slot (filament-manager spool and/or the AMS tray). The API falls back to the printer's live
   * AMS status for any field left unset. `spoolId` enables saving a spool-scoped result.
   */
  spoolId: z.string().trim().min(1).nullable().optional(),
  brand: z.string().trim().max(120).nullable().optional(),
  filamentType: z.string().trim().max(60).nullable().optional(),
  materialSubtype: z.string().trim().max(120).nullable().optional(),
  colorName: z.string().trim().max(120).nullable().optional()
})
export type CreateCalibrationRun = z.infer<typeof createCalibrationRunSchema>

/** Submit the user's measurement for a run awaiting a result; the API computes the value. */
export const submitCalibrationMeasurementSchema = z.object({
  measurement: calibrationMeasurementSchema
})
export type SubmitCalibrationMeasurement = z.infer<typeof submitCalibrationMeasurementSchema>

/**
 * Save a run's computed result. `scope: 'spool'` binds it to the run's spool;
 * `spoolIds` can extend that narrow target to several explicitly chosen physical
 * spools. `scope: 'identity'` binds it to the ticked identity fields (a wildcard
 * for any unticked field). Results stay in PrintStream, never printer profiles.
 */
export const saveCalibrationResultSchema = z
  .object({
    printerTarget: calibrationPrinterTargetSchema.optional(),
    scope: calibrationScopeSchema,
    /** Absolute replacement when editing a saved result; validated against the run's kind. */
    value: z.number().finite().optional(),
    spoolIds: z.array(z.string().trim().min(1)).max(100).optional(),
    /** Save-time corrections for a missing or incomplete AMS identity snapshot. */
    identity: z
      .object({
        brand: z.string().trim().max(120).nullable().optional(),
        filamentType: z.string().trim().max(60).nullable().optional(),
        materialSubtype: z.string().trim().max(120).nullable().optional(),
        colorName: z.string().trim().max(120).nullable().optional()
      })
      .optional(),
    match: z
      .object({
        brand: z.boolean().default(true),
        filamentType: z.boolean().default(true),
        materialSubtype: z.boolean().default(true),
        colorName: z.boolean().default(false)
      })
      .optional(),
    /** Legacy clients may send false; printer-profile writes are no longer supported here. */
    applyToPrinter: z.literal(false).default(false)
  })
  .refine((value) => value.scope !== 'identity' || value.match != null, {
    message: 'Identity scope requires match criteria'
  })
  .refine(
    (value) => value.scope !== 'identity' || (value.match != null && Object.values(value.match).some(Boolean)),
    { message: 'Identity scope must match at least one filament field' }
  )
export type SaveCalibrationResult = z.infer<typeof saveCalibrationResultSchema>

/** Direct entry of an externally measured value. Never starts a run or writes to a printer. */
export const manualCalibrationResultSchema = z.object({
  calibration: calibrationSavedValueSchema,
  printerModel: z.string().trim().min(1).max(120),
  nozzleDiameter: z.enum(['0.2', '0.4', '0.6', '0.8']),
  target: saveCalibrationResultSchema
}).refine((input) => !input.target.applyToPrinter, { message: 'Manual entry only saves to PrintStream' })
export type ManualCalibrationResult = z.infer<typeof manualCalibrationResultSchema>

export const calibrationRunListSchema = z.object({ runs: z.array(calibrationRunSchema) })
export type CalibrationRunList = z.infer<typeof calibrationRunListSchema>

export const calibrationResultListSchema = z.object({ results: z.array(calibrationResultSchema) })
export type CalibrationResultList = z.infer<typeof calibrationResultListSchema>

/**
 * Compute a new flow ratio from the chosen patch offset (BambuStudio's formula).
 * A patch printed at offset `o`% of `currentFlowRatio` that looks best means the
 * true ratio is that patch's ratio.
 */
export function flowRatioFromOffset(currentFlowRatio: number, offsetPercent: number): number {
  return currentFlowRatio * (100 + offsetPercent) / 100
}

/**
 * Compute a pressure-advance K from the best band height on a tower where K
 * steps once per mm of Z: `K = startK + step * floor(heightMm)`, clamped to the
 * calibrated range.
 */
export function pressureAdvanceFromHeight(startK: number, step: number, heightMm: number): number {
  const raw = startK + step * Math.floor(heightMm)
  return Math.min(MAX_PA_K_VALUE, Math.max(MIN_PA_K_VALUE, raw))
}

/** Return the directly selected value for the four labelled tower calibrations. */
export function directCalibrationMeasurementValue(measurement: CalibrationMeasurement): number | null {
  switch (measurement.kind) {
    case 'temperature': return measurement.selectedTemperature
    case 'maxVolumetricSpeed': return measurement.selectedSpeed
    case 'vfa': return measurement.selectedSpeed
    case 'retraction': return measurement.selectedLength
    case 'pressureAdvance':
    case 'flowRatio': return null
  }
}
