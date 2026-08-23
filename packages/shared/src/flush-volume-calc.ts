/**
 * BambuStudio's flush-volume AUTO-CALCULATION: how many mm3 to purge when swapping filament A for
 * filament B, derived from the two colours.
 *
 * OWNS: the port of `FlushVolCalculator` (`libslic3r/FlushVolCalc.cpp`), its measured-dataset
 * lookup (`FlushVolPredictor.cpp`), and the per-extruder matrix builder
 * (`WipingDialog::CalcFlushingVolumes`, `slic3r/GUI/WipeTowerDialog.cpp`). Pure arithmetic over
 * colours and a few project/machine values: callers own reading `project_settings.config` and
 * shaping the result into the stored matrix ({@link module:flush-volumes-matrix}).
 *
 * CONTRACT. {@link calcFlushVolumesMatrix} returns the volumes BambuStudio's "Re-calculate" button
 * would produce for one extruder, as a `filaments x filaments` matrix of mm3 integers (row = from,
 * column = to). It is the SUGGESTION only: what a project actually purges is whatever sits in
 * `flush_volumes_matrix`, which the user may have hand-tuned. Never write this over stored values
 * without the user asking.
 *
 * WHY THE DATASET MATTERS. Studio does not trust the colour formula where it has measurements: it
 * ships lookup tables of real purge volumes between Bambu's own filament colours
 * (`resources/flush/flush_data_*.txt`) and prefers a table hit over the formula, matching colours
 * within DeltaE2000 <= 5. The gap is not cosmetic: measured against the standard table, the
 * formula alone is a mean 80 mm3 out and up to +286 mm3 (grey -> yellow: 180 measured, 466
 * computed), always over-purging. So a dataset-less calculation would quietly tell users to waste
 * filament while disagreeing with the numbers Bambu Studio shows for the same project. We therefore
 * read the tables from the BambuStudio image our slicer already runs rather than reimplementing
 * them; {@link FlushVolumeDataset} is that table, and its ABSENCE is a supported state: the
 * formula alone is exactly what Studio falls back to when its own data file is missing
 * (`FlushVolPredictor::m_valid == false`).
 *
 * FIDELITY NOTE. Two of Studio's expressions look wrong and are ported anyway, because the goal is
 * to show the same numbers Studio shows, not better ones: the dark/light boost compares a 0-255
 * luminance against a 0-1 threshold (see {@link calcFlushVolume}), and `min_flush_volume` is added
 * to a table hit under dataset 0 but not under datasets 1/2. Do not "fix" either without a
 * matching change in the engine we slice with.
 *
 * VERSION DRIFT. Every tunable below comes from `generated/flush-volume-model.generated.ts` rather
 * than a literal in this file, because these are compiled into BambuStudio and a vendor bump that
 * retunes one would otherwise leave us showing the previous release's numbers with nothing failing.
 * Re-run `scripts/dev/generate-flush-volume-model.mjs` after vendoring a newer BambuStudio;
 * `flush-volume-calc.test.ts` re-derives them from the vendored source and fails on any drift.
 */
import { FLUSH_VOLUME_MODEL } from './generated/flush-volume-model.generated.js'

/**
 * Round to 32-bit float.
 *
 * BambuStudio computes this whole chain in `float`, and JavaScript numbers are doubles, so a
 * straight transcription drifts in the last bit, which `Math.trunc` at the end turns into a
 * visible off-by-one. It is not hypothetical: BLACK -> WHITE, the most common two-material pairing
 * there is, computed 559 against Studio's 560, because `1*0.3 + 1*0.59 + 1*0.11` is 0.999... in
 * double but exactly 1 once rounded to float. So every step that C++ stores into a `float` is
 * rounded here too. Where C++ uses a DOUBLE literal (`0.3`, `0.67`, `1.3`, `M_PI`) the arithmetic
 * genuinely happens in double and is rounded only on assignment, those spots round once, at the
 * end, and the difference between the two is exactly the case above.
 */
const f32 = Math.fround

/** An 8-bit RGB colour. Alpha rides separately because only full transparency changes the maths. */
export interface FlushRgbColor {
  r: number
  g: number
  b: number
}

/**
 * One measured flush table (`resources/flush/flush_data_standard.txt` and its dual-nozzle
 * siblings), parsed into a lookup.
 *
 * `colors` is the reference palette the measurements were taken against; a query colour is snapped
 * to the FIRST palette entry within DeltaE2000 <= 5 before the lookup, so near-matches of Bambu's
 * own filaments hit the table too. `volumes` is keyed by {@link flushDatasetKey} over the snapped
 * pair. Both halves must snap or there is no hit and the caller falls back to the formula.
 */
export interface FlushVolumeDataset {
  colors: FlushRgbColor[]
  volumes: ReadonlyMap<string, number>
  /** Smallest measured volume in the table: Studio's floor for the multiplier UI's range hint. */
  minVolume: number
}

/** BambuStudio's `g_min_flush_volume_from_support`, a swap AWAY from support never purges less. */
export const FLUSH_MIN_VOLUME_FROM_SUPPORT = FLUSH_VOLUME_MODEL.minVolumeFromSupport
/** BambuStudio's `g_flush_volume_to_support`, a swap TO support material is a flat cost. */
export const FLUSH_VOLUME_TO_SUPPORT = FLUSH_VOLUME_MODEL.volumeToSupport
/** BambuStudio's `g_max_flush_volume`: the ceiling every calculated volume is clamped to. */
export const FLUSH_MAX_VOLUME = FLUSH_VOLUME_MODEL.maxVolume
/** BambuStudio's `g_min_flush_multiplier` / `g_max_flush_multiplier` (WipeTowerDialog.cpp). */
export const FLUSH_MULTIPLIER_RANGE = {
  min: FLUSH_VOLUME_MODEL.minMultiplier,
  max: FLUSH_VOLUME_MODEL.maxMultiplier
} as const
/** Which measured table each `nozzle_flush_dataset` code selects, under BambuStudio's resources. */
export const FLUSH_DATASET_FILES: Readonly<Record<string, string>> = FLUSH_VOLUME_MODEL.datasetFiles

/** Lookup key for a measured pair. Mirrors the predictor's packed-RGB hash, in string form. */
export function flushDatasetKey(from: FlushRgbColor, to: FlushRgbColor): string {
  return `${from.r},${from.g},${from.b}>${to.r},${to.g},${to.b}`
}

/**
 * Parse one of BambuStudio's `resources/flush/*.txt` tables.
 *
 * Format: a header line, a whitespace-separated palette line of `#rrggbb`, a column-name line, then
 * `<src> <dst> <volume>` rows. Returns null when any line fails to parse: Studio treats a
 * malformed file as no file at all (`m_valid = false`), and a partially-read table would silently
 * mix measured and computed volumes in one matrix.
 */
export function parseFlushVolumeDataset(text: string): FlushVolumeDataset | null {
  const lines = text.split(/\r?\n/)
  const paletteLine = lines[1]
  if (lines.length < 3 || paletteLine === undefined) return null
  const colors: FlushRgbColor[] = []
  for (const token of paletteLine.trim().split(/\s+/)) {
    const color = parseFlushHexColor(token)
    if (!color) return null
    colors.push(color)
  }
  if (colors.length === 0) return null
  const volumes = new Map<string, number>()
  let minVolume = Number.POSITIVE_INFINITY
  for (const line of lines.slice(3)) {
    if (line.trim().length === 0) continue
    const [fromHex, toHex, rawVolume] = line.trim().split(/\s+/)
    const from = parseFlushHexColor(fromHex)
    const to = parseFlushHexColor(toHex)
    const volume = Number(rawVolume)
    if (!from || !to || !Number.isFinite(volume)) return null
    // First writer wins, like the C++ `emplace`, so a duplicated pair cannot depend on read order.
    const key = flushDatasetKey(from, to)
    if (!volumes.has(key)) volumes.set(key, volume)
    minVolume = Math.min(minVolume, volume)
  }
  if (volumes.size === 0) return null
  return { colors, volumes, minVolume }
}

/** `#rrggbb` -> RGB. Studio asserts on any other shape and gives up on the file; so do we. */
function parseFlushHexColor(value: string | undefined): FlushRgbColor | null {
  if (!value || value.length !== 7 || value[0] !== '#') return null
  const r = Number.parseInt(value.slice(1, 3), 16)
  const g = Number.parseInt(value.slice(3, 5), 16)
  const b = Number.parseInt(value.slice(5, 7), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  return { r, g, b }
}

/**
 * Look a pair up in a measured table, snapping each end to the nearest palette colour first.
 *
 * Returns null when either end has no similar palette colour, or the snapped pair was never
 * measured: the caller must then compute the volume rather than substituting a default.
 */
export function lookupMeasuredFlushVolume(
  dataset: FlushVolumeDataset | null | undefined,
  from: FlushRgbColor,
  to: FlushRgbColor
): number | null {
  if (!dataset) return null
  const similarFrom = dataset.colors.find((color) => isSimilarFlushColor(color, from))
  const similarTo = dataset.colors.find((color) => isSimilarFlushColor(color, to))
  if (!similarFrom || !similarTo) return null
  return dataset.volumes.get(flushDatasetKey(similarFrom, similarTo)) ?? null
}

/** Two colours are "the same filament" for lookup purposes below DeltaE2000 5 (Studio's default). */
export function isSimilarFlushColor(
  from: FlushRgbColor,
  to: FlushRgbColor,
  threshold = FLUSH_VOLUME_MODEL.similarColorThreshold
): boolean {
  return flushColorDistance(from, to) <= threshold
}

/**
 * The volume to purge going from one colour to another, in mm3.
 *
 * `minFlushVolume` is the extruder's own dead volume for the SOURCE filament (see
 * {@link resolveMinFlushVolumes}); `dataset` selects which of Studio's measured tables applies
 * (`nozzle_flush_dataset` for this extruder) and may be null, leaving the colour formula alone.
 *
 * Alpha 0 counts as white on both ends: Studio treats a transparent filament as white rather than
 * as the colour underneath it.
 */
export function calcFlushVolume(input: {
  from: FlushRgbColor
  to: FlushRgbColor
  fromAlpha?: number
  toAlpha?: number
  minFlushVolume: number
  maxFlushVolume?: number
  /** The extruder's `nozzle_flush_dataset` code; decides WHICH table and how it is applied. */
  datasetCode: number
  dataset: FlushVolumeDataset | null | undefined
}): number {
  const maxFlushVolume = input.maxFlushVolume ?? FLUSH_MAX_VOLUME
  const from = input.fromAlpha === 0 ? { r: 255, g: 255, b: 255 } : input.from
  const to = input.toAlpha === 0 ? { r: 255, g: 255, b: 255 } : input.to

  // Datasets 1/2 (the dual-nozzle tables) short-circuit on a hit: the measured value IS the answer,
  // with no extruder dead volume added. Dataset 0 consults its table one level down instead, inside
  // the formula, and DOES pick up the dead volume below. That asymmetry is Studio's, not a port bug.
  if (input.datasetCode !== 0) {
    const measured = lookupMeasuredFlushVolume(input.dataset, from, to)
    if (measured !== null) return Math.min(Math.trunc(measured), maxFlushVolume)
  }

  let volume = calcFlushVolumeFromColor(from, to, input.datasetCode, input.dataset)

  // Studio compares a 0-255 luminance against a 0-1 threshold here, so `isFromDark` is true for
  // everything but near-black and `isToLight` only for near-black: in practice the 1.3x boost
  // applies to swaps INTO black on the dual-nozzle datasets. Ported as written: see the module
  // header. (`dark_color_thres` / `light_color_thres` in FlushVolCalc.cpp.)
  const darkColorThreshold = FLUSH_VOLUME_MODEL.darkColorThresholdNumerator / 255
  const lightColorThreshold = FLUSH_VOLUME_MODEL.lightColorThresholdNumerator / 255
  const isFromDark = flushLuminance(from.r, from.g, from.b) > darkColorThreshold
  const isToLight = flushLuminance(to.r, to.g, to.b) < lightColorThreshold
  if (input.datasetCode !== 0 && isFromDark && isToLight) volume = f32(volume * FLUSH_VOLUME_MODEL.darkToLightBoost)

  volume = f32(volume + input.minFlushVolume)
  return Math.min(Math.trunc(volume), maxFlushVolume)
}

/**
 * Studio's `calc_flush_vol_rgb`: the colour-distance formula, with dataset 0's table consulted
 * first. Exported for tests that pin the formula against BambuStudio's own numbers.
 */
export function calcFlushVolumeFromColor(
  from: FlushRgbColor,
  to: FlushRgbColor,
  datasetCode: number,
  dataset: FlushVolumeDataset | null | undefined
): number {
  if (datasetCode === 0) {
    const measured = lookupMeasuredFlushVolume(dataset, from, to)
    if (measured !== null) return Math.trunc(measured)
  }
  const fromR = f32(from.r / 255)
  const fromG = f32(from.g / 255)
  const fromB = f32(from.b / 255)
  const toR = f32(to.r / 255)
  const toG = f32(to.g / 255)
  const toB = f32(to.b / 255)

  const [fromHue, fromSat, fromVal] = rgbToHsv(fromR, fromG, fromB)
  const [toHue, toSat, toVal] = rgbToHsv(toR, toG, toB)
  let hueSatDistance = deltaHueSaturation(fromHue, fromSat, fromVal, toHue, toSat, toVal)

  // Two asymmetries Studio bakes in: a difference reads stronger when the destination is BRIGHT
  // (so a light-over-dark swap costs much more), and when the destination is darker the hue term is
  // capped by how dark it is: hiding a hue shift under a dark colour is cheap.
  const fromLuminance = flushLuminance(fromR, fromG, fromB)
  const toLuminance = flushLuminance(toR, toG, toB)
  let luminanceFlush: number
  if (toLuminance >= fromLuminance) {
    luminanceFlush = f32(f32(Math.pow(f32(toLuminance - fromLuminance), FLUSH_VOLUME_MODEL.brighterExponent)) * FLUSH_VOLUME_MODEL.brighterScale)
  } else {
    luminanceFlush = f32(f32(fromLuminance - toLuminance) * FLUSH_VOLUME_MODEL.darkerScale)
    // Double literals in the source, so this one blend really is double arithmetic.
    const { to: toWeight, from: fromWeight } = FLUSH_VOLUME_MODEL.darkerHueCapWeights
    hueSatDistance = Math.min(f32(toWeight * toVal + fromWeight * fromVal), hueSatDistance)
  }

  // The two terms are combined as sides of an obtuse triangle rather than added: a swap that is
  // extreme on ONE axis costs nearly that axis alone, instead of double-counting both.
  const volume = Math.max(
    triangleThirdEdge(
      f32(FLUSH_VOLUME_MODEL.hueSaturationScale * hueSatDistance),
      luminanceFlush,
      FLUSH_VOLUME_MODEL.combineAngleDegrees
    ),
    FLUSH_VOLUME_MODEL.volumeFloor
  )
  return Math.trunc(volume)
}

/**
 * BambuStudio's perceptual luminance weights (`get_luminance`). Unit-agnostic: in scale = out
 * scale, which is what lets {@link calcFlushVolume} feed it 0-255 values against a 0-1 threshold.
 * The weights are double literals in the source, so the sum is taken in double and rounded once.
 */
function flushLuminance(r: number, g: number, b: number): number {
  const { r: rw, g: gw, b: bw } = FLUSH_VOLUME_MODEL.luminanceWeights
  return f32(r * rw + g * gw + b * bw)
}

/** Law of cosines: `calc_triangle_3rd_edge`, float-stepped like the original. */
function triangleThirdEdge(edgeA: number, edgeB: number, degreesBetween: number): number {
  const cosine = f32(Math.cos(toRadians(degreesBetween)))
  const squares = f32(f32(edgeA * edgeA) + f32(edgeB * edgeB))
  return f32(Math.sqrt(f32(squares - f32(f32(f32(2 * edgeA) * edgeB) * cosine))))
}

/** `to_radians`: the division is float, but `M_PI` is a double, so only the result is rounded. */
function toRadians(degrees: number): number {
  return f32(f32(degrees / 180) * Math.PI)
}

/**
 * `DeltaHS_BBS`: hue+saturation distance taken in the HSV disc (each colour is a point at angle
 * `h`, radius `s * v`), capped at 1.2 so wildly opposite hues do not run away.
 */
function deltaHueSaturation(h1: number, s1: number, v1: number, h2: number, s2: number, v2: number): number {
  const dx = f32(f32(f32(Math.cos(toRadians(h1))) * s1) * v1 - f32(f32(Math.cos(toRadians(h2))) * s2) * v2)
  const dy = f32(f32(f32(Math.sin(toRadians(h1))) * s1) * v1 - f32(f32(Math.sin(toRadians(h2))) * s2) * v2)
  return Math.min(f32(FLUSH_VOLUME_MODEL.hueSaturationCap), f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy)))))
}

/** `RGB2HSV` from `ColorSpaceConvert.cpp`: rgb in [0,1]; h in [0,360], s and v in [0,1]. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = f32(max - min)
  let hue: number
  if (Math.abs(delta) < 0.001) hue = 0
  else if (max === r) hue = f32(60 * f32(f32(f32(g - b) / delta) % 6))
  else if (max === g) hue = f32(60 * f32(f32(f32(b - r) / delta) + 2))
  else hue = f32(60 * f32(f32(f32(r - g) / delta) + 4))
  const saturation = Math.abs(max) < 0.001 ? 0 : f32(delta / max)
  return [hue, saturation, max]
}

/** CIE L*a*b* for the dataset lookup: `FlushPredict::RGB2LAB`, D65 white point. */
function rgbToLab(color: FlushRgbColor): { l: number; a: number; b: number } {
  const gamma = (x: number): number => x > 0.04045 ? Math.pow((x + 0.055) / 1.055, 2.4) : x / 12.92
  const red = gamma(color.r / 255) * 100
  const green = gamma(color.g / 255) * 100
  const blue = gamma(color.b / 255) * 100
  const x = 0.412453 * red + 0.35758 * green + 0.180423 * blue
  const y = 0.212671 * red + 0.71516 * green + 0.072169 * blue
  const z = 0.019334 * red + 0.119193 * green + 0.950227 * blue
  const f = (t: number): number => t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 0.137931
  const fx = f(x / 95.0489)
  const fy = f(y / 100)
  const fz = f(z / 108.884)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** CIEDE2000: `FlushPredict::calc_color_distance`, ported term for term. */
export function flushColorDistance(from: FlushRgbColor, to: FlushRgbColor): number {
  const lab1 = rgbToLab(from)
  const lab2 = rgbToLab(to)
  const pow25To7 = Math.pow(25, 7)

  const c1 = Math.sqrt(lab1.a * lab1.a + lab1.b * lab1.b)
  const c2 = Math.sqrt(lab2.a * lab2.a + lab2.b * lab2.b)
  const cMean = (c1 + c2) / 2
  const powCMeanTo7 = Math.pow(cMean, 7)
  const g = 0.5 * (1 - Math.sqrt(powCMeanTo7 / (powCMeanTo7 + pow25To7)))

  const pa1 = (1 + g) * lab1.a
  const pa2 = (1 + g) * lab2.a
  const pc1 = Math.sqrt(pa1 * pa1 + lab1.b * lab1.b)
  const pc2 = Math.sqrt(pa2 * pa2 + lab2.b * lab2.b)
  const ph1 = hueAngle(pa1, lab1.b)
  const ph2 = hueAngle(pa2, lab2.b)

  const deltaL = lab2.l - lab1.l
  const deltaC = pc2 - pc1
  let deltaH = 0
  if (pc1 * pc2 !== 0) {
    let raw = ph2 - ph1
    if (raw < -Math.PI) raw += 2 * Math.PI
    else if (raw > Math.PI) raw -= 2 * Math.PI
    deltaH = 2 * Math.sqrt(pc1 * pc2) * Math.sin(raw / 2)
  }

  const lMean = (lab1.l + lab2.l) / 2
  const cMeanPrime = (pc1 + pc2) / 2
  const hueSum = ph1 + ph2
  let hMean: number
  if (pc1 * pc2 === 0) hMean = hueSum
  else if (Math.abs(ph1 - ph2) <= Math.PI) hMean = hueSum / 2
  else hMean = hueSum < 2 * Math.PI ? (hueSum + 2 * Math.PI) / 2 : (hueSum - 2 * Math.PI) / 2

  const t = 1
    - 0.17 * Math.cos(hMean - toRadians(30))
    + 0.24 * Math.cos(2 * hMean)
    + 0.32 * Math.cos(3 * hMean + toRadians(6))
    - 0.2 * Math.cos(4 * hMean - toRadians(63))
  const dTheta = toRadians(30) * Math.exp(-Math.pow((hMean - toRadians(275)) / toRadians(25), 2))
  const powCMeanPrimeTo7 = Math.pow(cMeanPrime, 7)
  const rc = 2 * Math.sqrt(powCMeanPrimeTo7 / (powCMeanPrimeTo7 + pow25To7))
  const powLMeanTo2 = Math.pow(lMean - 50, 2)
  const sl = 1 + (0.015 * powLMeanTo2) / Math.sqrt(20 + powLMeanTo2)
  const sc = 1 + 0.045 * cMeanPrime
  const sh = 1 + 0.015 * cMeanPrime * t
  const rt = -Math.sin(2 * dTheta) * rc

  return Math.sqrt(
    Math.pow(deltaL / sl, 2)
    + Math.pow(deltaC / sc, 2)
    + Math.pow(deltaH / sh, 2)
    + rt * (deltaC / sc) * (deltaH / sh)
  )
}

function hueAngle(a: number, b: number): number {
  if (a === 0 && b === 0) return 0
  const angle = Math.atan2(b, a)
  return angle < 0 ? angle + Math.PI * 2 : angle
}

/** One filament slot, as the matrix calculation sees it. */
export interface FlushCalcFilament {
  /** Display colour. Multi-colour filaments list every colour; the worst pair wins. */
  colors: FlushRgbColor[]
  /** Alpha per entry of {@link colors}; 0 means transparent, which counts as white. */
  alphas?: number[]
  /** `filament_is_support` for this slot: support material has its own flat volumes. */
  isSupport: boolean
}

/**
 * Build one extruder's `filaments x filaments` suggestion matrix (`CalcFlushingVolumes`).
 *
 * `minFlushVolumes` is per FILAMENT (from {@link resolveMinFlushVolumes}) and indexed by the SOURCE
 * slot, not the destination. Support material short-circuits both ways: swapping to support is a
 * flat {@link FLUSH_VOLUME_TO_SUPPORT}, and swapping away from it never drops below
 * {@link FLUSH_MIN_VOLUME_FROM_SUPPORT}, a support interface that carries the previous colour is
 * the failure this guards against.
 */
export function calcFlushVolumesMatrix(input: {
  filaments: readonly FlushCalcFilament[]
  minFlushVolumes: readonly number[]
  datasetCode: number
  dataset: FlushVolumeDataset | null | undefined
  maxFlushVolume?: number
}): number[][] {
  const { filaments, minFlushVolumes, datasetCode, dataset } = input
  return filaments.map((fromFilament, fromIndex) => filaments.map((toFilament, toIndex) => {
    if (fromIndex === toIndex) return 0
    if (toFilament.isSupport) return FLUSH_VOLUME_TO_SUPPORT
    const minFlushVolume = minFlushVolumes[fromIndex] ?? 0
    let volume = 0
    fromFilament.colors.forEach((from, fromColorIndex) => {
      toFilament.colors.forEach((to, toColorIndex) => {
        volume = Math.max(volume, calcFlushVolume({
          from,
          to,
          fromAlpha: fromFilament.alphas?.[fromColorIndex],
          toAlpha: toFilament.alphas?.[toColorIndex],
          minFlushVolume,
          maxFlushVolume: input.maxFlushVolume,
          datasetCode,
          dataset
        }))
      })
    })
    return fromFilament.isSupport ? Math.max(FLUSH_MIN_VOLUME_FROM_SUPPORT, volume) : volume
  }))
}

/**
 * Per-filament "dead volume" floor for one extruder: `get_min_flush_volumes` (`Plater.cpp`).
 *
 * It is the nozzle's own volume, less whatever a long retraction pulls back out of the melt zone
 * before the swap, so a machine that retracts on cut purges less. The retraction term applies only
 * when BOTH the machine and the filament enable it, and the filament's own distance is used only at
 * the machine's `EnableFilament` level (2), at `EnableMachine` (1) every filament uses the
 * machine's distance.
 *
 * Values come from `project_settings.config`; each is optional and defaults the way Studio's config
 * does, so a project missing the newer keys still calculates.
 */
export function resolveMinFlushVolumes(input: {
  filamentCount: number
  extruderIndex: number
  /** `nozzle_volume`, indexed by extruder (Studio's `get_at(nozzle_id)`). */
  nozzleVolume: readonly (number | null)[]
  /** `enable_long_retraction_when_cut`: 0 disabled, 1 machine-level, 2 filament-level. */
  enableLongRetractionWhenCut?: number
  /** `long_retractions_when_cut`, indexed by extruder. */
  longRetractionsWhenCut?: readonly (number | null)[]
  /** `retraction_distances_when_cut`, indexed by extruder (mm). */
  retractionDistancesWhenCut?: readonly (number | null)[]
  /** `filament_long_retractions_when_cut`, indexed by filament; null means "follow the machine". */
  filamentLongRetractionsWhenCut?: readonly (number | null)[]
  /** `filament_retraction_distances_when_cut`, indexed by filament (mm); null falls back. */
  filamentRetractionDistancesWhenCut?: readonly (number | null)[]
}): number[] {
  const nozzleVolume = Math.trunc(input.nozzleVolume[input.extruderIndex] ?? 0)
  const machineLevel = input.enableLongRetractionWhenCut ?? 0
  const machineActivated = (input.longRetractionsWhenCut?.[input.extruderIndex] ?? 0) === 1
  const machineDistance = input.retractionDistancesWhenCut?.[input.extruderIndex] ?? 18

  return Array.from({ length: input.filamentCount }, (_unused, filamentIndex) => {
    let retractLength = machineLevel !== 0 && machineActivated ? machineDistance : 0
    const filamentActivated = input.filamentLongRetractionsWhenCut?.[filamentIndex] ?? 0
    if (filamentActivated === 0) {
      retractLength = 0
    } else if (filamentActivated === 1 && machineLevel === 2) {
      const filamentDistance = input.filamentRetractionDistancesWhenCut?.[filamentIndex]
      retractLength = filamentDistance ?? machineDistance
    }
    // The cylinder of 1.75 mm filament pulled back out of the nozzle, in mm3.
    return Math.trunc(nozzleVolume - (Math.PI * 1.75 * 1.75 / 4) * retractLength)
  })
}
