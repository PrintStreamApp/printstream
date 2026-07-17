/**
 * Plane cut for editor objects (the editor's Cut tool, #28).
 *
 * Pure geometry: a world-space triangle soup is cut by a horizontal plane `z = cutZ` into an
 * upper and a lower half, and each open cross-section is capped (multiple loops and holes
 * supported) so both halves stay solid, sliceable meshes. The halves are serialized as binary
 * STL and staged through the editor's existing foreign-import endpoint, so the backend bakes
 * them into the 3MF exactly like any imported model — no new API surface.
 *
 * Caps only form where the cross-section's boundary chains close; an unclosed chain (a hole in
 * a broken source mesh) is skipped rather than failing the cut.
 */
import * as THREE from 'three'

export interface CutHalves {
  /** Triangle soup (9 floats per triangle) at or above the plane. Empty when nothing is above. */
  upper: Float32Array
  /** Triangle soup at or below the plane. Empty when nothing is below. */
  lower: Float32Array
}

/** Distance (mm) within which a vertex counts as lying on the cut plane. */
const PLANE_EPSILON = 1e-5
/** Quantization (mm) used to match boundary-segment endpoints when chaining cap loops. */
const CHAIN_QUANTUM = 1e-4

/**
 * Collect the world-space triangle soup of every model mesh under `root`, skipping editor
 * decorations (face-hull overlays, paint-tint overlays, modifier meshes, prime towers) and
 * non-mesh helpers. Paint overlays are real meshes parented under the part mesh, so without
 * the skip a painted object's painted triangles would be collected twice.
 * `includeModifierVolumes` keeps helper volumes (negative/modifier/blocker/enforcer meshes)
 * in the soup — used when a specific part is exported deliberately, never for the solid
 * geometry walks (cut/split/assemble/whole-object export).
 */
export function collectWorldTriangles(
  root: THREE.Object3D,
  options?: { includeModifierVolumes?: boolean }
): Float32Array {
  root.updateWorldMatrix(true, true)
  const chunks: Float32Array[] = []
  let total = 0
  const vertex = new THREE.Vector3()
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.isFaceHull || mesh.userData.isPaintOverlay || mesh.userData.isPrimeTower) return
    if (mesh.userData.isModifier && !options?.includeModifierVolumes) return
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) return
    const index = geometry.getIndex()
    const vertexCount = index ? index.count : position.count
    const out = new Float32Array(vertexCount * 3)
    for (let i = 0; i < vertexCount; i++) {
      const v = index ? index.getX(i) : i
      vertex.set(position.getX(v), position.getY(v), position.getZ(v)).applyMatrix4(mesh.matrixWorld)
      out[i * 3] = vertex.x; out[i * 3 + 1] = vertex.y; out[i * 3 + 2] = vertex.z
    }
    chunks.push(out)
    total += out.length
  })
  const soup = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) { soup.set(chunk, offset); offset += chunk.length }
  return soup
}

/** Axis a cut plane is perpendicular to. */
export type CutAxis = 'x' | 'y' | 'z'

/**
 * Cut a triangle soup with the plane `axis = value` and cap both cross-sections. `upper` is the
 * half on the positive side of the axis. Non-Z axes are handled by cyclically rotating the
 * coordinates into the Z frame (a proper rotation, so winding/normals are preserved), cutting,
 * and rotating back.
 */
export function cutTriangleSoup(soup: Float32Array, axis: CutAxis, value: number): CutHalves {
  if (axis === 'z') return cutTriangleSoupAtZ(soup, value)
  const { upper, lower } = cutTriangleSoupAtZ(cycleAxes(soup, axis === 'x' ? 1 : 2), value)
  const back = axis === 'x' ? 2 : 1
  return { upper: cycleAxes(upper, back), lower: cycleAxes(lower, back) }
}

/**
 * Cyclically permute every vertex's coordinates `steps` times: one step maps (x,y,z) -> (y,z,x).
 * One step brings X into the Z slot; two steps bring Y into the Z slot. Returns a new array.
 */
function cycleAxes(soup: Float32Array, steps: 1 | 2): Float32Array {
  const out = new Float32Array(soup.length)
  for (let i = 0; i < soup.length; i += 3) {
    if (steps === 1) { out[i] = soup[i + 1]!; out[i + 1] = soup[i + 2]!; out[i + 2] = soup[i]! }
    else { out[i] = soup[i + 2]!; out[i + 1] = soup[i]!; out[i + 2] = soup[i + 1]! }
  }
  return out
}

/** Cut a triangle soup with the horizontal plane `z = cutZ` and cap both cross-sections. */
export function cutTriangleSoupAtZ(soup: Float32Array, cutZ: number): CutHalves {
  const upper: number[] = []
  const lower: number[] = []
  /** Boundary segments of the cross-section: [x1, y1, x2, y2] per crossing triangle. */
  const segments: number[] = []
  const triCount = Math.floor(soup.length / 9)

  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const verts: Array<readonly [number, number, number]> = [
      [soup[o]!, soup[o + 1]!, soup[o + 2]!],
      [soup[o + 3]!, soup[o + 4]!, soup[o + 5]!],
      [soup[o + 6]!, soup[o + 7]!, soup[o + 8]!]
    ]
    const dist = verts.map((v) => v[2] - cutZ)
    if (dist.every((d) => Math.abs(d) <= PLANE_EPSILON)) continue // coplanar sliver: contributes no volume
    if (dist.every((d) => d >= -PLANE_EPSILON)) { pushTriangle(upper, verts[0]!, verts[1]!, verts[2]!); continue }
    if (dist.every((d) => d <= PLANE_EPSILON)) { pushTriangle(lower, verts[0]!, verts[1]!, verts[2]!); continue }

    // The triangle genuinely spans the plane: clip it into both halves (orientation preserved)
    // and record the chord where it crosses for cap building.
    const up: Array<readonly [number, number, number]> = []
    const lo: Array<readonly [number, number, number]> = []
    const cross: Array<readonly [number, number, number]> = []
    for (let i = 0; i < 3; i++) {
      const a = verts[i]!, b = verts[(i + 1) % 3]!
      const da = dist[i]!, db = dist[(i + 1) % 3]!
      if (Math.abs(da) <= PLANE_EPSILON) {
        up.push(a); lo.push(a); cross.push(a)
      } else if (da > 0) up.push(a)
      else lo.push(a)
      if (Math.abs(da) > PLANE_EPSILON && Math.abs(db) > PLANE_EPSILON && (da > 0) !== (db > 0)) {
        const f = da / (da - db)
        const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, cutZ] as const
        up.push(p); lo.push(p); cross.push(p)
      }
    }
    pushFan(upper, up)
    pushFan(lower, lo)
    if (cross.length === 2) segments.push(cross[0]![0], cross[0]![1], cross[1]![0], cross[1]![1])
  }

  // Cap each closed cross-section loop on both halves (normal +Z on the lower half's top face,
  // -Z on the upper half's bottom face).
  for (const cap of triangulateCrossSection(segments)) {
    const [a, b, c] = cap
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    const ccw: Array<readonly [number, number, number]> = area2 >= 0
      ? [[a.x, a.y, cutZ], [b.x, b.y, cutZ], [c.x, c.y, cutZ]]
      : [[a.x, a.y, cutZ], [c.x, c.y, cutZ], [b.x, b.y, cutZ]]
    pushTriangle(lower, ccw[0]!, ccw[1]!, ccw[2]!)
    pushTriangle(upper, ccw[0]!, ccw[2]!, ccw[1]!)
  }

  return { upper: new Float32Array(upper), lower: new Float32Array(lower) }
}

function pushTriangle(
  out: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number]
): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
}

/** Fan-triangulate a convex clipped polygon (3-4 vertices), preserving its winding. */
function pushFan(out: number[], polygon: Array<readonly [number, number, number]>): void {
  for (let i = 1; i + 1 < polygon.length; i++) pushTriangle(out, polygon[0]!, polygon[i]!, polygon[i + 1]!)
}

/** Chain boundary segments into closed 2D loops, group holes under their outers, triangulate. */
function triangulateCrossSection(segments: number[]): Array<[THREE.Vector2, THREE.Vector2, THREE.Vector2]> {
  const quantize = (x: number, y: number) => `${Math.round(x / CHAIN_QUANTUM)},${Math.round(y / CHAIN_QUANTUM)}`
  // Dedupe segments (a mesh edge lying exactly on the plane reports once per adjacent triangle).
  const segByKey = new Map<string, [number, number, number, number]>()
  for (let i = 0; i + 3 < segments.length; i += 4) {
    const a = quantize(segments[i]!, segments[i + 1]!)
    const b = quantize(segments[i + 2]!, segments[i + 3]!)
    if (a === b) continue
    segByKey.set(a < b ? `${a}|${b}` : `${b}|${a}`, [segments[i]!, segments[i + 1]!, segments[i + 2]!, segments[i + 3]!])
  }
  // Endpoint adjacency for chain walking.
  const adjacency = new Map<string, Array<{ segKey: string; point: THREE.Vector2; otherKey: string; other: THREE.Vector2 }>>()
  for (const [segKey, [x1, y1, x2, y2]] of segByKey) {
    const k1 = quantize(x1, y1), k2 = quantize(x2, y2)
    const p1 = new THREE.Vector2(x1, y1), p2 = new THREE.Vector2(x2, y2)
    if (!adjacency.has(k1)) adjacency.set(k1, [])
    if (!adjacency.has(k2)) adjacency.set(k2, [])
    adjacency.get(k1)!.push({ segKey, point: p1, otherKey: k2, other: p2 })
    adjacency.get(k2)!.push({ segKey, point: p2, otherKey: k1, other: p1 })
  }

  const usedSegs = new Set<string>()
  const loops: THREE.Vector2[][] = []
  for (const [segKey, [x1, y1, x2, y2]] of segByKey) {
    if (usedSegs.has(segKey)) continue
    usedSegs.add(segKey)
    const startKey = quantize(x1, y1)
    let currentKey = quantize(x2, y2)
    const loop: THREE.Vector2[] = [new THREE.Vector2(x1, y1), new THREE.Vector2(x2, y2)]
    let closed = false
    // Walk endpoint-to-endpoint until back at the start or stuck (open chain -> no cap).
    for (let guard = 0; guard < segByKey.size; guard++) {
      const next = (adjacency.get(currentKey) ?? []).find((entry) => !usedSegs.has(entry.segKey))
      if (!next) break
      usedSegs.add(next.segKey)
      currentKey = next.otherKey
      if (currentKey === startKey) { closed = true; break }
      loop.push(next.other)
    }
    if (closed && loop.length >= 3) loops.push(loop)
  }
  if (loops.length === 0) return []

  // Even containment depth = outer contour, odd = hole assigned to its smallest containing outer.
  const depths = loops.map((loop, i) =>
    loops.reduce((depth, other, j) => (j !== i && pointInLoop(loop[0]!, other) ? depth + 1 : depth), 0))
  const caps: Array<[THREE.Vector2, THREE.Vector2, THREE.Vector2]> = []
  loops.forEach((outer, i) => {
    if (depths[i]! % 2 !== 0) return
    const holes = loops.filter((hole, j) =>
      j !== i && depths[j]! % 2 === 1 && depths[j]! === depths[i]! + 1 && pointInLoop(hole[0]!, outer))
    const points = [...outer, ...holes.flat()]
    for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) {
      caps.push([points[tri[0]!]!, points[tri[1]!]!, points[tri[2]!]!])
    }
  })
  return caps
}

/** Even-odd point-in-polygon test in the cut plane. */
function pointInLoop(point: THREE.Vector2, loop: THREE.Vector2[]): boolean {
  let inside = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]!, b = loop[j]!
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Translate a soup so its XY bounding-box centre sits at the origin and its lowest point at
 * z = 0 (the editor's natural pivot), returning the removed offset so the caller can place the
 * new instance exactly where the geometry came from.
 */
export function rebaseTriangleSoup(soup: Float32Array): { offset: { x: number; y: number; z: number } } {
  if (soup.length === 0) return { offset: { x: 0, y: 0, z: 0 } }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < soup.length; i += 3) {
    minX = Math.min(minX, soup[i]!); maxX = Math.max(maxX, soup[i]!)
    minY = Math.min(minY, soup[i + 1]!); maxY = Math.max(maxY, soup[i + 1]!)
    minZ = Math.min(minZ, soup[i + 2]!)
  }
  const offset = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: minZ }
  for (let i = 0; i < soup.length; i += 3) {
    soup[i] = soup[i]! - offset.x
    soup[i + 1] = soup[i + 1]! - offset.y
    soup[i + 2] = soup[i + 2]! - offset.z
  }
  return { offset }
}

/** Serialize a triangle soup as a binary STL (the staged-import upload format). */
export function triangleSoupToBinaryStl(soup: Float32Array): ArrayBuffer {
  const triCount = Math.floor(soup.length / 9)
  const buffer = new ArrayBuffer(84 + triCount * 50)
  const view = new DataView(buffer)
  view.setUint32(80, triCount, true)
  let offset = 84
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const ux = soup[o + 3]! - soup[o]!, uy = soup[o + 4]! - soup[o + 1]!, uz = soup[o + 5]! - soup[o + 2]!
    const vx = soup[o + 6]! - soup[o]!, vy = soup[o + 7]! - soup[o + 1]!, vz = soup[o + 8]! - soup[o + 2]!
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) { nx /= len; ny /= len; nz /= len } else { nx = 0; ny = 0; nz = 1 }
    view.setFloat32(offset, nx, true); view.setFloat32(offset + 4, ny, true); view.setFloat32(offset + 8, nz, true)
    offset += 12
    for (let i = 0; i < 9; i++) { view.setFloat32(offset, soup[o + i]!, true); offset += 4 }
    view.setUint16(offset, 0, true)
    offset += 2
  }
  return buffer
}

/**
 * Split a triangle soup into its connected components (Bambu's "split to objects"):
 * triangles that share a vertex position belong to the same component. Components
 * come back largest-first. A watertight single shell returns one entry.
 */
export function splitTriangleSoup(soup: Float32Array): Float32Array[] {
  const triCount = Math.floor(soup.length / 9)
  if (triCount === 0) return []
  // Vertex ids by exact float32 position (soups come from a shared mesh, so shared
  // corners are bit-identical).
  const vertexIds = new Map<string, number>()
  const parent: number[] = []
  const find = (id: number): number => {
    let root = id
    while (parent[root] !== root) root = parent[root]!
    while (parent[id] !== root) { const next = parent[id]!; parent[id] = root; id = next }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const vertexId = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`
    let id = vertexIds.get(key)
    if (id === undefined) {
      id = vertexIds.size
      vertexIds.set(key, id)
      parent[id] = id
    }
    return id
  }
  const triVertex = new Int32Array(triCount)
  for (let t = 0; t < triCount; t += 1) {
    const o = t * 9
    const a = vertexId(soup[o]!, soup[o + 1]!, soup[o + 2]!)
    const b = vertexId(soup[o + 3]!, soup[o + 4]!, soup[o + 5]!)
    const c = vertexId(soup[o + 6]!, soup[o + 7]!, soup[o + 8]!)
    union(a, b)
    union(a, c)
    triVertex[t] = a
  }
  const byRoot = new Map<number, number[]>()
  for (let t = 0; t < triCount; t += 1) {
    const root = find(triVertex[t]!)
    const list = byRoot.get(root)
    if (list) list.push(t)
    else byRoot.set(root, [t])
  }
  return [...byRoot.values()]
    .sort((a, b) => b.length - a.length)
    .map((triangles) => {
      const part = new Float32Array(triangles.length * 9)
      triangles.forEach((t, index) => part.set(soup.subarray(t * 9, t * 9 + 9), index * 9))
      return part
    })
}
