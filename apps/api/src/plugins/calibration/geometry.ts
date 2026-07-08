/**
 * Procedural test geometry for the calibration plugin.
 *
 * Calibration prints are trivial shapes, so rather than vendor BambuStudio's
 * AGPL calibration models we generate our own axis-aligned box meshes here and
 * let the normal 3MF builder + slicer do the rest:
 *
 * - a **flow-ratio plate** is a row of flat square patches, one per flow offset,
 *   each sliced with its own `print_flow_ratio` (the smoothest top surface wins);
 * - a **pressure-advance tower** is one tall square-section prism whose corners
 *   reveal ringing as K is stepped once per mm of Z via injected layer G-code.
 *
 * Output meshes are plain indexed triangle soup in the same minimal shape the
 * editor's importer produces ({@link ImportedMesh}: flat `positions`/`indices` +
 * an AABB), positioned in plate-local millimetres with the base at z = 0, so the
 * 3MF builder can bake them as ordinary objects.
 */
import type { ImportedMesh } from '../../lib/mesh-import.js'

/** Millimetre footprint + height of a generated box. */
export interface BoxDimensions {
  width: number
  depth: number
  height: number
}

/**
 * A closed, outward-wound axis-aligned box. `centerX`/`centerY` place the
 * footprint centre in plate-local millimetres; the base sits on z = 0.
 */
export function boxMesh(dimensions: BoxDimensions, centerX = 0, centerY = 0): ImportedMesh {
  const { width, depth, height } = dimensions
  const x0 = centerX - width / 2
  const x1 = centerX + width / 2
  const y0 = centerY - depth / 2
  const y1 = centerY + depth / 2
  const z0 = 0
  const z1 = height

  // 8 corners: 0-3 bottom (z0), 4-7 top (z1), CCW in XY.
  const positions = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1
  ]
  // 12 triangles, outward-facing (CCW seen from outside each face).
  const indices = [
    0, 2, 1, 0, 3, 2, // bottom (-Z)
    4, 5, 6, 4, 6, 7, // top (+Z)
    0, 1, 5, 0, 5, 4, // front (-Y)
    2, 3, 7, 2, 7, 6, // back (+Y)
    0, 4, 7, 0, 7, 3, // left (-X)
    1, 2, 6, 1, 6, 5 // right (+X)
  ]

  return {
    positions,
    indices,
    bounds: { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } }
  }
}

/**
 * OrcaSlicer's pressure-advance tower footprint (mm, centred at origin), taken verbatim from its
 * `tower_with_seam.drc` calibration model. A 70x70 hexagonal prism whose front comes to a point at
 * -Y (for orientation and a sharp direction change) with a flat rear at +Y where the seam is placed.
 * Vertices are ordered counter-clockwise.
 */
const PA_TOWER_FOOTPRINT: ReadonlyArray<readonly [number, number]> = [
  [35, 0], [35, 34.75], [0, 35], [-35, 34.75], [-35, 0], [0, -35]
]

/**
 * A closed, outward-wound vertical prism extruded from a convex, counter-clockwise 2D footprint,
 * with the base on z = 0. Caps are fan-triangulated (valid for convex footprints).
 */
export function polygonPrism(footprint: ReadonlyArray<readonly [number, number]>, height: number): ImportedMesh {
  const n = footprint.length
  const positions: number[] = []
  for (const [x, y] of footprint) positions.push(x, y, 0) // bottom ring: 0..n-1
  for (const [x, y] of footprint) positions.push(x, y, height) // top ring: n..2n-1

  const indices: number[] = []
  for (let i = 1; i < n - 1; i++) {
    indices.push(0, i + 1, i) // bottom cap (-Z outward)
    indices.push(n, n + i, n + i + 1) // top cap (+Z outward)
  }
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n
    indices.push(i, next, n + next, i, n + next, n + i) // side wall, outward
  }

  const xs = footprint.map(([x]) => x)
  const ys = footprint.map(([, y]) => y)
  return {
    positions,
    indices,
    bounds: {
      min: { x: Math.min(...xs), y: Math.min(...ys), z: 0 },
      max: { x: Math.max(...xs), y: Math.max(...ys), z: height }
    }
  }
}

/** One flow-ratio patch: its box mesh and the flow offset (percent) it prints at. */
export interface FlowPatch {
  offsetPercent: number
  mesh: ImportedMesh
}

export interface FlowPlateOptions {
  /** Patch side length in mm (square footprint). */
  patchSize?: number
  /** Patch height in mm (a few solid top layers make the surface readable). */
  patchHeight?: number
  /** Gap between patches in mm. */
  gap?: number
  /** Max columns before wrapping to a new row; defaults to a near-square grid. */
  columns?: number
}

/**
 * Lay the given flow offsets out as a centred grid of square patches (a single
 * row of 9-10 patches would overflow a 256 mm bed). Each patch is returned with
 * its offset so the caller can apply a matching `print_flow_ratio` per object.
 * Patches are ordered left-to-right, top row first, so the printed grid reads in
 * the same order as `offsets`.
 */
export function flowRatioPlate(offsets: readonly number[], options: FlowPlateOptions = {}): FlowPatch[] {
  const patchSize = options.patchSize ?? 20
  const patchHeight = options.patchHeight ?? 1.2
  const gap = options.gap ?? 4
  const columns = options.columns ?? Math.min(offsets.length, Math.ceil(Math.sqrt(offsets.length)))
  const rows = Math.ceil(offsets.length / columns)
  const pitch = patchSize + gap
  const gridWidth = columns * pitch - gap
  const gridDepth = rows * pitch - gap
  const startX = -gridWidth / 2 + patchSize / 2
  // Top row first: start at the +Y edge and step toward -Y.
  const startY = gridDepth / 2 - patchSize / 2

  return offsets.map((offsetPercent, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    return {
      offsetPercent,
      mesh: boxMesh({ width: patchSize, depth: patchSize, height: patchHeight }, startX + col * pitch, startY - row * pitch)
    }
  })
}

export interface PaTowerOptions {
  /** Extra base height in mm below where K starts stepping. */
  baseHeight?: number
}

export interface PaTower {
  mesh: ImportedMesh
  /** Total tower height in mm. */
  heightMm: number
  /** Z (mm) where K begins stepping (top of the base). */
  bandStartZ: number
}

/**
 * OrcaSlicer's pressure-advance tower ({@link PA_TOWER_FOOTPRINT}), sized so K sweeps from `startK`
 * to `endK` at `step` per mm of Z. Height above the base equals the number of K steps in mm, so a
 * measured band height reads back the K directly (matching BambuStudio/Orca's tower where K is set
 * once per millimetre of Z).
 */
export function pressureAdvanceTower(
  startK: number,
  endK: number,
  step: number,
  options: PaTowerOptions = {}
): PaTower {
  const baseHeight = options.baseHeight ?? 0
  const bandMm = Math.max(1, Math.ceil((endK - startK) / step))
  const heightMm = baseHeight + bandMm
  return {
    mesh: polygonPrism(PA_TOWER_FOOTPRINT, heightMm),
    heightMm,
    bandStartZ: baseHeight
  }
}
