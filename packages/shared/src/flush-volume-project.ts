/**
 * Reads everything the flushing-volumes editor needs out of a project's `project_settings.config`.
 *
 * OWNS: turning one raw settings document into the machine context the calculation runs against —
 * per-extruder dataset codes and dead volumes, the stored matrix split into per-extruder blocks,
 * the multiplier and which key it lives in. Keeping this in one place is the point: the dialog, the
 * bake and the repair pass must agree on where these values come from, and a UI that re-derived
 * "how many extruders" or "which multiplier key" on its own is how the two halves drift apart.
 *
 * CONTRACT. Returns null only when the document is unreadable or names no filaments — treat that
 * as "unknown", never as "no flush settings". `storedBlocks` is null when the project carries no
 * matrix (legitimate: BambuStudio computes one) OR when the stored matrix does not match the
 * project's own topology (the defect `needsSettingsRepair` flags), and the two are distinguished by
 * {@link ProjectFlushContext.matrixInconsistent} so the UI can offer a repair instead of silently
 * showing an empty grid.
 *
 * Counterparts: `flush-volume-calc.ts` (what the numbers should be), `flush-volumes-matrix.ts`
 * (what shape they must have), and the bake's `applyFlushVolumes` (writing them back).
 */
import {
  flushMultiplierKeyForPrimeVolumeMode,
  inspectProjectFlushVolumesMatrix,
  readFlushVolumesMatrixBlock
} from './flush-volumes-matrix.js'
import { calcFlushVolumesMatrix, resolveMinFlushVolumes, type FlushVolumeDataset } from './flush-volume-calc.js'

export interface ProjectFlushContext {
  filamentCount: number
  extruderCount: number
  /** Per-extruder `filaments x filaments` blocks, or null when unset/mis-sized (see above). */
  storedBlocks: number[][][] | null
  /** True when a matrix IS stored but contradicts the topology — the repairable defect. */
  matrixInconsistent: boolean
  /** One entry per extruder, defaulted to the engine's own default when absent or short. */
  multiplier: number[]
  /** Which key `multiplier` came from, decided by `prime_volume_mode`. */
  multiplierKey: 'flush_multiplier' | 'flush_multiplier_fast'
  /** `nozzle_flush_dataset` per extruder — selects which measured table applies. */
  datasetCodes: number[]
  /** Per-extruder, then per-filament dead volume floors (`get_min_flush_volumes`). */
  minFlushVolumes: number[][]
  /** `filament_is_support` per filament; support material has its own flat volumes. */
  filamentIsSupport: boolean[]
  /** `filament_colour` as stored, so a caller can tell the project's colours from the session's. */
  filamentColors: string[]
}

export function readProjectFlushContext(projectSettingsJson: string | null | undefined): ProjectFlushContext | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>

  const filamentColors = stringList(record.filament_colour)
  const filamentCount = filamentColors.length
  if (filamentCount <= 0) return null
  // One entry per NOZZLE — never the deduplicated nozzle-size list, which collapses a dual-0.4
  // machine back to one and would size the matrix a whole block short.
  const extruderCount = Math.max(numberList(record.nozzle_diameter).length, 1)

  const inspection = inspectProjectFlushVolumesMatrix(projectSettingsJson)
  const matrixInconsistent = inspection?.matrixInconsistent ?? false
  const rawMatrix = Array.isArray(record.flush_volumes_matrix) ? record.flush_volumes_matrix : null
  const blocks: number[][][] = []
  for (let extruder = 0; extruder < extruderCount; extruder += 1) {
    const block = readFlushVolumesMatrixBlock(rawMatrix, extruder, filamentCount, extruderCount)
    if (!block) break
    blocks.push(block)
  }

  const multiplierKey = flushMultiplierKeyForPrimeVolumeMode(record.prime_volume_mode)
  const storedMultiplier = numberList(record[multiplierKey])
  const multiplierDefault = multiplierKey === 'flush_multiplier_fast' ? 1.2 : 1
  const multiplier = Array.from({ length: extruderCount }, (_unused, index) =>
    storedMultiplier[index] ?? storedMultiplier[storedMultiplier.length - 1] ?? multiplierDefault)

  const variantIndices = resolveExtruderVariantIndices(record, extruderCount)
  const datasetCodesRaw = numberList(record.nozzle_flush_dataset)
  const nozzleVolume = nullableNumberList(record.nozzle_volume)
  const enableLongRetractionWhenCut = firstNumber(record.enable_long_retraction_when_cut) ?? 0
  const longRetractionsWhenCut = nullableNumberList(record.long_retractions_when_cut)
  const retractionDistancesWhenCut = nullableNumberList(record.retraction_distances_when_cut)
  const filamentLongRetractionsWhenCut = nullableNumberList(record.filament_long_retractions_when_cut)
  const filamentRetractionDistancesWhenCut = nullableNumberList(record.filament_retraction_distances_when_cut)

  return {
    filamentCount,
    extruderCount,
    storedBlocks: blocks.length === extruderCount ? blocks : null,
    matrixInconsistent,
    multiplier,
    multiplierKey,
    // Resolved through the VARIANT table, not by position — see `resolveExtruderVariantIndices`.
    // Absent means dataset 0, the config default.
    datasetCodes: variantIndices.map((variantIndex) => datasetCodesRaw[variantIndex] ?? 0),
    // Every extruder gets extruder 0's dead volumes. That is not a simplification on our side: the
    // engine hoists `get_min_flush_volumes(config, 0)` out of its per-extruder loop and reuses it
    // for all of them (`BambuStudio.cpp:3806`), so a machine whose second nozzle has a different
    // volume still purges by the first one's. Its GUI dialog does compute per-extruder, so the two
    // disagree on such a machine; we follow the ENGINE, because these numbers are written into the
    // project and it is the engine that purges. Verified against the real CLI (see
    // `flush-volume-project.test.ts`).
    minFlushVolumes: Array.from({ length: extruderCount }, () => resolveMinFlushVolumes({
      filamentCount,
      extruderIndex: 0,
      nozzleVolume,
      enableLongRetractionWhenCut,
      longRetractionsWhenCut,
      retractionDistancesWhenCut,
      filamentLongRetractionsWhenCut,
      filamentRetractionDistancesWhenCut
    })),
    filamentIsSupport: Array.from({ length: filamentCount }, (_unused, index) =>
      truthyFlag(asArray(record.filament_is_support)[index])),
    filamentColors
  }
}

/**
 * Suggest the whole matrix for a project — every extruder's block, from its own settings.
 *
 * The one place that composes "read the project" with "calculate", so the dialog, the calibration
 * check and any future caller cannot pair them differently. Returns one block per extruder.
 */
export function suggestProjectFlushVolumes(input: {
  context: ProjectFlushContext
  /** Colours to price, in slot order. Defaults to the project's own. */
  colors?: readonly string[]
  /** Measured tables keyed by dataset code; absent codes fall back to the colour formula. */
  datasets: Readonly<Record<string, FlushVolumeDataset>>
}): number[][][] {
  const { context } = input
  const colors = input.colors ?? context.filamentColors
  const filaments = colors.map((color, index) => ({
    colors: [parseFlushHexColor(color)],
    alphas: [parseFlushHexAlpha(color)],
    isSupport: context.filamentIsSupport[index] ?? false
  }))
  return Array.from({ length: context.extruderCount }, (_unused, extruderIndex) => {
    const datasetCode = context.datasetCodes[extruderIndex] ?? 0
    return calcFlushVolumesMatrix({
      filaments,
      minFlushVolumes: context.minFlushVolumes[extruderIndex] ?? [],
      datasetCode,
      dataset: input.datasets[String(datasetCode)] ?? null
    })
  })
}

/** How our suggestion compares with what the engine computed for the very same settings. */
export interface FlushCalibrationVerdict {
  agrees: boolean
  /** Flattened, so the two are directly comparable with the stored representation. */
  engine: string[]
  ours: string[]
}

/**
 * Check our port against BambuStudio's own computed matrix.
 *
 * `settingsJson` and `engineMatrix` must come from the SAME engine run (the slicer's
 * `/flush-calibration`), so any difference is genuinely ours rather than an input mismatch.
 * Disagreement means the engine we slice with has moved away from the vendored source our
 * constants were generated from — the drift the generator's test cannot see, because the image and
 * the vendored source are bumped independently.
 *
 * Returns null when the settings are unreadable, which is "unknown", not "agrees".
 */
export function evaluateFlushCalibration(input: {
  settingsJson: string
  engineMatrix: readonly string[]
  datasets: Readonly<Record<string, FlushVolumeDataset>>
}): FlushCalibrationVerdict | null {
  const context = readProjectFlushContext(input.settingsJson)
  if (!context) return null
  const ours = suggestProjectFlushVolumes({ context, datasets: input.datasets })
    .flatMap((block) => block.flatMap((row) => row.map((cell) => String(cell))))
  const engine = input.engineMatrix.map((entry) => String(Number(entry)))
  return { agrees: ours.length === engine.length && ours.every((cell, index) => cell === engine[index]), engine, ours }
}

/** `#rrggbb` / `#rrggbbaa` -> RGB; an unreadable colour reads as white, like BambuStudio's default. */
function parseFlushHexColor(value: string): { r: number; g: number; b: number } {
  const cleaned = value.replace('#', '')
  if (cleaned.length < 6) return { r: 255, g: 255, b: 255 }
  return {
    r: Number.parseInt(cleaned.slice(0, 2), 16),
    g: Number.parseInt(cleaned.slice(2, 4), 16),
    b: Number.parseInt(cleaned.slice(4, 6), 16)
  }
}

/** Bambu writes `#rrggbbaa`; a fully transparent filament is treated as white by the calculation. */
function parseFlushHexAlpha(value: string): number {
  const cleaned = value.replace('#', '')
  if (cleaned.length < 8) return 255
  const alpha = Number.parseInt(cleaned.slice(6, 8), 16)
  return Number.isFinite(alpha) ? alpha : 255
}

/**
 * Which row of a VARIANT-WIDE machine array each extruder reads.
 *
 * On a machine with extruder variants (H2D and friends) arrays like `nozzle_flush_dataset` and
 * `nozzle_volume` carry one entry per (extruder x variant) — five entries for two extruders — and
 * the entry an extruder uses is NOT its position. BambuStudio finds it by matching the extruder's
 * `<extruder_type> <nozzle_volume_type>` against `printer_extruder_variant` while requiring
 * `printer_extruder_id` to be that extruder's 1-based id (`DynamicPrintConfig::get_index_for_extruder`).
 *
 * Reading positionally is wrong in a way that looks right: index 0 happens to be correct for the
 * first extruder, so a dual-nozzle machine mis-prices only its SECOND nozzle's purges. Caught by
 * comparing against the real engine — an H2D resolves both extruders to dataset 1, where naive
 * indexing gives the second one dataset 2 and a different measured table.
 *
 * Falls back to positional when the machine declares no variant table (every single-variant
 * machine), which is exactly what BambuStudio's `index = 0` default degrades to there.
 */
function resolveExtruderVariantIndices(record: Record<string, unknown>, extruderCount: number): number[] {
  const variants = stringList(record.printer_extruder_variant)
  const extruderIds = numberList(record.printer_extruder_id)
  if (variants.length === 0) return Array.from({ length: extruderCount }, (_unused, index) => index)
  const extruderTypes = stringList(record.extruder_type)
  const volumeTypes = stringList(record.nozzle_volume_type)
  return Array.from({ length: extruderCount }, (_unused, extruderIndex) => {
    // `Hybrid` is not representable in presets; BambuStudio matches it as `Standard`.
    const rawVolumeType = volumeTypes[extruderIndex] ?? 'Standard'
    const volumeType = rawVolumeType === 'Hybrid' ? 'Standard' : rawVolumeType
    const wanted = `${extruderTypes[extruderIndex] ?? 'Direct Drive'} ${volumeType}`
    const found = variants.findIndex((variant, index) =>
      variant === wanted && extruderIds[index] === extruderIndex + 1)
    return found >= 0 ? found : 0
  })
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringList(value: unknown): string[] {
  return asArray(value).map((entry) => String(entry))
}

/** Bambu writes numbers as strings; `nil` is its "unset" marker and must not become 0. */
function nullableNumberList(value: unknown): (number | null)[] {
  return asArray(value).map((entry) => {
    if (entry === null || entry === 'nil' || entry === '') return null
    const parsed = Number(entry)
    return Number.isFinite(parsed) ? parsed : null
  })
}

function numberList(value: unknown): number[] {
  return nullableNumberList(value).map((entry) => entry ?? 0)
}

function firstNumber(value: unknown): number | null {
  if (Array.isArray(value)) return nullableNumberList(value)[0] ?? null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}
