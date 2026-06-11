/**
 * Support-paint helpers (Bambu Studio's "support painting" brush) for the editor.
 *
 * Owns the pure brush/overlay logic so `EditorView` only wires pointer events:
 * - per-triangle scan data (centroids + face normals) cached on the geometry,
 * - the brush application (sphere select + front-facing filter) over a paint map,
 * - the painted-triangle overlay mesh build.
 *
 * Paint codes use the Bambu/PrusaSlicer `paint_supports` encoding: `'4'` is a
 * whole-triangle support enforcer, `'8'` a whole-triangle blocker; longer hex strings
 * are sub-triangle split codes from the source file, which the editor preserves and
 * re-emits verbatim but does not author (the brush paints whole triangles). All
 * geometry handled here is the editor's non-indexed mesh output, where triangle `i`
 * occupies position floats `[i*9, i*9+9)` and matches source-mesh triangle `i`.
 */
import * as THREE from 'three'
import type { SupportPaintCodes } from './threeMfScene'
import {
  createCircleCursor,
  createHeightRangeCursor,
  createSphereCursor,
  decodePaintTree,
  encodePaintTree,
  isPaintTreeEmpty,
  paintTreeWithBrush,
  walkPaintTree,
  type PaintCursor,
  type PaintTreeNode,
  type PaintVec3
} from './trianglePaintTree'

export const SUPPORT_PAINT_ENFORCER_CODE = '4'
export const SUPPORT_PAINT_BLOCKER_CODE = '8'

export type SupportPaintBrushMode = 'enforcer' | 'blocker' | 'eraser'
/** Brush cursor shape: Bambu's sphere or its view-aligned circle (cylinder) cursor. */
export type SupportPaintBrushShape = 'sphere' | 'circle'

export interface PaintPalette {
  enforcer: number
  blocker: number
  /**
   * Sub-triangle split codes carried over from the source file: shown as a single
   * blended tint since the editor doesn't decode per-subtriangle states.
   */
  mixed: number
}

/** Support-paint colours, approximating BambuStudio's enforcer blue / blocker red. */
export const SUPPORT_PAINT_COLORS: PaintPalette = {
  enforcer: 0x3a62e0,
  blocker: 0xd24a4a,
  mixed: 0x8a63d6
}

/** Seam-paint colours: green forces the seam here, orange blocks it. */
export const SEAM_PAINT_COLORS: PaintPalette = {
  enforcer: 0x2fae6a,
  blocker: 0xe08a2a,
  mixed: 0x8a63d6
}

export interface TriangleScanData {
  count: number
  /** The source non-indexed position stream (9 floats per triangle), geometry-local. */
  positions: Float32Array
  /** Per-triangle centroid xyz, geometry-local. */
  centroids: Float32Array
  /** Per-triangle unit face normal xyz, geometry-local. */
  normals: Float32Array
  /** Per-triangle bounding radius (max centroid->vertex distance) for the broad phase. */
  boundRadii: Float32Array
  /** Lazily built edge adjacency (see {@link getTriangleAdjacency}). */
  adjacency?: Int32Array
}

/**
 * Per-edge triangle adjacency for a scan, built once and cached on it: entry
 * `[i*3 + side]` is the triangle sharing side `side` of triangle `i` (sides follow the
 * vertex order: 0 = v0v1, 1 = v1v2, 2 = v2v0), or -1 at open/non-manifold edges.
 * Vertices are matched by exact float32 position (the editor's non-indexed streams come
 * from indexed sources, so shared corners are bit-identical).
 */
export function getTriangleAdjacency(scan: TriangleScanData): Int32Array {
  if (scan.adjacency) return scan.adjacency
  const adjacency = new Int32Array(scan.count * 3).fill(-1)
  const vertexIds = new Map<string, number>()
  const cornerIds = new Int32Array(scan.count * 3)
  for (let corner = 0; corner < scan.count * 3; corner += 1) {
    const o = corner * 3
    const key = `${scan.positions[o]},${scan.positions[o + 1]},${scan.positions[o + 2]}`
    let id = vertexIds.get(key)
    if (id === undefined) {
      id = vertexIds.size
      vertexIds.set(key, id)
    }
    cornerIds[corner] = id
  }
  // First face+side seen for each undirected edge; the second match links both ways.
  const edgeOwner = new Map<string, number>()
  for (let face = 0; face < scan.count; face += 1) {
    for (let side = 0; side < 3; side += 1) {
      const a = cornerIds[face * 3 + side]!
      const b = cornerIds[face * 3 + ((side + 1) % 3)]!
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      const owner = edgeOwner.get(key)
      if (owner === undefined) {
        edgeOwner.set(key, face * 3 + side)
      } else if (owner >= 0) {
        adjacency[owner] = face
        adjacency[face * 3 + side] = Math.floor(owner / 3)
        edgeOwner.set(key, -1) // non-manifold third face: leave further sides open
      }
    }
  }
  scan.adjacency = adjacency
  return adjacency
}

/** Build brush scan data from a non-indexed position array (9 floats per triangle). */
export function buildTriangleScanData(positions: ArrayLike<number>): TriangleScanData {
  const count = Math.floor(positions.length / 9)
  const positionArray = positions instanceof Float32Array ? positions : Float32Array.from(positions)
  const centroids = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const boundRadii = new Float32Array(count)
  const edgeAB = new THREE.Vector3()
  const edgeAC = new THREE.Vector3()
  const normal = new THREE.Vector3()
  for (let i = 0; i < count; i += 1) {
    const o = i * 9
    const ax = positionArray[o]!; const ay = positionArray[o + 1]!; const az = positionArray[o + 2]!
    const bx = positionArray[o + 3]!; const by = positionArray[o + 4]!; const bz = positionArray[o + 5]!
    const cx = positionArray[o + 6]!; const cy = positionArray[o + 7]!; const cz = positionArray[o + 8]!
    const mx = (ax + bx + cx) / 3
    const my = (ay + by + cy) / 3
    const mz = (az + bz + cz) / 3
    centroids[i * 3] = mx
    centroids[i * 3 + 1] = my
    centroids[i * 3 + 2] = mz
    boundRadii[i] = Math.sqrt(Math.max(
      (ax - mx) ** 2 + (ay - my) ** 2 + (az - mz) ** 2,
      (bx - mx) ** 2 + (by - my) ** 2 + (bz - mz) ** 2,
      (cx - mx) ** 2 + (cy - my) ** 2 + (cz - mz) ** 2
    ))
    edgeAB.set(bx - ax, by - ay, bz - az)
    edgeAC.set(cx - ax, cy - ay, cz - az)
    normal.crossVectors(edgeAB, edgeAC)
    if (normal.lengthSq() > 1e-12) normal.normalize()
    normals[i * 3] = normal.x
    normals[i * 3 + 1] = normal.y
    normals[i * 3 + 2] = normal.z
  }
  return { count, positions: positionArray, centroids, normals, boundRadii }
}

/** Scan data for a mesh's geometry, built once and cached on `geometry.userData`. */
export function getTriangleScanData(geometry: THREE.BufferGeometry): TriangleScanData | null {
  const cached = (geometry.userData as { supportPaintScan?: TriangleScanData }).supportPaintScan
  if (cached) return cached
  if (geometry.index) return null // editor meshes are non-indexed; bail rather than misindex
  const positions = geometry.getAttribute('position')
  if (!positions) return null
  const scan = buildTriangleScanData(positions.array as ArrayLike<number>)
  geometry.userData.supportPaintScan = scan
  return scan
}

/** Read triangle `i`'s vertices out of a scan's position stream. */
function scanTriangleVertices(scan: TriangleScanData, i: number): [PaintVec3, PaintVec3, PaintVec3] {
  const o = i * 9
  return [
    { x: scan.positions[o]!, y: scan.positions[o + 1]!, z: scan.positions[o + 2]! },
    { x: scan.positions[o + 3]!, y: scan.positions[o + 4]!, z: scan.positions[o + 5]! },
    { x: scan.positions[o + 6]!, y: scan.positions[o + 7]!, z: scan.positions[o + 8]! }
  ]
}

/**
 * Paint one triangle's tree with a cursor (decode -> paintTreeWithBrush -> re-encode),
 * mutating `codes`. Returns whether the stored code changed.
 */
function paintTriangleWithCursor(
  codes: SupportPaintCodes,
  scan: TriangleScanData,
  i: number,
  cursor: PaintCursor,
  state: number
): boolean {
  const existingCode = codes[i]
  const existing: PaintTreeNode = (existingCode ? decodePaintTree(existingCode) : null) ?? { kind: 'leaf', state: 0 }
  const painted = paintTreeWithBrush(existing, scanTriangleVertices(scan, i), cursor, state)
  if (isPaintTreeEmpty(painted)) {
    if (existingCode != null) {
      delete codes[i]
      return true
    }
    return false
  }
  const nextCode = encodePaintTree(painted)
  if (nextCode !== existingCode) {
    codes[i] = nextCode
    return true
  }
  return false
}

/** Set/clear one whole triangle's paint state, mutating `codes`. Returns changed. */
function setWholeTriangleState(codes: SupportPaintCodes, i: number, state: number): boolean {
  if (state <= 0) {
    if (codes[i] == null) return false
    delete codes[i]
    return true
  }
  const code = encodePaintTree({ kind: 'leaf', state })
  if (codes[i] === code) return false
  codes[i] = code
  return true
}

/**
 * Apply one brush dab to a paint-code map (mutated in place), mirroring
 * TriangleSelector::select_patch. The cursor is a sphere around the hit point or
 * Bambu's circle (an infinite cylinder around the pointer ray); partially covered
 * triangles split to `min(radius/5, 0.2mm)` edges so the result follows the brush.
 * Returns whether anything changed. All inputs are geometry-local; the caller converts
 * the world-space hit point/ray and brush radius.
 *
 * When `seedTriangle` is given, the dab grows breadth-first from the hit triangle over
 * shared edges, enqueueing only viewer-facing neighbours (`normal · direction < 0`) —
 * Bambu's rule, which keeps the brush off disconnected geometry that merely falls
 * inside the cursor (essential for the infinite circle cylinder). Without a seed every
 * facing triangle is tested directly (centroid broad phase + exact cursor test).
 */
export function applySupportPaintBrush(options: {
  codes: SupportPaintCodes
  scan: TriangleScanData
  point: { x: number; y: number; z: number }
  direction: { x: number; y: number; z: number }
  radius: number
  mode: SupportPaintBrushMode
  /** Explicit paint state (colour channel: the 1-based filament id). */
  state?: number
  shape?: SupportPaintBrushShape
  /** Triangle index under the pointer; enables Bambu's connectivity-limited growth. */
  seedTriangle?: number
  /**
   * Per-triangle eligibility (Bambu's highlight_by_angle "on overhangs only"):
   * ineligible facets are neither painted nor propagated through.
   */
  triangleAllowed?: (index: number) => boolean
  /**
   * Edge detection: stop BFS growth across edges where neighbouring face normals
   * differ by more than this angle (deg), so strokes stay on the clicked face.
   */
  propagationAngleDeg?: number
}): boolean {
  const { codes, scan, point, direction, radius, mode } = options
  const paintState = mode === 'eraser' ? 0 : options.state ?? (mode === 'enforcer' ? 1 : 2)
  // Bambu's split refinement: edges longer than min(radius/5, 0.2mm) keep splitting,
  // so stroke boundaries follow the brush instead of stair-stepping.
  const edgeLimit = Math.min(radius / 5, 0.2)
  const cursor = options.shape === 'circle'
    ? createCircleCursor(point, direction, radius, edgeLimit)
    : createSphereCursor(point, radius, edgeLimit)

  const intersectsCursor = (i: number): boolean => {
    const vertices = scanTriangleVertices(scan, i)
    return cursor.containsPoint(vertices[0]) || cursor.containsPoint(vertices[1]) ||
      cursor.containsPoint(vertices[2]) || cursor.touchesTriangle(vertices)
  }
  const isFacing = (i: number): boolean =>
    scan.normals[i * 3]! * direction.x
      + scan.normals[i * 3 + 1]! * direction.y
      + scan.normals[i * 3 + 2]! * direction.z < 0

  const allowed = options.triangleAllowed
  const propagationLimit = options.propagationAngleDeg != null
    ? Math.cos((options.propagationAngleDeg * Math.PI) / 180) - 1e-7
    : null
  let changed = false
  const seed = options.seedTriangle
  if (seed != null && seed >= 0 && seed < scan.count) {
    const adjacency = getTriangleAdjacency(scan)
    const visited = new Uint8Array(scan.count)
    const queue: number[] = [seed]
    visited[seed] = 1
    while (queue.length > 0) {
      const face = queue.pop()!
      // Ineligible facets (e.g. not an overhang) block both paint and growth, like
      // Bambu's highlight_by_angle gate in select_patch.
      if (allowed && !allowed(face)) continue
      if (!intersectsCursor(face)) continue
      if (paintTriangleWithCursor(codes, scan, face, cursor, paintState)) changed = true
      for (let side = 0; side < 3; side += 1) {
        const neighbor = adjacency[face * 3 + side]!
        if (neighbor < 0 || visited[neighbor] || !isFacing(neighbor)) continue
        if (propagationLimit != null) {
          const dot = scan.normals[face * 3]! * scan.normals[neighbor * 3]!
            + scan.normals[face * 3 + 1]! * scan.normals[neighbor * 3 + 1]!
            + scan.normals[face * 3 + 2]! * scan.normals[neighbor * 3 + 2]!
          if (Math.min(Math.max(dot, 0), 1) < propagationLimit) continue
        }
        visited[neighbor] = 1
        queue.push(neighbor)
      }
    }
    return changed
  }

  for (let i = 0; i < scan.count; i += 1) {
    if (!isFacing(i)) continue
    if (allowed && !allowed(i)) continue
    // Broad phase: the cursor cannot touch a triangle whose centroid is farther from
    // the brush centre/axis than the radius plus the triangle's own bounding radius.
    const dx = scan.centroids[i * 3]! - point.x
    const dy = scan.centroids[i * 3 + 1]! - point.y
    const dz = scan.centroids[i * 3 + 2]! - point.z
    const reach = radius + scan.boundRadii[i]!
    let centroidDistSq = dx * dx + dy * dy + dz * dz
    if (options.shape === 'circle') {
      const along = dx * direction.x + dy * direction.y + dz * direction.z
      centroidDistSq -= along * along
    }
    if (centroidDistSq > reach * reach) continue
    if (!intersectsCursor(i)) continue
    if (paintTriangleWithCursor(codes, scan, i, cursor, paintState)) changed = true
  }
  return changed
}

/**
 * Smart fill (TriangleSelector::seed_fill_select_triangles): flood out from the hit
 * triangle across shared edges while neighbouring face normals stay within
 * `angleDeg` of each other (`clamp(n1·n2, 0, 1) >= cos(angleDeg)`), painting whole
 * source triangles. `state` 0 erases the region. Returns whether anything changed.
 */
export function applySmartFill(options: {
  codes: SupportPaintCodes
  scan: TriangleScanData
  seedTriangle: number
  angleDeg: number
  state: number
  /** Per-triangle eligibility (e.g. "on overhangs only"); blocks paint and growth. */
  triangleAllowed?: (index: number) => boolean
}): boolean {
  const { codes, scan, seedTriangle, state } = options
  if (seedTriangle < 0 || seedTriangle >= scan.count) return false
  const adjacency = getTriangleAdjacency(scan)
  const angleLimit = Math.cos((options.angleDeg * Math.PI) / 180) - 1e-7
  const visited = new Uint8Array(scan.count)
  const queue: number[] = [seedTriangle]
  visited[seedTriangle] = 1
  let changed = false
  while (queue.length > 0) {
    const face = queue.pop()!
    if (options.triangleAllowed && !options.triangleAllowed(face)) continue
    if (setWholeTriangleState(codes, face, state)) changed = true
    const nx = scan.normals[face * 3]!
    const ny = scan.normals[face * 3 + 1]!
    const nz = scan.normals[face * 3 + 2]!
    for (let side = 0; side < 3; side += 1) {
      const neighbor = adjacency[face * 3 + side]!
      if (neighbor < 0 || visited[neighbor]) continue
      const dot = nx * scan.normals[neighbor * 3]!
        + ny * scan.normals[neighbor * 3 + 1]!
        + nz * scan.normals[neighbor * 3 + 2]!
      if (Math.min(Math.max(dot, 0), 1) >= angleLimit) {
        visited[neighbor] = 1
        queue.push(neighbor)
      }
    }
  }
  return changed
}

/** Paint or erase exactly one whole source triangle (Bambu's MMU "Triangles" tool). */
export function applySingleTrianglePaint(options: {
  codes: SupportPaintCodes
  seedTriangle: number
  state: number
}): boolean {
  if (options.seedTriangle < 0) return false
  return setWholeTriangleState(options.codes, options.seedTriangle, options.state)
}

/**
 * A triangle's whole-facet paint state for bucket-fill region matching: 0 when
 * unpainted, the decoded state for whole-triangle codes, and null for sub-triangle
 * split codes (mixed facets act as region boundaries).
 */
function wholeTriangleState(code: string | undefined): number | null {
  if (code == null) return 0
  return decodeWholeTriangleColorState(code)
}

/**
 * Bucket fill (Bambu's MMU "Fill" tool): flood out from the hit triangle across
 * shared edges while neighbours carry the SAME paint state as the seed (an
 * unpainted region floods unpainted neighbours; a red region floods red ones),
 * repainting the region to `state`. Mixed (split-code) facets bound the region.
 */
export function applyBucketFill(options: {
  codes: SupportPaintCodes
  scan: TriangleScanData
  seedTriangle: number
  state: number
}): boolean {
  const { codes, scan, seedTriangle, state } = options
  if (seedTriangle < 0 || seedTriangle >= scan.count) return false
  const seedState = wholeTriangleState(codes[seedTriangle])
  if (seedState == null || seedState === state) return false
  const adjacency = getTriangleAdjacency(scan)
  const visited = new Uint8Array(scan.count)
  const queue: number[] = [seedTriangle]
  visited[seedTriangle] = 1
  let changed = false
  while (queue.length > 0) {
    const face = queue.pop()!
    if (setWholeTriangleState(codes, face, state)) changed = true
    for (let side = 0; side < 3; side += 1) {
      const neighbor = adjacency[face * 3 + side]!
      if (neighbor < 0 || visited[neighbor]) continue
      // Compare against the PRE-fill state: painted faces were just rewritten, but
      // unvisited neighbours still hold their original code.
      if (wholeTriangleState(codes[neighbor]) === seedState) {
        visited[neighbor] = 1
        queue.push(neighbor)
      }
    }
  }
  return changed
}

/**
 * Height-range paint (TriangleSelector's HeightRange cursor): paint every triangle
 * crossing the world-z band `[zBottom, zTop]`, splitting at the band planes with
 * Bambu's fixed fine edge limit (0.1mm world) so the edges come out crisp. Unlike the
 * brush this ignores facing and connectivity — the band wraps the whole part.
 * `localToWorld` maps geometry-local points to world (the caller passes the mesh's
 * matrixWorld); `averageScale` converts the world edge limit to local units.
 */
export function applyHeightRangePaint(options: {
  codes: SupportPaintCodes
  scan: TriangleScanData
  zBottom: number
  zTop: number
  state: number
  localToWorld: THREE.Matrix4
  averageScale: number
}): boolean {
  const { codes, scan, zBottom, zTop, state } = options
  const elements = options.localToWorld.elements
  const worldZ = (p: PaintVec3): number =>
    elements[2]! * p.x + elements[6]! * p.y + elements[10]! * p.z + elements[14]!
  const cursor = createHeightRangeCursor(worldZ, zBottom, zTop, 0.1 / (options.averageScale || 1))
  let changed = false
  for (let i = 0; i < scan.count; i += 1) {
    const vertices = scanTriangleVertices(scan, i)
    if (!cursor.touchesTriangle(vertices)) continue
    if (paintTriangleWithCursor(codes, scan, i, cursor, state)) changed = true
  }
  return changed
}

/** Overlay lift along the face normal (mm); see the z-fighting note in the builder. */
const PAINT_OVERLAY_LIFT = 0.05

export const SUPPORT_PAINT_OVERLAY_NAME = 'supportPaintOverlay'
export const SEAM_PAINT_OVERLAY_NAME = 'seamPaintOverlay'

/**
 * Build the painted-triangle overlay for a mesh: a vertex-coloured copy of just the
 * painted triangles, pulled toward the camera with polygon offset so it tints the
 * surface without z-fighting. Returns null when nothing is painted. `options` selects
 * the channel's palette/name and a polygon-offset factor (a more negative factor draws
 * that channel's overlay above the other's when a triangle carries both paints).
 */
/**
 * Decode a whole-triangle mmu colour-paint code to its 1-based filament id, or null for
 * sub-triangle split codes (rendered as mixed). The serialized hex string is consumed
 * REVERSED, nibble bits are `xxyy` with `yy` = split sides (0 for leaves) and `xx` =
 * state; `xx == 3` marks an extension where the next consumed nibble holds `state - 3`.
 * So filament 1 -> '4', 2 -> '8', 3 -> '0C', 4 -> '1C', ...
 */
export function decodeWholeTriangleColorState(code: string): number | null {
  const upper = code.toUpperCase()
  if (upper.length === 1) {
    const nibble = Number.parseInt(upper, 16)
    if (!Number.isFinite(nibble) || (nibble & 0b11) !== 0) return null
    const state = nibble >> 2
    return state >= 1 && state <= 2 ? state : null
  }
  if (upper.length === 2 && upper[1] === 'C') {
    const extra = Number.parseInt(upper[0]!, 16)
    return Number.isFinite(extra) ? extra + 3 : null
  }
  return null
}

/** Inverse of {@link decodeWholeTriangleColorState}: whole-triangle code for a filament. */
export function encodeWholeTriangleColorState(filamentId: number): string | null {
  if (!Number.isInteger(filamentId) || filamentId < 1 || filamentId > 15) return null
  if (filamentId <= 2) return (filamentId << 2).toString(16).toUpperCase()
  return `${(filamentId - 3).toString(16).toUpperCase()}C`
}

export function buildTrianglePaintOverlay(
  geometry: THREE.BufferGeometry,
  codes: SupportPaintCodes,
  options: { palette: PaintPalette; name: string; offsetFactor: number; colorForState?: (state: number) => number | null }
): THREE.Mesh | null {
  if (geometry.index) return null
  const sourcePositions = geometry.getAttribute('position')
  if (!sourcePositions) return null
  const triangleCount = Math.floor(sourcePositions.count / 3)
  const sourceArray = sourcePositions.array as Float32Array

  // Decode every painted triangle's tree and collect painted leaf sub-triangles.
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const color = new THREE.Color()
  const edgeAB = new THREE.Vector3()
  const edgeAC = new THREE.Vector3()
  const faceNormal = new THREE.Vector3()
  const stateColor = (state: number): number => {
    const custom = options.colorForState?.(state)
    if (custom != null) return custom
    return state === 1 ? options.palette.enforcer : state === 2 ? options.palette.blocker : options.palette.mixed
  }
  for (const key of Object.keys(codes)) {
    const triangle = Number.parseInt(key, 10)
    if (!Number.isInteger(triangle) || triangle < 0 || triangle >= triangleCount) continue
    const tree = decodePaintTree(codes[triangle]!)
    if (!tree) continue
    const o = triangle * 9
    const vertices: [PaintVec3, PaintVec3, PaintVec3] = [
      { x: sourceArray[o]!, y: sourceArray[o + 1]!, z: sourceArray[o + 2]! },
      { x: sourceArray[o + 3]!, y: sourceArray[o + 4]!, z: sourceArray[o + 5]! },
      { x: sourceArray[o + 6]!, y: sourceArray[o + 7]!, z: sourceArray[o + 8]! }
    ]
    edgeAB.set(vertices[1].x - vertices[0].x, vertices[1].y - vertices[0].y, vertices[1].z - vertices[0].z)
    edgeAC.set(vertices[2].x - vertices[0].x, vertices[2].y - vertices[0].y, vertices[2].z - vertices[0].z)
    faceNormal.crossVectors(edgeAB, edgeAC)
    if (faceNormal.lengthSq() > 1e-12) faceNormal.normalize()
    walkPaintTree(tree, vertices, (state, leaf) => {
      if (state <= 0) return
      color.setHex(stateColor(state))
      for (const vertex of leaf) {
        // Lift the overlay slightly off the surface along the face normal: both
        // viewers render with a logarithmic depth buffer, which writes gl_FragDepth
        // and so BYPASSES polygonOffset — without the physical lift the overlay
        // z-fights the base mesh into stripes.
        positions.push(
          vertex.x + faceNormal.x * PAINT_OVERLAY_LIFT,
          vertex.y + faceNormal.y * PAINT_OVERLAY_LIFT,
          vertex.z + faceNormal.z * PAINT_OVERLAY_LIFT
        )
        normals.push(faceNormal.x, faceNormal.y, faceNormal.z)
        colors.push(color.r, color.g, color.b)
      }
    })
  }
  if (positions.length === 0) return null

  const overlayGeometry = new THREE.BufferGeometry()
  overlayGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  overlayGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3))
  overlayGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
  const overlay = new THREE.Mesh(
    overlayGeometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: options.offsetFactor,
      polygonOffsetUnits: options.offsetFactor
    })
  )
  overlay.name = options.name
  overlay.renderOrder = 1
  return overlay
}
