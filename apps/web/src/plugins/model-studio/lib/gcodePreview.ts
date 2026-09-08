/**
 * Layered G-code parsing + rendering for the sliced-file preview (#28).
 *
 * Renders the toolpath the way Bambu Studio's preview does: every extrusion as a solid 3D
 * ribbon at its real width (`; LINE_WIDTH:`) and layer height (`; LAYER_HEIGHT:`), coloured by
 * feature type (`; FEATURE:`: outer wall, infill, ...). Bambu emits the bulk of walls as arc
 * moves (G2/G3 arc-fitting is on by default), so those are interpolated into segments, without
 * that the preview would draw only the rare straight moves and look like sparse 2D lines.
 *
 * Moves are grouped BY LAYER so the preview can scrub the print (a vertical slider sets the top
 * visible layer; a single-layer mode isolates one layer) by adjusting the geometry draw range
 * (O(1), no rebuilds). `parseGcodeLayers` is pure (no THREE) and unit-tested.
 *
 * Coordinates stay in raw G-code millimetres (printer Z-up); the caller orients the group into
 * the viewer the same way it does for `GCodeLoader` output.
 */
import * as THREE from 'three'
import { GCODE_FEATURE_NAMES, GCODE_FEATURE_ROLES } from './gcodeFeatureRoles'
// The header time line is a BambuStudio contract shared with the slicer service, which reads the
// same line to report a slice's prepare phase. One parser, so the two cannot drift.
import { parseGcodeDuration } from '@printstream/shared'
import {
  emptyValueRange,
  gcodeViewModeMetric,
  rangeColorAt,
  roundToBin,
  updateValueRange,
  GCODE_MARKER_COLORS,
  GCODE_TRAVEL_COLORS,
  GCODE_WIPE_COLOR,
  type GcodeMarkerKind,
  type GcodeValueRange,
  type GcodeViewMetric,
  type GcodeViewMode
} from './gcodeViewModes'
import { buildGcodeMarkerGeometry } from './gcodeMarkers'

/**
 * Feature-type palette mirroring BambuStudio's `Extrusion_Role_Colors`
 * (src/slic3r/GUI/GCodeRenderer/BaseRenderer.cpp), keyed by the `; FEATURE:` names it writes
 * (ExtrusionEntity::role_to_string). Index 0 is the fallback for unknown/untagged moves.
 */
export const GCODE_FEATURE_COLORS: ReadonlyArray<number> = [
  0xe6b3b3, // 0 unknown / none
  0xffe54d, // 1 Inner wall
  0xff7d38, // 2 Outer wall
  0x1f1fff, // 3 Overhang wall
  0xb03029, // 4 Sparse infill
  0x9654cc, // 5 Internal solid infill
  0xf04040, // 6 Top surface
  0x665cc7, // 7 Bottom surface
  0xff8c69, // 8 Ironing / Support ironing
  0x4d80ba, // 9 Bridge
  0xd9d9d9, // 10 Gap infill
  0x00876e, // 11 Skirt
  0x003b6e, // 12 Brim
  0x00c000, // 13 Support
  0x008000, // 14 Support interface
  0xb3e3ab, // 15 Prime tower
  0x5ed194, // 16 Custom
  0xd9a6f2  // 17 Flush
]

/**
 * Map a `; FEATURE:` name to its {@link GCODE_FEATURE_COLORS} index.
 *
 * DERIVED from the name table rather than a hand-written switch: the switch was a third structure
 * parallel to the names and the colours, so reordering one entry left it mapping a label to the
 * wrong colour with nothing to fail.
 */
function featureRoleIndex(name: string): number {
  return FEATURE_ROLE_BY_NAME.get(name.trim().toLowerCase()) ?? GCODE_FEATURE_ROLES.other
}

const FEATURE_ROLE_BY_NAME = new Map(GCODE_FEATURE_NAMES.map((label, index) => [label.toLowerCase(), index]))


/**
 * Print-time/usage stats accumulated while parsing. Move times are the feedrate-based
 * estimate `distance / F` (no acceleration model), so individual numbers run a little
 * low; the preview normalizes the per-feature PROPORTIONS against the slicer's own
 * total (gcode header / slice_info prediction) when one is available.
 */
export interface GcodeStats {
  /** Estimated seconds per feature role (index into {@link GCODE_FEATURE_NAMES}). */
  featureSeconds: number[]
  /** Estimated seconds spent on non-extruding travel moves (excluding wipes). */
  travelSeconds: number
  /**
   * Estimated seconds spent wiping (the `;WIPE_START`/`;WIPE_END` regions).
   *
   * Separate from {@link travelSeconds} because wipes render as their own toggleable path, and a
   * legend row must describe the geometry its swatch draws.
   */
  wipeSeconds: number
  /** Sum of all estimated move seconds (features + travel + wipe). */
  totalSeconds: number
  /** Slicer's own total estimate parsed from the gcode header, when present. */
  headerTotalSeconds: number | null
  /** Total extruded filament length (mm of filament E). */
  filamentMm: number
  /** Highest extrusion Z (mm): the printed height. */
  maxZ: number
}

/**
 * The whole-print extent of every metric a range view colours by (#92).
 *
 * Accumulated during the parse and never recomputed afterwards, which is BambuStudio's rule
 * (`BaseRenderer.cpp:1278` walks every move; the layer slider does not call it): a ramp that
 * rescaled per visible layer would make one bead change colour as the user scrubs.
 */
export interface GcodeValueRanges {
  /** Speed in mm/s over EXTRUSION moves only. */
  feedrate: GcodeValueRange
  /**
   * Speed in mm/s over extrusion AND travel moves.
   *
   * Two ranges rather than one because BambuStudio folds travel feedrates into the Speed ramp
   * only while travel is being displayed (`BaseRenderer.cpp:1311`, and the Travel checkbox calls
   * `refresh()` at `:2099`). Travels are much faster than extrusions, so including them
   * compresses every printing speed into the ramp's bottom third; precomputing both means the
   * toggle re-picks a range instead of re-walking the file.
   */
  feedrateWithTravel: GcodeValueRange
  /** Layer height in mm, quantised, excluding custom-G-code extrusions. */
  layerHeight: GcodeValueRange
  /** Line width in mm, quantised, excluding custom-G-code extrusions. */
  lineWidth: GcodeValueRange
  /** Volumetric flow in mm3/s, quantised, ignoring segments too short to measure. */
  volumetric: GcodeValueRange
  /** Part-cooling fan duty as a percentage. */
  fanSpeed: GcodeValueRange
  /** Nozzle temperature in Celsius. */
  temperature: GcodeValueRange
}

export interface ParsedGcodeLayers {
  /** Number of detected print layers (distinct extrusion Z heights). */
  layerCount: number
  /**
   * Each layer's extrusion Z in mm: the layer's top, matching the `top_z` a layer
   * pause or filament change is stored at (length = layerCount).
   */
  layerZ: number[]
  /** Flat extrusion vertex positions [x1,y1,z1,x2,y2,z2,...], ordered by layer. */
  extrusionPositions: Float32Array
  /** Cumulative extrusion vertex count at the END of each layer (length = layerCount). */
  extrusionLayerEnd: number[]
  /** Per-segment extrusion width in mm (length = extrusion segment count). */
  extrusionWidths: Float32Array
  /** Per-segment layer height in mm (length = extrusion segment count). */
  extrusionHeights: Float32Array
  /** Per-segment feature index into {@link GCODE_FEATURE_COLORS} (length = segment count). */
  extrusionRoles: Uint8Array
  /** Per-segment speed in mm/s (length = segment count). */
  extrusionFeedrates: Float32Array
  /** Per-segment volumetric flow in mm3/s (length = segment count). */
  extrusionVolumetric: Float32Array
  /** Per-segment part-cooling fan duty, 0-100 (length = segment count). */
  extrusionFanSpeeds: Uint8Array
  /** Per-segment nozzle temperature in Celsius (length = segment count). */
  extrusionTemperatures: Uint16Array
  /**
   * Per-segment printed-object label id, or -1 outside any object (length = segment count).
   *
   * From `; start printing object, unique label id: N` / `M625`. Bambu-flavour G-code carries only
   * the NUMBER, never the object's name, so nothing downstream can name an object from the file
   * alone. Used by the toolpath-conflict check to tell one object's paths from another's.
   */
  extrusionObjectIds: Int32Array
  /** Flat travel-move vertex positions, ordered by layer. */
  travelPositions: Float32Array
  /** Cumulative travel vertex count at the END of each layer (length = layerCount). */
  travelLayerEnd: number[]
  /** Per-travel-segment speed in mm/s (length = travel segment count). */
  travelFeedrates: Float32Array
  /**
   * Per-travel-segment {@link GcodeTravelKind}: 0 move, 1 extruding, 2 retracting
   * (length = travel segment count).
   */
  travelKinds: Uint8Array
  /** Flat wipe-move vertex positions, ordered by layer. */
  wipePositions: Float32Array
  /** Cumulative wipe vertex count at the END of each layer (length = layerCount). */
  wipeLayerEnd: number[]
  /** Point-marker positions [x,y,z,...], ordered by layer. */
  markerPositions: Float32Array
  /** Per-marker {@link GcodeMarkerKind} (length = marker count). */
  markerKinds: Uint8Array
  /**
   * Per-marker extrusion width and layer height in mm, CARRIED OVER from the last extruding move.
   *
   * A marker sits on a move that extrudes nothing, so it has no size of its own; BambuStudio
   * scales its diamond by 1.5x the processor's still-current `width`/`height`
   * (`LegacyRenderer.cpp:1230-1233`), which are only recomputed on extrusions.
   */
  markerWidths: Float32Array
  markerHeights: Float32Array
  /** Cumulative marker count at the END of each layer (length = layerCount). */
  markerLayerEnd: number[]
  /** Whole-print extent of each range-view metric. */
  ranges: GcodeValueRanges
  /** Time/usage breakdown accumulated during the parse. */
  stats: GcodeStats
}

const Z_EPSILON = 1e-3
const DEFAULT_EXTRUSION_WIDTH = 0.42 // mm; used only when the G-code has no LINE_WIDTH comments
const DEFAULT_LAYER_HEIGHT = 0.2
/** Max chord deviation (mm) when tessellating an arc into segments. */
const ARC_CHORD_TOLERANCE = 0.08
/**
 * Max chord length (mm) when tessellating an arc. Sag tolerance alone lets large-radius arcs
 * emit multi-millimetre flat chords: visible straight facets that sit out of phase layer to
 * layer because each loop's seam starts at a different angle. Capping chord length keeps the
 * silhouette round regardless of radius.
 */
const ARC_MAX_CHORD = 1.0
const MAX_ARC_SEGMENTS = 720
/** Filament diameter (mm) assumed until the header's `; filament_diameter:` line is read. */
const DEFAULT_FILAMENT_DIAMETER = 1.75
/**
 * Shortest segment (mm) whose volumetric rate is trusted for the FLOW RANGE
 * (BambuStudio's `VOLUMETRIC_RATE_MIN_SEGMENT_LEN`, `BaseRenderer.cpp:96`).
 *
 * Flow is reverse-computed as `filamentArea * dE/dL` from G-code that prints X/Y to 3 decimals,
 * so the relative error grows as the segment shortens. Below this the value is noise, and one
 * noisy sample would set the legend's maximum for the whole plate. The per-segment value is still
 * stored and coloured (as Studio stores it), it just does not get to define the range.
 */
const VOLUMETRIC_RATE_MIN_SEGMENT_LEN = 0.05
/**
 * Feature role for custom G-code, excluded from the layer-height and line-width ranges.
 *
 * Mirrors BambuStudio's `erCustom` exclusion (`BaseRenderer.cpp:1289-1292`): start/end G-code
 * extrudes at wild widths and heights (priming lines, purge), and letting those define the range
 * pushes every real printing value into one stop of the ramp.
 */
const CUSTOM_FEATURE_ROLE = GCODE_FEATURE_ROLES.custom
/** `erExternalPerimeter` / `erOverhangPerimeter`: the roles a seam run is detected across. */
const OUTER_WALL_ROLE = GCODE_FEATURE_ROLES.outerWall
const OVERHANG_WALL_ROLE = GCODE_FEATURE_ROLES.overhangWall
/**
 * How close (squared mm) an outer-wall run's two ends must be to count as a closed loop, and so
 * to earn a seam marker. BambuStudio's own value, and its own comment calls it arbitrary
 * ("the threshold value = 0.0625f == 0.25 * 0.25 is arbitrary", `GCodeProcessor.cpp:4393`).
 */
const SEAM_CLOSE_DISTANCE_SQUARED = 0.0625
/**
 * Width and height (mm) BambuStudio forces onto every wipe move (`GCodeProcessor.cpp:86-87`),
 * plus the half-height lift its renderers apply so a wipe floats above the bead it retraces
 * instead of z-fighting it (`LegacyRenderer.cpp:1465`).
 */
const WIPE_LINE_SIZE = 0.05

/**
 * The numeric words of an already-split G-code line, keyed by their letter.
 *
 * Only for the low-frequency commands (fan, temperature): the move path stays hand-rolled because
 * it runs for every one of a plate's hundreds of thousands of moves. Letters with no number
 * (Bambu's `M104 S140 A`) are dropped rather than recorded as NaN.
 */
function readWords(tokens: string[]): Record<string, number> {
  const words: Record<string, number> = {}
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    const axis = token[0]?.toUpperCase()
    if (!axis) continue
    const value = Number.parseFloat(token.slice(1))
    if (!Number.isNaN(value)) words[axis] = value
  }
  return words
}

/**
 * Parse G-code into per-layer extrusion/travel segments with per-segment width, layer height and
 * feature role. A new layer starts whenever an extruding move occurs at a Z that differs from the
 * current layer's Z (so travel z-hops never create phantom layers, independent of slicer-specific
 * layer comments). Handles G0/G1 linear moves, G2/G3 arc moves (I/J centre form, interpolated),
 * absolute/relative positioning (G90/G91), absolute/relative extrusion (M82/M83), G92 axis resets,
 * and BambuStudio's `; FEATURE:` / `; LINE_WIDTH:` / `; LAYER_HEIGHT:` annotations.
 */
export function parseGcodeLayers(text: string): ParsedGcodeLayers {
  let x = 0
  let y = 0
  let z = 0
  let e = 0
  let absolutePositions = true
  let absoluteExtrusion = true
  let layer = -1
  let currentLayerZ: number | null = null
  // Latest annotated extrusion attributes (BambuStudio writes them just before the moves they cover).
  let curWidth = 0
  let curHeight = 0
  let curRole = 0
  let sawWidth = false
  let sawHeight = false
  // Time/usage accumulation: current feedrate (mm/min, modal) + per-role tallies.
  let feedrate = 0
  const featureSeconds = new Array<number>(GCODE_FEATURE_COLORS.length).fill(0)
  let travelSeconds = 0
  let wipeSeconds = 0
  let filamentMm = 0
  let maxZ = 0
  let headerTotalSeconds: number | null = null
  // Machine state the range views colour by. Modal like the feedrate: an M106/M104 holds until
  // the next one, so every segment emitted between them carries the same value.
  let fanPercent = 0
  let nozzleTemperature = 0
  let filamentArea = Math.PI * (DEFAULT_FILAMENT_DIAMETER / 2) ** 2
  // Per-MOVE derivatives, set before the emit loop so an arc's sub-segments all inherit them
  // (equal sub-chords, so the move's rate is each sub-segment's rate).
  let curFeedrateMmS = 0
  let curMm3PerMm = 0
  const ranges: GcodeValueRanges = {
    feedrate: emptyValueRange(),
    feedrateWithTravel: emptyValueRange(),
    layerHeight: emptyValueRange(),
    lineWidth: emptyValueRange(),
    volumetric: emptyValueRange(),
    fanSpeed: emptyValueRange(),
    temperature: emptyValueRange()
  }

  const extrusionLayers: number[][] = []
  const layerZ: number[] = []
  const widthLayers: number[][] = []
  const heightLayers: number[][] = []
  const roleLayers: number[][] = []
  const feedrateLayers: number[][] = []
  const volumetricLayers: number[][] = []
  const fanLayers: number[][] = []
  const temperatureLayers: number[][] = []
  const travelLayers: number[][] = []
  const travelFeedrateLayers: number[][] = []
  const travelKindLayers: number[][] = []
  const wipeLayers: number[][] = []
  const markerLayers: number[][] = []
  const markerKindLayers: number[][] = []
  const markerWidthLayers: number[][] = []
  const markerHeightLayers: number[][] = []
  // Wipe is a comment-delimited REGION, not a property of a move: between `;WIPE_START` and
  // `;WIPE_END` every move is a wipe whatever its E sign or XY motion, because BambuStudio tests
  // `m_wiping` first in its move classifier (`GCodeProcessor.cpp:4050`).
  let wiping = false
  // Seam detection state, porting `SeamsDetector` (`GCodeProcessor.hpp:1002-1021`). A seam is not
  // annotated anywhere in the G-code: it is derived from an outer-wall run that closes on itself.
  let seamFirstVertex: { x: number; y: number; z: number } | null = null
  /** The printed object currently being emitted, or -1 between objects. */
  let currentObjectId = -1
  const objectIdLayers: number[][] = []

  const ensureLayer = (index: number) => {
    while (extrusionLayers.length <= index) {
      extrusionLayers.push([]); widthLayers.push([]); heightLayers.push([]); roleLayers.push([])
      feedrateLayers.push([]); volumetricLayers.push([]); fanLayers.push([]); temperatureLayers.push([])
      objectIdLayers.push([])
    }
    while (travelLayers.length <= index) {
      travelLayers.push([]); travelFeedrateLayers.push([]); travelKindLayers.push([])
      wipeLayers.push([]); markerLayers.push([]); markerKindLayers.push([])
      markerWidthLayers.push([]); markerHeightLayers.push([])
    }
  }

  // Advance to a new layer when an extruding MOVE's target Z changes: called ONCE per move
  // (not per interpolated arc sub-segment), so a Z-changing arc is one layer, not hundreds.
  const advanceLayerForZ = (targetZ: number) => {
    if (currentLayerZ === null || Math.abs(targetZ - currentLayerZ) > Z_EPSILON) {
      layer += 1
      currentLayerZ = targetZ
      layerZ[layer] = targetZ
    }
  }

  /** Record one extrusion segment on the current layer, tagged with the active attributes. */
  const emitExtrusion = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    if (layer < 0) advanceLayerForZ(bz) // safety: first extrusion before any layer was opened
    ensureLayer(layer)
    const width = curWidth > 0 ? curWidth : DEFAULT_EXTRUSION_WIDTH
    const height = curHeight > 0 ? curHeight : 0
    extrusionLayers[layer]!.push(ax, ay, az, bx, by, bz)
    widthLayers[layer]!.push(width)
    heightLayers[layer]!.push(height)
    roleLayers[layer]!.push(curRole)
    objectIdLayers[layer]!.push(currentObjectId)
    const volumetric = curFeedrateMmS * curMm3PerMm
    feedrateLayers[layer]!.push(curFeedrateMmS)
    volumetricLayers[layer]!.push(volumetric)
    fanLayers[layer]!.push(fanPercent)
    temperatureLayers[layer]!.push(nozzleTemperature)

    // Ranges are accumulated HERE rather than per G-code move so an arc contributes the same
    // samples its sub-segments render with, which is also what BambuStudio's processor does
    // (it emits one MoveVertex per interpolated arc point).
    // Layer height is deliberately NOT accumulated here: an unannotated segment is 0 at this
    // point and only gets its real value from the backfill below, so the range is taken over the
    // FINAL heights once that has run. Width has no such second pass (it defaults at emit).
    if (curRole !== CUSTOM_FEATURE_ROLE) updateValueRange(ranges.lineWidth, roundToBin(width))
    if (curFeedrateMmS > 0) {
      updateValueRange(ranges.feedrate, curFeedrateMmS)
      updateValueRange(ranges.feedrateWithTravel, curFeedrateMmS)
    }
    updateValueRange(ranges.fanSpeed, fanPercent)
    if (nozzleTemperature > 0) updateValueRange(ranges.temperature, nozzleTemperature)
    if (volumetric > 0 && Math.hypot(bx - ax, by - ay, bz - az) >= VOLUMETRIC_RATE_MIN_SEGMENT_LEN) {
      updateValueRange(ranges.volumetric, roundToBin(volumetric))
    }
  }

  const emitTravel = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, kind: number) => {
    if (layer < 0) return
    ensureLayer(layer)
    travelLayers[layer]!.push(ax, ay, az, bx, by, bz)
    travelFeedrateLayers[layer]!.push(curFeedrateMmS)
    travelKindLayers[layer]!.push(kind)
    // Travel speeds join the Speed ramp only in the range that includes them: see
    // `GcodeValueRanges.feedrateWithTravel` for why both are kept.
    if (curFeedrateMmS > 0) updateValueRange(ranges.feedrateWithTravel, curFeedrateMmS)
  }

  const emitWipe = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    if (layer < 0) return
    ensureLayer(layer)
    wipeLayers[layer]!.push(ax, ay, az, bx, by, bz)
  }

  /** Record a point marker at the head's current position, sized by the last extrusion. */
  const emitMarker = (px: number, py: number, pz: number, kind: number) => {
    if (layer < 0) return
    ensureLayer(layer)
    markerLayers[layer]!.push(px, py, pz)
    markerKindLayers[layer]!.push(kind)
    markerWidthLayers[layer]!.push(curWidth > 0 ? curWidth : DEFAULT_EXTRUSION_WIDTH)
    markerHeightLayers[layer]!.push(curHeight > 0 ? curHeight : DEFAULT_LAYER_HEIGHT)
  }

  for (const rawLine of text.split('\n')) {
    const semi = rawLine.indexOf(';')
    if (semi >= 0) {
      const comment = rawLine.slice(semi + 1)
      const feature = /^\s*FEATURE:\s*(.+?)\s*$/i.exec(comment)
      if (feature) curRole = featureRoleIndex(feature[1]!)
      // Bambu emits these unspaced (`;WIPE_START`), but the reserved tag it matches carries a
      // leading space, so accept either rather than depending on the writer's spacing.
      if (/^\s*WIPE_START\b/i.test(comment)) wiping = true
      else if (/^\s*WIPE_END\b/i.test(comment)) wiping = false
      // Which printed object the following moves belong to. Bambu writes the id in a comment and
      // then repeats it base64-encoded on `M624`; the comment is the readable one. `M625` closes
      // the block (handled with the commands below), and the bare `; stop printing object` line
      // it also writes carries no id, so it cannot be relied on to close the right one.
      const objectStart = /^\s*start printing object, unique label id:\s*(-?\d+)/i.exec(comment)
      if (objectStart) currentObjectId = Number.parseInt(objectStart[1]!, 10)
      const width = /^\s*LINE_WIDTH:\s*([0-9.]+)/i.exec(comment)
      if (width) { curWidth = Number.parseFloat(width[1]!); sawWidth = true }
      const height = /^\s*LAYER_HEIGHT:\s*([0-9.]+)/i.exec(comment)
      if (height) { curHeight = Number.parseFloat(height[1]!); sawHeight = true }
      // The slicer's own total ("; total estimated time: 1h 2m 3s" / "; estimated
      // printing time (normal mode) = ..."): authoritative when present. Bambu puts
      // it mid-comment after the model time, so the match is not anchored.
      if (headerTotalSeconds === null) {
        const total = /(?:total estimated time|estimated printing time(?:\s*\([^)]*\))?)\s*[:=]\s*([0-9dhms\s]+)/i.exec(comment)
        if (total) headerTotalSeconds = parseGcodeDuration(total[1]!)
      }
      // Volumetric flow is reverse-computed as filamentArea * dE/dL, so it needs the filament's
      // cross-section. Bambu writes `; filament_diameter: 1.75,1.75` in the HEADER (one entry per
      // slot), ahead of every move, so a streaming parse can still use it; the slots are in
      // practice always equal, and a per-slot area would need the tool assignment we do not track.
      const diameter = /^\s*filament_diameter\s*[:=]\s*([0-9.]+)/i.exec(comment)
      if (diameter) {
        const value = Number.parseFloat(diameter[1]!)
        if (value > 0) filamentArea = Math.PI * (value / 2) ** 2
      }
    }
    const line = (semi >= 0 ? rawLine.slice(0, semi) : rawLine).trim()
    if (!line) continue
    const tokens = line.split(/\s+/)
    const command = tokens[0]!.toUpperCase()

    if (command === 'G90') { absolutePositions = true; continue }
    if (command === 'G91') { absolutePositions = false; continue }
    if (command === 'M82') { absoluteExtrusion = true; continue }
    if (command === 'M83') { absoluteExtrusion = false; continue }
    if (command === 'M625') { currentObjectId = -1; continue }
    // Fan and temperature are modal machine state, tracked so the Fan speed and Temperature
    // views have something per segment to colour by. Only the PART-COOLING fan counts: Bambu
    // addresses it as `M106` or `M106 P1`, while P2 is the auxiliary/side fan and P3 the chamber
    // fan, which is BambuStudio's own split (`MoveVertex::fan_speed` vs `additional_fan_speed`).
    // Reading every M106 into one number made a chamber fan look like part cooling.
    if (command === 'M106' || command === 'M107') {
      const words = readWords(tokens)
      const port = words.P
      if (port === undefined || port === 1) {
        // Duty is 0-255 on the wire and a percentage everywhere a user sees it.
        fanPercent = command === 'M107' ? 0 : Math.round(Math.min(255, Math.max(0, words.S ?? 0)) / 2.55)
      }
      continue
    }
    if (command === 'M104' || command === 'M109') {
      // Bambu writes bare `M104 S140`, and also `M104 S140 A` / `M104 S220 T1` for the second
      // toolhead. We track one nozzle: the tool a segment belongs to is not something this parser
      // follows, and a per-tool temperature would be attributed to the wrong moves.
      const words = readWords(tokens)
      if (words.S !== undefined && words.S > 0) nozzleTemperature = Math.round(words.S)
      continue
    }
    if (command === 'G92') {
      for (const token of tokens.slice(1)) {
        const axis = token[0]?.toUpperCase()
        const value = Number.parseFloat(token.slice(1))
        if (Number.isNaN(value)) continue
        if (axis === 'X') x = value
        else if (axis === 'Y') y = value
        else if (axis === 'Z') z = value
        else if (axis === 'E') e = value
      }
      continue
    }

    const isArc = command === 'G2' || command === 'G3'
    if (command !== 'G0' && command !== 'G1' && !isArc) continue

    const prevX = x, prevY = y, prevZ = z
    let deltaE = 0
    let movesXY = false
    let iOff = 0, jOff = 0
    for (const token of tokens.slice(1)) {
      const axis = token[0]?.toUpperCase()
      const value = Number.parseFloat(token.slice(1))
      if (Number.isNaN(value)) continue
      if (axis === 'X') { x = absolutePositions ? value : x + value; movesXY = true }
      else if (axis === 'Y') { y = absolutePositions ? value : y + value; movesXY = true }
      else if (axis === 'Z') { z = absolutePositions ? value : z + value }
      else if (axis === 'I') iOff = value
      else if (axis === 'J') jOff = value
      else if (axis === 'F') { if (value > 0) feedrate = value }
      else if (axis === 'E') {
        const next = absoluteExtrusion ? value : e + value
        deltaE = next - e
        e = next
      }
    }
    const extruding = deltaE > 1e-6 && movesXY && !wiping

    // BambuStudio's move classifier (`GCodeProcessor.cpp:4047-4064`), which decides both what is
    // DRAWN and what earns a point marker. Wipe wins over everything, then the sign of E:
    // a negative-E move that also moves is a travel, one that does not is a Retract; a positive-E
    // move with no XY is an Unretract only if Z is also still (a Z-hop makes it a travel).
    const movesZ = prevZ !== z
    const isRetract = !wiping && deltaE < -1e-6 && !movesXY && !movesZ
    const isUnretract = !wiping && deltaE > 1e-6 && !movesXY && !movesZ

    // Seam detection, ported from `GCodeProcessor.cpp:4365-4407`. Note `prevX/prevY/prevZ` is
    // this move's START, which is exactly what Studio reads as `m_result.moves.back().position`
    // (the previous stored move's end) -- using this move's own endpoint instead puts every seam
    // one segment along the wall.
    const isOuterWall = extruding && curRole === OUTER_WALL_ROLE
    const continuesWall = extruding && (curRole === OUTER_WALL_ROLE || curRole === OVERHANG_WALL_ROLE)
    // The first vertex IS the state. Studio keeps `activate()` and `set_first_vertex()` separable
    // and so needs a flag as well, but this port arms and anchors in the same statement and clears
    // both together, so a second variable could only ever agree with this one, and the branch that
    // anchored an already-active run was unreachable.
    if (seamFirstVertex) {
      if (!continuesWall) {
        const dx = prevX - seamFirstVertex.x, dy = prevY - seamFirstVertex.y, dz = prevZ - seamFirstVertex.z
        // Studio's own arbitrary threshold: the run's ends within 0.25mm means it closed a loop.
        if (dx * dx + dy * dy + dz * dz < SEAM_CLOSE_DISTANCE_SQUARED) {
          emitMarker(0.5 * (prevX + seamFirstVertex.x), 0.5 * (prevY + seamFirstVertex.y), 0.5 * (prevZ + seamFirstVertex.z), 2)
        }
        seamFirstVertex = null
      }
    } else if (isOuterWall) {
      seamFirstVertex = { x: prevX, y: prevY, z: prevZ }
    }

    if (isRetract) { emitMarker(x, y, z, 0); continue }
    if (isUnretract) { emitMarker(x, y, z, 1); continue }
    if (!movesXY && !movesZ) continue
    // Stats: feedrate-based move time + per-feature filament usage. Arc length uses the
    // true sweep (computed below for rendering too, but cheap to redo here for clarity).
    let distance = Math.hypot(x - prevX, y - prevY, z - prevZ)
    {
      if (isArc && (iOff !== 0 || jOff !== 0)) {
        const cx = prevX + iOff, cy = prevY + jOff
        const radius = Math.hypot(prevX - cx, prevY - cy)
        if (radius > 1e-4) {
          let sweep = Math.atan2(y - cy, x - cx) - Math.atan2(prevY - cy, prevX - cx)
          if (command === 'G2' && sweep >= 0) sweep -= 2 * Math.PI
          if (command === 'G3' && sweep <= 0) sweep += 2 * Math.PI
          distance = Math.abs(sweep) * radius
        }
      }
      if (feedrate > 0 && distance > 0) {
        const seconds = distance / (feedrate / 60)
        // Wipe time is tallied apart from travel, because the legend's Travel row has to describe
        // the travel the legend's Travel swatch actually draws, and wipes are now their own bucket.
        if (extruding) featureSeconds[curRole] = (featureSeconds[curRole] ?? 0) + seconds
        else if (wiping) wipeSeconds += seconds
        else travelSeconds += seconds
      }
      if (extruding) {
        filamentMm += deltaE
        if (z > maxZ) maxZ = z
      }
    }
    // Per-move derivatives the emitters stamp onto every segment they produce. Flow mirrors
    // BambuStudio's `MoveVertex::volumetric_rate() = feedrate * mm3_per_mm`
    // (`GCodeProcessor.hpp:231`), with `mm3_per_mm` reverse-computed from the G-code the same way
    // its processor does: filament cross-section times filament consumed per mm travelled.
    // An arc's sub-chords are equal length, so the whole move's rate IS each sub-segment's rate.
    curFeedrateMmS = feedrate / 60
    curMm3PerMm = distance > 0 && deltaE > 0 ? (deltaE / distance) * filamentArea : 0
    // Which of the three travel colours this move takes, from the SIGN of its E delta
    // (`LegacyRenderer.cpp:1788-1792`). Exactly zero is a plain move. The Retract colour is
    // reachable only on a NON-wiping travel that also retracts: a pure retract has no XY motion so
    // never becomes a drawn segment, and a wipe is routed to `emitWipe` below, which paints one
    // flat colour and takes no kind at all.
    const travelKind = deltaE < 0 ? 2 : deltaE > 0 ? 1 : 0
    if (isArc && (iOff !== 0 || jOff !== 0)) {
      // Interpolate the arc about its centre (cx,cy) = start + (I,J). Z lerps across the sweep.
      const cx = prevX + iOff, cy = prevY + jOff
      const radius = Math.hypot(prevX - cx, prevY - cy)
      if (radius > 1e-4) {
        const a0 = Math.atan2(prevY - cy, prevX - cx)
        let sweep = Math.atan2(y - cy, x - cx) - a0
        const clockwise = command === 'G2'
        if (clockwise && sweep >= 0) sweep -= 2 * Math.PI
        if (!clockwise && sweep <= 0) sweep += 2 * Math.PI
        const dThetaSag = 2 * Math.acos(Math.max(-1, 1 - ARC_CHORD_TOLERANCE / radius))
        const dThetaMax = Math.min(dThetaSag, ARC_MAX_CHORD / radius)
        const steps = Math.min(MAX_ARC_SEGMENTS, Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(dThetaMax, 1e-3))))
        if (extruding) advanceLayerForZ(z) // one layer for the whole arc, keyed off its target Z
        let px = prevX, py = prevY, pz = prevZ
        for (let k = 1; k <= steps; k++) {
          const t = k / steps
          const ang = a0 + sweep * t
          const nx = cx + radius * Math.cos(ang)
          const ny = cy + radius * Math.sin(ang)
          const nz = prevZ + (z - prevZ) * t
          if (extruding) emitExtrusion(px, py, pz, nx, ny, nz)
          else if (wiping) emitWipe(px, py, pz, nx, ny, nz)
          else emitTravel(px, py, pz, nx, ny, nz, travelKind)
          px = nx; py = ny; pz = nz
        }
        continue
      }
    }

    if (extruding) { advanceLayerForZ(z); emitExtrusion(prevX, prevY, prevZ, x, y, z) }
    else if (wiping) emitWipe(prevX, prevY, prevZ, x, y, z)
    else if (movesXY) emitTravel(prevX, prevY, prevZ, x, y, z, travelKind)
  }

  const layerCount = extrusionLayers.length
  const flattenPositions = (layers: number[][]): { positions: Float32Array; layerEnd: number[] } => {
    const layerEnd: number[] = []
    let total = 0
    for (const layerPositions of layers) { total += layerPositions.length / 3; layerEnd.push(total) }
    const positions = new Float32Array(total * 3)
    let offset = 0
    for (const layerPositions of layers) { positions.set(layerPositions, offset); offset += layerPositions.length }
    return { positions, layerEnd }
  }
  const flattenScalar = <T extends Float32Array | Uint8Array | Uint16Array | Int32Array>(
    layers: number[][],
    TypedArray: { new (length: number): T }
  ): T => {
    let total = 0
    for (const l of layers) total += l.length
    const out = new TypedArray(total)
    let offset = 0
    for (const l of layers) { out.set(l, offset); offset += l.length }
    return out
  }

  const extrusion = flattenPositions(extrusionLayers)
  const travel = flattenPositions(travelLayers)
  const wipe = flattenPositions(wipeLayers)
  // Markers are single POINTS (3 floats each), not segments, so their per-layer ends count
  // markers rather than vertices; `flattenPositions` counts in vertices and suits both.
  const markers = flattenPositions(markerLayers)
  const heights = flattenScalar(heightLayers, Float32Array)
  // Fill in any unannotated layer heights from the Z spacing between layers (older/non-Bambu G-code).
  if (!sawHeight) {
    const estimated = estimateLayerHeight(extrusion.positions, extrusion.layerEnd) || DEFAULT_LAYER_HEIGHT
    for (let i = 0; i < heights.length; i++) if (heights[i] === 0) heights[i] = estimated
  } else {
    for (let i = 0; i < heights.length; i++) if (heights[i] === 0) heights[i] = DEFAULT_LAYER_HEIGHT
  }
  void sawWidth

  const roles = flattenScalar(roleLayers, Uint8Array)
  // Layer-height range over the FINAL heights, so G-code with no `; LAYER_HEIGHT:` annotations
  // still colours (it would otherwise range over the zeros the backfill has just replaced).
  for (let i = 0; i < heights.length; i++) {
    if (roles[i] !== CUSTOM_FEATURE_ROLE && heights[i]! > 0) {
      updateValueRange(ranges.layerHeight, roundToBin(heights[i]!))
    }
  }

  // ensureLayer can open a layer the Z tracker never stamped (safety path); backfill
  // holes from the previous layer so the readout never shows undefined.
  for (let i = 0; i < layerCount; i++) if (layerZ[i] === undefined) layerZ[i] = layerZ[i - 1] ?? 0

  return {
    layerCount,
    layerZ: layerZ.slice(0, layerCount),
    extrusionPositions: extrusion.positions,
    extrusionLayerEnd: extrusion.layerEnd,
    extrusionWidths: flattenScalar(widthLayers, Float32Array),
    extrusionHeights: heights,
    extrusionRoles: roles,
    extrusionFeedrates: flattenScalar(feedrateLayers, Float32Array),
    extrusionVolumetric: flattenScalar(volumetricLayers, Float32Array),
    extrusionFanSpeeds: flattenScalar(fanLayers, Uint8Array),
    extrusionTemperatures: flattenScalar(temperatureLayers, Uint16Array),
    extrusionObjectIds: flattenScalar(objectIdLayers, Int32Array),
    travelPositions: travel.positions,
    travelLayerEnd: travel.layerEnd,
    travelFeedrates: flattenScalar(travelFeedrateLayers, Float32Array),
    travelKinds: flattenScalar(travelKindLayers, Uint8Array),
    wipePositions: wipe.positions,
    wipeLayerEnd: wipe.layerEnd,
    markerPositions: markers.positions,
    markerKinds: flattenScalar(markerKindLayers, Uint8Array),
    markerWidths: flattenScalar(markerWidthLayers, Float32Array),
    markerHeights: flattenScalar(markerHeightLayers, Float32Array),
    markerLayerEnd: markers.layerEnd,
    ranges,
    stats: {
      featureSeconds,
      travelSeconds,
      wipeSeconds,
      totalSeconds: featureSeconds.reduce((sum, value) => sum + value, 0) + travelSeconds + wipeSeconds,
      headerTotalSeconds,
      filamentMm,
      maxZ
    }
  }
}

/** Median of the positive entries of a bounded sample, with a fallback for empty input. */
function medianPositive(values: Float32Array, fallback: number): number {
  if (values.length === 0) return fallback
  const stride = Math.max(1, Math.floor(values.length / 1024))
  const sample: number[] = []
  for (let i = 0; i < values.length; i += stride) {
    if (values[i]! > 0) sample.push(values[i]!)
  }
  if (sample.length === 0) return fallback
  sample.sort((a, b) => a - b)
  return sample[Math.floor(sample.length / 2)]!
}

/**
 * Representative layer pitch (mm) for the moire fade: the median of a bounded sample of the
 * per-segment layer heights, robust to a few adaptive-height outliers. Exported for tests.
 */
export function representativeLayerHeight(heights: Float32Array): number {
  return medianPositive(heights, DEFAULT_LAYER_HEIGHT)
}

/**
 * Anti-moire shading for zoomed-out views: the shading analogue of mipmapping. Bead shading
 * repeats at two pitches: vertically every layer (~0.2 mm) on walls, and in-plane every bead
 * width (~0.4 mm) on flat surfaces (top/bottom skins, infill). Once a screen pixel spans about
 * one repeat, the bright-top/dark-side alternation under-samples into interference bands. Each
 * vertex carries `aMacroUp` (0 = wall-ish role, 1 = flat-ish role) selecting which repetition
 * drives the fade and which macro normal to converge on: walls flatten toward their horizontal
 * component, flat surfaces toward vertical (sign-matched so undersides shade correctly). Close
 * ups keep full bead detail in both cases. Assumes a Z-up world, which is how the preview
 * mounts the G-code group (no rotation).
 */
function applyMoireFade(material: THREE.MeshStandardMaterial, layerPitch: number, beadWidth: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLayerPitch = { value: Math.max(layerPitch, 1e-3) }
    shader.uniforms.uBeadWidth = { value: Math.max(beadWidth, 1e-3) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMacroUp;\nvarying float vMacroUp;\nvarying vec3 vBeadWorld;')
      .replace('#include <project_vertex>', 'vBeadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvMacroUp = aMacroUp;\n#include <project_vertex>')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vMacroUp;\nvarying vec3 vBeadWorld;\nuniform float uLayerPitch;\nuniform float uBeadWidth;')
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          float layersPerPixel = fwidth(vBeadWorld.z) / uLayerPitch;
          float beadsPerPixel = length(vec2(fwidth(vBeadWorld.x), fwidth(vBeadWorld.y))) / uBeadWidth;
          float repeatsPerPixel = mix(layersPerPixel, beadsPerPixel, vMacroUp);
          float moireFade = smoothstep(0.5, 1.5, repeatsPerPixel);
          if (moireFade > 0.0) {
            vec3 upView = normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
            float upDot = dot(normal, upView);
            vec3 wallMacro = normal - upDot * upView;
            wallMacro /= max(length(wallMacro), 1e-4);
            vec3 flatMacro = upView * (upDot >= 0.0 ? 1.0 : -1.0);
            vec3 macroNormal = normalize(mix(wallMacro, flatMacro, vMacroUp));
            normal = normalize(mix(normal, macroNormal, moireFade));
          }
        }`)
  }
}

/** Estimate layer height from the Z of consecutive layers' first extrusion vertex. */
function estimateLayerHeight(positions: Float32Array, layerEnd: number[]): number {
  for (let layer = 1; layer < layerEnd.length; layer++) {
    const prevStart = (layer > 1 ? layerEnd[layer - 2]! : 0) * 3
    const thisStart = layerEnd[layer - 1]! * 3
    const delta = (positions[thisStart + 2] ?? 0) - (positions[prevStart + 2] ?? 0)
    if (delta > 0.01 && delta < 2) return delta
  }
  return DEFAULT_LAYER_HEIGHT
}

/**
 * Which point/path markers the legend has switched on.
 *
 * All default to false: this preview shipped without markers, so turning one on by default would
 * change what every existing user sees. (BambuStudio defaults Seam on, `LegacyRenderer.cpp:270`.)
 */
export interface GcodeMarkerVisibility {
  retract?: boolean
  unretract?: boolean
  seam?: boolean
  wipe?: boolean
}

export interface LayeredGcodePreview {
  /** Group holding the extrusion mesh + travel line segments (raw G-code mm, Z-up). */
  object: THREE.Group
  layerCount: number
  /**
   * Show the print up to `topLayer` (0-based, inclusive). With `single`, show only that
   * layer. `moveEnd` truncates the topmost visible layer after its first N extrusion moves
   * (1-based; omitted/clamped = the whole layer) for Bambu-style within-layer scrubbing.
   * Travel moves are only shown for the topmost visible layer (Bambu-style). O(1): only
   * adjusts geometry draw ranges.
   */
  setVisibleLayers: (
    topLayer: number,
    options?: { single?: boolean; showTravel?: boolean; moveEnd?: number; markers?: GcodeMarkerVisibility }
  ) => void
  /**
   * Recolour every bead (and every travel line) for a colour scheme.
   *
   * Repaints the kept colour attributes in place and flags them for re-upload; the geometry is
   * untouched, so this costs one pass over the segments rather than a rebuild. `showTravel`
   * selects which Speed range applies (see `GcodeValueRanges.feedrateWithTravel`), so callers
   * must pass the same value they pass to {@link setVisibleLayers}.
   */
  setViewMode: (mode: GcodeViewMode, options?: { showTravel?: boolean }) => void
  /** Number of scrubbable extrusion moves rendered on a layer (drives the move slider). */
  moveCount: (layer: number) => number
  /** The layer's print Z in mm (its top): what a layer pause or filament change keys on. */
  layerZ: (layer: number) => number
  dispose: () => void
}

/**
 * Feature roles whose beads form vertical surfaces (walls, skirt loops, prime tower sides).
 * Their moire fade targets the layer stacking (vertical repetition -> horizontal macro normal);
 * every other role lies flat (top/bottom surfaces, infill, brim, support) and fades against the
 * in-plane bead repetition toward an upright macro normal. Untagged G-code (role 0) is treated
 * as wall since walls dominate the silhouette.
 */
const WALL_ROLES = new Set([0, 1, 2, 3, 11, 15])

/**
 * Bead cross-section swept along each move: a closed rounded profile (flat bottom on the
 * layer below, bevelled/rounded top) defined once as perp offset `u` in [-1,1] x halfWidth,
 * height `v` in [0,1] x layerHeight, plus the outward normal of a matching ellipse. Normals
 * are explicit and SMOOTH: ring vertices shared between welded sections carry the mitered
 * direction, so a curved wall shades continuously like a cylinder instead of showing one
 * facet per G-code segment.
 */
const PROFILE: ReadonlyArray<readonly [u: number, v: number, nu: number, nv: number]> = [
  [-1.0, 0.0, -0.447, -0.894], [1.0, 0.0, 0.447, -0.894], // flat bottom on the layer below
  [0.88, 0.55, 0.975, 0.222], [0.45, 1.0, 0.22, 0.975],   // right wall + right top slope
  [-0.45, 1.0, -0.22, 0.975], [-0.88, 0.55, -0.975, 0.222] // left top slope + left wall
]

/**
 * sRGB byte -> linear byte, one entry per input value.
 *
 * Vertex colours bypass three's sRGB conversion, so the palette has to be linearized by hand.
 * A range view picks a fresh interpolated colour per segment, and doing that through
 * `new THREE.Color(...).convertSRGBToLinear()` would allocate once per segment (460k on a real
 * plate) inside a repaint the user is waiting on. Same transfer function as three's
 * `SRGBToLinear`, so the feature palette's bytes are unchanged from when it did use that.
 */
const SRGB_TO_LINEAR_BYTE = (() => {
  const table = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    const linear = c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4)
    table[i] = Math.round(linear * 255)
  }
  return table
})()

/** Linear-space 0-255 RGB per feature colour (vertex colours bypass sRGB conversion). */
function buildRoleRGB(): ReadonlyArray<readonly [number, number, number]> {
  return GCODE_FEATURE_COLORS.map((hex) => linearRGB(hex))
}

/** One sRGB hex as a linear 0-255 triple. */
function linearRGB(hex: number): readonly [number, number, number] {
  return [
    SRGB_TO_LINEAR_BYTE[(hex >> 16) & 0xff]!,
    SRGB_TO_LINEAR_BYTE[(hex >> 8) & 0xff]!,
    SRGB_TO_LINEAR_BYTE[hex & 0xff]!
  ] as const
}

/**
 * The per-segment source array a range view reads, or null for the categorical feature view.
 *
 * One switch, so adding a metric to `GcodeViewMetric` is a case here and a row in
 * `GCODE_VIEW_MODES` rather than a branch in the repaint, the legend and the range lookup.
 */
/**
 * Just the per-segment arrays a colour repaint reads, and nothing else.
 *
 * A named subset rather than `ParsedGcodeLayers` so the preview's long-lived closures CANNOT
 * capture the position arrays by accident: the type is what enforces the memory contract, since
 * holding the whole parse type-checks perfectly and only shows up as a leak on a real plate.
 */
export interface GcodeMetricSource {
  extrusionRoles: Uint8Array
  extrusionWidths: Float32Array
  extrusionHeights: Float32Array
  extrusionFeedrates: Float32Array
  extrusionVolumetric: Float32Array
  extrusionFanSpeeds: Uint8Array
  extrusionTemperatures: Uint16Array
  travelFeedrates: Float32Array
  travelKinds: Uint8Array
  ranges: GcodeValueRanges
}

function metricValues(parsed: GcodeMetricSource, metric: GcodeViewMetric): ArrayLike<number> {
  switch (metric) {
    case 'feedrate': return parsed.extrusionFeedrates
    case 'layerHeight': return parsed.extrusionHeights
    case 'lineWidth': return parsed.extrusionWidths
    case 'volumetric': return parsed.extrusionVolumetric
    case 'fanSpeed': return parsed.extrusionFanSpeeds
    case 'temperature': return parsed.extrusionTemperatures
  }
}

/**
 * The whole-print range a metric is coloured against.
 *
 * Speed is the one metric with two ranges: which one applies depends on whether travel moves are
 * on screen, because BambuStudio folds travel feedrates into the ramp only while they are shown
 * (`BaseRenderer.cpp:1311`, and its Travel checkbox calls `refresh()` at `:2099`).
 */
export function gcodeMetricRange(
  ranges: GcodeValueRanges,
  metric: GcodeViewMetric,
  showTravel: boolean
): GcodeValueRange {
  switch (metric) {
    case 'feedrate': return showTravel ? ranges.feedrateWithTravel : ranges.feedrate
    case 'layerHeight': return ranges.layerHeight
    case 'lineWidth': return ranges.lineWidth
    case 'volumetric': return ranges.volumetric
    case 'fanSpeed': return ranges.fanSpeed
    case 'temperature': return ranges.temperature
  }
}

const WELD_EPSILON = 1e-3 // mm; endpoints of one path come from the same parsed values
// Bambu varies LINE_WIDTH slightly between wall moves; welds survive small changes by
// tapering the tube through an averaged joint ring instead of breaking into capped beads.
const WELD_WIDTH_TOLERANCE = 0.1 // mm
// Sharper joints than this fall back to capped ends (the miter offset would spike).
const MITER_DOT_MIN = 0.5
// Below this XY length a segment is degenerate: skipped, and it breaks any weld run.
const DEGENERATE_SEGMENT_LENGTH = 1e-4

interface ExtrusionGeometryBuild {
  geometry: THREE.BufferGeometry
  /**
   * Where each segment's own vertices begin, with a final entry holding the total
   * (length = segment count + 1).
   *
   * `[start[i], start[i+1])` is exactly what segment `i` pushed, so a view-mode switch can repaint
   * one segment without re-deriving the weld decisions. A degenerate segment pushed nothing and
   * has `start[i] === start[i+1]`. A WELDED joint ring belongs to the EARLIER segment (which
   * pushed it as its end ring), so the tube gradates from one segment's value to the next's,
   * which is what makes a speed change read as a gradient rather than a hard seam.
   */
  segmentVertexStart: Uint32Array
  /** Cumulative index count at the END of each layer (drives the layer slider draw range). */
  layerIndexEnd: number[]
  /**
   * Cumulative VERTEX count at the end of each layer. Vertices are emitted layer by layer, so this
   * gives each layer a contiguous range, which is what lets a per-layer mesh compute its own
   * bounds while sharing one position buffer with every other layer.
   */
  layerVertexEnd: number[]
  /**
   * Cumulative emitted-move count at the end of each layer (the bead mesh skips
   * degenerate segments, so this can differ from the parsed segment count).
   */
  layerMoveEnd: number[]
  /** Draw-range end after the given emitted move (within-layer scrub boundaries). */
  moveEndIndex: (move: number) => number
}

/**
 * Build the merged extrusion mesh (see {@link buildLayeredGcodePreview}). Two passes over
 * the parsed segments: the first records each joint's weld/miter decision and counts
 * exactly how many vertices/indices the welded tubes and caps need; the second fills
 * exact-size buffers. (The previous single pass allocated the no-weld worst case, four
 * rings per segment, which over-allocated hundreds of MB on a dense multi-hour plate and
 * kept it alive via subarray views.) Vertex data is quantized where precision allows:
 * int8 normalized normals, uint8 normalized colours, uint8 macro-up flags, and a uint16
 * index when the mesh is small enough; positions stay float32.
 *
 * Deliberately a separate function from buildLayeredGcodePreview: V8 gives all closures
 * created in a scope ONE shared context, so if this work ran inline, the preview's
 * returned closures would pin every intermediate array here for the preview's lifetime.
 */
function buildExtrusionGeometry(parsed: ParsedGcodeLayers): ExtrusionGeometryBuild {
  const pos = parsed.extrusionPositions
  const widths = parsed.extrusionWidths
  const heights = parsed.extrusionHeights
  const roles = parsed.extrusionRoles
  const segCount = pos.length / 6 // 2 vertices (6 floats) per segment
  const P = PROFILE.length

  // Pass 1: weld/miter decision per segment, STORED, so pass 2 cannot diverge from the
  // counted sizes, plus the exact vertex/index totals.
  const jointWeld = new Uint8Array(segCount)
  const jointPx = new Float32Array(segCount)
  const jointPy = new Float32Array(segCount)
  const jointHalfW = new Float32Array(segCount)
  let vertexCount = 0
  let indexCount = 0
  for (let layer = 0; layer < parsed.layerCount; layer++) {
    const startSeg = (layer > 0 ? parsed.extrusionLayerEnd[layer - 1]! : 0) / 2
    const endSeg = parsed.extrusionLayerEnd[layer]! / 2
    let weldedFromPrev = false
    for (let seg = startSeg; seg < endSeg; seg++) {
      const o = seg * 6
      const ax = pos[o]!, ay = pos[o + 1]!, az = pos[o + 2]!
      const bx = pos[o + 3]!, by = pos[o + 4]!
      const segDx = bx - ax, segDy = by - ay
      const len = Math.hypot(segDx, segDy)
      if (len < DEGENERATE_SEGMENT_LENGTH) { weldedFromPrev = false; continue }
      const nx = -segDy / len, ny = segDx / len // perpendicular unit (in the bed plane)

      // Does the NEXT segment continue this path? (Shared endpoint, same feature/height, a near
      // width, and a joint shallow enough to miter.) If so, the shared ring is emitted once with
      // the mitered perp and reused: the tube stays continuous instead of leaving a wedge gap
      // at the bend; a small width change tapers smoothly through the averaged joint ring.
      if (seg + 1 < endSeg) {
        const n = (seg + 1) * 6
        const sameAttrs = roles[seg + 1] === roles[seg] &&
          Math.abs(widths[seg + 1]! - widths[seg]!) < WELD_WIDTH_TOLERANCE &&
          Math.abs(heights[seg + 1]! - heights[seg]!) < 1e-6
        const sharedPoint = Math.abs(pos[n]! - bx) < WELD_EPSILON &&
          Math.abs(pos[n + 1]! - by) < WELD_EPSILON &&
          Math.abs(pos[n + 2]! - az) < WELD_EPSILON
        if (sameAttrs && sharedPoint) {
          let ndx = pos[n + 3]! - pos[n]!, ndy = pos[n + 4]! - pos[n + 1]!
          const nlen = Math.hypot(ndx, ndy)
          if (nlen >= DEGENERATE_SEGMENT_LENGTH) {
            ndx /= nlen; ndy /= nlen
            let mx = nx + -ndy, my = ny + ndx // sum of the two unit perps
            const mlen = Math.hypot(mx, my)
            if (mlen > 1e-4) {
              mx /= mlen; my /= mlen
              const cosHalf = mx * nx + my * ny
              if (cosHalf > MITER_DOT_MIN) {
                // Widen the joint ring by 1/cos(θ/2) so the bead walls stay flush through the bend.
                jointWeld[seg] = 1
                jointPx[seg] = mx
                jointPy[seg] = my
                jointHalfW[seg] = ((widths[seg]! || DEFAULT_EXTRUSION_WIDTH) + (widths[seg + 1]! || DEFAULT_EXTRUSION_WIDTH)) / 4 / cosHalf
              }
            }
          }
        }
      }

      const weldNext = jointWeld[seg] === 1
      // Start ring + its cap ring unless welded into; end ring always; end cap ring unless welding on.
      vertexCount += (weldedFromPrev ? 0 : 2 * P) + P + (weldNext ? 0 : P)
      // P side quads; a (P-2)-triangle cap fan per open end.
      indexCount += P * 6 + (weldedFromPrev ? 0 : (P - 2) * 3) + (weldNext ? 0 : (P - 2) * 3)
      weldedFromPrev = weldNext
    }
  }

  // Pass 2: fill the exact-size buffers.
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Int8Array(vertexCount * 3)
  const colors = new Uint8Array(vertexCount * 3)
  const macroUps = new Uint8Array(vertexCount)
  const indices = vertexCount > 65536 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
  const layerIndexEnd: number[] = []
  const layerVertexEnd: number[] = []
  const moveIndexEnd: number[] = []
  const layerMoveEnd: number[] = []
  let vCount = 0
  let iCount = 0

  const roleRGB = buildRoleRGB()

  let cr = 255, cg = 255, cb = 255
  let macroUp = 0
  const pushVertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    const o = vCount * 3
    positions[o] = x; positions[o + 1] = y; positions[o + 2] = z
    normals[o] = Math.round(nx * 127); normals[o + 1] = Math.round(ny * 127); normals[o + 2] = Math.round(nz * 127)
    colors[o] = cr; colors[o + 1] = cg; colors[o + 2] = cb
    macroUps[vCount] = macroUp
    return vCount++
  }
  /**
   * A side quad, wound so its front face points OUT of the bead. Orientation is load-bearing now
   * that the mesh is back-face culled: `gcodePreview.test.ts` asserts every triangle's geometric
   * normal agrees with the outward normal `pushVertex` authored for it.
   */
  const pushQuad = (a: number, b: number, c: number, d: number) => {
    indices[iCount++] = a; indices[iCount++] = c; indices[iCount++] = b
    indices[iCount++] = a; indices[iCount++] = d; indices[iCount++] = c
  }
  /**
   * Close an open tube end: duplicate the ring with flat axial normals (so the cap does not
   * inherit the ring's radial shading) and fan over it. `flip` runs the fan the other way for the
   * cap that faces backwards, so both end up front-side out.
   */
  const pushCap = (ringBase: number, nx: number, ny: number, flip: boolean) => {
    const base = vCount
    for (let p = 0; p < P; p++) {
      const o = (ringBase + p) * 3
      pushVertex(positions[o]!, positions[o + 1]!, positions[o + 2]!, nx, ny, 0)
    }
    // The two caps face OPPOSITE ways, so one fan has to run the other way round; emitting both in
    // the same order left every path with one inward-facing end, invisible only because the mesh
    // was double-sided.
    for (let p = 1; p < P - 1; p++) {
      indices[iCount++] = base
      indices[iCount++] = flip ? base + p + 1 : base + p
      indices[iCount++] = flip ? base + p : base + p + 1
    }
  }
  /** Emit one profile ring at (cx,cy) offset along the unit perp (px,py), scaled by halfW. */
  const pushRing = (cx: number, cy: number, px: number, py: number, halfW: number, bot: number, layerHeight: number): number => {
    const base = vCount
    for (let p = 0; p < P; p++) {
      const u = PROFILE[p]![0] * halfW
      const v = bot + PROFILE[p]![1] * layerHeight
      const nu = PROFILE[p]![2], nv = PROFILE[p]![3]
      pushVertex(cx + px * u, cy + py * u, v, px * nu, py * nu, nv)
    }
    return base
  }

  const segmentVertexStart = new Uint32Array(segCount + 1)
  for (let layer = 0; layer < parsed.layerCount; layer++) {
    const startSeg = (layer > 0 ? parsed.extrusionLayerEnd[layer - 1]! : 0) / 2
    const endSeg = parsed.extrusionLayerEnd[layer]! / 2
    // Ring carried over from the previous segment when it welds into this one.
    let weldRingBase = -1
    for (let seg = startSeg; seg < endSeg; seg++) {
      // Recorded BEFORE the degenerate check so every segment index has an entry, including the
      // ones that push nothing: a view-mode repaint indexes this by segment, not by drawn run.
      segmentVertexStart[seg] = vCount
      const o = seg * 6
      const ax = pos[o]!, ay = pos[o + 1]!, az = pos[o + 2]!
      const bx = pos[o + 3]!, by = pos[o + 4]!
      let dx = bx - ax, dy = by - ay
      const len = Math.hypot(dx, dy)
      if (len < DEGENERATE_SEGMENT_LENGTH) { weldRingBase = -1; continue }
      dx /= len; dy /= len
      const nx = -dy, ny = dx
      const halfW = (widths[seg]! || DEFAULT_EXTRUSION_WIDTH) / 2
      const layerHeight = heights[seg]! || DEFAULT_LAYER_HEIGHT
      const bot = az - layerHeight
      const rgb = roleRGB[roles[seg]!] ?? roleRGB[0]!
      cr = rgb[0]; cg = rgb[1]; cb = rgb[2]
      macroUp = WALL_ROLES.has(roles[seg]!) ? 0 : 1

      // Joint decision from pass 1 (identical by construction).
      const weldNext = jointWeld[seg] === 1
      const endPx = weldNext ? jointPx[seg]! : nx
      const endPy = weldNext ? jointPy[seg]! : ny
      const endHalfW = weldNext ? jointHalfW[seg]! : halfW

      const startBase = weldRingBase >= 0 ? weldRingBase : pushRing(ax, ay, nx, ny, halfW, bot, layerHeight)
      if (weldRingBase < 0) pushCap(startBase, -dx, -dy, true)
      const endBase = pushRing(bx, by, endPx, endPy, endHalfW, bot, layerHeight)
      if (!weldNext) pushCap(endBase, dx, dy, false)
      weldRingBase = weldNext ? endBase : -1

      // Connect the two rings into a closed tube (P side quads), wound outward: see pushQuad.
      for (let p = 0; p < P; p++) {
        const p1 = (p + 1) % P
        pushQuad(startBase + p, endBase + p, endBase + p1, startBase + p1)
      }
      moveIndexEnd.push(iCount)
    }
    layerIndexEnd.push(iCount)
    layerVertexEnd.push(vCount)
    layerMoveEnd.push(moveIndexEnd.length)
  }

  // A silent mismatch would render garbage from misaligned buffers; fail loudly instead.
  if (vCount !== vertexCount || iCount !== indexCount) {
    throw new Error(`G-code preview geometry mismatch: emitted ${vCount}/${iCount} vertices/indices, counted ${vertexCount}/${indexCount}`)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true))
  geometry.setAttribute('aMacroUp', new THREE.BufferAttribute(macroUps, 1))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  segmentVertexStart[segCount] = vCount
  return {
    geometry,
    segmentVertexStart,
    layerIndexEnd,
    layerVertexEnd,
    layerMoveEnd,
    moveEndIndex: (move) => moveIndexEnd[move] ?? 0
  }
}

/**
 * Build a volumetric extrusion mesh: each segment becomes a boxed ribbon (top + two side faces)
 * at its real width and layer height, vertex-coloured by feature type, so the print reads like
 * Bambu Studio's preview rather than flat lines. Consecutive segments of the same path (shared
 * endpoint, same feature/height, near width) are welded into one continuous tube with a mitered
 * joint ring, every open tube end is capped, and shading uses smooth per-vertex normals, without
 * this, curved walls (arcs tessellated into short segments) show wedge gaps at every bend,
 * see-through holes at line ends, and one visible shading facet per segment. One merged
 * indexed geometry; the layer slider just moves the index draw range (O(1), no rebuilds). Travel
 * moves stay thin lines, hidden by default.
 *
 * Memory contract: MOST CPU-side buffer arrays are FREED after the renderer uploads them
 * (onUpload): callers must do any bounds/raycast work that reads vertex data before the
 * first render, and a lost WebGL context must be recovered by rebuilding the preview, not
 * by three's automatic restore (which would re-upload from the freed arrays).
 *
 * The two COLOUR attributes are the exception, and are deliberately kept, along with the parse's
 * per-segment metric arrays (roles, widths, heights, speeds, flow, fan, temperature) and
 * `segmentVertexStart`. That is what lets {@link LayeredGcodePreview.setViewMode} repaint in
 * place. Measured on a real 6.6h H2D plate (460k segments, 3.9M vertices): about 11 MiB of colour
 * plus about 9 MiB of metrics. The alternative is rebuilding the geometry per switch, which costs
 * ~340ms, a full re-upload of every position/normal/index, AND retaining the 11 MiB position
 * array to rebuild from, so it is worse on both axes. Positions are still freed, since nothing
 * re-derives geometry.
 */
/**
 * One mesh per layer, over ONE shared set of vertex buffers.
 *
 * The point is DRAW ORDER, not culling. A single mesh draws its triangles in buffer order, layer 0
 * first, which for a camera looking down at a plate is back-to-front, the worst case: every layer
 * is fully shaded and then painted over by the one above it, so a 45-layer print shades each pixel
 * ~45 times. Three sorts opaque OBJECTS front-to-back (`painterSortStable`, ascending camera-space
 * z) precisely so early-Z can reject hidden fragments before the fragment shader runs, but it
 * cannot sort WITHIN a mesh. Splitting by layer hands it that lever, and costs nothing in memory:
 * the geometries share the same BufferAttribute INSTANCES, which three uploads once per attribute
 * object, and only the small index views differ.
 *
 * Bounds are set MANUALLY, for two independent reasons, and getting either wrong is silent:
 * `computeBoundingSphere` reads the whole shared position buffer, so every layer would claim the
 * bounds of the entire plate (sorting still works, culling quietly does nothing); and the caller
 * frees the CPU-side arrays on upload, so a lazily computed sphere would read a freed array mid-sort
 * and kill the render loop on the object's first frame.
 */
function buildPerLayerMeshes(
  source: THREE.BufferGeometry,
  layerIndexEnd: number[],
  layerVertexEnd: number[],
  material: THREE.Material
): THREE.Mesh[] {
  const index = source.getIndex()
  const position = source.getAttribute('position')
  if (!index) return []
  const indexArray = index.array as Uint16Array | Uint32Array
  const meshes: THREE.Mesh[] = []
  for (let layer = 0; layer < layerIndexEnd.length; layer++) {
    const indexStart = layer > 0 ? layerIndexEnd[layer - 1]! : 0
    const indexEnd = layerIndexEnd[layer]!
    if (indexEnd <= indexStart) continue
    const geometry = new THREE.BufferGeometry()
    // Shared instances, one upload for all layers, not one per layer.
    for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute)
    geometry.setIndex(new THREE.BufferAttribute(indexArray.subarray(indexStart, indexEnd), 1))

    const vertexStart = layer > 0 ? layerVertexEnd[layer - 1]! : 0
    const vertexEnd = layerVertexEnd[layer]!
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let v = vertexStart; v < vertexEnd; v++) {
      const x = position.getX(v), y = position.getY(v), z = position.getZ(v)
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
    if (minX <= maxX) {
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ))
      const centre = geometry.boundingBox.getCenter(new THREE.Vector3())
      // The corner distance bounds every vertex in the box, so this sphere always contains the
      // layer, never tight, never wrong, and it costs one pass instead of two.
      geometry.boundingSphere = new THREE.Sphere(centre, centre.distanceTo(geometry.boundingBox.max))
    } else {
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0)
    }

    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData.layer = layer
    meshes.push(mesh)
  }
  return meshes
}

export function buildLayeredGcodePreview(parsed: ParsedGcodeLayers): LayeredGcodePreview {
  const group = new THREE.Group()
  const build = buildExtrusionGeometry(parsed)
  // FrontSide, not DoubleSide: a bead is a CLOSED tube (capped at every open end, welded rings
  // through joints), so its back faces are always occluded by its own front faces and shading them
  // was pure cost: doubled per-fragment PBR work across a mesh measured at 2.6M triangles on a
  // real plate, on a preview that resets the GPU process. Back-face culling happens before fragment
  // shading, so it also drops half the raster work, and the image is identical.
  //
  // This is only safe because the winding is now consistent: `gcodePreview.test.ts` asserts every
  // triangle's geometric normal agrees with the outward normal the builder authored. It was NOT
  // consistent before (all side quads were inverted, and one cap of every path), which is what
  // DoubleSide was quietly covering for.
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.FrontSide, roughness: 0.82, metalness: 0.0 })
  applyMoireFade(material, representativeLayerHeight(parsed.extrusionHeights), medianPositive(parsed.extrusionWidths, DEFAULT_EXTRUSION_WIDTH))
  const { geometry: extrusionGeometry, layerIndexEnd, layerVertexEnd, layerMoveEnd, moveEndIndex } = build
  // One mesh per layer so three can sort them front-to-back: see buildPerLayerMeshes. Their bounds
  // are real (not the whole plate), so frustum culling is left ON here, unlike the single mesh this
  // replaced, whose draw-range scrubbing invalidated any bounds it might have had.
  const layerMeshes = buildPerLayerMeshes(extrusionGeometry, layerIndexEnd, layerVertexEnd, material)

  const travelGeometry = new THREE.BufferGeometry()
  travelGeometry.setAttribute('position', new THREE.BufferAttribute(parsed.travelPositions, 3))
  // Travel is vertex-coloured rather than one flat colour, because it carries two different
  // meanings: normally BambuStudio's Move/Extrude/Retract triple (by the sign of the move's E
  // delta), but in the Speed view the feedrate ramp, like extrusions (`LegacyRenderer.cpp:2009`).
  const travelColors = new Uint8Array((parsed.travelPositions.length / 3) * 3)
  const travelColorAttribute = new THREE.BufferAttribute(travelColors, 3, true)
  travelGeometry.setAttribute('color', travelColorAttribute)
  const travel = new THREE.LineSegments(
    travelGeometry,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45 })
  )
  travel.frustumCulled = false

  // Wipe moves are their own path, not travel: BambuStudio classifies any move inside a
  // `;WIPE_START`/`;WIPE_END` region as a Wipe whatever its E sign, and gives it its own colour
  // and its own toggle. They are lifted half their forced 0.05mm height so a wipe floats above
  // the bead it retraces instead of z-fighting it (`LegacyRenderer.cpp:1465`).
  const wipeGeometry = new THREE.BufferGeometry()
  const liftedWipe = new Float32Array(parsed.wipePositions.length)
  liftedWipe.set(parsed.wipePositions)
  for (let i = 2; i < liftedWipe.length; i += 3) liftedWipe[i] = liftedWipe[i]! + WIPE_LINE_SIZE * 0.5
  wipeGeometry.setAttribute('position', new THREE.BufferAttribute(liftedWipe, 3))
  const wipe = new THREE.LineSegments(
    wipeGeometry,
    new THREE.LineBasicMaterial({ color: GCODE_WIPE_COLOR, transparent: true, opacity: 0.9 })
  )
  wipe.frustumCulled = false
  wipe.visible = false

  // One mesh per marker kind: a legend checkbox hides a kind, the layer slider hides a Z range,
  // and the two are independent. See `gcodeMarkers.ts`.
  const markerKinds: GcodeMarkerKind[] = [0, 1, 2]
  const markerMeshes = markerKinds.map((kind) => {
    const built = buildGcodeMarkerGeometry(parsed, kind)
    const material = new THREE.MeshStandardMaterial({
      // The bare hex, NOT `.convertSRGBToLinear()`. three ships `ColorManagement.enabled = true`,
      // so `Color` already converts an sRGB hex into the linear working space; converting again
      // roughly halves each channel and the marker renders duller than the legend swatch that
      // names it. (The bead mesh does linearize by hand, but that is different: VERTEX colours
      // bypass colour management entirely, which is why `SRGB_TO_LINEAR_BYTE` exists for them.)
      color: GCODE_MARKER_COLORS[kind]!,
      side: THREE.FrontSide,
      roughness: 0.6,
      metalness: 0
    })
    const mesh = new THREE.Mesh(built.geometry, material)
    mesh.frustumCulled = false
    mesh.visible = false
    return { kind, mesh, material, layerIndexEnd: built.layerIndexEnd, markerCount: built.markerCount }
  })

  for (const mesh of layerMeshes) group.add(mesh)
  group.add(travel)
  group.add(wipe)
  for (const marker of markerMeshes) if (marker.markerCount > 0) group.add(marker.mesh)

  // Copy the small per-layer tables out of `parsed`: the closures below must not reference
  // `parsed` itself, or they'd pin its POSITION arrays (11 MiB of extrusion vertices on a real
  // plate) for the preview's whole lifetime. The per-segment METRIC arrays below are pinned
  // deliberately, because repainting for a colour scheme has to re-read them; positions are not,
  // because nothing re-derives geometry. See the memory contract in the JSDoc above.
  const layerCount = parsed.layerCount
  const layerZ = parsed.layerZ
  const travelLayerEnd = parsed.travelLayerEnd
  const wipeLayerEnd = parsed.wipeLayerEnd
  // The per-segment METRICS a repaint re-reads, pulled out INDIVIDUALLY. Holding `parsed` itself
  // here (which is what this used to do) captures the position arrays too, which is exactly what
  // the paragraph above says must not happen: they are the 11 MiB the free-on-upload contract
  // exists to release, and pinning them also silently defeats `PreviewView`'s own release of the
  // parse after the conflict scan. Nothing below may reference `parsed`.
  const metricSource: GcodeMetricSource = {
    extrusionRoles: parsed.extrusionRoles,
    extrusionWidths: parsed.extrusionWidths,
    extrusionHeights: parsed.extrusionHeights,
    extrusionFeedrates: parsed.extrusionFeedrates,
    extrusionVolumetric: parsed.extrusionVolumetric,
    extrusionFanSpeeds: parsed.extrusionFanSpeeds,
    extrusionTemperatures: parsed.extrusionTemperatures,
    travelFeedrates: parsed.travelFeedrates,
    travelKinds: parsed.travelKinds,
    ranges: parsed.ranges
  }
  const { segmentVertexStart } = build
  const extrusionColorAttribute = extrusionGeometry.getAttribute('color') as THREE.BufferAttribute
  const extrusionColors = extrusionColorAttribute.array as Uint8Array
  const segmentCount = parsed.extrusionRoles.length

  /**
   * Repaint both colour buffers for a scheme. O(segments), no allocation per segment.
   *
   * Feature type is categorical (a role indexes the palette); every other mode reads its metric
   * and interpolates the range ramp. Travel takes the same ramp ONLY in the Speed view, which is
   * BambuStudio's rule (`LegacyRenderer.cpp:2009-2010`) and the reason travel needs its own colours.
   */
  const paintViewMode = (mode: GcodeViewMode, showTravel: boolean, options?: { extrusion?: boolean }): void => {
    // `extrusion: false` skips the extrusion half. Only the initial build passes it, because
    // `buildExtrusionGeometry` has just written those colours from the same role palette; repainting
    // them is a full pass over every segment (~25ms on a 460k-segment plate) plus a needless
    // `needsUpdate` on a buffer that has not been uploaded once, landing on the frame the user is
    // already waiting on for the preview to appear.
    const paintExtrusion = options?.extrusion ?? true
    const metric = gcodeViewModeMetric(mode)
    const values = metric ? metricValues(metricSource, metric) : null
    const range = metric ? gcodeMetricRange(metricSource.ranges, metric, showTravel) : null
    // Channels are unpacked inline rather than through `linearRGB`, which returns a tuple, so the
    // per-segment path allocates nothing. (Worth knowing if this is ever profiled again: the tuple
    // was NOT what made range repaints slow. That was a closure inside the ramp's own colour lerp,
    // and removing it took a repaint from ~140ms to ~25ms on a 460k-segment plate; the tuple was
    // worth about 5ms of that.)
    if (paintExtrusion) {
      const roleRGB = buildRoleRGB()
      for (let seg = 0; seg < segmentCount; seg++) {
        const start = segmentVertexStart[seg]!
        const end = segmentVertexStart[seg + 1]!
        if (end <= start) continue
        let r: number, g: number, b: number
        if (!values || !range) {
          const rgb = roleRGB[metricSource.extrusionRoles[seg]!] ?? roleRGB[0]!
          r = rgb[0]; g = rgb[1]; b = rgb[2]
        } else {
          const hex = rangeColorAt(range, values[seg]!)
          r = SRGB_TO_LINEAR_BYTE[(hex >> 16) & 0xff]!
          g = SRGB_TO_LINEAR_BYTE[(hex >> 8) & 0xff]!
          b = SRGB_TO_LINEAR_BYTE[hex & 0xff]!
        }
        for (let v = start; v < end; v++) {
          const o = v * 3
          extrusionColors[o] = r; extrusionColors[o + 1] = g; extrusionColors[o + 2] = b
        }
      }
      extrusionColorAttribute.needsUpdate = true
    }

    const travelRange = metric === 'feedrate' ? range : null
    for (let seg = 0; seg < metricSource.travelKinds.length; seg++) {
      const hex = travelRange
        ? rangeColorAt(travelRange, metricSource.travelFeedrates[seg]!)
        : GCODE_TRAVEL_COLORS[metricSource.travelKinds[seg]!] ?? GCODE_TRAVEL_COLORS[0]!
      const r = SRGB_TO_LINEAR_BYTE[(hex >> 16) & 0xff]!
      const g = SRGB_TO_LINEAR_BYTE[(hex >> 8) & 0xff]!
      const b = SRGB_TO_LINEAR_BYTE[hex & 0xff]!
      // Two vertices per travel segment, laid out exactly like the positions they colour.
      for (let v = seg * 2; v < seg * 2 + 2; v++) {
        const o = v * 3
        travelColors[o] = r; travelColors[o + 1] = g; travelColors[o + 2] = b
      }
    }
    travelColorAttribute.needsUpdate = true
  }
  // `buildExtrusionGeometry` already wrote feature colours into the extrusion buffer from the same
  // role palette, so only travel needs painting here. A later switch must still find both buffers
  // consistent, which is why travel is painted at all rather than left until first use.
  paintViewMode('feature', false, { extrusion: false })

  // Precompute bounds BEFORE registering the onUpload frees below. The renderer's sort
  // pass lazily computes a null boundingSphere during projectObject, AFTER
  // objects.update() has already uploaded and freed the arrays earlier in the same
  // frame, so a lazy compute would read a null array, throw, and kill the render loop
  // on the object's first frame. Precomputed bounds also make the caller's framing
  // (Box3.setFromObject) free.
  // The per-layer geometries already carry hand-computed bounds (buildPerLayerMeshes); the source
  // geometry is never rendered itself, so only travel needs this.
  travelGeometry.computeBoundingBox()
  travelGeometry.computeBoundingSphere()
  // Wipe needs the same treatment for the same reason; the marker geometries compute their own
  // inside `buildGcodeMarkerGeometry`. A geometry that reaches the renderer with a null
  // boundingSphere is not a slow path: the sort pass computes it lazily AFTER the upload has
  // freed the array, which throws and kills the render loop on the object's first frame.
  wipeGeometry.computeBoundingBox()
  wipeGeometry.computeBoundingSphere()

  // Free each CPU-side buffer once the renderer has uploaded it: layer/move scrubbing
  // only adjusts draw ranges and nothing raycasts the toolpath mesh, so the arrays are
  // never read back. This halves the preview's steady-state footprint. (See the memory
  // contract in the function JSDoc.)
  //
  // The two COLOUR attributes are excluded, because `setViewMode` rewrites them in place and
  // re-uploads. Freeing one is not a slow path, it is a CRASH: three would upload from a null
  // array on the next `needsUpdate`. They are excluded BY IDENTITY rather than by name, so an
  // attribute added later is freed by default and a colour buffer cannot be freed by a typo.
  const keepResident = new Set<THREE.BufferAttribute>([extrusionColorAttribute, travelColorAttribute])
  const releaseArray = function (this: THREE.BufferAttribute) {
    ;(this as unknown as { array: unknown }).array = null
  } as unknown as () => void
  const uploadOnce = [
    // The vertex attributes are shared by every layer mesh, so freeing them once frees them for all.
    ...Object.values(extrusionGeometry.attributes),
    // Each layer's index is its own view; they free independently as they upload.
    ...layerMeshes.map((mesh) => mesh.geometry.getIndex()).filter((index): index is THREE.BufferAttribute => index !== null),
    travelGeometry.getAttribute('position'),
    wipeGeometry.getAttribute('position'),
    // Marker meshes are static geometry (a kind's colour lives on its material, not per vertex),
    // so every one of their buffers is freeable.
    ...markerMeshes.flatMap((marker) => [
      ...Object.values(marker.mesh.geometry.attributes),
      marker.mesh.geometry.getIndex()
    ]).filter((attribute): attribute is THREE.BufferAttribute => attribute != null)
  ]
  for (const attribute of uploadOnce) {
    const typed = attribute as THREE.BufferAttribute
    if (!keepResident.has(typed)) typed.onUpload(releaseArray)
  }

  const layerMoveCount = (layer: number): number => {
    const clamped = Math.max(0, Math.min(layer, layerCount - 1))
    const start = clamped > 0 ? layerMoveEnd[clamped - 1]! : 0
    return (layerMoveEnd[clamped] ?? 0) - start
  }

  const setVisibleLayers: LayeredGcodePreview['setVisibleLayers'] = (topLayer, options) => {
    const clamped = Math.max(0, Math.min(topLayer, layerCount - 1))
    const single = options?.single ?? false
    // Where the TOP layer should stop, in the global index space (the within-layer scrub).
    const topLayerStart = clamped > 0 ? layerIndexEnd[clamped - 1]! : 0
    let topEnd = layerIndexEnd[clamped] ?? 0
    if (options?.moveEnd !== undefined && options.moveEnd < layerMoveCount(clamped)) {
      const firstMove = clamped > 0 ? layerMoveEnd[clamped - 1]! : 0
      const lastMove = firstMove + Math.max(0, Math.floor(options.moveEnd)) - 1
      topEnd = lastMove >= firstMove ? moveEndIndex(lastMove) : topLayerStart
    }
    // Visibility per layer instead of one draw range: below the top they are whole, the top one is
    // truncated, and `single` shows only the top. A hidden mesh is not submitted OR sorted, so this
    // is also what keeps the front-to-back ordering meaningful while scrubbing.
    for (const mesh of layerMeshes) {
      const layer = mesh.userData.layer as number
      if (layer > clamped || (single && layer !== clamped)) {
        mesh.visible = false
        continue
      }
      mesh.visible = true
      if (layer === clamped) {
        // Draw ranges are LOCAL to each layer's own index view.
        mesh.geometry.setDrawRange(0, Math.max(0, topEnd - topLayerStart))
      } else {
        mesh.geometry.setDrawRange(0, Infinity)
      }
    }

    if (options?.showTravel) {
      // Travel spans the SAME visible layers as the beads it belongs to, which is BambuStudio's
      // rule (`LegacyRenderer.cpp:1866-1871` tests travel against the full `m_layers_z_range`,
      // not against the top layer). Showing only the top layer's travel, as this did while the
      // flag had no caller, hid the thing travel is looked at for: where the head goes between
      // the parts of a print, which is a question about the print and not about one layer.
      // `single` still isolates one layer, because that is what the mode means.
      const travelStart = single
        ? (clamped > 0 ? travelLayerEnd[clamped - 1]! : 0)
        : 0
      const travelEnd = travelLayerEnd[clamped] ?? 0
      travel.visible = travelEnd > travelStart
      travelGeometry.setDrawRange(travelStart, Math.max(0, travelEnd - travelStart))
    } else {
      travel.visible = false
    }

    // Wipes and markers follow the same visible-layer rule as travel: a checkbox decides whether
    // the kind exists on screen, the slider decides which layers of it are drawn.
    const markers = options?.markers
    if (markers?.wipe) {
      const wipeStart = single ? (clamped > 0 ? wipeLayerEnd[clamped - 1]! : 0) : 0
      const wipeEnd = wipeLayerEnd[clamped] ?? 0
      wipe.visible = wipeEnd > wipeStart
      wipeGeometry.setDrawRange(wipeStart, Math.max(0, wipeEnd - wipeStart))
    } else {
      wipe.visible = false
    }
    for (const marker of markerMeshes) {
      const wanted = marker.kind === 0 ? markers?.retract : marker.kind === 1 ? markers?.unretract : markers?.seam
      if (!wanted || marker.markerCount === 0) {
        marker.mesh.visible = false
        continue
      }
      const markerStart = single ? (clamped > 0 ? marker.layerIndexEnd[clamped - 1]! : 0) : 0
      const markerEnd = marker.layerIndexEnd[clamped] ?? 0
      marker.mesh.visible = markerEnd > markerStart
      marker.mesh.geometry.setDrawRange(markerStart, Math.max(0, markerEnd - markerStart))
    }
  }
  // Default: whole print, no travel moves.
  setVisibleLayers(layerCount - 1)

  return {
    object: group,
    layerCount,
    setVisibleLayers,
    setViewMode: (mode, options) => paintViewMode(mode, options?.showTravel ?? false),
    moveCount: layerMoveCount,
    layerZ: (layer: number) => layerZ[Math.max(0, Math.min(layer, layerCount - 1))] ?? 0,
    dispose: () => {
      // The layer geometries share the source's attributes, so disposing the source releases the
      // vertex buffers once; each layer geometry still owns its index view.
      for (const mesh of layerMeshes) mesh.geometry.dispose()
      extrusionGeometry.dispose()
      travelGeometry.dispose()
      wipeGeometry.dispose()
      material.dispose()
      ;(travel.material as THREE.Material).dispose()
      ;(wipe.material as THREE.Material).dispose()
      for (const marker of markerMeshes) {
        marker.mesh.geometry.dispose()
        marker.material.dispose()
      }
    }
  }
}
