/**
 * TriangleSelector paint GEOMETRY: the splitting brush, cursors, and leaf walking.
 *
 * The string codec (decode/encode of the `paint_supports`/`paint_seam`/`paint_color` hex trees,
 * plus the colour-channel filament-id remaps) lives in `@printstream/shared/three-mf`
 * (`triangle-paint-codec.ts`) because the BAKE re-keys base-file paint with it too; this module
 * re-exports it so the plugin keeps one import site. What stays here is everything that needs
 * vertex positions: child sub-triangle layout mirrors TriangleSelector::perform_split (vertices
 * rotated so the special side leads, split edges bisected at midpoints), and the brush mirrors
 * select_patch/split_triangle.
 *
 * States are channel-dependent: supports/seam use 1 = enforcer, 2 = blocker; colour paint uses the
 * 1-based filament id. State 0 is unpainted.
 */
import type { PaintTreeNode } from '@printstream/shared/three-mf'

export {
  decodePaintTree,
  encodePaintTree,
  isPaintTreeEmpty,
  remapColorPaintCode,
  remapColorPaintMap,
  type PaintTreeNode
} from '@printstream/shared/three-mf'

export interface PaintVec3 {
  x: number
  y: number
  z: number
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

/** Squared distance from `point` to the segment `[a, b]`. */
function distanceSqToSegment(point: PaintVec3, a: PaintVec3, b: PaintVec3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z
  const lengthSq = abx * abx + aby * aby + abz * abz
  if (lengthSq < 1e-24) return distanceSq(point, a)
  const raw = ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / lengthSq
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
  const dx = point.x - (a.x + abx * t)
  const dy = point.y - (a.y + aby * t)
  const dz = point.z - (a.z + abz * t)
  return dx * dx + dy * dy + dz * dz
}

/** Squared distance between the segments `[p1,q1]` and `[p2,q2]` (Ericson, 5.1.9). */
function segmentDistanceSq(p1: PaintVec3, q1: PaintVec3, p2: PaintVec3, q2: PaintVec3): number {
  const d1 = { x: q1.x - p1.x, y: q1.y - p1.y, z: q1.z - p1.z }
  const d2 = { x: q2.x - p2.x, y: q2.y - p2.y, z: q2.z - p2.z }
  const r = { x: p1.x - p2.x, y: p1.y - p2.y, z: p1.z - p2.z }
  const a = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z
  const e = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z
  const f = d2.x * r.x + d2.y * r.y + d2.z * r.z
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
  const EPS = 1e-24
  let s: number
  let t: number
  if (a <= EPS && e <= EPS) return distanceSq(p1, p2)
  if (a <= EPS) { s = 0; t = clamp01(f / e) }
  else {
    const c = d1.x * r.x + d1.y * r.y + d1.z * r.z
    if (e <= EPS) { t = 0; s = clamp01(-c / a) }
    else {
      const b = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z
      const denom = a * e - b * b
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) { t = 0; s = clamp01(-c / a) }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a) }
    }
  }
  const cx = p1.x + d1.x * s - (p2.x + d2.x * t)
  const cy = p1.y + d1.y * s - (p2.y + d2.y * t)
  const cz = p1.z + d1.z * s - (p2.z + d2.z * t)
  return cx * cx + cy * cy + cz * cz
}

/** Does the segment `[p, q]` pierce the triangle? (Moller-Trumbore, bounded to the segment.) */
function segmentCrossesTriangle(
  p: PaintVec3, q: PaintVec3, a: PaintVec3, b: PaintVec3, c: PaintVec3
): boolean {
  const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z
  const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z
  const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x
  const det = e1x * hx + e1y * hy + e1z * hz
  if (Math.abs(det) < 1e-18) return false
  const invDet = 1 / det
  const sx = p.x - a.x, sy = p.y - a.y, sz = p.z - a.z
  const u = (sx * hx + sy * hy + sz * hz) * invDet
  if (u < 0 || u > 1) return false
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
  const v = (dx * qx + dy * qy + dz * qz) * invDet
  if (v < 0 || u + v > 1) return false
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet
  return t >= 0 && t <= 1
}

/**
 * Swept SPHERE cursor (TriangleSelector::Capsule3D): the volume the sphere brush covers moving
 * from `first` to `second`.
 *
 * BambuStudio paints a capsule between each consecutive pair of interpolated pointer positions
 * rather than a sphere at each (`DoublePointCursor::cursor_factory`), which is what makes a stroke
 * a continuous band instead of a row of dabs -- a fast drag outruns the pointer-event rate, and
 * dabs alone leave visible gaps in it.
 *
 * The predicates are stated as SEGMENT distances where Studio writes the end-caps and the tube out
 * separately ({@link https://github.com/bambulab/BambuStudio} `TriangleSelector.cpp:2387`). Same
 * shape, same answers, and it collapses into the one `touchesTriangle` this interface has where
 * Studio splits it across two virtuals.
 */
export function createCapsule3DCursor(
  first: PaintVec3,
  second: PaintVec3,
  radius: number,
  edgeLimit: number
): PaintCursor {
  const radiusSq = radius * radius
  return {
    edgeLimitSq: edgeLimit * edgeLimit,
    containsPoint: (point) => distanceSqToSegment(point, first, second) < radiusSq,
    touchesTriangle: (vertices) => {
      // A triangle the capsule pierces has no vertex or edge near the axis, so the crossing test
      // is not redundant: without it a stroke skips any facet larger than the brush.
      if (segmentCrossesTriangle(first, second, vertices[0], vertices[1], vertices[2])) return true
      if (distanceSqToTriangle(first, vertices[0], vertices[1], vertices[2]) <= radiusSq) return true
      if (distanceSqToTriangle(second, vertices[0], vertices[1], vertices[2]) <= radiusSq) return true
      for (let side = 0; side < 3; side += 1) {
        const edgeA = vertices[side]!
        const edgeB = vertices[side < 2 ? side + 1 : 0]!
        if (segmentDistanceSq(first, second, edgeA, edgeB) <= radiusSq) return true
      }
      return false
    }
  }
}

/**
 * Swept CIRCLE cursor (TriangleSelector::Capsule2D): the circle brush's infinite view-aligned
 * cylinder, swept from `first` to `second`.
 *
 * Every test is the Capsule3D one measured in the plane PERPENDICULAR to `dir`, which is exactly
 * what the circle cursor is to the sphere cursor. Studio spells the same shape out as two end
 * cylinders plus the rectangle between them (`TriangleSelector.cpp:2405`); flattening first says it
 * once. The pointer test stays Studio's own, run at BOTH centres as
 * `DoublePointCursor::is_pointer_in_triangle` does, because "does the view ray cross this triangle"
 * is not a distance question.
 */
export function createCapsule2DCursor(
  first: PaintVec3,
  second: PaintVec3,
  dir: PaintVec3,
  radius: number,
  edgeLimit: number
): PaintCursor {
  const radiusSq = radius * radius
  const flatten = (point: PaintVec3): PaintVec3 => {
    const along = point.x * dir.x + point.y * dir.y + point.z * dir.z
    return { x: point.x - along * dir.x, y: point.y - along * dir.y, z: point.z - along * dir.z }
  }
  const flatFirst = flatten(first)
  const flatSecond = flatten(second)
  const circleAt = (center: PaintVec3): PaintCursor => createCircleCursor(center, dir, radius, edgeLimit)
  const firstCircle = circleAt(first)
  const secondCircle = circleAt(second)
  return {
    edgeLimitSq: edgeLimit * edgeLimit,
    containsPoint: (point) => distanceSqToSegment(flatten(point), flatFirst, flatSecond) < radiusSq,
    touchesTriangle: (vertices) => {
      if (firstCircle.touchesTriangle(vertices) || secondCircle.touchesTriangle(vertices)) return true
      const flat: [PaintVec3, PaintVec3, PaintVec3] = [flatten(vertices[0]), flatten(vertices[1]), flatten(vertices[2])]
      for (let side = 0; side < 3; side += 1) {
        const edgeA = flat[side]!
        const edgeB = flat[side < 2 ? side + 1 : 0]!
        if (segmentDistanceSq(flatFirst, flatSecond, edgeA, edgeB) <= radiusSq) return true
      }
      return false
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
