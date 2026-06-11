/**
 * Bambu/PrusaSlicer TriangleSelector paint-tree codec and splitting brush.
 *
 * A painted triangle's 3MF attribute (`paint_supports`/`paint_seam`/`paint_color`) is a
 * hex string encoding a recursive split tree (TriangleSelector::serialize):
 * - The bitstream is read 4 bits per hex digit, LSB-first, digits consumed from the
 *   END of the string (FacetsAnnotation builds the string reversed).
 * - Each node: 2 bits split-side count. Leaves follow with 2 bits of state; state 3
 *   (0b11) marks an extension — 4-bit chunks follow, each `15` adding 15, the final
 *   chunk (<15) completing `state = 3 + sum`. Split nodes follow with 2 bits special
 *   side, then their `splits + 1` children serialized in REVERSE child order.
 * - Child sub-triangle layout mirrors TriangleSelector::perform_split: vertices are
 *   rotated so the special side leads, split edges are bisected at midpoints.
 *
 * States are channel-dependent: supports/seam use 1 = enforcer, 2 = blocker; colour
 * paint uses the 1-based filament id. State 0 is unpainted.
 */

export type PaintTreeNode =
  | { kind: 'leaf'; state: number }
  | { kind: 'split'; splits: 1 | 2 | 3; special: 0 | 1 | 2; children: PaintTreeNode[] }

export interface PaintVec3 {
  x: number
  y: number
  z: number
}

const EXTENSION_MARKER = 3

/** Decode a paint code into its tree, or null when the code is malformed. */
export function decodePaintTree(code: string): PaintTreeNode | null {
  const bits: boolean[] = []
  for (let i = code.length - 1; i >= 0; i -= 1) {
    const value = Number.parseInt(code[i]!, 16)
    if (!Number.isFinite(value)) return null
    for (let bit = 0; bit < 4; bit += 1) bits.push(Boolean(value & (1 << bit)))
  }
  let cursor = 0
  const read = (count: number): number | null => {
    if (cursor + count > bits.length) return null
    let value = 0
    for (let bit = 0; bit < count; bit += 1) {
      if (bits[cursor + bit]) value |= 1 << bit
    }
    cursor += count
    return value
  }
  const parse = (): PaintTreeNode | null => {
    const splits = read(2)
    if (splits == null) return null
    if (splits === 0) {
      let state = read(2)
      if (state == null) return null
      if (state === EXTENSION_MARKER) {
        state = EXTENSION_MARKER
        let chunk = read(4)
        if (chunk == null) return null
        while (chunk === 15) {
          state += 15
          chunk = read(4)
          if (chunk == null) return null
        }
        state += chunk
      }
      return { kind: 'leaf', state }
    }
    const special = read(2)
    if (special == null || special > 2) return null
    const reversed: PaintTreeNode[] = []
    for (let child = 0; child <= splits; child += 1) {
      const node = parse()
      if (!node) return null
      reversed.push(node)
    }
    return { kind: 'split', splits: splits as 1 | 2 | 3, special: special as 0 | 1 | 2, children: reversed.reverse() }
  }
  const root = parse()
  // Trailing bits are only the implicit nibble padding (always zero in practice).
  return root
}

/** Encode a paint tree back into the reversed-hex attribute string. */
export function encodePaintTree(root: PaintTreeNode): string {
  const bits: boolean[] = []
  const write = (value: number, count: number) => {
    for (let bit = 0; bit < count; bit += 1) bits.push(Boolean(value & (1 << bit)))
  }
  const emit = (node: PaintTreeNode) => {
    if (node.kind === 'leaf') {
      write(0, 2)
      if (node.state >= EXTENSION_MARKER) {
        write(EXTENSION_MARKER, 2)
        let remaining = node.state - EXTENSION_MARKER
        while (remaining >= 15) {
          write(15, 4)
          remaining -= 15
        }
        write(remaining, 4)
      } else {
        write(node.state, 2)
      }
      return
    }
    write(node.splits, 2)
    write(node.special, 2)
    // Children serialized in reverse order (TriangleSelector compatibility).
    for (let child = node.splits; child >= 0; child -= 1) emit(node.children[child]!)
  }
  emit(root)
  let out = ''
  for (let offset = 0; offset < bits.length; offset += 4) {
    let value = 0
    for (let bit = 0; bit < 4; bit += 1) {
      if (bits[offset + bit]) value |= 1 << bit
    }
    out = value.toString(16).toUpperCase() + out
  }
  return out
}

function midpoint(a: PaintVec3, b: PaintVec3): PaintVec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
}

/**
 * Child sub-triangles for a split node, matching TriangleSelector::perform_split:
 * vertices rotated so `special` leads, split edges bisected, children in stored order.
 */
export function splitChildTriangles(
  vertices: [PaintVec3, PaintVec3, PaintVec3],
  splits: 1 | 2 | 3,
  special: 0 | 1 | 2
): Array<[PaintVec3, PaintVec3, PaintVec3]> {
  const v0 = vertices[special]!
  const v1 = vertices[(special + 1) % 3]!
  const v2 = vertices[(special + 2) % 3]!
  if (splits === 1) {
    const m = midpoint(v2, v1)
    return [[v0, v1, m], [m, v2, v0]]
  }
  if (splits === 2) {
    const m1 = midpoint(v1, v0)
    const m2 = midpoint(v0, v2)
    return [[v0, m1, m2], [m1, v1, m2], [v1, v2, m2]]
  }
  const m0 = midpoint(v0, v1)
  const m1 = midpoint(v2, v1)
  const m2 = midpoint(v0, v2)
  return [[v0, m0, m2], [m0, v1, m1], [m1, v2, m2], [m0, m1, m2]]
}

/** Walk a tree, invoking `visit` for every leaf with its sub-triangle vertices. */
export function walkPaintTree(
  node: PaintTreeNode,
  vertices: [PaintVec3, PaintVec3, PaintVec3],
  visit: (state: number, vertices: [PaintVec3, PaintVec3, PaintVec3]) => void
): void {
  if (node.kind === 'leaf') {
    visit(node.state, vertices)
    return
  }
  const children = splitChildTriangles(vertices, node.splits, node.special)
  for (let index = 0; index < children.length; index += 1) {
    walkPaintTree(node.children[index]!, children[index]!, visit)
  }
}

function distanceSqToTriangle(p: PaintVec3, a: PaintVec3, b: PaintVec3, c: PaintVec3): number {
  // Closest point on triangle (Ericson, Real-Time Collision Detection) without THREE.
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z }
  const dot = (u: PaintVec3, v: PaintVec3) => u.x * v.x + u.y * v.y + u.z * v.z
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  let closest: PaintVec3
  if (d1 <= 0 && d2 <= 0) closest = a
  else {
    const bp = { x: p.x - b.x, y: p.y - b.y, z: p.z - b.z }
    const d3 = dot(ab, bp)
    const d4 = dot(ac, bp)
    if (d3 >= 0 && d4 <= d3) closest = b
    else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const t = d1 / (d1 - d3)
        closest = { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t }
      } else {
        const cp = { x: p.x - c.x, y: p.y - c.y, z: p.z - c.z }
        const d5 = dot(ab, cp)
        const d6 = dot(ac, cp)
        if (d6 >= 0 && d5 <= d6) closest = c
        else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const t = d2 / (d2 - d6)
            closest = { x: a.x + ac.x * t, y: a.y + ac.y * t, z: a.z + ac.z * t }
          } else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const t = (d4 - d3) / ((d4 - d3) + (d5 - d6))
              closest = { x: b.x + (c.x - b.x) * t, y: b.y + (c.y - b.y) * t, z: b.z + (c.z - b.z) * t }
            } else {
              const denom = 1 / (va + vb + vc)
              const v = vb * denom
              const w = vc * denom
              closest = { x: a.x + ab.x * v + ac.x * w, y: a.y + ab.y * v + ac.y * w, z: a.z + ab.z * v + ac.z * w }
            }
          }
        }
      }
    }
  }
  const dx = p.x - closest.x
  const dy = p.y - closest.y
  const dz = p.z - closest.z
  return dx * dx + dy * dy + dz * dz
}

function distanceSq(a: PaintVec3, b: PaintVec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

/** Recursion backstop well past any realistic edge-limit refinement depth. */
const MAX_SPLIT_DEPTH = 12

/**
 * A paint cursor shape, mirroring TriangleSelector::Cursor: a point-membership test,
 * a triangle-touch test (Bambu's `is_pointer_in_triangle || is_edge_inside_cursor`),
 * and the edge length below which partially covered leaves stop splitting. All
 * coordinates are geometry-local; callers convert world radii/limits.
 */
export interface PaintCursor {
  containsPoint(point: PaintVec3): boolean
  touchesTriangle(vertices: [PaintVec3, PaintVec3, PaintVec3]): boolean
  edgeLimitSq: number
}

/** Spherical brush cursor (TriangleSelector::Sphere). */
export function createSphereCursor(center: PaintVec3, radius: number, edgeLimit: number): PaintCursor {
  const radiusSq = radius * radius
  return {
    edgeLimitSq: edgeLimit * edgeLimit,
    containsPoint: (point) => distanceSq(point, center) < radiusSq,
    touchesTriangle: (vertices) =>
      distanceSqToTriangle(center, vertices[0], vertices[1], vertices[2]) <= radiusSq
  }
}

/**
 * Circle brush cursor (TriangleSelector::Circle): an infinite cylinder around the
 * pointer ray (`center` on the surface, `dir` the unit view direction). Membership is
 * distance from the axis; the touch test mirrors Bambu's `is_circle_pointer_inside_triangle`
 * (does the axis cross the triangle near the hit?) plus the per-edge projected-distance test.
 */
export function createCircleCursor(
  center: PaintVec3,
  dir: PaintVec3,
  radius: number,
  edgeLimit: number
): PaintCursor {
  const radiusSq = radius * radius
  const axisDistanceSq = (point: PaintVec3): number => {
    const dx = center.x - point.x
    const dy = center.y - point.y
    const dz = center.z - point.z
    const along = dx * dir.x + dy * dir.y + dz * dir.z
    return dx * dx + dy * dy + dz * dz - along * along
  }
  // Bambu tests the unit segment center±dir against the triangle (the hit point is on
  // the surface, so a local crossing is all that matters).
  const q1 = { x: center.x + dir.x, y: center.y + dir.y, z: center.z + dir.z }
  const q2 = { x: center.x - dir.x, y: center.y - dir.y, z: center.z - dir.z }
  const volumeSign = (a: PaintVec3, b: PaintVec3, c: PaintVec3, d: PaintVec3): boolean => {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z
    const adx = d.x - a.x, ady = d.y - a.y, adz = d.z - a.z
    return (aby * acz - abz * acy) * adx + (abz * acx - abx * acz) * ady + (abx * acy - aby * acx) * adz > 0
  }
  const pointerInTriangle = (p1: PaintVec3, p2: PaintVec3, p3: PaintVec3): boolean => {
    if (volumeSign(q1, p1, p2, p3) === volumeSign(q2, p1, p2, p3)) return false
    const positive = volumeSign(q1, q2, p1, p2)
    return volumeSign(q1, q2, p2, p3) === positive && volumeSign(q1, q2, p3, p1) === positive
  }
  const edgeInsideCursor = (a: PaintVec3, b: PaintVec3): boolean => {
    // Closest point on the edge to the cursor centre, then its distance from the axis
    // projected perpendicular to `dir` (TriangleSelector::Circle::is_edge_inside_cursor).
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z
    const length = Math.sqrt(abx * abx + aby * aby + abz * abz)
    if (length < 1e-12) return false
    const sx = abx / length, sy = aby / length, sz = abz / length
    const t = (center.x - a.x) * sx + (center.y - a.y) * sy + (center.z - a.z) * sz
    const vx = a.x + t * sx - center.x
    const vy = a.y + t * sy - center.y
    const vz = a.z + t * sz - center.z
    const along = vx * dir.x + vy * dir.y + vz * dir.z
    const distSq = vx * vx + vy * vy + vz * vz - along * along
    return distSq < radiusSq && t >= 0 && t <= length
  }
  return {
    edgeLimitSq: edgeLimit * edgeLimit,
    containsPoint: (point) => axisDistanceSq(point) < radiusSq,
    touchesTriangle: (vertices) =>
      pointerInTriangle(vertices[0], vertices[1], vertices[2]) ||
      edgeInsideCursor(vertices[0], vertices[1]) ||
      edgeInsideCursor(vertices[1], vertices[2]) ||
      edgeInsideCursor(vertices[2], vertices[0])
  }
}

/**
 * Height-range cursor (TriangleSelector::HeightRange): a horizontal world-space band
 * `[zBottom, zTop]`. `worldZ` maps a geometry-local point to world z. Bambu paints
 * with a fixed fine edge limit (0.1mm world) and a 0.02mm membership tolerance so the
 * band edges come out crisp.
 */
export function createHeightRangeCursor(
  worldZ: (point: PaintVec3) => number,
  zBottom: number,
  zTop: number,
  edgeLimit: number
): PaintCursor {
  const TOLERANCE = 0.02
  return {
    edgeLimitSq: edgeLimit * edgeLimit,
    containsPoint: (point) => {
      const z = worldZ(point)
      return z > zBottom - TOLERANCE && z < zTop + TOLERANCE
    },
    touchesTriangle: (vertices) => {
      const z0 = worldZ(vertices[0])
      const z1 = worldZ(vertices[1])
      const z2 = worldZ(vertices[2])
      return !(
        (z0 < zBottom && z1 < zBottom && z2 < zBottom) ||
        (z0 > zTop && z1 > zTop && z2 > zTop)
      )
    }
  }
}

/**
 * Paint a cursor dab onto one source triangle's tree, following
 * TriangleSelector::select_patch/split_triangle:
 * - a leaf with every vertex inside the cursor is painted whole;
 * - a touched leaf whose sides are all at or below `edgeLimit` is painted whole
 *   (it is already finer than the brush resolution);
 * - otherwise the sides LONGER than the limit are split (1 side -> that side is the
 *   special side; 2 sides -> the KEPT side is special; 3 -> special 0) and children
 *   are painted recursively. Existing split topology is descended, not re-split.
 * Returns the new tree, collapsed where children agree (keeps codes compact).
 */
export function paintTreeWithBrush(
  node: PaintTreeNode,
  vertices: [PaintVec3, PaintVec3, PaintVec3],
  cursor: PaintCursor,
  state: number,
  depth = 0
): PaintTreeNode {
  const inside =
    cursor.containsPoint(vertices[0]) &&
    cursor.containsPoint(vertices[1]) &&
    cursor.containsPoint(vertices[2])
  if (inside) return { kind: 'leaf', state }
  const touches = cursor.containsPoint(vertices[0]) || cursor.containsPoint(vertices[1]) ||
    cursor.containsPoint(vertices[2]) || cursor.touchesTriangle(vertices)
  if (!touches) return node

  if (node.kind === 'leaf') {
    if (node.state === state) return node
    // Sides opposite each vertex, matching split_triangle's ordering.
    const sides = [
      distanceSq(vertices[2], vertices[1]),
      distanceSq(vertices[0], vertices[2]),
      distanceSq(vertices[1], vertices[0])
    ]
    const sidesToSplit: number[] = []
    let sideToKeep = 0
    for (let side = 0; side < 3; side += 1) {
      if (sides[side]! > cursor.edgeLimitSq) sidesToSplit.push(side)
      else sideToKeep = side
    }
    if (sidesToSplit.length === 0 || depth >= MAX_SPLIT_DEPTH) {
      // Finer than the brush resolution: paint the whole (tiny) leaf.
      return { kind: 'leaf', state }
    }
    const splits = sidesToSplit.length as 1 | 2 | 3
    const special = (splits === 1 ? sidesToSplit[0]! : splits === 2 ? sideToKeep : 0) as 0 | 1 | 2
    node = {
      kind: 'split',
      splits,
      special,
      children: Array.from({ length: splits + 1 }, () => ({ kind: 'leaf' as const, state: node.kind === 'leaf' ? node.state : 0 }))
    }
  }

  const children = splitChildTriangles(vertices, node.splits, node.special)
  const painted = node.children.map((child, index) =>
    paintTreeWithBrush(child, children[index]!, cursor, state, depth + 1)
  )
  // Collapse when every child became the same plain leaf.
  const first = painted[0]!
  if (
    first.kind === 'leaf' &&
    painted.every((child) => child.kind === 'leaf' && child.state === first.state)
  ) {
    return { kind: 'leaf', state: first.state }
  }
  return { kind: 'split', splits: node.splits, special: node.special, children: painted }
}

/** True when the tree paints nothing (every leaf is state 0). */
export function isPaintTreeEmpty(node: PaintTreeNode): boolean {
  if (node.kind === 'leaf') return node.state === 0
  return node.children.every(isPaintTreeEmpty)
}
