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

/** Which quantity a calibration measures. */
export const calibrationKindSchema = z.enum(['pressureAdvance', 'flowRatio'])
export type CalibrationKind = z.infer<typeof calibrationKindSchema>

/**
 * Run lifecycle: `slicing` (generating + slicing the test) -> `readyToPrint`
 * (sliced artifact ready) -> `printing` (dispatched to the printer) ->
 * `awaitingResult` (print finished, waiting for the user's measurement) ->
 * `saved` | `discarded`; `failed` is any terminal error.
 */
export const calibrationRunStatusSchema = z.enum([
  'slicing',
  'readyToPrint',
  'printing',
  'awaitingResult',
  'saved',
  'discarded',
  'failed'
])
export type CalibrationRunStatus = z.infer<typeof calibrationRunStatusSchema>

/** How a saved result is matched to filament: one specific spool, or an identity. */
export const calibrationScopeSchema = z.enum(['spool', 'identity'])
export type CalibrationScope = z.infer<typeof calibrationScopeSchema>

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

const kValueSchema = z.number().min(MIN_PA_K_VALUE).max(MAX_PA_K_VALUE)
const flowRatioSchema = z.number().gt(MIN_FLOW_RATIO).lt(MAX_FLOW_RATIO)

const pressureAdvanceShape = {
  startK: kValueSchema,
  endK: kValueSchema,
  step: z.number().min(MIN_PA_K_STEP).max(MAX_PA_K_VALUE)
}
const flowRatioShape = {
  pass: z.union([z.literal(1), z.literal(2)]),
  currentFlowRatio: flowRatioSchema,
  offsets: z.array(z.number().min(-50).max(50)).min(2).max(25)
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
    z.object({ kind: z.literal('flowRatio'), ...flowRatioShape })
  ])
  .superRefine((value, ctx) => {
    if (value.kind === 'pressureAdvance' && value.endK < value.startK + value.step) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'End K must be at least one step above start K', path: ['endK'] })
    }
  })
export type CalibrationParameters = z.infer<typeof calibrationParametersSchema>

/**
 * The user's raw measurement of a printed test, discriminated by kind. For a PA
 * tower it is the Z height (mm) of the best-looking band; for a flow plate it is
 * the offset (percent) of the smoothest patch.
 */
export const calibrationMeasurementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pressureAdvance'), bestHeightMm: z.number().min(0).max(1000) }),
  z.object({ kind: z.literal('flowRatio'), selectedOffset: z.number().min(-50).max(50) })
])
export type CalibrationMeasurement = z.infer<typeof calibrationMeasurementSchema>

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
 * `scope: 'identity'` binds it to the ticked identity fields (a wildcard for any
 * unticked field). `applyToPrinter` (pressure advance only) also writes the value
 * to the printer's own K profile for the loaded tray.
 */
export const saveCalibrationResultSchema = z
  .object({
    scope: calibrationScopeSchema,
    match: z
      .object({
        brand: z.boolean().default(true),
        filamentType: z.boolean().default(true),
        materialSubtype: z.boolean().default(true),
        colorName: z.boolean().default(false)
      })
      .optional(),
    applyToPrinter: z.boolean().default(false)
  })
  .refine((value) => value.scope !== 'identity' || value.match != null, {
    message: 'Identity scope requires match criteria'
  })
export type SaveCalibrationResult = z.infer<typeof saveCalibrationResultSchema>

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
