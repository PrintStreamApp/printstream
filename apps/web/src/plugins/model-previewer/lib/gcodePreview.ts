/**
 * Layered G-code parsing + rendering for the sliced-file preview (#28).
 *
 * Renders the toolpath the way Bambu Studio's preview does: every extrusion as a solid 3D
 * ribbon at its real width (`; LINE_WIDTH:`) and layer height (`; LAYER_HEIGHT:`), coloured by
 * feature type (`; FEATURE:` — outer wall, infill, ...). Bambu emits the bulk of walls as arc
 * moves (G2/G3 arc-fitting is on by default), so those are interpolated into segments — without
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

/** Display names parallel to {@link GCODE_FEATURE_COLORS} (Bambu's role labels). */
export const GCODE_FEATURE_NAMES: ReadonlyArray<string> = [
  'Other',
  'Inner wall',
  'Outer wall',
  'Overhang wall',
  'Sparse infill',
  'Internal solid infill',
  'Top surface',
  'Bottom surface',
  'Ironing',
  'Bridge',
  'Gap infill',
  'Skirt',
  'Brim',
  'Support',
  'Support interface',
  'Prime tower',
  'Custom',
  'Flush'
]

/** Map a `; FEATURE:` name to its {@link GCODE_FEATURE_COLORS} index. */
function featureRoleIndex(name: string): number {
  switch (name.trim().toLowerCase()) {
    case 'inner wall': return 1
    case 'outer wall': return 2
    case 'overhang wall': return 3
    case 'sparse infill': return 4
    case 'internal solid infill': return 5
    case 'top surface': return 6
    case 'bottom surface': return 7
    case 'ironing':
    case 'support ironing': return 8
    case 'bridge': return 9
    case 'gap infill': return 10
    case 'skirt': return 11
    case 'brim': return 12
    case 'support': return 13
    case 'support interface':
    case 'support transition': return 14
    case 'prime tower': return 15
    case 'custom': return 16
    case 'flush': return 17
    default: return 0
  }
}

/**
 * Print-time/usage stats accumulated while parsing. Move times are the feedrate-based
 * estimate `distance / F` (no acceleration model), so individual numbers run a little
 * low; the preview normalizes the per-feature PROPORTIONS against the slicer's own
 * total (gcode header / slice_info prediction) when one is available.
 */
export interface GcodeStats {
  /** Estimated seconds per feature role (index into {@link GCODE_FEATURE_NAMES}). */
  featureSeconds: number[]
  /** Extruded filament length (mm of filament E) per feature role. */
  featureExtrusionMm: number[]
  /** Estimated seconds spent on non-extruding travel moves. */
  travelSeconds: number
  /** Sum of all estimated move seconds (features + travel). */
  totalSeconds: number
  /** Slicer's own total estimate parsed from the gcode header, when present. */
  headerTotalSeconds: number | null
  /** Total extruded filament length (mm of filament E). */
  filamentMm: number
  /** Highest extrusion Z (mm) — the printed height. */
  maxZ: number
}

export interface ParsedGcodeLayers {
  /** Number of detected print layers (distinct extrusion Z heights). */
  layerCount: number
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
  /** Flat travel-move vertex positions, ordered by layer. */
  travelPositions: Float32Array
  /** Cumulative travel vertex count at the END of each layer (length = layerCount). */
  travelLayerEnd: number[]
  /** Time/usage breakdown accumulated during the parse. */
  stats: GcodeStats
}

/** Parse BambuStudio header durations like `1d 2h 3m 4s` / `35m 21s` into seconds. */
function parseGcodeDuration(value: string): number | null {
  let seconds = 0
  let matched = false
  for (const match of value.matchAll(/(\d+)\s*([dhms])/gi)) {
    const amount = Number.parseInt(match[1]!, 10)
    if (!Number.isFinite(amount)) continue
    matched = true
    switch (match[2]!.toLowerCase()) {
      case 'd': seconds += amount * 86400; break
      case 'h': seconds += amount * 3600; break
      case 'm': seconds += amount * 60; break
      case 's': seconds += amount; break
    }
  }
  return matched ? seconds : null
}

const Z_EPSILON = 1e-3
const DEFAULT_EXTRUSION_WIDTH = 0.42 // mm; used only when the G-code has no LINE_WIDTH comments
const DEFAULT_LAYER_HEIGHT = 0.2
/** Max chord deviation (mm) when tessellating an arc into segments. */
const ARC_CHORD_TOLERANCE = 0.08
/**
 * Max chord length (mm) when tessellating an arc. Sag tolerance alone lets large-radius arcs
 * emit multi-millimetre flat chords — visible straight facets that sit out of phase layer to
 * layer because each loop's seam starts at a different angle. Capping chord length keeps the
 * silhouette round regardless of radius.
 */
const ARC_MAX_CHORD = 1.0
const MAX_ARC_SEGMENTS = 720

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
  const featureExtrusionMm = new Array<number>(GCODE_FEATURE_COLORS.length).fill(0)
  let travelSeconds = 0
  let filamentMm = 0
  let maxZ = 0
  let headerTotalSeconds: number | null = null

  const extrusionLayers: number[][] = []
  const widthLayers: number[][] = []
  const heightLayers: number[][] = []
  const roleLayers: number[][] = []
  const travelLayers: number[][] = []

  const ensureLayer = (index: number) => {
    while (extrusionLayers.length <= index) {
      extrusionLayers.push([]); widthLayers.push([]); heightLayers.push([]); roleLayers.push([])
    }
    while (travelLayers.length <= index) travelLayers.push([])
  }

  /** Record one extrusion segment on the current layer, tagged with the active attributes. */
  const emitExtrusion = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    if (currentLayerZ === null || Math.abs(bz - currentLayerZ) > Z_EPSILON) {
      // Arc/line entry Z may differ slightly; key the layer off the segment's end Z.
      if (currentLayerZ === null || Math.abs(bz - currentLayerZ) > Z_EPSILON) {
        layer += 1
        currentLayerZ = bz
      }
    }
    ensureLayer(layer)
    extrusionLayers[layer]!.push(ax, ay, az, bx, by, bz)
    widthLayers[layer]!.push(curWidth > 0 ? curWidth : DEFAULT_EXTRUSION_WIDTH)
    heightLayers[layer]!.push(curHeight > 0 ? curHeight : 0)
    roleLayers[layer]!.push(curRole)
  }

  const emitTravel = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    if (layer < 0) return
    ensureLayer(layer)
    travelLayers[layer]!.push(ax, ay, az, bx, by, bz)
  }

  for (const rawLine of text.split('\n')) {
    const semi = rawLine.indexOf(';')
    if (semi >= 0) {
      const comment = rawLine.slice(semi + 1)
      const feature = /^\s*FEATURE:\s*(.+?)\s*$/i.exec(comment)
      if (feature) curRole = featureRoleIndex(feature[1]!)
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
    }
    const line = (semi >= 0 ? rawLine.slice(0, semi) : rawLine).trim()
    if (!line) continue
    const tokens = line.split(/\s+/)
    const command = tokens[0]!.toUpperCase()

    if (command === 'G90') { absolutePositions = true; continue }
    if (command === 'G91') { absolutePositions = false; continue }
    if (command === 'M82') { absoluteExtrusion = true; continue }
    if (command === 'M83') { absoluteExtrusion = false; continue }
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
    if (!movesXY && prevZ === z) continue

    const extruding = deltaE > 1e-6 && movesXY
    // Stats: feedrate-based move time + per-feature filament usage. Arc length uses the
    // true sweep (computed below for rendering too, but cheap to redo here for clarity).
    {
      let distance = Math.hypot(x - prevX, y - prevY, z - prevZ)
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
        if (extruding) featureSeconds[curRole] = (featureSeconds[curRole] ?? 0) + seconds
        else travelSeconds += seconds
      }
      if (extruding) {
        featureExtrusionMm[curRole] = (featureExtrusionMm[curRole] ?? 0) + deltaE
        filamentMm += deltaE
        if (z > maxZ) maxZ = z
      }
    }
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
        let px = prevX, py = prevY, pz = prevZ
        for (let k = 1; k <= steps; k++) {
          const t = k / steps
          const ang = a0 + sweep * t
          const nx = cx + radius * Math.cos(ang)
          const ny = cy + radius * Math.sin(ang)
          const nz = prevZ + (z - prevZ) * t
          if (extruding) emitExtrusion(px, py, pz, nx, ny, nz)
          else emitTravel(px, py, pz, nx, ny, nz)
          px = nx; py = ny; pz = nz
        }
        continue
      }
    }

    if (extruding) emitExtrusion(prevX, prevY, prevZ, x, y, z)
    else if (movesXY) emitTravel(prevX, prevY, prevZ, x, y, z)
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
  const flattenScalar = (layers: number[][], TypedArray: typeof Float32Array | typeof Uint8Array) => {
    let total = 0
    for (const l of layers) total += l.length
    const out = new TypedArray(total)
    let offset = 0
    for (const l of layers) { out.set(l, offset); offset += l.length }
    return out
  }

  const extrusion = flattenPositions(extrusionLayers)
  const travel = flattenPositions(travelLayers)
  const heights = flattenScalar(heightLayers, Float32Array) as Float32Array
  // Fill in any unannotated layer heights from the Z spacing between layers (older/non-Bambu G-code).
  if (!sawHeight) {
    const estimated = estimateLayerHeight(extrusion.positions, extrusion.layerEnd) || DEFAULT_LAYER_HEIGHT
    for (let i = 0; i < heights.length; i++) if (heights[i] === 0) heights[i] = estimated
  } else {
    for (let i = 0; i < heights.length; i++) if (heights[i] === 0) heights[i] = DEFAULT_LAYER_HEIGHT
  }
  void sawWidth

  return {
    layerCount,
    extrusionPositions: extrusion.positions,
    extrusionLayerEnd: extrusion.layerEnd,
    extrusionWidths: flattenScalar(widthLayers, Float32Array) as Float32Array,
    extrusionHeights: heights,
    extrusionRoles: flattenScalar(roleLayers, Uint8Array) as Uint8Array,
    travelPositions: travel.positions,
    travelLayerEnd: travel.layerEnd,
    stats: {
      featureSeconds,
      featureExtrusionMm,
      travelSeconds,
      totalSeconds: featureSeconds.reduce((sum, value) => sum + value, 0) + travelSeconds,
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
 * Anti-moire shading for zoomed-out views — the shading analogue of mipmapping. Bead shading
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
  setVisibleLayers: (topLayer: number, options?: { single?: boolean; showTravel?: boolean; moveEnd?: number }) => void
  /** Number of scrubbable extrusion moves rendered on a layer (drives the move slider). */
  moveCount: (layer: number) => number
  dispose: () => void
}

const TRAVEL_COLOR = 0x6f8194

/**
 * Feature roles whose beads form vertical surfaces (walls, skirt loops, prime tower sides).
 * Their moire fade targets the layer stacking (vertical repetition -> horizontal macro normal);
 * every other role lies flat (top/bottom surfaces, infill, brim, support) and fades against the
 * in-plane bead repetition toward an upright macro normal. Untagged G-code (role 0) is treated
 * as wall since walls dominate the silhouette.
 */
const WALL_ROLES = new Set([0, 1, 2, 3, 11, 15])

/**
 * Build a volumetric extrusion mesh: each segment becomes a boxed ribbon (top + two side faces)
 * at its real width and layer height, vertex-coloured by feature type — so the print reads like
 * Bambu Studio's preview rather than flat lines. Consecutive segments of the same path (shared
 * endpoint, same feature/height, near width) are welded into one continuous tube with a mitered
 * joint ring, every open tube end is capped, and shading uses smooth per-vertex normals — without
 * this, curved walls (arcs tessellated into short segments) show wedge gaps at every bend,
 * see-through holes at line ends, and one visible shading facet per segment. One merged
 * indexed geometry; the layer slider just moves the index draw range (O(1), no rebuilds). Travel
 * moves stay thin lines, hidden by default.
 */
export function buildLayeredGcodePreview(parsed: ParsedGcodeLayers): LayeredGcodePreview {
  const group = new THREE.Group()
  const pos = parsed.extrusionPositions
  const widths = parsed.extrusionWidths
  const heights = parsed.extrusionHeights
  const roles = parsed.extrusionRoles
  const segCount = pos.length / 6 // 2 vertices (6 floats) per segment

  // Each segment is a bead swept along the move: a closed rounded cross-section (flat bottom on
  // the layer below, bevelled/rounded top) extruded from A to B. The cross-section is defined
  // once (perp offset `u` in [-1,1] x halfWidth, height `v` in [0,1] x layerHeight, plus the
  // outward normal of a matching ellipse) and swept. Normals are explicit and SMOOTH: ring
  // vertices shared between welded sections carry the mitered direction, so a curved wall shades
  // continuously like a cylinder instead of showing one facet per G-code segment.
  const PROFILE: ReadonlyArray<readonly [u: number, v: number, nu: number, nv: number]> = [
    [-1.0, 0.0, -0.447, -0.894], [1.0, 0.0, 0.447, -0.894], // flat bottom on the layer below
    [0.88, 0.55, 0.975, 0.222], [0.45, 1.0, 0.22, 0.975],   // right wall + right top slope
    [-0.45, 1.0, -0.22, 0.975], [-0.88, 0.55, -0.975, 0.222] // left top slope + left wall
  ]
  const P = PROFILE.length
  // Welding only reduces ring use; each cap adds one duplicated ring (axial normals) + a fan.
  const positions = new Float32Array(segCount * P * 4 * 3)
  const normals = new Float32Array(segCount * P * 4 * 3)
  const colors = new Float32Array(segCount * P * 4 * 3)
  const macroUps = new Float32Array(segCount * P * 4)
  const indices = new Uint32Array(segCount * (P * 6 + (P - 2) * 6))
  const layerIndexEnd: number[] = []
  // Per emitted move: cumulative index count after it (for within-layer scrubbing), plus the
  // cumulative emitted-move count at the end of each layer (degenerate segments are skipped,
  // so this can differ from the parsed segment count).
  const moveIndexEnd: number[] = []
  const layerMoveEnd: number[] = []
  let vCount = 0
  let iCount = 0

  // Precompute the linear-space RGB for each feature colour (vertex colours bypass sRGB conversion).
  const roleRGB = GCODE_FEATURE_COLORS.map((hex) => {
    const c = new THREE.Color(hex).convertSRGBToLinear()
    return [c.r, c.g, c.b] as const
  })

  let cr = 1, cg = 1, cb = 1
  let macroUp = 0
  const pushVertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    const o = vCount * 3
    positions[o] = x; positions[o + 1] = y; positions[o + 2] = z
    normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz
    colors[o] = cr; colors[o + 1] = cg; colors[o + 2] = cb
    macroUps[vCount] = macroUp
    return vCount++
  }
  const pushQuad = (a: number, b: number, c: number, d: number) => {
    indices[iCount++] = a; indices[iCount++] = b; indices[iCount++] = c
    indices[iCount++] = a; indices[iCount++] = c; indices[iCount++] = d
  }
  /**
   * Close an open tube end: duplicate the ring with flat axial normals (so the cap does not
   * inherit the ring's radial shading) and fan over it. Winding-agnostic via DoubleSide.
   */
  const pushCap = (ringBase: number, nx: number, ny: number) => {
    const base = vCount
    for (let p = 0; p < P; p++) {
      const o = (ringBase + p) * 3
      pushVertex(positions[o]!, positions[o + 1]!, positions[o + 2]!, nx, ny, 0)
    }
    for (let p = 1; p < P - 1; p++) {
      indices[iCount++] = base; indices[iCount++] = base + p; indices[iCount++] = base + p + 1
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

  const WELD_EPSILON = 1e-3 // mm; endpoints of one path come from the same parsed values
  // Bambu varies LINE_WIDTH slightly between wall moves; welds survive small changes by
  // tapering the tube through an averaged joint ring instead of breaking into capped beads.
  const WELD_WIDTH_TOLERANCE = 0.1 // mm
  // Sharper joints than this fall back to capped ends (the miter offset would spike).
  const MITER_DOT_MIN = 0.5

  for (let layer = 0; layer < parsed.layerCount; layer++) {
    const startSeg = (layer > 0 ? parsed.extrusionLayerEnd[layer - 1]! : 0) / 2
    const endSeg = parsed.extrusionLayerEnd[layer]! / 2
    // Ring carried over from the previous segment when it welds into this one.
    let weldRingBase = -1
    for (let seg = startSeg; seg < endSeg; seg++) {
      const o = seg * 6
      const ax = pos[o]!, ay = pos[o + 1]!, az = pos[o + 2]!
      const bx = pos[o + 3]!, by = pos[o + 4]!
      let dx = bx - ax, dy = by - ay
      const len = Math.hypot(dx, dy)
      if (len < 1e-4) { weldRingBase = -1; continue }
      dx /= len; dy /= len
      const nx = -dy, ny = dx // perpendicular unit (in the bed plane)
      const halfW = (widths[seg]! || DEFAULT_EXTRUSION_WIDTH) / 2
      const layerHeight = heights[seg]! || DEFAULT_LAYER_HEIGHT
      const bot = az - layerHeight
      const rgb = roleRGB[roles[seg]!] ?? roleRGB[0]!
      cr = rgb[0]; cg = rgb[1]; cb = rgb[2]
      macroUp = WALL_ROLES.has(roles[seg]!) ? 0 : 1

      // Does the NEXT segment continue this path? (Shared endpoint, same feature/height, a near
      // width, and a joint shallow enough to miter.) If so, the shared ring is emitted once with
      // the mitered perp and reused — the tube stays continuous instead of leaving a wedge gap
      // at the bend; a small width change tapers smoothly through the averaged joint ring.
      let weldNext = false
      let endPx = nx, endPy = ny, endHalfW = halfW
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
          if (nlen >= 1e-4) {
            ndx /= nlen; ndy /= nlen
            let mx = nx + -ndy, my = ny + ndx // sum of the two unit perps
            const mlen = Math.hypot(mx, my)
            if (mlen > 1e-4) {
              mx /= mlen; my /= mlen
              const cosHalf = mx * nx + my * ny
              if (cosHalf > MITER_DOT_MIN) {
                // Widen the joint ring by 1/cos(θ/2) so the bead walls stay flush through the bend.
                weldNext = true
                endPx = mx; endPy = my
                endHalfW = ((widths[seg]! || DEFAULT_EXTRUSION_WIDTH) + (widths[seg + 1]! || DEFAULT_EXTRUSION_WIDTH)) / 4 / cosHalf
              }
            }
          }
        }
      }

      const startBase = weldRingBase >= 0 ? weldRingBase : pushRing(ax, ay, nx, ny, halfW, bot, layerHeight)
      if (weldRingBase < 0) pushCap(startBase, -dx, -dy)
      const endBase = pushRing(bx, by, endPx, endPy, endHalfW, bot, layerHeight)
      if (!weldNext) pushCap(endBase, dx, dy)
      weldRingBase = weldNext ? endBase : -1

      // Connect the two rings into a closed tube (P side quads). Winding-agnostic via DoubleSide.
      for (let p = 0; p < P; p++) {
        const p1 = (p + 1) % P
        pushQuad(startBase + p, endBase + p, endBase + p1, startBase + p1)
      }
      moveIndexEnd.push(iCount)
    }
    layerIndexEnd.push(iCount)
    layerMoveEnd.push(moveIndexEnd.length)
  }

  // Trim to the slots actually used (degenerate segments were skipped) so the bounding box
  // (used for centering/framing) ignores the zeroed tail.
  const extrusionGeometry = new THREE.BufferGeometry()
  extrusionGeometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, vCount * 3), 3))
  extrusionGeometry.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(0, vCount * 3), 3))
  extrusionGeometry.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, vCount * 3), 3))
  extrusionGeometry.setAttribute('aMacroUp', new THREE.BufferAttribute(macroUps.subarray(0, vCount), 1))
  extrusionGeometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, iCount), 1))
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.82, metalness: 0.0 })
  applyMoireFade(material, representativeLayerHeight(heights), medianPositive(widths, DEFAULT_EXTRUSION_WIDTH))
  const extrusion = new THREE.Mesh(extrusionGeometry, material)
  extrusion.frustumCulled = false

  const travelGeometry = new THREE.BufferGeometry()
  travelGeometry.setAttribute('position', new THREE.BufferAttribute(parsed.travelPositions, 3))
  const travel = new THREE.LineSegments(travelGeometry, new THREE.LineBasicMaterial({ color: TRAVEL_COLOR, transparent: true, opacity: 0.45 }))
  travel.frustumCulled = false

  group.add(extrusion)
  group.add(travel)

  const layerMoveCount = (layer: number): number => {
    const clamped = Math.max(0, Math.min(layer, parsed.layerCount - 1))
    const start = clamped > 0 ? layerMoveEnd[clamped - 1]! : 0
    return (layerMoveEnd[clamped] ?? 0) - start
  }

  const setVisibleLayers: LayeredGcodePreview['setVisibleLayers'] = (topLayer, options) => {
    const clamped = Math.max(0, Math.min(topLayer, parsed.layerCount - 1))
    const single = options?.single ?? false
    const start = single && clamped > 0 ? layerIndexEnd[clamped - 1]! : 0
    let end = layerIndexEnd[clamped] ?? 0
    // Truncate the top layer after its first `moveEnd` moves (the within-layer scrub).
    if (options?.moveEnd !== undefined && options.moveEnd < layerMoveCount(clamped)) {
      const firstMove = clamped > 0 ? layerMoveEnd[clamped - 1]! : 0
      const lastMove = firstMove + Math.max(0, Math.floor(options.moveEnd)) - 1
      end = lastMove >= firstMove
        ? moveIndexEnd[lastMove]!
        : (clamped > 0 ? layerIndexEnd[clamped - 1]! : 0)
    }
    extrusionGeometry.setDrawRange(start, Math.max(0, end - start))

    if (options?.showTravel) {
      const travelStart = clamped > 0 ? parsed.travelLayerEnd[clamped - 1]! : 0
      const travelEnd = parsed.travelLayerEnd[clamped] ?? 0
      travel.visible = travelEnd > travelStart
      travelGeometry.setDrawRange(travelStart, Math.max(0, travelEnd - travelStart))
    } else {
      travel.visible = false
    }
  }
  // Default: whole print, no travel moves.
  setVisibleLayers(parsed.layerCount - 1)

  return {
    object: group,
    layerCount: parsed.layerCount,
    setVisibleLayers,
    moveCount: layerMoveCount,
    dispose: () => {
      extrusionGeometry.dispose()
      travelGeometry.dispose()
      ;(extrusion.material as THREE.Material).dispose()
      ;(travel.material as THREE.Material).dispose()
    }
  }
}
