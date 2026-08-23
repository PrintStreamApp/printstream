/**
 * Rigid-body math for transforming a MULTI-selection as one body: BambuStudio's
 * `Selection::rotate` / `scale_and_translate` semantics (Instance mode, `World|Relative`, the
 * gizmo default): every member's OFFSET orbits the selection pivot while its own orientation /
 * scale composes with the delta, so the selection keeps its internal layout. The deltas are
 * always recomputed from a drag-start snapshot, never accumulated per frame, mirroring Studio's
 * drag-start cache (`set_caches`), incremental composition would drift.
 *
 * The pivots mirror Studio's two caches, which are DIFFERENT points on an asymmetric selection:
 * rotation pivots on the selection's minimum enclosing sphere centre (`m_cache.rotation_pivot`,
 * a Bambu divergence from PrusaSlicer's AABB centre: Selection.cpp:2683) while translate/scale
 * pivot on the selection AABB centre (`m_cache.dragging_center`). Studio also renders each gizmo
 * at its own pivot, which is why {@link selectionPivot} is mode-keyed.
 *
 * Deliberate divergences from Studio, both documented at the call site in `useEditorScene`:
 * no Alt "independent" mode (spin/scale each member about its own origin), and unselected
 * sibling instances are never touched (Studio's `synchronize_unselected_instances` re-orients
 * them on X/Y rotations; our linked copies have always kept fully independent placements).
 */
import * as THREE from 'three'

/** A member's decomposed editor transform (outer-group position/scale + rotor rotation). */
export interface SelectionMemberPose {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  scale: THREE.Vector3
}

/** The gizmo proxy's drag delta, decomposed. Identity when the drag has not moved. */
export interface SelectionDelta {
  translation: THREE.Vector3
  rotation: THREE.Quaternion
  /** Component-wise world-axis factors (1,1,1 = unchanged). */
  scale: THREE.Vector3
}

export type MultiTransformMode = 'translate' | 'rotate' | 'scale'

/**
 * The proxy's delta since drag start. The proxy is re-seated to identity rotation/unit scale on
 * attach, so `start` is normally identity: computed generally anyway so a stale proxy state can
 * never read as a phantom transform.
 */
export function selectionDeltaFromProxy(current: SelectionMemberPose, start: SelectionMemberPose): SelectionDelta {
  const safe = (value: number): number => (Math.abs(value) < 1e-9 ? 1 : value)
  return {
    translation: current.position.clone().sub(start.position),
    rotation: current.quaternion.clone().multiply(start.quaternion.clone().invert()),
    scale: new THREE.Vector3(
      current.scale.x / safe(start.scale.x),
      current.scale.y / safe(start.scale.y),
      current.scale.z / safe(start.scale.z)
    )
  }
}

/**
 * A member's new pose under the selection delta, rigid-body about `pivot`:
 * - translate: same world displacement for every member (Studio `Selection::translate`);
 * - rotate: offset orbits the pivot AND the member's orientation composes with the rotation
 *   (`transform_instance_relative`, `T(pivot)·R·T(-pivot)` premultiplied), all axes, not just Z;
 * - scale: offsets push away from / pull toward the pivot while each member scales
 *   (`scale_and_translate`). Factors compose onto the outer-group scale, which our T·S·R group
 *   structure applies along WORLD axes: matching Studio's world-coordinates scale, where
 *   non-uniform factors on a multi-selection are explicitly allowed (a Bambu divergence).
 *
 * Composing a world rotation into the rotor quaternion is exact for uniformly-scaled members;
 * a non-uniformly scaled member gets the same approximation the single-object rotate gizmo
 * already makes (the decomposed form cannot represent the shear Studio's full matrices keep).
 */
export function applySelectionDelta(
  mode: MultiTransformMode,
  start: SelectionMemberPose,
  delta: SelectionDelta,
  pivot: THREE.Vector3
): SelectionMemberPose {
  if (mode === 'translate') {
    return {
      position: start.position.clone().add(delta.translation),
      quaternion: start.quaternion.clone(),
      scale: start.scale.clone()
    }
  }
  const offset = start.position.clone().sub(pivot)
  if (mode === 'rotate') {
    return {
      position: pivot.clone().add(offset.applyQuaternion(delta.rotation)),
      quaternion: delta.rotation.clone().multiply(start.quaternion),
      scale: start.scale.clone()
    }
  }
  return {
    position: pivot.clone().add(offset.multiply(delta.scale)),
    quaternion: start.quaternion.clone(),
    scale: start.scale.clone().multiply(delta.scale)
  }
}

/**
 * Where the multi-selection gizmo sits and what the transform pivots on, from the members'
 * world boxes: the minimum-enclosing-sphere centre for rotate, the union-box centre otherwise
 * (see the module header for the Studio counterparts). Null with no non-empty box.
 */
export function selectionPivot(boxes: ReadonlyArray<THREE.Box3>, mode: MultiTransformMode): THREE.Vector3 | null {
  const nonEmpty = boxes.filter((box) => !box.isEmpty())
  if (nonEmpty.length === 0) return null
  if (mode === 'rotate') {
    const corners: THREE.Vector3[] = []
    const corner = (box: THREE.Box3, x: 'min' | 'max', y: 'min' | 'max', z: 'min' | 'max') =>
      new THREE.Vector3(box[x].x, box[y].y, box[z].z)
    for (const box of nonEmpty) {
      for (const x of ['min', 'max'] as const) {
        for (const y of ['min', 'max'] as const) {
          for (const z of ['min', 'max'] as const) corners.push(corner(box, x, y, z))
        }
      }
    }
    return minEnclosingSphereCenter(corners)
  }
  const union = new THREE.Box3()
  for (const box of nonEmpty) union.union(box)
  return union.getCenter(new THREE.Vector3())
}

interface Sphere {
  center: THREE.Vector3
  radiusSq: number
}

/**
 * Centre of the minimum enclosing sphere of a point set (Welzl's algorithm). Studio computes
 * this over the selection's convex-hull vertices with CGAL; we feed member AABB corners, whose
 * sphere encloses the same geometry with the centre in practically the same place. Deterministic
 * (no shuffle: the inputs are a few dozen box corners, so the worst case is irrelevant).
 */
export function minEnclosingSphereCenter(points: ReadonlyArray<THREE.Vector3>): THREE.Vector3 | null {
  if (points.length === 0) return null
  // Dedupe: touching boxes duplicate corners, and duplicated points degrade the boundary solvers.
  const unique: THREE.Vector3[] = []
  for (const point of points) {
    if (!unique.some((existing) => existing.distanceToSquared(point) < 1e-12)) unique.push(point)
  }
  return welzl(unique, unique.length, []).center.clone()
}

const CONTAINS_EPSILON = 1e-7

function sphereContains(sphere: Sphere, point: THREE.Vector3): boolean {
  return sphere.center.distanceToSquared(point) <= sphere.radiusSq + CONTAINS_EPSILON * (1 + sphere.radiusSq)
}

/** Welzl recursion: min sphere of the first `count` points with `boundary` constrained on it. */
function welzl(points: THREE.Vector3[], count: number, boundary: THREE.Vector3[]): Sphere {
  if (count === 0 || boundary.length === 4) return sphereOfBoundary(boundary)
  const point = points[count - 1] as THREE.Vector3
  const without = welzl(points, count - 1, boundary)
  if (sphereContains(without, point)) return without
  return welzl(points, count - 1, [...boundary, point])
}

/** Smallest sphere with every boundary point ON it (exact for 0-2; circum-solvers beyond). */
function sphereOfBoundary(boundary: THREE.Vector3[]): Sphere {
  const [a, b, c, d] = boundary
  if (!a) return { center: new THREE.Vector3(), radiusSq: -1 }
  if (!b) return { center: a.clone(), radiusSq: 0 }
  if (!c) return diametral(a, b)
  if (!d) return circumSphere3(a, b, c) ?? widestDiametral([a, b, c])
  return circumSphere4(a, b, c, d)
    ?? bestContainingSubSphere([a, b, c, d])
    ?? widestDiametral([a, b, c, d])
}

function diametral(a: THREE.Vector3, b: THREE.Vector3): Sphere {
  const center = a.clone().add(b).multiplyScalar(0.5)
  return { center, radiusSq: center.distanceToSquared(a) }
}

/** Fallback for degenerate boundaries (collinear/coplanar): the widest pair's diametral sphere. */
function widestDiametral(points: THREE.Vector3[]): Sphere {
  let best: Sphere = { center: (points[0] as THREE.Vector3).clone(), radiusSq: 0 }
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const candidate = diametral(points[i] as THREE.Vector3, points[j] as THREE.Vector3)
      if (candidate.radiusSq > best.radiusSq) best = candidate
    }
  }
  return best
}

/** Circumsphere through three points (their planar circumcircle); null when collinear. */
function circumSphere3(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): Sphere | null {
  const ab = b.clone().sub(a)
  const ac = c.clone().sub(a)
  const normal = ab.clone().cross(ac)
  const normalSq = normal.lengthSq()
  if (normalSq < 1e-12) return null
  const offset = ac.clone().cross(normal).multiplyScalar(ab.lengthSq())
    .add(normal.clone().cross(ab).multiplyScalar(ac.lengthSq()))
    .divideScalar(2 * normalSq)
  const center = a.clone().add(offset)
  return { center, radiusSq: center.distanceToSquared(a) }
}

/** Circumsphere through four points; null when they are (near-)coplanar. */
function circumSphere4(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): Sphere | null {
  // Solve 2·(p_i - a)·x = |p_i|² - |a|² for x via Cramer's rule.
  const rows = [b, c, d].map((p) => p.clone().sub(a).multiplyScalar(2))
  const [r0, r1, r2] = rows as [THREE.Vector3, THREE.Vector3, THREE.Vector3]
  const rhs = [b, c, d].map((p) => p.lengthSq() - a.lengthSq()) as [number, number, number]
  const det = r0.clone().cross(r1).dot(r2)
  if (Math.abs(det) < 1e-9) return null
  const detFor = (column: 0 | 1 | 2): number => {
    const replace = (row: THREE.Vector3, value: number): THREE.Vector3 => {
      const copy = row.clone()
      if (column === 0) copy.x = value
      else if (column === 1) copy.y = value
      else copy.z = value
      return copy
    }
    const m0 = replace(r0, rhs[0])
    const m1 = replace(r1, rhs[1])
    const m2 = replace(r2, rhs[2])
    return m0.clone().cross(m1).dot(m2)
  }
  const center = new THREE.Vector3(detFor(0) / det, detFor(1) / det, detFor(2) / det)
  return { center, radiusSq: center.distanceToSquared(a) }
}

/** Coplanar-4 fallback: the smallest 3-point circumsphere that still contains the fourth. */
function bestContainingSubSphere(points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]): Sphere | null {
  let best: Sphere | null = null
  for (let skip = 0; skip < 4; skip += 1) {
    const triple = points.filter((_point, index) => index !== skip)
    const sphere = circumSphere3(triple[0] as THREE.Vector3, triple[1] as THREE.Vector3, triple[2] as THREE.Vector3)
    if (!sphere) continue
    if (!sphereContains(sphere, points[skip] as THREE.Vector3)) continue
    if (!best || sphere.radiusSq < best.radiusSq) best = sphere
  }
  return best
}
