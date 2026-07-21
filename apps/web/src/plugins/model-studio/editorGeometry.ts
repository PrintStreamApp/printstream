/**
 * Pure Three.js / geometry / math helpers for the 3MF plate editor.
 *
 * Everything here is component-agnostic: footprint rasterization and placement-warning
 * detection, prime-tower / brim-ear / face-hull / filament-change-band scene builders,
 * bed-resting and bounding-box math, the geometry LRU cache helpers, and the small
 * scheduling primitives ({@link nextPaint}/{@link nextIdle}). The shared paint-channel,
 * paint-tool, cut-axis, and keyboard-step constants and the plain editor types
 * ({@link GizmoMode}, {@link PaintToolType}, {@link SelectedTransform}, etc.) live here too
 * so both EditorView and the leaf panels (editorPanels.tsx) can import them without
 * pulling in the large view module.
 */
import * as THREE from 'three'
import { ConvexGeometry } from 'three-stdlib'
import type { LibraryThreeMfPrimeTower, SceneEditPartSubtype } from '@printstream/shared'
import type { SliceConfigSnapshot } from '../../components/library/SliceSettingsPanel'
import type { TrianglePaintChannel } from './lib/threeMfScene'
import { FOOTPRINT_CELL_MM, footprintCellKey } from './lib/arrange'
import { estimateWipeTowerFootprint } from './lib/primeTower'
import {
  SEAM_PAINT_COLORS,
  SEAM_PAINT_OVERLAY_NAME,
  SUPPORT_PAINT_COLORS,
  SUPPORT_PAINT_OVERLAY_NAME,
  type PaintPalette
} from './lib/supportPaint'
import type { CutAxis } from './lib/meshCut'
import type { EditorInstance, EditorPlate, EditorState } from './lib/editorModel'

export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'layFace' | 'cut' | 'paintSupports' | 'paintSeam' | 'paintColor' | 'brimEars' | 'measure'

/** Scene-object name for the brim-ear disc markers (children of an instance's rotor). */
export const BRIM_EAR_MARKER_NAME = 'brimEarMarker'
export const BRIM_EAR_MARKER_COLOR = 0xeec25a

/** Viewport meshes for added part volumes (negative parts, modifiers, blockers). */
export const ADDED_PART_MESH_NAME = 'addedPartVolume'

/** BambuStudio's "Change type" options, in its menu order, with its labels. */
export const PART_SUBTYPE_OPTIONS: ReadonlyArray<{ subtype: SceneEditPartSubtype; label: string }> = [
  { subtype: 'normal_part', label: 'Normal part' },
  { subtype: 'negative_part', label: 'Negative part' },
  { subtype: 'modifier_part', label: 'Modifier' },
  { subtype: 'support_blocker', label: 'Support blocker' },
  { subtype: 'support_enforcer', label: 'Support enforcer' }
]

/**
 * Per-channel wiring for the two triangle-paint brushes. Both share the brush, panel,
 * undo, and overlay machinery; they differ only in which EditorState map they edit,
 * which `geometry.userData` key seeds them, and how the overlay renders. The seam
 * overlay's stronger polygon offset draws it above support paint on doubly-painted
 * triangles.
 */
export const PAINT_CHANNEL_SPECS: Record<TrianglePaintChannel, {
  stateKey: 'supportPaint' | 'seamPaint' | 'colorPaint'
  overlayName: string
  palette: PaintPalette
  offsetFactor: number
}> = {
  supports: { stateKey: 'supportPaint', overlayName: SUPPORT_PAINT_OVERLAY_NAME, palette: SUPPORT_PAINT_COLORS, offsetFactor: -2 },
  seam: { stateKey: 'seamPaint', overlayName: SEAM_PAINT_OVERLAY_NAME, palette: SEAM_PAINT_COLORS, offsetFactor: -3 },
  // Colour painting tints with the LIVE filament colours via colorForCode; the palette
  // only covers undecodable split codes. Strongest offset so colour wins visually.
  color: { stateKey: 'colorPaint', overlayName: 'colorPaintOverlay', palette: SUPPORT_PAINT_COLORS, offsetFactor: -4 }
}

/**
 * Modes that put the move/rotate/scale gizmo on the selection — i.e. the ones where a
 * transform readout means anything. Every other mode (paint, cut, lay-face, brim ears,
 * measure) detaches the gizmo and drives its own floating panel instead. Single source of
 * truth for both the detach decision and whether the readout renders, so the two can't drift.
 */
export function isTransformGizmoMode(mode: GizmoMode): boolean {
  return mode === 'translate' || mode === 'rotate' || mode === 'scale'
}

export function paintChannelForGizmoMode(mode: GizmoMode): TrianglePaintChannel | null {
  return mode === 'paintSupports' ? 'supports' : mode === 'paintSeam' ? 'seam' : mode === 'paintColor' ? 'color' : null
}

/**
 * Paint tools, mirroring Bambu Studio's per-gizmo tool rows: circle/sphere brushes
 * everywhere, smart fill on supports + colour, and the single-triangle,
 * same-colour bucket-fill, and height-range tools on colour only.
 */
export type PaintToolType = 'circle' | 'sphere' | 'fill' | 'bucket' | 'triangle' | 'height'

export const PAINT_TOOLS_BY_CHANNEL: Record<TrianglePaintChannel, PaintToolType[]> = {
  supports: ['circle', 'sphere', 'fill'],
  seam: ['circle', 'sphere'],
  color: ['circle', 'sphere', 'triangle', 'fill', 'bucket', 'height']
}

export const PAINT_TOOL_LABELS: Record<PaintToolType, string> = {
  circle: 'Circle',
  sphere: 'Sphere',
  fill: 'Fill',
  bucket: 'Bucket',
  triangle: 'Tri',
  height: 'Height'
}

/** The channel's tool for a selection, falling back to the circle brush. */
export function effectivePaintTool(channel: TrianglePaintChannel, tool: PaintToolType): PaintToolType {
  return PAINT_TOOLS_BY_CHANNEL[channel].includes(tool) ? tool : 'circle'
}

/** Bed-relative names for the two halves either side of each cut-plane axis. */
export const CUT_AXIS_SIDES: Record<CutAxis, { lower: string; upper: string }> = {
  x: { lower: 'left', upper: 'right' },
  y: { lower: 'front', upper: 'back' },
  z: { lower: 'lower', upper: 'upper' }
}

/** One undo/redo step: either a scene snapshot or a slice-config snapshot (not both). */
export type EditorHistoryEntry = { state: EditorState | null; sliceConfig: SliceConfigSnapshot | null }

export const DOWN_VECTOR = new THREE.Vector3(0, 0, -1)

/**
 * Cache of decoded 3MF geometry keyed by `entryPath`. Values are PROMISES so
 * concurrent loads of the same entry (parallel part fetches, prefetch + build)
 * dedupe to one request/parse; failed/aborted loads evict themselves.
 */
export type GeometryCache = Map<string, Promise<Map<number, THREE.BufferGeometry>>>
/** Cache of decoded imported STL geometry keyed by `importId` (promise, as above). */
export type ImportGeometryCache = Map<string, Promise<THREE.BufferGeometry>>

/**
 * Per-session geometry caches are unbounded by default and only freed at editor unmount, so a long
 * session over a big multi-plate project accumulates every parsed BufferGeometry (each solid can be
 * 1MB+) for the whole session — GC/GPU pressure that eventually loses the WebGL context. Cap them
 * (LRU: a hit refreshes recency via {@link touchCacheEntry}) and dispose the evicted geometry, which
 * is safe because the live plate uses per-instance CLONES of these cached originals, not the
 * originals themselves.
 */
// Generous enough to hold a large plate's objects (each part-file object is its own key) plus a few
// neighbouring plates, so eviction targets genuinely cold geometry from earlier plate visits rather
// than thrashing within one build. (Disposing-then-cloning is still safe — clone copies CPU arrays —
// so even an undersized cap degrades to re-upload, never a crash.)
export const GEOMETRY_CACHE_MAX_ENTRIES = 128
/** Move a hit entry to the most-recently-used end so eviction drops genuinely cold geometry. */
export function touchCacheEntry<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key)
  cache.set(key, value)
}
/** Evict least-recently-used entries past the cap, disposing the geometry each resolves to. */
export function evictGeometryCache<V>(cache: Map<string, Promise<V>>, max: number, dispose: (value: V) => void): void {
  while (cache.size > max) {
    const oldestKey = cache.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    const evicted = cache.get(oldestKey)
    cache.delete(oldestKey)
    evicted?.then(dispose).catch(() => undefined)
  }
}

export const ISO_UP = new THREE.Vector3(0, 0, 1)

/** Keyboard move steps (mm) for the bed plane. */
export const KEY_MOVE_STEP = 1
export const KEY_MOVE_STEP_LARGE = 10
export const KEY_MOVE_STEP_FINE = 0.1
/** Keyboard rotate step (radians) about Z. */
export const KEY_ROTATE_STEP = THREE.MathUtils.degToRad(15)
/** Rotation snap increments (radians). Coarse while a modifier is held. */
export const ROTATE_SNAP_COARSE = THREE.MathUtils.degToRad(45)
export const ROTATE_SNAP_FINE = THREE.MathUtils.degToRad(15)

/**
 * Resolve once the browser has had a chance to paint. Awaited before a synchronous,
 * main-thread-blocking rebuild (e.g. switching plates) so a just-shown loading overlay
 * renders first — otherwise the await-chain that follows starves the paint and the work
 * looks like a silent UI freeze. Falls back to a short timer if rAF is paused (backgrounded
 * tab) so the rebuild never stalls.
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    requestAnimationFrame(() => requestAnimationFrame(finish))
    setTimeout(finish, 120)
  })
}

/**
 * Resolve when the main thread has spare time. Awaited between background geometry
 * builds (non-active plate thumbnails) so their synchronous XML-parse/mesh-build
 * chunks land in idle gaps instead of starving in-flight orbit/gizmo interactions.
 * Falls back to a short timer where `requestIdleCallback` is unavailable (Safari).
 */
export function nextIdle(): Promise<void> {
  return new Promise((resolve) => {
    const host = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
    }
    if (typeof host.requestIdleCallback === 'function') {
      host.requestIdleCallback(() => resolve(), { timeout: 1000 })
    } else {
      setTimeout(resolve, 50)
    }
  })
}

/**
 * Build the prime/wipe tower marker. `wipe_tower_x/y` (`tower.x/y`) is the lower-left corner.
 * The footprint matches BambuStudio's prepare-view estimate (see {@link estimateWipeTowerFootprint}):
 * it depends on the purge volume, the plate's filament count and its tallest object, so it is
 * generally smaller than the raw `prime_tower_width` square we used to draw. The Z height is just
 * a visual marker (rises to the print height) and isn't significant.
 */
export function createPrimeTowerObject(
  tower: LibraryThreeMfPrimeTower,
  plateFilamentCount: number,
  printHeight: number
): THREE.Object3D {
  const height = Math.max(printHeight, 2)
  const footprint = estimateWipeTowerFootprint(tower.sizing, tower.width, plateFilamentCount, printHeight)
  const group = new THREE.Group()
  group.userData.isPrimeTower = true
  group.userData.towerWidth = footprint.width
  group.userData.towerDepth = footprint.depth
  const geometry = new THREE.BoxGeometry(footprint.width, footprint.depth, height)
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0xf3a23a, transparent: true, opacity: 0.4, roughness: 0.75, metalness: 0.04 })
  )
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
  group.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.85, depthWrite: false })
  ))
  group.position.set(tower.x + footprint.width / 2, tower.y + footprint.depth / 2, height / 2)
  return group
}

/** The inner rotation group of an instance group (rotation lives here, not on the outer). */
export function rotorOf(group: THREE.Object3D): THREE.Object3D {
  return (group.userData.rotor as THREE.Object3D | undefined) ?? group
}

/** Disc-flat-on-bed orientation for brim ear markers (cylinder axis Y -> world Z). */
const BRIM_EAR_FLAT_QUATERNION = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
const UNIT_SCALE = new THREE.Vector3(1, 1, 1)

/**
 * Re-bake ear marker matrices so every disc sits flat ON THE BED at world scale,
 * whatever the instance's rotation/scale (Bambu's rule: brim ears are first-layer
 * features that always face up). Markers are rotor children so they follow drags;
 * their local matrix is the rotor's inverse world transform composed with the
 * desired bed-level world placement.
 */
export function syncBrimEarMarkerMatrices(group: THREE.Object3D): void {
  const rotor = rotorOf(group)
  let inverse: THREE.Matrix4 | null = null
  for (const child of rotor.children) {
    if (child.name !== BRIM_EAR_MARKER_NAME) continue
    if (!inverse) {
      rotor.updateWorldMatrix(true, false)
      inverse = new THREE.Matrix4().copy(rotor.matrixWorld).invert()
    }
    const ear = child.userData.brimEarLocal as { x: number; y: number; z: number } | undefined
    if (!ear) continue
    const world = new THREE.Vector3(ear.x, ear.y, ear.z).applyMatrix4(rotor.matrixWorld)
    world.z = 0.5 // 1mm-thick disc resting on the bed
    child.matrix.copy(inverse).multiply(new THREE.Matrix4().compose(world, BRIM_EAR_FLAT_QUATERNION, UNIT_SCALE))
  }
}

/**
 * World AABB of an instance's PRINTABLE geometry only (its `Mesh` parts), ignoring
 * decorations like the slightly-enlarged edge-outline `LineSegments`. Those edges are
 * scaled 1.0004x around the part-local origin, so for an object baked far from its local
 * origin they dip below the actual mesh — which previously skewed resting and lifted the
 * object off the bed.
 */
export function printableMeshBox(object: THREE.Object3D, precise = true): THREE.Box3 {
  object.updateMatrixWorld(true)
  const box = new THREE.Box3()
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    // Non-printed aids must NOT affect resting or the selection box. Exclude modifier/support
    // volumes AND viewport-only overlays that sit at the bed (z=0): the place-on-face pick hull
    // (`isFaceHull`), the prime tower, and brim-ear markers. Including the face hull was the
    // "lay flat leaves the part floating" bug — the hull's z=0 box made restObjectOnBed think the
    // object already touched the bed, so it never dropped the freshly rotated geometry.
    if (mesh.userData.isHelperVolume || mesh.userData.isFaceHull || mesh.userData.isPrimeTower) return
    // Paint overlays are a lifted visual aid (and can be 100k+ triangles) — never part of the
    // printable bounds, and walking them per-vertex here is what made dragging a painted part hitch.
    if (mesh.userData.isPaintOverlay) return
    if (mesh.name === BRIM_EAR_MARKER_NAME) return
    // `precise: true` walks actual vertices. Required for rotated meshes: the cheap path
    // transforms the mesh's LOCAL AABB, whose corners rotate BELOW the real geometry, so the
    // box dipped under the mesh and rested the object floating (the "handle" bug). Callers
    // needing exact bounds (resting on the bed) keep the default; the live selection box passes
    // precise=false while dragging, where a slightly loose box is fine and the per-vertex walk
    // would stutter high-poly drags.
    box.expandByObject(mesh, precise)
  })
  return box
}

/** Drop an object so its lowest printable point rests on the bed (z = 0); nothing floats. */
export function restObjectOnBed(object: THREE.Object3D): void {
  const box = printableMeshBox(object)
  if (!box.isEmpty()) object.position.z -= box.min.z
}

/** Do two boxes overlap in the XY (bed) plane, beyond a small tolerance? */
export function xyBoxesOverlap(a: THREE.Box3, b: THREE.Box3, tol = 0.2): boolean {
  return a.min.x < b.max.x - tol && a.max.x > b.min.x + tol
    && a.min.y < b.max.y - tol && a.max.y > b.min.y + tol
}

// Collision grid (2mm cells) shared with the auto-arrange packer in lib/arrange.ts.

/** Is point p inside triangle abc (inclusive)? */
export function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/**
 * Rasterize an instance's actual triangles (projected to XY) into a set of grid
 * cells — the true footprint, so concave/curved parts don't collide just because
 * their bounding box or convex hull would. Each triangle marks its three vertex
 * cells (so thin features register) plus any cells whose centre it covers.
 */
/** Mark all grid cells covered by a triangle (vertex cells + centre-covered cells). */
export function addTriangleCells(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, cells: Set<number>
): void {
  cells.add(footprintCellKey(Math.floor(ax / FOOTPRINT_CELL_MM), Math.floor(ay / FOOTPRINT_CELL_MM)))
  cells.add(footprintCellKey(Math.floor(bx / FOOTPRINT_CELL_MM), Math.floor(by / FOOTPRINT_CELL_MM)))
  cells.add(footprintCellKey(Math.floor(cx / FOOTPRINT_CELL_MM), Math.floor(cy / FOOTPRINT_CELL_MM)))
  const minCX = Math.floor(Math.min(ax, bx, cx) / FOOTPRINT_CELL_MM)
  const maxCX = Math.floor(Math.max(ax, bx, cx) / FOOTPRINT_CELL_MM)
  const minCY = Math.floor(Math.min(ay, by, cy) / FOOTPRINT_CELL_MM)
  const maxCY = Math.floor(Math.max(ay, by, cy) / FOOTPRINT_CELL_MM)
  for (let gx = minCX; gx <= maxCX; gx += 1) {
    for (let gy = minCY; gy <= maxCY; gy += 1) {
      const px = (gx + 0.5) * FOOTPRINT_CELL_MM
      const py = (gy + 0.5) * FOOTPRINT_CELL_MM
      if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) cells.add(footprintCellKey(gx, gy))
    }
  }
}

export function computeFootprintCells(group: THREE.Object3D): Set<number> {
  group.updateWorldMatrix(true, true)
  const cells = new Set<number>()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.isFaceHull || mesh.userData.isPrimeTower || mesh.userData.isHelperVolume || mesh.userData.isPaintOverlay) return
    const position = mesh.geometry.getAttribute('position')
    if (!position) return
    const index = mesh.geometry.getIndex()
    const triangleCount = index ? index.count / 3 : position.count / 3
    for (let t = 0; t < triangleCount; t += 1) {
      const i0 = index ? index.getX(t * 3) : t * 3
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
      a.fromBufferAttribute(position, i0).applyMatrix4(mesh.matrixWorld)
      b.fromBufferAttribute(position, i1).applyMatrix4(mesh.matrixWorld)
      c.fromBufferAttribute(position, i2).applyMatrix4(mesh.matrixWorld)
      addTriangleCells(a.x, a.y, b.x, b.y, c.x, c.y, cells)
    }
  })
  return cells
}

/** Rasterize a (possibly concave) polygon's cells via fan triangulation. */
export function rasterizePolygonCells(polygon: Array<{ x: number; y: number }>): Set<number> {
  const cells = new Set<number>()
  const p0 = polygon[0]
  if (!p0) return cells
  for (let i = 1; i < polygon.length - 1; i += 1) {
    const p1 = polygon[i]!
    const p2 = polygon[i + 1]!
    addTriangleCells(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, cells)
  }
  return cells
}

/**
 * Which nozzle an exclude zone's label requires, as a RUNTIME nozzle id (1 = left, 0 = right) —
 * the same space `filament.nozzleId` uses everywhere else. It previously answered in a private
 * 1 = left / 2 = right space while every caller compared it against runtime ids, so `has(2)` was
 * never true: right-nozzle objects were never held out of a left-nozzle-only zone, and a
 * right-nozzle object sitting legitimately in the "Right nozzle only area" was flagged
 * unreachable.
 */
export function zoneRequiredNozzle(label: string | null): number | null {
  if (!label) return null
  if (/left/i.test(label)) return 1
  if (/right/i.test(label)) return 0
  return null
}

/**
 * Do two footprint cell sets overlap by a meaningful area? Requires several shared
 * cells (not just one boundary cell) so objects that merely touch — or whose edges
 * round into the same 2 mm cell — aren't flagged as colliding.
 */
export function footprintCellsOverlap(a: Set<number>, b: Set<number>, minSharedCells = 4): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const cell of small) {
    if (large.has(cell)) {
      shared += 1
      if (shared >= minSharedCells) return true
    }
  }
  return false
}

/** Rounded transform signature for caching footprints across validation ticks. */
export function groupTransformSignature(group: THREE.Object3D): string {
  const r = (n: number) => Math.round(n * 100) / 100
  const { position: p, quaternion: q, scale: s } = group
  return `${r(p.x)},${r(p.y)},${r(p.z)}|${r(q.x)},${r(q.y)},${r(q.z)},${r(q.w)}|${r(s.x)},${r(s.y)},${r(s.z)}`
}

/**
 * An object's footprint SHAPE signature: its orientation + scale but NOT its position. Two poses
 * with the same shape signature differ only by a translation, so their footprints are the same
 * shape shifted — letting the placement-warning recompute shift cached cells instead of
 * re-rasterizing (see {@link shiftFootprintCells}). Same fields/precision as
 * {@link groupTransformSignature} minus position.
 */
export function groupShapeSignature(group: THREE.Object3D): string {
  const r = (n: number) => Math.round(n * 100) / 100
  const { quaternion: q, scale: s } = group
  return `${r(q.x)},${r(q.y)},${r(q.z)},${r(q.w)}|${r(s.x)},${r(s.y)},${r(s.z)}`
}

/**
 * Full world-affecting transform of an instance group: the outer group's position+scale
 * (it carries no rotation) plus its rotor child's rotation. Full float precision so the
 * selection box stays pixel-accurate during a drag, while letting the animation loop skip
 * the expensive precise-bounds recompute on frames where nothing moved (idle selection or
 * a camera-only orbit) — the per-frame vertex walk was the main avoidable editor cost.
 */
export function selectionBoxSignature(group: THREE.Object3D): string {
  const { position: p, scale: s } = group
  const rq = rotorOf(group).quaternion
  return `${p.x},${p.y},${p.z}|${s.x},${s.y},${s.z}|${rq.x},${rq.y},${rq.z},${rq.w}`
}

/** Whether two plate beds (bounds + unprintable zones) are identical. */
export function bedsEqual(a: EditorPlate['bed'], b: EditorPlate['bed']): boolean {
  return a.minX === b.minX && a.maxX === b.maxX && a.minY === b.minY && a.maxY === b.maxY
    && JSON.stringify(a.excludeAreas) === JSON.stringify(b.excludeAreas)
}

/**
 * Does an axis-aligned XY footprint overlap any unprintable exclude zone? Tested against each
 * zone's bounding box (zones are corner/edge rectangles), which is conservative for any
 * non-rectangular zone — safe, since it only keeps the tower further clear of the excluded area.
 */
export function footprintHitsExcludeZones(
  minX: number, maxX: number, minY: number, maxY: number,
  zones: EditorPlate['bed']['excludeAreas']
): boolean {
  const tol = 0.01
  for (const zone of zones) {
    if (zone.polygon.length === 0) continue
    let zMinX = Infinity, zMaxX = -Infinity, zMinY = Infinity, zMaxY = -Infinity
    for (const point of zone.polygon) {
      zMinX = Math.min(zMinX, point.x); zMaxX = Math.max(zMaxX, point.x)
      zMinY = Math.min(zMinY, point.y); zMaxY = Math.max(zMaxY, point.y)
    }
    if (minX < zMaxX - tol && maxX > zMinX + tol && minY < zMaxY - tol && maxY > zMinY + tol) return true
  }
  return false
}

export interface PlacementWarning {
  key: string
  name: string
  issues: string[]
}

/**
 * Detect placement problems for the printed objects on a plate, mirroring
 * BambuStudio's prepare-view checks: collisions, floating above the bed, extending
 * past the plate, sitting in a truly unprintable area, and — for dual-nozzle
 * machines — sitting in a nozzle-only area the object's nozzle can't reach (e.g. a
 * left-nozzle object in the "Right nozzle only area"), and overlapping the purge/prime
 * tower's footprint. Zone and tower tests use the object's true rasterized footprint,
 * not its bounding box.
 */
export function computePlacementWarnings(
  groups: Map<string, THREE.Group>,
  plate: EditorPlate,
  isPrinted: (instance: EditorInstance) => boolean,
  footprints: Map<string, Set<number>>,
  instanceNozzles: (instance: EditorInstance) => Set<number>,
  primeTower: { minX: number; maxX: number; minY: number; maxY: number } | null
): PlacementWarning[] {
  const entries: Array<{ instance: EditorInstance; box: THREE.Box3 }> = []
  for (const instance of plate.instances) {
    const group = groups.get(instance.key)
    if (!group || !isPrinted(instance)) continue
    const box = new THREE.Box3().setFromObject(group)
    if (!box.isEmpty()) entries.push({ instance, box })
  }
  const issues = new Map<string, Set<string>>()
  const add = (key: string, message: string) => {
    const set = issues.get(key) ?? new Set<string>()
    set.add(message)
    issues.set(key, set)
  }
  // Rasterize each exclude zone once for shape-accurate footprint-vs-zone tests.
  const zoneCells = plate.bed.excludeAreas.map((zone) => ({
    zone,
    cells: rasterizePolygonCells(zone.polygon),
    requiredNozzle: zoneRequiredNozzle(zone.label)
  }))
  // Rasterize the purge/prime tower's footprint once (only present on multi-filament
  // plates) so objects that intrude into it are flagged — BambuStudio keeps the tower
  // clear of printed parts. The tower is draggable, so the caller passes its live rect.
  const towerCells = primeTower
    ? rasterizePolygonCells([
        { x: primeTower.minX, y: primeTower.minY },
        { x: primeTower.maxX, y: primeTower.minY },
        { x: primeTower.maxX, y: primeTower.maxY },
        { x: primeTower.minX, y: primeTower.maxY }
      ])
    : null
  const tol = 0.2
  for (const { instance, box } of entries) {
    if (box.min.z > 0.3) add(instance.key, 'floats above the plate')
    const footprint = footprints.get(instance.key)
    // Use the shape-accurate footprint (the rasterized cells where geometry actually
    // sits) for the off-plate test, not the AABB — a curved/diagonal object's AABB pokes
    // past the plate even when no geometry reaches that corner (false positive). A cell is
    // only "past" when it clears the edge by ~a cell, so geometry resting at the edge
    // (quantized into a boundary cell) doesn't trip it. Falls back to the AABB if a
    // footprint hasn't been rasterized yet.
    const edgeTol = FOOTPRINT_CELL_MM
    if (footprint && footprint.size > 0) {
      let past = false
      for (const cell of footprint) {
        const cy = (cell % 32768) - 16384
        const cx = (cell - (cell % 32768)) / 32768 - 16384
        const cellMinX = cx * FOOTPRINT_CELL_MM
        const cellMinY = cy * FOOTPRINT_CELL_MM
        if (cellMinX < plate.bed.minX - edgeTol
          || cellMinX + FOOTPRINT_CELL_MM > plate.bed.maxX + edgeTol
          || cellMinY < plate.bed.minY - edgeTol
          || cellMinY + FOOTPRINT_CELL_MM > plate.bed.maxY + edgeTol) {
          past = true
          break
        }
      }
      if (past) add(instance.key, 'extends past the plate')
    } else if (box.min.x < plate.bed.minX - tol || box.max.x > plate.bed.maxX + tol
      || box.min.y < plate.bed.minY - tol || box.max.y > plate.bed.maxY + tol) {
      add(instance.key, 'extends past the plate')
    }
    if (footprint) {
      for (const { cells, requiredNozzle } of zoneCells) {
        if (!footprintCellsOverlap(footprint, cells, 3)) continue
        if (requiredNozzle == null) {
          add(instance.key, 'is in an unprintable area')
        } else {
          // The zone is reachable only by `requiredNozzle`; valid only if the object
          // uses solely that nozzle. Unknown nozzles stay lenient (no false alarm).
          const nozzles = instanceNozzles(instance)
          if (nozzles.size > 0 && !(nozzles.size === 1 && nozzles.has(requiredNozzle))) {
            add(instance.key, `can't reach here with its nozzle (${requiredNozzle === 1 ? 'left' : 'right'} nozzle only)`)
          }
        }
      }
    }
    if (towerCells && footprint && footprintCellsOverlap(footprint, towerCells)) {
      add(instance.key, 'overlaps the purge tower')
    }
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!
      const b = entries[j]!
      // Cheap AABB reject first, then precise convex-hull (SAT) so tightly packed
      // round/irregular parts whose boxes touch aren't false-flagged as colliding.
      if (!xyBoxesOverlap(a.box, b.box)) continue
      const cellsA = footprints.get(a.instance.key)
      const cellsB = footprints.get(b.instance.key)
      const overlaps = cellsA && cellsB ? footprintCellsOverlap(cellsA, cellsB) : true
      if (overlaps) {
        add(a.instance.key, 'overlaps another object')
        add(b.instance.key, 'overlaps another object')
      }
    }
  }
  return entries
    .filter(({ instance }) => issues.has(instance.key))
    .map(({ instance }) => ({ key: instance.key, name: instance.name ?? 'Object', issues: [...issues.get(instance.key)!] }))
}

/**
 * Dim an instance's materials when it is excluded from the print, so skipped
 * objects are visually distinct (like BambuStudio greys them out). The original
 * opacity/transparency is captured once so it can be restored when re-enabled.
 */
export const FILAMENT_CHANGE_MAX_BANDS = 8
export const LAYER_PAUSE_MAX_STRIPES = 8
/** Half-height (mm) of the pause stripe drawn at each pause's world Z. */
const LAYER_PAUSE_STRIPE_HALF_HEIGHT = 0.3

/**
 * Shared uniform set driving the layer-band overlay shader on every part material:
 * filament-change recolour bands plus layer-pause marker stripes.
 */
export interface LayerBandUniforms {
  uFcCount: { value: number }
  uFcHeights: { value: number[] }
  uFcColors: { value: THREE.Color[] }
  uPauseCount: { value: number }
  uPauseHeights: { value: number[] }
}

/**
 * Inject per-height layer overlays into a part's MeshStandardMaterial: above each
 * filament-change height (world Z, ascending) the fragment colour switches to that
 * change's material colour, and a thin amber stripe marks each layer pause, so the
 * 3D model shows both exactly where they will print. Uniforms are shared across all
 * part materials, so panel edits update every mesh per-frame without recompiling shaders.
 */
export function applyLayerBandOverlays(material: THREE.Material, uniforms: LayerBandUniforms): void {
  const standard = material as THREE.MeshStandardMaterial
  if (standard.userData.hasLayerBandOverlays) return
  standard.userData.hasLayerBandOverlays = true
  standard.onBeforeCompile = (shader) => {
    shader.uniforms.uFcCount = uniforms.uFcCount
    shader.uniforms.uFcHeights = uniforms.uFcHeights
    shader.uniforms.uFcColors = uniforms.uFcColors
    shader.uniforms.uPauseCount = uniforms.uPauseCount
    shader.uniforms.uPauseHeights = uniforms.uPauseHeights
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFcWorldZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFcWorldZ = (modelMatrix * vec4(position, 1.0)).z;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying float vFcWorldZ;',
        'uniform int uFcCount;',
        `uniform float uFcHeights[${FILAMENT_CHANGE_MAX_BANDS}];`,
        `uniform vec3 uFcColors[${FILAMENT_CHANGE_MAX_BANDS}];`,
        'uniform int uPauseCount;',
        `uniform float uPauseHeights[${LAYER_PAUSE_MAX_STRIPES}];`
      ].join('\n'))
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        `for (int i = 0; i < ${FILAMENT_CHANGE_MAX_BANDS}; i++) {`,
        '  if (i < uFcCount && vFcWorldZ >= uFcHeights[i]) {',
        '    diffuseColor.rgb = uFcColors[i];',
        '  }',
        '}',
        `for (int i = 0; i < ${LAYER_PAUSE_MAX_STRIPES}; i++) {`,
        // toFixed keeps the literal a valid GLSL float even for a whole-number constant.
        `  if (i < uPauseCount && abs(vFcWorldZ - uPauseHeights[i]) < ${LAYER_PAUSE_STRIPE_HALF_HEIGHT.toFixed(4)}) {`,
        '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.62, 0.11), 0.85);',
        '  }',
        '}'
      ].join('\n'))
  }
  standard.needsUpdate = true
}

export function setObjectPrintedStyle(object: THREE.Object3D, printed: boolean): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (!material) continue
      if (material.userData.basePrintOpacity === undefined) {
        material.userData.basePrintOpacity = material.opacity
        material.userData.basePrintTransparent = material.transparent
      }
      const baseOpacity = material.userData.basePrintOpacity as number
      const baseTransparent = material.userData.basePrintTransparent as boolean
      material.opacity = printed ? baseOpacity : Math.min(baseOpacity, 0.16)
      material.transparent = printed ? baseTransparent : true
      material.needsUpdate = true
    }
  })
}

/**
 * Build a translucent convex-hull overlay (in the group's local frame) to show the
 * "place on face" candidate faces — including a pseudo-face/lid over open ends like
 * a cup, which BambuStudio also exposes. Returns null if the object has too few
 * points. Tag it with `isFaceHull` so picking can target it.
 */
/** Convex hull of all the group's mesh vertices, in the group's local frame. */
export function buildHullGeometry(group: THREE.Object3D): THREE.BufferGeometry | null {
  group.updateMatrixWorld(true)
  const toLocal = new THREE.Matrix4().copy(group.matrixWorld).invert()
  const points: THREE.Vector3[] = []
  const vertex = new THREE.Vector3()
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.isFaceHull) return
    const position = mesh.geometry.getAttribute('position')
    if (!position) return
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(toLocal)
      points.push(vertex.clone())
    }
  })
  if (points.length < 4) return null
  try {
    return new ConvexGeometry(points)
  } catch {
    return null
  }
}

export function buildFaceHullOverlay(group: THREE.Object3D): THREE.Mesh | null {
  const geometry = buildHullGeometry(group)
  if (!geometry) return null
  // The convex hull is nearly coincident with the printed surface over large areas, so depth
  // testing it against the object z-fights badly (per-fragment flicker — the "triangle artifacts",
  // worst when a hull face sits right on an object face, e.g. viewing a part from below the bed).
  // polygonOffset can't reliably separate a near-coincident curved hull. Instead, take the overlay
  // out of the depth fight: depthTest:false so it always draws over the printed surface. FrontSide
  // (not DoubleSide) so only the camera-facing hull tints — no back-face double-render muddiness —
  // and so picking only hits faces you can see. renderOrder keeps it on top of the opaque scene.
  const overlay = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.18, side: THREE.FrontSide, depthWrite: false, depthTest: false })
  )
  overlay.userData.isFaceHull = true
  overlay.renderOrder = 6
  // Hovered-face highlight (BambuStudio-style): a brighter coplanar-face fill + bright outline,
  // hidden until the pointer is over a face (driven by updateHullFaceHighlight). Same depthTest:false
  // treatment so the highlight never z-fights the face it sits on; drawn above the hull.
  const highlight = new THREE.Group()
  highlight.visible = false
  const fill = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, depthTest: false })
  )
  // Tag the highlight fill as part of the hull too: it is a separate child mesh, so without this
  // printableMeshBox/buildHullGeometry would count the hovered face's geometry — when that face is
  // the bottom (sitting at z=0) it polluted the rest box and the part floated after lay-flat.
  fill.userData.isFaceHull = true
  fill.renderOrder = 7
  const outline = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })
  )
  outline.renderOrder = 8
  highlight.add(fill, outline)
  overlay.add(highlight)
  overlay.userData.highlight = highlight
  return overlay
}

/** xyz-triple positions of the convex-hull triangles coplanar with triangle `faceIndex`. */
function coplanarFacePositions(geometry: THREE.BufferGeometry, faceIndex: number): Float32Array | null {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!pos) return null
  const index = geometry.getIndex()
  const triCount = index ? index.count / 3 : pos.count / 3
  if (faceIndex < 0 || faceIndex >= triCount) return null
  const vertexIndex = (tri: number, corner: number) => (index ? index.getX(tri * 3 + corner) : tri * 3 + corner)
  const read = (tri: number, va: THREE.Vector3, vb: THREE.Vector3, vc: THREE.Vector3) => {
    va.fromBufferAttribute(pos, vertexIndex(tri, 0))
    vb.fromBufferAttribute(pos, vertexIndex(tri, 1))
    vc.fromBufferAttribute(pos, vertexIndex(tri, 2))
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  read(faceIndex, a, b, c)
  const refNormal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
  if (refNormal.lengthSq() === 0) return null
  refNormal.normalize()
  const refOffset = refNormal.dot(a)
  const out: number[] = []
  const ta = new THREE.Vector3(), tb = new THREE.Vector3(), tc = new THREE.Vector3(), normal = new THREE.Vector3()
  for (let tri = 0; tri < triCount; tri++) {
    read(tri, ta, tb, tc)
    normal.subVectors(tb, ta).cross(new THREE.Vector3().subVectors(tc, ta))
    if (normal.lengthSq() === 0) continue
    normal.normalize()
    if (normal.dot(refNormal) < 0.996) continue // ~5deg: same outward-facing orientation
    if (Math.abs(refNormal.dot(ta) - refOffset) > 0.4) continue // same plane (0.4mm tolerance)
    out.push(ta.x, ta.y, ta.z, tb.x, tb.y, tb.z, tc.x, tc.y, tc.z)
  }
  return out.length > 0 ? new Float32Array(out) : null
}

/**
 * Show/refresh the place-on-face hull's hovered-face highlight for the convex-hull triangle
 * `faceIndex` (the whole coplanar face it belongs to), or hide it when `faceIndex` is null.
 */
export function updateHullFaceHighlight(hull: THREE.Mesh, faceIndex: number | null): void {
  const highlight = hull.userData.highlight as THREE.Group | undefined
  if (!highlight) return
  // Skip the rebuild while the pointer stays on the same triangle (pointermove fires per pixel).
  if (hull.userData.highlightFaceIndex === faceIndex) return
  hull.userData.highlightFaceIndex = faceIndex
  const positions = faceIndex == null ? null : coplanarFacePositions(hull.geometry as THREE.BufferGeometry, faceIndex)
  if (!positions) { highlight.visible = false; return }
  const fill = highlight.children[0] as THREE.Mesh
  const outline = highlight.children[1] as THREE.LineSegments
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  fill.geometry.dispose()
  fill.geometry = geometry
  outline.geometry.dispose()
  outline.geometry = new THREE.EdgesGeometry(geometry, 1)
  highlight.visible = true
}

/**
 * The world-space normal of the group's largest convex-hull "face" (coplanar hull
 * triangles clustered by normal, biggest summed world area wins). Resting the object
 * on this face is the auto-orient heuristic: the largest flat face is the most
 * stable, support-free base. Returns null when no hull can be built.
 */
export function largestHullFaceNormal(group: THREE.Object3D): THREE.Vector3 | null {
  const geometry = buildHullGeometry(group)
  if (!geometry) return null
  const position = geometry.getAttribute('position')
  if (!position) return null
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edgeAB = new THREE.Vector3()
  const edgeAC = new THREE.Vector3()
  const cross = new THREE.Vector3()
  const clusters = new Map<string, { normal: THREE.Vector3; area: number }>()
  for (let i = 0; i + 2 < position.count; i += 3) {
    // World-space triangle (the group may be scaled) for both the normal and area.
    a.fromBufferAttribute(position, i).applyMatrix4(group.matrixWorld)
    b.fromBufferAttribute(position, i + 1).applyMatrix4(group.matrixWorld)
    c.fromBufferAttribute(position, i + 2).applyMatrix4(group.matrixWorld)
    edgeAB.subVectors(b, a)
    edgeAC.subVectors(c, a)
    cross.crossVectors(edgeAB, edgeAC)
    const area = cross.length() / 2
    if (area < 1e-9) continue
    cross.normalize()
    const key = `${cross.x.toFixed(2)},${cross.y.toFixed(2)},${cross.z.toFixed(2)}`
    const cluster = clusters.get(key)
    if (cluster) {
      cluster.area += area
      cluster.normal.addScaledVector(cross, area)
    } else {
      clusters.set(key, { normal: cross.clone().multiplyScalar(area), area })
    }
  }
  geometry.dispose()
  let best: { normal: THREE.Vector3; area: number } | null = null
  for (const cluster of clusters.values()) {
    if (!best || cluster.area > best.area) best = cluster
  }
  if (!best) return null
  return best.normal.normalize()
}

/** Live transform of the selected instance, surfaced to the manual-input panel. */
export interface SelectedTransform {
  position: { x: number; y: number; z: number }
  /** Rotation in degrees (display units). */
  rotationDeg: { x: number; y: number; z: number }
  /** Scale in percent (display units). */
  scalePct: { x: number; y: number; z: number }
}

/** Build a small Bambu-style rotation snap-guide ring with spokes at 45-deg steps. */
export function createRotationSnapGuides(): THREE.Group {
  const group = new THREE.Group()
  const radius = 26
  const ringPoints: THREE.Vector3[] = []
  for (let i = 0; i <= 64; i += 1) {
    const angle = (i / 64) * Math.PI * 2
    ringPoints.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.2))
  }
  group.add(
    new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ringPoints),
      new THREE.LineBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.5, depthTest: false })
    )
  )
  for (let deg = 0; deg < 360; deg += 45) {
    const angle = THREE.MathUtils.degToRad(deg)
    const inner = deg % 90 === 0 ? 0 : radius * 0.55
    const spoke = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(angle) * inner, Math.sin(angle) * inner, 0.2),
        new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.2)
      ]),
      new THREE.LineBasicMaterial({
        color: deg % 90 === 0 ? 0xffd27f : 0x7fb8ff,
        transparent: true,
        opacity: deg % 90 === 0 ? 0.85 : 0.45,
        depthTest: false
      })
    )
    group.add(spoke)
  }
  group.renderOrder = 5
  return group
}

/** Floating "123.45 mm" sprite for the measure overlay (always faces the camera). */
export function createMeasureLabelSprite(text: string): THREE.Sprite | null {
  const fontSize = 44
  const paddingX = 16
  const paddingY = 10
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return null
  context.font = `600 ${fontSize}px sans-serif`
  canvas.width = Math.ceil(context.measureText(text).width + paddingX * 2)
  canvas.height = fontSize + paddingY * 2
  context.font = `600 ${fontSize}px sans-serif`
  // Solid-ish backdrop so the value stays readable over any model colour.
  context.fillStyle = 'rgba(13, 19, 34, 0.82)'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = 'rgba(208, 226, 255, 0.96)'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, canvas.width / 2, canvas.height / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 4
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }))
  const heightMm = 9
  sprite.scale.set((canvas.width / canvas.height) * heightMm, heightMm, 1)
  sprite.renderOrder = 8
  return sprite
}
