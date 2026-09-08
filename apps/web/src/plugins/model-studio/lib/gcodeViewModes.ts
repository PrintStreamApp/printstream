/**
 * What the G-code preview can colour a toolpath BY, and how a value becomes a colour (#92).
 *
 * Owns the view-mode catalogue (labels, units, legend precision), BambuStudio's `Range_Colors`
 * ramp, and the range arithmetic both the renderer and the legend run. Pure: no THREE, no DOM, so
 * `gcodeViewModes.test.ts` can pin the ramp against the C++ it is ported from.
 *
 * The contract callers rely on: a mode is either CATEGORICAL (feature type, coloured from
 * `GCODE_FEATURE_COLORS` by role index) or a RANGE (every other mode, coloured by interpolating
 * the 10-stop ramp between the print's own min and max). `gcodeViewModeMetric` is the one place
 * that says which, so a caller never switches on the mode name itself.
 *
 * Ported from BambuStudio 02.07.01.57 (`src/slic3r/GUI/GCodeRenderer/BaseRenderer.cpp`). Three
 * things about that port are deliberate and easy to "fix" wrongly:
 *
 * - **The ramp is a piecewise-linear gradient over 10 stops, not 10 discrete bands.** Studio's CPU
 *   renderer lerps between adjacent stops (`Range::get_color_at:3870`); its GPU renderer samples a
 *   10-texel `GL_LINEAR` texture instead, which squashes the ends (texel centres sit at
 *   (i+0.5)/10, so the first and last twentieth are flat). The CPU form is the canonical one and
 *   the one its own legend labels describe, so that is what is ported here.
 * - **The range is computed over the WHOLE print and never recomputed while scrubbing layers.**
 *   Studio's `refresh()` walks every move (`BaseRenderer.cpp:1278`) and the layer slider does not
 *   call it. A ramp that rescaled per visible layer would make the same bead change colour as the
 *   user scrubs, which reads as the print changing rather than the view.
 * - **Values are quantised to two significant figures** ({@link roundToBin}) before they enter a
 *   range, which is what makes the legend's ten labels land on round numbers instead of on the
 *   float dirt of one outlying segment.
 *
 * Counterpart: `gcodePreview.ts` (which accumulates the ranges during the parse and applies the
 * colours to the bead mesh) and `GcodeToolpathPanel.tsx` (which draws the legend from the same
 * numbers, so a swatch cannot disagree with the geometry beside it).
 */

/**
 * BambuStudio's `Range_Colors` (`BaseRenderer.cpp:157-169`): magenta -> yellow -> green.
 *
 * The `// bluish` / `// reddish` comments on the first and last entries in the C++ are stale
 * leftovers from the commented-out palette below them; the values really are magenta and green.
 */
export const GCODE_RANGE_COLORS: ReadonlyArray<number> = [
  0xff00ff,
  0xff55a9,
  0xfe8778,
  0xffb847,
  0xffd925,
  0xffff00,
  0xd8ff00,
  0xadff04,
  0x76ff01,
  0x00ff00
]

/**
 * Colour for a value below the range's floor by more than {@link RANGE_UNDERFLOW_TOLERANCE}
 * (`ColorRGBA::GRAY()`, `Color.hpp:135`).
 *
 * Unreachable for every mode here, because each range's floor IS its data minimum. It is ported
 * anyway so the ramp function is total: Studio reaches it only for its fixed-range Helio thermal
 * views, which we do not have.
 */
export const GCODE_RANGE_OUT_OF_RANGE_COLOR = 0x808080

/** How far below a range's floor a value may sit and still clamp to the first stop, not to grey. */
const RANGE_UNDERFLOW_TOLERANCE = 0.01

/**
 * BambuStudio's `Travel_Colors` (`BaseRenderer.cpp:150-154`), indexed by
 * {@link GcodeTravelKind}. The Move entry doubles as the legend's Travel swatch, as it does there.
 */
export const GCODE_TRAVEL_COLORS: ReadonlyArray<number> = [
  0x38489b, // 0 Move: no extruder motion
  0x1d6c1a, // 1 Extrude: extruding while travelling (de-retract, priming)
  0x811007  // 2 Retract: filament pulled back
]

/**
 * A point marker on a move that prints nothing: {@link GCODE_MARKER_COLORS} indexes on this.
 *
 * Only the three BambuStudio actually offers. Its `Options_Colors` also carries ToolChanges,
 * ColorChanges, PausePrints and CustomGCodes, but none of them reach its legend: `Tool_change` is
 * commented out of `options_items` (`BaseRenderer.cpp:3229-3238`) and the other three are never
 * added, so porting them would build controls its own UI does not have.
 */
export type GcodeMarkerKind = 0 | 1 | 2

/** Retract / Unretract / Seam, from BambuStudio's `Options_Colors` (`BaseRenderer.cpp:141-149`). */
export const GCODE_MARKER_COLORS: ReadonlyArray<number> = [
  0xcd22d6, // 0 Retract (magenta)
  0x49adcf, // 1 Unretract (cyan)
  0xe6e6e6  // 2 Seam (near-white)
]

/** Labels parallel to {@link GCODE_MARKER_COLORS}, matching BambuStudio's legend rows. */
export const GCODE_MARKER_NAMES: ReadonlyArray<string> = ['Retract', 'Unretract', 'Seam']

/** BambuStudio's `Wipe_Color` (`BaseRenderer.cpp:197`). Wipe is a path, not a point marker. */
export const GCODE_WIPE_COLOR = 0xffff00

/**
 * Which of {@link GCODE_TRAVEL_COLORS} a travel move takes, from the SIGN of its E delta
 * (`LegacyRenderer.cpp:1788-1792`). Exactly zero is a plain move.
 */
export type GcodeTravelKind = 0 | 1 | 2

/** A metric's observed extent across the whole print, plus Studio's odd sample counter. */
export interface GcodeValueRange {
  min: number
  max: number
  /**
   * How many samples differed from the running min AND max when they arrived
   * (`BaseRenderer.hpp:396-398`).
   *
   * Not a distinct-value count and not a sample count: it is order-dependent, and it exists only
   * because Studio's legend switches on it (1 sample draws one swatch, 2 draws the two ends, 3+
   * draws all ten). Ported so a range with one real value does not draw ten identical rows.
   */
  count: number
}

/** An empty range: `min`/`max` are seeded inverted so the first sample defines both. */
export function emptyValueRange(): GcodeValueRange {
  return { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, count: 0 }
}

/** Whether any sample ever reached this range (an all-travel plate has no extrusion metrics). */
export function hasRangeSamples(range: GcodeValueRange): boolean {
  return range.count > 0 && Number.isFinite(range.min) && Number.isFinite(range.max)
}

/** Fold one sample into a range, mirroring `Range::update_from` (`BaseRenderer.hpp:396-403`). */
export function updateValueRange(range: GcodeValueRange, value: number): void {
  if (!Number.isFinite(value)) return
  if (value !== range.max && value !== range.min) range.count += 1
  if (value < range.min) range.min = value
  if (value > range.max) range.max = value
}

/**
 * Quantise to a bin with at least two digits of resolution, BambuStudio's `round_to_bin`
 * (`BaseRenderer.cpp:97-111`).
 *
 * Applied to layer height, line width and volumetric rate before they enter a range: without it
 * the legend's ten labels report the float dirt of whichever segment happened to be widest.
 *
 * Note the C++ calls itself equivalent to `sprintf("%.2g")`, and that comment is wrong above
 * ~0.095: the scale never coarsens past two DECIMALS, so 123 stays 123 where `%.2g` would give
 * 120. The code is ported, not the comment, because these are the numbers the legend must match.
 */
export function roundToBin(value: number): number {
  const scale = [100, 1000, 10000, 100000, 1000000]
  const invScale = [0.01, 0.001, 0.0001, 0.00001, 0.000001]
  const threshold = [0.095, 0.0095, 0.00095, 0.000095, 0.0000095]
  let i = 0
  while (i < 4 && value < threshold[i]!) i += 1
  return Math.round(value * scale[i]!) * invScale[i]!
}

/**
 * Where a value sits on the ramp, as a stop position in [0, 9].
 *
 * Split out of {@link rangeColorAt} because the legend needs the same arithmetic to place its
 * labels, and the two disagreeing is exactly the bug this module exists to prevent.
 */
function rampPosition(range: GcodeValueRange, value: number): number {
  const stops = GCODE_RANGE_COLORS.length - 1 // Studio's `get_color_size()` == 9
  const step = range.max > range.min ? (range.max - range.min) / stops : 0
  return step > 0 && value > range.min ? (value - range.min) / step : 0
}

/**
 * The colour a value takes on the ramp, porting `Range::get_color_at`
 * (`BaseRenderer.cpp:3870-3912`) as an sRGB hex.
 *
 * Edge behaviour is Studio's and is not symmetric: above `max` clamps hard to the last stop,
 * between `min - 0.01` and `min` clamps hard to the first, and below that returns grey.
 */
export function rangeColorAt(range: GcodeValueRange, value: number): number {
  const lastIndex = GCODE_RANGE_COLORS.length - 1
  if (!hasRangeSamples(range)) return GCODE_RANGE_COLORS[0]!
  if (value > range.max) return GCODE_RANGE_COLORS[lastIndex]!
  if (value < range.min) {
    return value < range.min - RANGE_UNDERFLOW_TOLERANCE ? GCODE_RANGE_OUT_OF_RANGE_COLOR : GCODE_RANGE_COLORS[0]!
  }
  const position = rampPosition(range, value)
  const lowIndex = Math.min(Math.max(Math.floor(position), 0), lastIndex)
  const highIndex = Math.min(lowIndex + 1, lastIndex)
  const t = Math.min(Math.max(position - lowIndex, 0), 1)
  return lerpHex(GCODE_RANGE_COLORS[lowIndex]!, GCODE_RANGE_COLORS[highIndex]!, t)
}

/**
 * Blend two sRGB hex colours per channel, as Studio's `lerp(ColorRGBA, ...)` does.
 *
 * Written out per channel rather than through a local helper closure: this runs once per SEGMENT
 * during a view-mode repaint (460k times on a real plate), and the closure form allocated three
 * times per call. Measured at 310ns -> 41ns per `rangeColorAt`.
 */
function lerpHex(low: number, high: number, t: number): number {
  const r0 = (low >> 16) & 0xff, g0 = (low >> 8) & 0xff, b0 = low & 0xff
  const r1 = (high >> 16) & 0xff, g1 = (high >> 8) & 0xff, b1 = high & 0xff
  const r = Math.round(r0 + (r1 - r0) * t) & 0xff
  const g = Math.round(g0 + (g1 - g0) * t) & 0xff
  const b = Math.round(b0 + (b1 - b0) * t) & 0xff
  return (r << 16) | (g << 8) | b
}

/**
 * The value the legend prints beside stop `step`, porting `Range::get_value_at_step`
 * (`BaseRenderer.cpp:3928-3940`).
 */
export function rangeValueAtStep(range: GcodeValueRange, step: number): number {
  const stops = GCODE_RANGE_COLORS.length - 1
  return range.min + (step * (range.max - range.min)) / stops
}

/**
 * The legend's rows for a range view, TOP-DOWN (max first), mirroring `append_range`
 * (`BaseRenderer.cpp:1550-1570`).
 *
 * The three cases are Studio's: a range only one sample ever disagreed with draws a single
 * swatch, two draws just the ends, and anything else draws all ten stops. Without that, a plate
 * printed entirely at one speed drew ten identical rows labelled with the same number.
 */
export function rangeLegendRows(range: GcodeValueRange): Array<{ color: number; value: number }> {
  if (!hasRangeSamples(range)) return []
  const lastIndex = GCODE_RANGE_COLORS.length - 1
  if (range.count === 1) return [{ color: GCODE_RANGE_COLORS[0]!, value: range.min }]
  if (range.count === 2) {
    return [
      { color: GCODE_RANGE_COLORS[lastIndex]!, value: range.max },
      { color: GCODE_RANGE_COLORS[0]!, value: range.min }
    ]
  }
  const rows: Array<{ color: number; value: number }> = []
  for (let i = lastIndex; i >= 0; i--) {
    rows.push({ color: GCODE_RANGE_COLORS[i]!, value: rangeValueAtStep(range, i) })
  }
  return rows
}

/** Every way the preview can colour a toolpath. */
export type GcodeViewMode =
  | 'feature'
  | 'speed'
  | 'layerHeight'
  | 'lineWidth'
  | 'flow'
  | 'fanSpeed'
  | 'temperature'

/**
 * The per-segment metric a range mode reads, naming the `ParsedGcodeLayers` array it comes from.
 *
 * `null` marks the one categorical mode. Callers switch on THIS rather than on the mode name, so
 * adding a mode is a row in {@link GCODE_VIEW_MODES} rather than a new case in three files.
 */
export type GcodeViewMetric = 'feedrate' | 'layerHeight' | 'lineWidth' | 'volumetric' | 'fanSpeed' | 'temperature'

export interface GcodeViewModeInfo {
  mode: GcodeViewMode
  /** Short name for the picker, matching BambuStudio's combo (`BaseRenderer.cpp:21-56`). */
  label: string
  /** Long name with units for the legend heading (`BaseRenderer.cpp:1951-1962`). */
  legendTitle: string
  /** The per-segment metric, or null for the categorical feature view. */
  metric: GcodeViewMetric | null
  /** Decimal places the legend prints values to (`BaseRenderer.cpp:2085-2109`). */
  decimals: number
}

/**
 * The picker's contents, in BambuStudio's combo order minus the modes we have no data for.
 *
 * Deliberate divergences from Studio's list, each because the data does not exist on our side
 * rather than as a preference:
 * - `Summary` / `Filament` (its `ColorPrint`) are its multi-nozzle and per-filament views, which
 *   need the per-move tool assignment its own processor tracks; we parse emitted G-code.
 * - `Layer Time` needs a per-layer duration; ours is a feedrate estimate with no acceleration
 *   model, so the number would be confidently wrong rather than merely approximate. Note it is
 *   also the ONLY view Studio ramps logarithmically, so adding it means reintroducing a log path
 *   here -- deliberately absent today rather than carried unused, because Studio's own two log
 *   branches disagree about the zero floor (0.001 when colouring, 0.0001 when labelling) and an
 *   unreachable port of that would have shipped a swatch that disagreed with its own label.
 * - `AUX Fan Speed` is `M106 P2`, which only printers with a side fan emit.
 * - `Thermal Index` is Helio-only.
 *
 * One naming divergence that IS a preference: Studio calls the categorical view "Line Type"; every
 * surface here already says "feature" (`GCODE_FEATURE_NAMES`, the toolpath panel's rows,
 * `featureSeconds`), so renaming one control would leave the panel beneath it speaking the other
 * language.
 */
export const GCODE_VIEW_MODES: ReadonlyArray<GcodeViewModeInfo> = [
  { mode: 'feature', label: 'Feature type', legendTitle: 'Feature type', metric: null, decimals: 0 },
  { mode: 'speed', label: 'Speed', legendTitle: 'Speed (mm/s)', metric: 'feedrate', decimals: 0 },
  { mode: 'layerHeight', label: 'Layer height', legendTitle: 'Layer height (mm)', metric: 'layerHeight', decimals: 2 },
  { mode: 'lineWidth', label: 'Line width', legendTitle: 'Line width (mm)', metric: 'lineWidth', decimals: 2 },
  { mode: 'flow', label: 'Flow', legendTitle: 'Volumetric flow rate (mm³/s)', metric: 'volumetric', decimals: 2 },
  { mode: 'fanSpeed', label: 'Fan speed', legendTitle: 'Fan speed (%)', metric: 'fanSpeed', decimals: 0 },
  { mode: 'temperature', label: 'Temperature', legendTitle: 'Temperature (°C)', metric: 'temperature', decimals: 0 }
]

/** Look up a mode's metadata; unknown names fall back to the feature view. */
export function gcodeViewModeInfo(mode: GcodeViewMode): GcodeViewModeInfo {
  return GCODE_VIEW_MODES.find((entry) => entry.mode === mode) ?? GCODE_VIEW_MODES[0]!
}

/** The metric a mode reads, or null when it colours categorically. */
export function gcodeViewModeMetric(mode: GcodeViewMode): GcodeViewMetric | null {
  return gcodeViewModeInfo(mode).metric
}

/** Whether a stored preference names a mode this build still offers. */
export function isGcodeViewMode(value: unknown): value is GcodeViewMode {
  return typeof value === 'string' && GCODE_VIEW_MODES.some((entry) => entry.mode === value)
}
