/**
 * Resolves the editor measure tool's world-space feature under a pointer.
 *
 * Owns lazy BVH and geometry-index caches for one viewport mount. Callers retain scene and event
 * ownership; dropping this picker with the viewport releases its caches without listeners or
 * scene objects to dispose. The counterpart is `useEditorScene`.
 */
import * as THREE from 'three'
import { ensureMeshBvh } from './meshBvh'
import {
  buildMeshCircleIndex,
  featureAtFace,
  transformMeasureFeature,
  STUDIO_FEATURE_HOVER_LIMIT,
  type MeasureFeature,
  type MeshCircleIndex
} from './measureFeatures'
import { circleScreenZone, raySeesThroughCircle } from './circleScreenZone'
import { BRIM_EAR_MARKER_NAME, MEASURE_CIRCLE_FACE_LIMIT } from '../editorGeometry'

/** Screen-space radius in pixels for a measure feature or centre marker. */
const MEASURE_SNAP_PX = 14

/** Feature used for arithmetic and the source under the cursor for its label. */
export interface MeasurePick {
  feature: MeasureFeature
  source: MeasureFeature
}

interface EditorMeasurePickerOptions {
  canvas: HTMLCanvasElement
  camera: THREE.PerspectiveCamera
  pointer: THREE.Vector2
  raycaster: THREE.Raycaster
  bedPlane: THREE.Plane
  getGroups: () => Iterable<THREE.Group>
  getCentreTargets: () => ReadonlyArray<{ object: THREE.Object3D; slot: number }>
  getPicks: () => ReadonlyArray<MeasurePick>
  getHoveredSource: () => MeasureFeature | null
  getBed: () => { minX: number; maxX: number; minY: number; maxY: number } | null | undefined
}

/** Pick a feature from live viewport refs without resubscribing pointer listeners. */
export function createEditorMeasurePicker({
  canvas,
  camera,
  pointer,
  raycaster,
  bedPlane,
  getGroups,
  getCentreTargets,
  getPicks,
  getHoveredSource,
  getBed
}: EditorMeasurePickerOptions): (event: PointerEvent, pointMode: boolean) => MeasurePick | null {
  /**
   * Instance groups whose meshes have been handed to {@link ensureMeshBvh}.
   *
   * `ensureMeshBvh` is itself a no-op after the first call, but the WALK to reach it is not: the
   * measure hit test runs on every pointer MOVE now (it drives the cursor), and traversing every
   * mesh of every object on the plate at pointer rate is thousands of node visits per move on a
   * dense project, purely to reach an early-out. Keyed on the GROUP, which is replaced whenever
   * its instance is rebuilt, so a rebuild re-indexes. A mesh added to a group already indexed
   * simply falls back to the stock raycast, which `meshBvh.ts` documents as slow, not broken.
   */
  const measureIndexedGroups = new WeakSet<THREE.Object3D>()

  /**
   * The feature index of one mesh, built on first use and kept for the mesh's life.
   *
   * Held on the GEOMETRY rather than the mesh, and in the geometry's OWN space, so it survives
   * every move, rotate and scale of the object -- which is also how Studio does it, keeping one
   * `Measuring` per volume and re-applying only the world transform (`GLGizmoMeasure.cpp:2664`).
   *
   * CAPPED, and the cap is the honest part. Building it walks every face and every edge with
   * string keys, which is the ~1s-per-663k-triangles cost `isClosedSoup` documents -- affordable
   * once for a CAD part with holes in it, and a frozen tab for a dense organic mesh, which has no
   * holes to find anyway. Past the cap the tool keeps its corner snapping and simply never offers
   * a centre.
   */
  const measureFeatureIndexes = new WeakMap<THREE.BufferGeometry, MeshCircleIndex | null>()
  const measureFeatureIndexFor = (geometry: THREE.BufferGeometry): MeshCircleIndex | null => {
    const cached = measureFeatureIndexes.get(geometry)
    if (cached !== undefined) return cached
    const position = geometry.getAttribute('position')
    // An INDEXED geometry addresses triangles differently, and every model mesh here is
    // deliberately non-indexed (see `meshBvh.ts`), so this is a guard rather than a case to handle.
    const usable = position instanceof THREE.BufferAttribute
      && !geometry.index
      && position.itemSize === 3
      && position.count / 3 <= MEASURE_CIRCLE_FACE_LIMIT
    const index = usable ? buildMeshCircleIndex(position.array as Float32Array) : null
    measureFeatureIndexes.set(geometry, index)
    return index
  }

  /**
   * How far from a feature the cursor may be and still resolve to it, in the MESH'S own units.
   *
   * Studio uses a flat 0.5mm (`Measure.cpp:42`), which its own notes flag as not scale-aware: at
   * any zoomed-out view that is sub-pixel and nothing can be hovered at all. A screen-pixel budget
   * is converted instead, which is also what the rest of this tool's snapping already spends, so
   * the two cannot disagree about what "near" means.
   *
   * The largest scale component is the divisor deliberately. On a non-uniformly scaled object the
   * budget converts differently per axis, and taking the largest yields the SMALLEST local reach,
   * which errs toward the cursor resolving to the face rather than grabbing a feature the user was
   * not pointing at.
   *
   * The viewport rect is PASSED IN rather than read here: `getBoundingClientRect` forces a
   * synchronous layout and the caller has already taken one on the same pointer move.
   */
  const measureHoverLimitFor = (mesh: THREE.Mesh, worldPoint: THREE.Vector3, rect: DOMRect): number => {
    if (rect.height <= 0) return STUDIO_FEATURE_HOVER_LIMIT
    const distance = camera.position.distanceTo(worldPoint)
    const worldPerPixel = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / rect.height
    const scale = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld)
    const largest = Math.max(scale.x, scale.y, scale.z) || 1
    return (MEASURE_SNAP_PX * worldPerPixel) / largest
  }

  /**
   * The point ON a feature nearest the cursor: Studio's point-selection mode
   * (`GLGizmoMeasure.cpp:1117`), reached by holding Shift.
   *
   * This is also where our own "measure between two arbitrary points" behaviour lives now. Studio
   * has no such mode -- everything it measures comes from a feature -- but a point on a PLANE is
   * exactly a free point on that face, so the two turn out to be the same gesture.
   */
  const pointOnFeature = (feature: MeasureFeature, hit: THREE.Vector3): THREE.Vector3 => {
    switch (feature.kind) {
      case 'point':
        return feature.point.clone()
      case 'edge': {
        // Along the edge, clamped to it: sliding off the end must not measure from thin air.
        const along = feature.end.clone().sub(feature.start)
        const t = THREE.MathUtils.clamp(hit.clone().sub(feature.start).dot(along) / along.lengthSq(), 0, 1)
        return feature.start.clone().addScaledVector(along, t)
      }
      case 'circle': {
        // Whichever the cursor is NEARER: the centre or the rim.
        //
        // Studio decides this with a separate clickable sphere drawn at the centre
        // (`GLGizmoMeasure.cpp:1159`) -- hovering that gripper gives the centre, anywhere else on
        // the torus gives the rim. A distance test is the same intent without a second raycast
        // layer, and it has to exist in some form: a circle's centre as a POINT is a different
        // measurement from the circle itself against a plane or an edge, so with rim-only snapping
        // that measurement is simply unreachable. Returning the centre only for a hit landing
        // exactly on it, which is what this did, is rim-only in practice -- a pointer never lands
        // within a picometre of anything.
        const flattened = hit.clone().sub(feature.center)
        flattened.addScaledVector(feature.normal, -flattened.dot(feature.normal))
        const fromCentre = flattened.length()
        if (fromCentre < feature.radius / 2) return feature.center.clone()
        return feature.center.clone().addScaledVector(flattened.normalize(), feature.radius)
      }
      case 'plane':
        return hit.clone()
    }
  }

  /**
   * Where a world point lands on screen, in the same client coordinates a pointer event uses.
   *
   * Null BEHIND the camera, which `project` alone does not report: it divides by a negative w and
   * hands back mirrored coordinates rather than nothing, so a feature orbited out of view would go
   * on claiming a region of the screen it is no longer anywhere near.
   */
  const toScreen = (point: THREE.Vector3, rect: DOMRect): { x: number; y: number } | null => {
    const inCamera = point.clone().applyMatrix4(camera.matrixWorldInverse)
    if (-inCamera.z <= camera.near) return null
    const projected = point.clone().project(camera)
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height
    }
  }

  /**
   * Resolve the nearest world-space feature, or a point on it in Shift mode.
   * The bed is our own addition and resolves to a bare point without mesh features.
   */
  const pickMeasureFeature = (event: PointerEvent, pointMode: boolean): MeasurePick | null => {
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const targets = Array.from(getGroups())
    // Index on first use, exactly as the paint hit test does and for the same reason: the stock
    // raycast walks every triangle.
    for (const group of targets) {
      if (measureIndexedGroups.has(group)) continue
      measureIndexedGroups.add(group)
      group.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh && mesh.name !== BRIM_EAR_MARKER_NAME) ensureMeshBvh(mesh)
      })
    }
    // THE CENTRE MARKER OF A SELECTED CIRCLE IS RAYCAST FIRST, ahead of the model. It is drawn in
    // empty space over the middle of a hole, so nothing else can be in front of it, and it is the
    // only route to a centre that does not need a hover: a TAP has no pointer path crossing the
    // rim, so on touch the screen-space rule below never arms and this is the whole gesture.
    const centreTargets = getCentreTargets()
    const centreHit = raycaster.intersectObjects(centreTargets.map((entry) => entry.object), false)[0]
    if (centreHit) {
      const slot = centreTargets.find((entry) => entry.object === centreHit.object)
      const circle = slot ? getPicks()[slot.slot]?.source : null
      if (circle?.kind === 'circle') {
        return { feature: { kind: 'point', point: circle.center.clone() }, source: circle }
      }
    }
    // A HOVERED CIRCLE OWNS ITS RING, decided in screen space BEFORE anything is raycast -- see
    // `circleScreenZone`. The source stays the circle, so the hover holds along the rim.
    //
    // Not in POINT MODE, which is the escape hatch. Shift means a free point on whatever is under
    // the cursor, so claiming the ring would hand back the whole circle instead of the point asked
    // for. Left to the raycast below, Shift still resolves the rim on its way to a point on it.
    const hoveredSource = getHoveredSource()
    const hoveredCircle = !pointMode && hoveredSource?.kind === 'circle' ? hoveredSource : null
    const zone = hoveredCircle
      ? circleScreenZone(
        hoveredCircle,
        { x: event.clientX, y: event.clientY },
        (world) => toScreen(world, rect),
        MEASURE_SNAP_PX
      )
      : null
    if (hoveredCircle && zone === 'ring') return { feature: hoveredCircle, source: hoveredCircle }
    const hit = raycaster.intersectObjects(targets, true)
      .find((entry) => entry.face && (entry.object as THREE.Mesh).isMesh && entry.object.name !== BRIM_EAR_MARKER_NAME)
    // A CIRCLE'S INTERIOR IS ONLY ITS OWN WHERE THE RAY GOES THROUGH IT. Screen position alone is
    // not enough, because an outer silhouette is a circle too (`circlesAroundFace`: "a round boss
    // reads as a circle exactly as a bore does"), so a disc claimed on projection would swallow the
    // whole top face of any cylinder and every feature on it. Comparing depths distinguishes the
    // two exactly, including under an oblique view: inside a bore the ray reaches the far wall or
    // nothing, which is BEHIND the circle's own plane, while on a solid round face it lands on that
    // face, at the plane itself, and the face rightly wins. It also keeps anything drawn in FRONT
    // of a hole pickable through it.
    if (hoveredCircle && zone === 'interior' && raySeesThroughCircle(hoveredCircle, raycaster.ray, hit?.distance ?? Infinity)) {
      return { feature: { kind: 'point', point: hoveredCircle.center.clone() }, source: hoveredCircle }
    }
    if (hit?.face && hit.faceIndex != null) {
      const mesh = hit.object as THREE.Mesh
      const index = measureFeatureIndexFor(mesh.geometry)
      if (index) {
        const inverse = new THREE.Matrix4().copy(mesh.matrixWorld).invert()
        const local = hit.point.clone().applyMatrix4(inverse)
        const found = featureAtFace(index, hit.faceIndex, local, measureHoverLimitFor(mesh, hit.point, rect))
        if (found) {
          const source = transformMeasureFeature(found, mesh.matrixWorld)
          return pointMode
            ? { feature: { kind: 'point', point: pointOnFeature(source, hit.point) }, source }
            : { feature: source, source }
        }
      }
      // No index (an indexed or very dense mesh): the raw surface point is still measurable.
      const point: MeasureFeature = { kind: 'point', point: hit.point.clone() }
      return { feature: point, source: point }
    }
    const bedPoint = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(bedPlane, bedPoint)) return null
    const bed = getBed()
    if (bed && (bedPoint.x < bed.minX - 5 || bedPoint.x > bed.maxX + 5
      || bedPoint.y < bed.minY - 5 || bedPoint.y > bed.maxY + 5)) return null
    const onBed: MeasureFeature = { kind: 'point', point: bedPoint }
    return { feature: onBed, source: onBed }
  }

  return pickMeasureFeature
}
