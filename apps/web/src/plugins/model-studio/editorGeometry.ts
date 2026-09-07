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
import type { MeasureFeature } from './lib/measureFeatures'
import { ConvexGeometry } from 'three-stdlib'
import type { LibraryThreeMfPrimeTower, SceneEditPartSubtype } from '@printstream/shared'
import type { SliceConfigSnapshot } from '../../components/library/SliceSettingsPanel'
import { createFlatBedLabel, disposeObject3D, type TrianglePaintChannel } from './lib/threeMfScene'
import { FOOTPRINT_CELL_MM, footprintCellKey } from './lib/arrange'
import { estimateWipeTowerFootprint } from './lib/primeTower'
import { primeTowerReachIssue } from './lib/primeTowerReach'
import {
  FUZZY_PAINT_COLORS,
  FUZZY_PAINT_OVERLAY_NAME,
  SEAM_PAINT_COLORS,
  SEAM_PAINT_OVERLAY_NAME,
  SUPPORT_PAINT_COLORS,
  SUPPORT_PAINT_OVERLAY_NAME,
  type PaintPalette
} from './lib/supportPaint'
import type { CutAxis } from './lib/meshCut'
import type { EditorInstance, EditorPlate, EditorState } from './lib/editorModel'

/**
 * `layerHeight` is BambuStudio's layers-editing MODE, not a gizmo: Studio's `enable_layers_editing`
 * runs alongside `reset_all_gizmos()`, so entering it leaves the object selected but detaches every
 * manipulation handle. Ours has to be a mode for the same reason -- the move gizmo's arrows and
 * bounding box sit exactly where the thickness shading needs to be read.
 */
export type GizmoMode = 'select' | 'translate' | 'rotate' | 'scale' | 'layFace' | 'cut' | 'meshBoolean' | 'paintSupports' | 'paintSeam' | 'paintColor' | 'paintFuzzy' | 'brimEars' | 'measure' | 'layerHeight' | 'text' | 'svg'

/**
 * Meshes that exist only to be LOOKED at: they are never printed, never part of the object's
 * bounds, and never input to a tool that reads geometry.
 *
 * One predicate rather than a flag list repeated at each call site, because the list is now long
 * enough that adding an aid means remembering three separate filters, and forgetting one is silent:
 * an aid in `collectWorldTriangles` corrupts the Adaptive layer-height input, and an aid in
 * `printableMeshBox` moves the object on the bed.
 */
export function isViewportAidMesh(mesh: THREE.Mesh): boolean {
  return Boolean(
    mesh.userData.isHelperVolume || mesh.userData.isFaceHull || mesh.userData.isPrimeTower
    || mesh.userData.isPaintOverlay || mesh.userData.isLayerHeightVisual
    // Brim ear markers are the one aid tagged by NAME rather than a `userData` flag (they are
    // plain discs the ear editor raycasts against), so they were invisible to this predicate and
    // reached every geometry reader that trusts it: `printableMeshBox` had to exclude them a second
    // time by name, and `collectWorldTriangles` did not exclude them at all -- an object with three
    // manual ears exported, cut, assembled and booleaned with three 1mm discs welded to its base.
    // The boolean is what made that fatal rather than merely wrong: the discs are open at the seam
    // where they meet the model, so the closed-solid gate refused the whole object.
    || mesh.name === BRIM_EAR_MARKER_NAME
  )
}

/**
 * How the text being edited is currently being interacted with, which is what its highlight shows.
 *
 * `drag` renders it in its REAL material deliberately: the highlight exists to say "this can be
 * grabbed", and once it has been grabbed that message is delivered. Anything left on screen then
 * competes with the only thing the user is judging, which is how the text sits on the surface.
 */
export type TextInteraction = 'idle' | 'hover' | 'drag'

/** Emissive tints for {@link TextInteraction}. `drag` has none: the text renders as it will print. */
export const TEXT_HIGHLIGHT_COLORS: Record<Exclude<TextInteraction, 'drag'>, number> = {
  idle: 0x2f7d63,
  hover: 0x4fd1a5
}

/** Scene-object name for the brim-ear disc markers (children of an instance's rotor). */
export const BRIM_EAR_MARKER_NAME = 'brimEarMarker'
export const BRIM_EAR_MARKER_COLOR = 0xeec25a

/** Viewport meshes for added part volumes (negative parts, modifiers, blockers). */
export const ADDED_PART_MESH_NAME = 'addedPartVolume'

/**
 * Whether a mesh belongs to a volume ADDED to an object this session, as opposed to the object's
 * own geometry.
 *
 * Both levels are tested because the volume is a named mesh that may carry children of its own
 * (a paint overlay), and a walk that only checks the mesh lets those through. Distinct from
 * {@link isViewportAidMesh}: an added part is real geometry that prints, so callers skip it only
 * when they specifically mean "the object's own body" -- where the text tool lands a glyph, and
 * which surface a boolean's body operand contributes.
 */
export function isAddedPartMesh(mesh: THREE.Object3D): boolean {
  return mesh.name === ADDED_PART_MESH_NAME || mesh.parent?.name === ADDED_PART_MESH_NAME
}

/**
 * The part identity tag on a render group, whichever kind it is: `partRef` for a part baked into
 * the project's 3MF, `importPartRef` for a solid of a still-unsaved import. The two are kept as
 * DIFFERENT keys on purpose, they bake through different `SceneEdit` seams (real 3MF object ids
 * vs import + solid index), but every consumer that only needs "which part is this group?"
 * (gizmo attach, drag write-back, selection outlines) must accept both, or a multi-solid import's
 * parts silently become unselectable.
 */
/**
 * Convert a PLATE-axis movement into the object-local delta that moves a part the same way.
 *
 * Arrow keys (and the manual position inputs) speak plate axes, but a part's stored position is
 * object-local. Without this conversion a rotated object sends its part the opposite way, press
 * right, the part goes left, and a scaled one moves it the wrong distance. Rotation AND scale are
 * inverted (a 2x object needs half the local delta); translation is irrelevant for a direction.
 */
export function plateDeltaToPartLocal(rotorMatrixWorld: THREE.Matrix4, dx: number, dy: number, dz = 0): THREE.Vector3 {
  return new THREE.Vector3(dx, dy, dz)
    .applyMatrix4(new THREE.Matrix4().copy(rotorMatrixWorld).setPosition(0, 0, 0).invert())
}

/**
 * The part a render group draws, or null. `partIndex` is the IDENTITY (the part's ordinal within
 * its object, BambuStudio's own key); `componentObjectId` is the MESH it references and is NOT
 * unique: several volumes of one object legitimately share a mesh, and keying on it made an edit
 * to one of them hit every sibling that shared it.
 */
export function partGroupRef(node: THREE.Object3D): { componentObjectId: number; partIndex: number } | null {
  const ref = (node.userData.partRef ?? node.userData.importPartRef) as
    { componentObjectId: number; partIndex: number } | undefined
  return ref ?? null
}

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
  stateKey: 'supportPaint' | 'seamPaint' | 'colorPaint' | 'fuzzyPaint'
  overlayName: string
  palette: PaintPalette
  offsetFactor: number
}> = {
  supports: { stateKey: 'supportPaint', overlayName: SUPPORT_PAINT_OVERLAY_NAME, palette: SUPPORT_PAINT_COLORS, offsetFactor: -2 },
  seam: { stateKey: 'seamPaint', overlayName: SEAM_PAINT_OVERLAY_NAME, palette: SEAM_PAINT_COLORS, offsetFactor: -3 },
  // Colour painting tints with the LIVE filament colours via colorForCode; the palette
  // only covers undecodable split codes. Strongest offset so colour wins visually.
  color: { stateKey: 'colorPaint', overlayName: 'colorPaintOverlay', palette: SUPPORT_PAINT_COLORS, offsetFactor: -4 },
  // Fuzzy skin is a single-state channel like seam: painted or not. Its own attribute even though
  // BambuStudio gives it the same VALUE as a support enforcer (`FUZZY_SKIN = ENFORCER`), so a
  // triangle can be both and painting one must not erase the other.
  fuzzy: { stateKey: 'fuzzyPaint', overlayName: FUZZY_PAINT_OVERLAY_NAME, palette: FUZZY_PAINT_COLORS, offsetFactor: -5 }
}

/**
 * Whether a painted-triangle overlay should be drawn, given the tool and selection.
 *
 * Colour paint always shows: it IS the print's colour, not an annotation. The other channels are
 * annotations over a very dense overlay mesh (100k+ leaf sub-triangles at the 0.2mm split limit), so
 * they show only for the SELECTED object while their own tool is active, matching BambuStudio.
 *
 * ONE rule, because it is applied from three places that must agree: the scene's per-frame sync, the
 * paint hook's overlay rebuild, and the plate build's initial seed. The seed was the one that did
 * not apply it -- a freshly built overlay simply inherited three's default `visible = true` -- so
 * every scene rebuild flashed the painted channels over the model until the sync next ran, which it
 * only does when the tool, selection or drag state CHANGES. On a project with fuzzy-skin paint that
 * is a full-model purple flash on every delete, undo, or part edit.
 *
 * Callers with extra reasons to hide everything (a live drag, layer-height editing) apply those on
 * top; this is the base rule, not the whole answer.
 */
export function paintOverlayVisible(
  channel: TrianglePaintChannel,
  activeChannel: TrianglePaintChannel | null,
  isSelectedGroup: boolean
): boolean {
  return channel === 'color' || (channel === activeChannel && isSelectedGroup)
}

/**
 * EVERY paint channel, derived from {@link PAINT_CHANNEL_SPECS} rather than written out.
 *
 * Two loops used to hardcode `['supports', 'seam', 'color']`: the overlay refresh that undo/redo
 * runs, and the seeding a freshly built part mesh gets. Adding fuzzy skin to the spec map left both
 * behind, so an undo mid-paint rebuilt three channels and dropped the fourth, and the next dab
 * (which rebuilds the whole channel from state) made it reappear. Nothing failed; the paint just
 * blinked out. Deriving the list means a fifth channel cannot repeat that.
 */
export const TRIANGLE_PAINT_CHANNELS = Object.keys(PAINT_CHANNEL_SPECS) as TrianglePaintChannel[]

/**
 * Modes that put the move/rotate/scale gizmo on the selection: i.e. the ones where a
 * transform readout means anything. Every other mode (paint, cut, lay-face, brim ears,
 * measure) detaches the gizmo and drives its own floating panel instead. Single source of
 * truth for both the detach decision and whether the readout renders, so the two can't drift.
 */
/**
 * The mode the editor rests in: pick things, move nothing.
 *
 * Ports BambuStudio's `GLGizmosManager::Undefined`, which is what its manager initialises to
 * (`GLGizmosManager.cpp:139`) and what clicking the active tool toggles back to (`:366`) -- so
 * Studio also opens a project with NO gizmo attached, and groups that state with Move/Rotate/Scale
 * for everything about selection (`is_allow_select_all`, `is_allow_multi_select_parts_or_objects`,
 * `:709-726`). We diverge on ONE point, deliberately: Studio still lets you drag an object's body
 * with no gizmo active (its drag test is `!any_gizmo_active || !evt.CmdDown()`,
 * `GLCanvas3D.cpp:5807`), so its no-gizmo state means "no handles drawn" rather than "nothing
 * moves". Here a drag orbits the camera instead, because the point of the mode is to click around
 * a dense plate without nudging anything -- Move is one click away when you want it.
 *
 * `translate` used to be the resting state, which meant every selected object always wore the move
 * arrows and any stray drag displaced it.
 */
export const RESTING_GIZMO_MODE = 'select' as const

/** The three modes that put the move/rotate/scale gizmo on the selection and show its readout. */
export type TransformGizmoMode = Extract<GizmoMode, 'translate' | 'rotate' | 'scale'>

/** Narrows to {@link TransformGizmoMode} so callers can hand the mode straight to the readout. */
export function isTransformGizmoMode(mode: GizmoMode): mode is TransformGizmoMode {
  return mode === 'translate' || mode === 'rotate' || mode === 'scale'
}

/**
 * Modes in which pointing at something still SELECTS it: the resting mode plus the three transform
 * gizmos.
 *
 * BambuStudio spells this exact set out three separate times over `Undefined | Move | Rotate |
 * Scale` (`is_allow_select_all`, `is_allow_multi_select_parts_or_objects`,
 * `is_allow_x_ray_in_assembly`, `GLGizmosManager.cpp:709-726`). Every other mode ACTS on whatever it
 * is pointed at -- paint, cut, place-on-face -- so a click there is the tool firing, not a pick.
 *
 * A predicate rather than the condition written out per site: it WAS written out, and adding the
 * resting mode to the multi-selection site while missing the part drill-down is exactly how
 * clicking a part inside a selected object silently stopped working.
 */
export function allowsSelectionPicking(mode: GizmoMode): boolean {
  return mode === RESTING_GIZMO_MODE || isTransformGizmoMode(mode)
}

/** What a press of Escape should do, given the editor's current state. */
export type EditorEscapeAction = 'reset-tool' | 'clear-selection' | 'close'

/**
 * Decide Escape's effect: back out of the tool, then out of the selection, then out of the editor.
 *
 * Split out as a pure function because its ONE caller is not where you would look for it. Escape
 * never reaches the editor's window-level shortcut handler: `EditorView` renders inside a Joy
 * `Modal`, and MUI's modal hook calls `stopPropagation()` on Escape ("Swallow the event, in case
 * someone is listening for the escape key on the body" -- `@mui/base/unstable_useModal`), so the
 * only place it arrives is the Modal's own `onClose`. Handling it there is not a workaround but the
 * better position: MUI fires `onClose` only for the TOP modal, so a settings dialog stacked over the
 * editor keeps its own Escape and this never runs, which a capture-phase listener would have had to
 * re-derive by hand.
 *
 * Mirrors BambuStudio's two stages, where the gizmo manager gets first refusal and closes the open
 * gizmo while KEEPING the selection (`GLGizmosManager.cpp:1132-1142`), and only then does
 * `GLCanvas3D`'s `case WXK_ESCAPE: deselect_all()` run (`GLCanvas3D.cpp:4607`). The third stage is
 * ours: Studio's canvas is a window, ours is a dialog, and a dialog that ignores Escape is worse
 * than one that closes.
 */
export function editorEscapeAction(mode: GizmoMode, hasSelection: boolean): EditorEscapeAction {
  if (mode !== RESTING_GIZMO_MODE) return 'reset-tool'
  if (hasSelection) return 'clear-selection'
  return 'close'
}

/**
 * Modes that are INERT without a selection, and so must fall back when one is cleared.
 *
 * Each of these drives a floating panel bound to the selected object and attaches no gizmo. With
 * nothing selected they render nothing at all, leaving the editor in a mode with no panel, no gizmo
 * and no way out except clicking an object: the rail still shows the tool lit, but disabled. The
 * resting mode and the transform modes are excluded because they are harmless with an empty
 * selection; `measure`, `text` and `svg` are excluded because they genuinely work without one --
 * measure picks points on any object, and text or artwork with nothing selected adds its OWN model,
 * which is the only way to letter or badge a plate that has no host. Text was not exempt, so opening
 * the tool with an empty selection bounced straight back to Move and the tool appeared to close
 * itself.
 */
export function isSelectionOnlyGizmoMode(mode: GizmoMode): boolean {
  return mode !== RESTING_GIZMO_MODE && !isTransformGizmoMode(mode)
    && mode !== 'measure' && mode !== 'text' && mode !== 'svg'
}

export function paintChannelForGizmoMode(mode: GizmoMode): TrianglePaintChannel | null {
  return mode === 'paintSupports' ? 'supports'
    : mode === 'paintSeam' ? 'seam'
    : mode === 'paintColor' ? 'color'
    : mode === 'paintFuzzy' ? 'fuzzy'
    : null
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
  color: ['circle', 'sphere', 'triangle', 'fill', 'bucket', 'height'],
  // Studio's fuzzy-skin gizmo offers circle, sphere, triangle and smart fill (`GLGizmoFuzzySkin`),
  // the same row as supports plus the single-triangle tool.
  fuzzy: ['circle', 'sphere', 'triangle', 'fill']
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
  // 'rear', matching the view cube's face: one axis must not have two names for its far side.
  y: { lower: 'front', upper: 'rear' },
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
 * 1MB+) for the whole session: GC/GPU pressure that eventually loses the WebGL context. Cap them
 * (LRU: a hit refreshes recency via {@link touchCacheEntry}) and dispose the evicted geometry, which
 * is safe because the live plate uses per-instance CLONES of these cached originals, not the
 * originals themselves.
 */
// Generous enough to hold a large plate's objects (each part-file object is its own key) plus a few
// neighbouring plates, so eviction targets genuinely cold geometry from earlier plate visits rather
// than thrashing within one build. (Disposing-then-cloning is still safe, clone copies CPU arrays,
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
 * renders first, otherwise the await-chain that follows starves the paint and the work
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
/**
 * Remove (and dispose) every prime tower under `root`.
 *
 * The tower has TWO adders, the async plate build and the live used-material toggle in
 * `EditorView`, so neither may trust a single ref to find "the" tower: doing so left an orphaned
 * one in the scene (duplicate towers). Both call this first, which makes tower placement
 * idempotent regardless of which ran last.
 */
export function removePrimeTowers(root: THREE.Object3D): void {
  for (const child of [...root.children]) {
    if (child.userData.isPrimeTower !== true) continue
    root.remove(child)
    disposeObject3D(child)
  }
}

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
  // Name the thing. An unlabelled amber block appearing beside your model reads as an error to
  // anyone who has not met a purge tower, and it is the one object on the plate the user did not
  // put there. Sat on the TOP face rather than the bed, because the tower's own translucent box
  // would otherwise occlude it, and fitted to the footprint by the same helper the exclusion zones
  // use, so a narrow tower gets smaller text instead of overflow. "Purge tower" matches the
  // placement warning's wording (`PRIME_TOWER_WARNING_KEY` below) rather than the config's
  // "prime tower", since that is what the rest of the UI shows the user.
  //
  // A null label (no 2D context, or a footprint too small for a legible glyph) is simply no label:
  // this is decoration on a functional fixture and must never fail the tower's own rendering.
  const label = createFlatBedLabel({
    text: 'Purge tower',
    centerX: 0,
    centerY: 0,
    boxWidth: footprint.width,
    boxHeight: footprint.depth,
    color: 'rgba(70, 42, 12, 0.85)',
    // Local space: the group is centred on the box, so its top face is half a height up.
    z: height / 2 + 0.05,
    // Above the tower's own transparent faces, which would otherwise sort over it.
    renderOrder: 5
  })
  if (label) group.add(label)
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
 * origin they dip below the actual mesh, which previously skewed resting and lifted the
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
    // "lay flat leaves the part floating" bug: the hull's z=0 box made restObjectOnBed think the
    // object already touched the bed, so it never dropped the freshly rotated geometry.
    // Brim ear markers included: `isViewportAidMesh` now knows them, so the second by-name check
    // that used to live here is gone. Paint overlays are covered by the same predicate, which
    // matters for more than correctness here: they can be 100k+ triangles, and walking them
    // per-vertex is what made dragging a painted part hitch.
    if (isViewportAidMesh(mesh)) return
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

/**
 * Multiply a group's scale and correct its position so the model grows about a fixed world
 * point instead of about its own local origin, then rest it on the bed.
 *
 * WHY THE CORRECTION IS NOT OPTIONAL. `position` places the object's local ORIGIN, and scaling
 * multiplies the mesh's own coordinates about that origin — so an object whose vertices sit far
 * from it (a Bambu mesh routinely carries plate coordinates) travels by `(factor - 1)` times its
 * whole origin-to-centroid offset. At the 25.4x of an inch conversion that is metres, and the
 * model leaves the bed entirely. This is the same trap the single-object 3MF export hit.
 *
 * `pivot` is a WORLD XY point the footprint centre is pinned to; omit it to grow in place. Z is
 * never pinned, because a printed body belongs on the bed and `restObjectOnBed` decides that.
 */
export function scaleGroupAboutPoint(
  group: THREE.Object3D,
  factor: number,
  pivot?: { x: number; y: number }
): void {
  const before = printableMeshBox(group)
  if (before.isEmpty()) return
  const anchor = pivot ?? { x: (before.min.x + before.max.x) / 2, y: (before.min.y + before.max.y) / 2 }
  group.scale.multiplyScalar(factor)
  const after = printableMeshBox(group)
  if (after.isEmpty()) return
  group.position.x += anchor.x - (after.min.x + after.max.x) / 2
  group.position.y += anchor.y - (after.min.y + after.max.y) / 2
  restObjectOnBed(group)
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
 * cells: the true footprint, so concave/curved parts don't collide just because
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
    if (!mesh.isMesh || isViewportAidMesh(mesh)) return
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
export function rasterizePolygonCells(polygon: ReadonlyArray<{ x: number; y: number }>): Set<number> {
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
 * Which nozzle an exclude zone's label requires, as a RUNTIME nozzle id (1 = left, 0 = right),
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
 * cells (not just one boundary cell) so objects that merely touch, or whose edges
 * round into the same 2 mm cell, aren't flagged as colliding.
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
 * shape shifted: letting the placement-warning recompute shift cached cells instead of
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
 * a camera-only orbit): the per-frame vertex walk was the main avoidable editor cost.
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
 * non-rectangular zone: safe, since it only keeps the tower further clear of the excluded area.
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

const OFF_BED_ISSUES = new Set(['extends past the plate', 'is in an unprintable area'])

/** Stable warning key for the purge tower, which has no instance key of its own. */
export const PRIME_TOWER_WARNING_KEY = 'prime-tower'

export interface PlacementWarning {
  key: string
  name: string
  issues: string[]
  /**
   * The object does not FIT the plate (past its edge, or inside a truly unprintable area), as
   * opposed to a collision or floating, which the user can fix without resizing the bed. Machine
   * switching keys its "no longer fits the new bed" warning on this, so a smaller target bed is
   * reported at switch time instead of surfacing as the CLI's exit-206 at slice time.
   */
  offBed: boolean
}

/**
 * Detect placement problems for the printed objects on a plate, mirroring
 * BambuStudio's prepare-view checks: collisions, floating above the bed, extending
 * past the plate, sitting in a truly unprintable area, and, for dual-nozzle
 * machines, sitting in a nozzle-only area the object's nozzle can't reach (e.g. a
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
  // plates) so objects that intrude into it are flagged: BambuStudio keeps the tower
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
    // sits) for the off-plate test, not the AABB, a curved/diagonal object's AABB pokes
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
  // The tower is not an object, but it can be unprintable in a way no object can: every extruder
  // purges into it, so unlike a part it may never sit in a single-nozzle-only zone whatever the
  // materials are. Reported through the same channel so it reaches the user before save/slice
  // without a second warning surface. See `lib/primeTowerReach.ts`.
  const towerIssue = primeTowerReachIssue(primeTower, plate.bed.excludeAreas)
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
  const warnings = entries
    .filter(({ instance }) => issues.has(instance.key))
    .map(({ instance }) => {
      const list = [...issues.get(instance.key)!]
      return {
        key: instance.key,
        name: instance.name ?? 'Object',
        issues: list,
        offBed: list.some((issue) => OFF_BED_ISSUES.has(issue))
      }
    })
  // Appended rather than folded into the object loop above: the tower is not an instance, so it has
  // no entry to hang off. `offBed` stays false, it is a reachability problem, not a bed-size one,
  // and the machine-switch warning counts off-bed OBJECTS.
  if (towerIssue) {
    warnings.push({ key: PRIME_TOWER_WARNING_KEY, name: 'Purge tower', issues: [towerIssue], offBed: false })
  }
  return warnings
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
 * "place on face" candidate faces, including a pseudo-face/lid over open ends like
 * a cup, which BambuStudio also exposes. Returns null if the object has too few
 * points. Tag it with `isFaceHull` so picking can target it.
 */
/**
 * Convex hull of the group's PRINTED mesh vertices, in the group's local frame.
 *
 * Viewport aids are excluded on the same rule as {@link printableMeshBox}: this hull decides where
 * auto-orient rests the object and which faces lay-flat offers, so a helper volume, a brim-ear
 * marker or a paint overlay reaching it changes the resulting ORIENTATION. It filtered only its own
 * previous overlay (`isFaceHull`), which meant adding a support blocker silently moved where the
 * object came to rest and made the blocker's own faces clickable as "lay this face down".
 */
export function buildHullGeometry(group: THREE.Object3D): THREE.BufferGeometry | null {
  group.updateMatrixWorld(true)
  const toLocal = new THREE.Matrix4().copy(group.matrixWorld).invert()
  const points: THREE.Vector3[] = []
  const vertex = new THREE.Vector3()
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || isViewportAidMesh(mesh)) return
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
  // testing it against the object z-fights badly (per-fragment flicker: the "triangle artifacts",
  // worst when a hull face sits right on an object face, e.g. viewing a part from below the bed).
  // polygonOffset can't reliably separate a near-coincident curved hull. Instead, take the overlay
  // out of the depth fight: depthTest:false so it always draws over the printed surface. FrontSide
  // (not DoubleSide) so only the camera-facing hull tints, no back-face double-render muddiness,
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
  // printableMeshBox/buildHullGeometry would count the hovered face's geometry: when that face is
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

/**
 * Diameter, in screen pixels, of a PLACED measurement endpoint.
 *
 * Read by {@link syncScreenSpaceOverlays}, which sizes every annotation this way. An annotation
 * sized in MILLIMETRES looks right at exactly one zoom and wrong at every other: the measure label
 * was 9mm tall, a modest tag over a whole plate and a banner across the screen once zoomed into the
 * feature being measured -- and its texture magnifies with it, so it also went soft. Sizing in
 * pixels keeps it legible at every distance and keeps the texture near 1:1, which is what makes it
 * crisp.
 */
export const MEASURE_MARKER_PX = 9

/**
 * Largest mesh, in triangles, the measure tool will look for hole centres in.
 *
 * Building that index walks every face and every edge with string keys, which is the
 * ~1s-per-663k-triangles cost `isClosedSoup` documents. Once, for a CAD part with holes in it, that
 * is affordable; on a dense organic mesh it is a frozen tab spent looking for holes such a model
 * does not have. Past this the tool keeps its corner snapping and simply never offers a centre --
 * so raising it trades a hitch on first hover for reach, rather than trading correctness.
 */
export const MEASURE_CIRCLE_FACE_LIMIT = 200_000

/**
 * Colour of the measure tool's HOVER cursor, and of the two points it can place.
 *
 * A placed point must not look like the cursor. It did: both were this same blue at the same 9px,
 * so the cursor sat exactly on top of the marker it had just created and clicking a hole changed
 * nothing on screen at all -- reported as not being able to tell a selection had been made. Studio
 * avoids it by giving each picked feature a colour of its own (`SELECTED_1ST_COLOR` teal and
 * `SELECTED_2ND_COLOR` magenta, `GLGizmoMeasure.hpp:31`), distinct from its hover colour, and those
 * are the values used here.
 *
 * Which point is which is worth seeing in its own right, since the readout's per-axis deltas are
 * signed from the first to the second.
 */
export const MEASURE_HOVER_COLOR = 0x7fb8ff
export const MEASURE_POINT_COLORS = [0x40bfbf, 0xbf40bf] as const

/**
 * Colour of the hovered feature while SHIFT is held, i.e. while a click takes a point rather than
 * the whole feature. Studio's `HOVER_COLOR` (`GLGizmoMeasure.hpp:34`), and it is deliberately not
 * one of the slot colours: point mode changes what a click MEANS, so it should not look like the
 * same gesture in a different slot.
 */
export const MEASURE_POINT_MODE_COLOR = 0x00ff00

/**
 * Diameter of the dot marking a circle's centre while the RIM is what is being measured.
 *
 * Small on purpose: it is an affordance rather than a selection, saying only that the centre can be
 * clicked. At the marker size it competes with the ring and the highlight stops reading as "you are
 * measuring this ring".
 */
export const MEASURE_CENTRE_AFFORDANCE_PX = 5

/**
 * Name of the sphere drawn at a circle's centre, so the measure pick can raycast it.
 *
 * On a SELECTED circle this marker is the only route to the centre that needs no hover, which is
 * what makes the gesture work on touch: a tap has no pointer path crossing the rim, so the
 * screen-space rule in `lib/circleScreenZone.ts` never arms for it.
 */
export const MEASURE_CENTRE_MARKER_NAME = 'measure-centre-marker'

/** On-screen LENGTH in pixels of a dimension line's arrowhead. */
export const MEASURE_ARROWHEAD_PX = 11


/**
 * How the "123.45 mm" distance label is drawn, in CSS pixels: glyph height, then the tag's padding
 * around it. {@link createMeasureLabelSprite} draws at exactly these sizes rather than drawing large
 * and scaling down, so they are also what the label MEASURES on screen.
 */
const MEASURE_LABEL_FONT_PX = 11
const MEASURE_LABEL_PAD_X_PX = 4
const MEASURE_LABEL_PAD_Y_PX = 2.5
/**
 * On-screen HEIGHT in pixels of the distance label.
 *
 * DERIVED from the three above rather than stated, because the sprite is sized by this value and
 * painted by those: written as its own number, a change to the font would silently letterbox the tag
 * or crop its glyphs, and nothing renders in a test that could catch it.
 */
export const MEASURE_LABEL_PX = MEASURE_LABEL_FONT_PX + MEASURE_LABEL_PAD_Y_PX * 2

export const SCREEN_SPACE_PX_KEY = 'screenSpacePx'
/** Marks a GROUP whose children carry {@link SCREEN_SPACE_PX_KEY}, so the sync can find them cheaply. */
export const SCREEN_SPACE_OVERLAY_KEY = 'screenSpaceOverlay'

/**
 * Re-scale every screen-space annotation for the current camera, once per rendered frame.
 *
 * Walks the scene's TOP-LEVEL children, and descends into a flagged overlay group to ANY depth. A
 * full `traverse` here would visit every mesh of every object on the plate on every frame to find a
 * handful of markers, which is why the flag exists; the depth limit inside a flagged group bought
 * nothing, because such a group holds only annotations.
 *
 * It used to stop one level in, which made every caller flatten its own highlights by hand
 * (`group.add(...highlight.children)`) with a paragraph each explaining that adding the group
 * itself would leave its markers at their raw 1-unit size. That is a trap rather than a contract:
 * a nested annotation was silently unscaled, with nothing failing.
 *
 * The tagged value is the annotation's FULL on-screen size, never a radius, so one key means one
 * thing whatever geometry carries it. That obliges a sphere to be built at radius 0.5 and a sprite
 * at scale 1, both of which are then one unit ACROSS. Built at radius 1 -- which is the obvious
 * thing to write, and what shipped -- a sphere came out at twice its stated size while the label
 * beside it was exact, so `MEASURE_MARKER_PX = 9` drew an 18px dot.
 */
export function syncScreenSpaceOverlays(
  scene: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  viewportHeightPx: number
): void {
  if (viewportHeightPx <= 0) return
  // World units per screen pixel at a given distance, for a perspective camera.
  const perPixelAt = (distance: number) =>
    (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / viewportHeightPx
  const worldPosition = new THREE.Vector3()
  const apply = (object: THREE.Object3D) => {
    const pixels = object.userData[SCREEN_SPACE_PX_KEY]
    if (typeof pixels !== 'number') return
    object.getWorldPosition(worldPosition)
    const size = pixels * perPixelAt(camera.position.distanceTo(worldPosition))
    const aspect = typeof object.userData.screenSpaceAspect === 'number' ? object.userData.screenSpaceAspect : 1
    object.scale.set(size * aspect, size, size)
  }
  const applyWithin = (object: THREE.Object3D) => {
    apply(object)
    for (const child of object.children) applyWithin(child)
  }
  for (const child of scene.children) {
    apply(child)
    if (child.userData[SCREEN_SPACE_OVERLAY_KEY]) applyWithin(child)
  }
}

/**
 * Floating "123.45 mm" sprite for the measure overlay (always faces the camera).
 *
 * Rendered at the device pixel ratio and sized in SCREEN pixels by
 * {@link syncScreenSpaceOverlays}, so the texture stays near 1:1 with the display. It used to be a
 * fixed 9mm tall drawn at CSS resolution, which zoomed into a blurry banner across the viewport.
 *
 * {@link MEASURE_LABEL_PX} is its on-screen height, and the glyphs and padding below are drawn to
 * fill exactly that. Drawing them larger and letting the sprite scale down would still read, but it
 * would spend texture on detail the display cannot resolve and give up the 1:1 that makes it crisp.
 */
export function createMeasureLabelSprite(text: string): THREE.Sprite | null {
  // Cap the ratio: past 2x the texture costs memory for detail no display resolves.
  const ratio = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  const fontSize = MEASURE_LABEL_FONT_PX
  const paddingX = MEASURE_LABEL_PAD_X_PX
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return null
  context.font = `600 ${fontSize}px sans-serif`
  const cssWidth = Math.ceil(context.measureText(text).width + paddingX * 2)
  const cssHeight = MEASURE_LABEL_PX
  canvas.width = Math.ceil(cssWidth * ratio)
  canvas.height = Math.ceil(cssHeight * ratio)
  // Re-set after resizing, which resets the 2D state, then work in CSS pixels.
  context.scale(ratio, ratio)
  context.font = `600 ${fontSize}px sans-serif`
  // Solid-ish backdrop so the value stays readable over any model colour.
  context.fillStyle = 'rgba(13, 19, 34, 0.82)'
  context.fillRect(0, 0, cssWidth, cssHeight)
  context.fillStyle = 'rgba(208, 226, 255, 0.96)'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, cssWidth / 2, cssHeight / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 4
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }))
  sprite.userData[SCREEN_SPACE_PX_KEY] = cssHeight
  sprite.userData.screenSpaceAspect = cssWidth / cssHeight
  sprite.renderOrder = 8
  return sprite
}

/**
 * Draw a measured feature: a vertex, an edge, a circle or a face.
 *
 * ONE definition, used for the hovered feature and for both selected ones, because they differ only
 * in colour. Two surfaces drawing the same feature their own way is how a hover ends up looking like
 * a different kind of thing from the selection it becomes on click.
 *
 * A vertex is sized in SCREEN pixels (the sphere carries {@link SCREEN_SPACE_PX_KEY} and the group
 * is flagged for the sync); everything else is real geometry in millimetres and must stay that way,
 * since an edge or a rim drawn at a constant screen size would slide off the model as the camera
 * moves. Rendered with `depthTest: false` so a feature on the far side of a part is still visible,
 * which is what makes measuring across a bore possible.
 */
export function createMeasureFeatureHighlight(
  feature: MeasureFeature,
  color: number,
  /**
   * Which part of a circle the user is acting on. `rim` keeps the ring loud and leaves the centre a
   * small dot -- present because it is the only affordance saying the centre can be clicked at all,
   * but quiet, because pointing at the ring measures the RING. `centre` reverses that.
   */
  emphasis: 'rim' | 'centre' = 'rim'
): THREE.Group {
  const group = new THREE.Group()
  group.userData[SCREEN_SPACE_OVERLAY_KEY] = true
  group.renderOrder = 7
  const lineMaterial = (opacity = 0.95) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false })
  const addPoint = (at: THREE.Vector3, pixels: number) => {
    const marker = new THREE.Mesh(
      // Radius 0.5 so the screen-space scale is a diameter; see `syncScreenSpaceOverlays`.
      new THREE.SphereGeometry(0.5, 16, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false })
    )
    marker.position.copy(at)
    marker.userData[SCREEN_SPACE_PX_KEY] = pixels
    marker.renderOrder = 7
    group.add(marker)
  }
  const addLoop = (points: ReadonlyArray<THREE.Vector3>, opacity = 0.95) => {
    if (points.length < 2) return
    const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([...points]), lineMaterial(opacity))
    loop.renderOrder = 7
    // The sync only touches children carrying the pixel key, so this is skipped rather than exempted.
    loop.frustumCulled = false
    group.add(loop)
  }

  switch (feature.kind) {
    case 'point':
      addPoint(feature.point, MEASURE_MARKER_PX)
      break
    case 'edge': {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([feature.start, feature.end]),
        lineMaterial()
      )
      line.renderOrder = 7
      line.frustumCulled = false
      group.add(line)
      break
    }
    case 'circle': {
      // BOTH parts are always drawn, because both are selectable and each says the other is there --
      // Studio draws the pair too (`GLGizmoMeasure.cpp:1227`). Only the emphasis moves: the part
      // being measured is the loud one, and the other stays visible as the affordance for it.
      addLoop(feature.rim, emphasis === 'rim' ? 0.95 : 0.35)
      addPoint(feature.center, emphasis === 'rim' ? MEASURE_CENTRE_AFFORDANCE_PX : MEASURE_MARKER_PX)
      const centre = group.children[group.children.length - 1]
      if (centre) centre.name = MEASURE_CENTRE_MARKER_NAME
      break
    }
    case 'plane':
      for (const border of feature.borders) addLoop(border)
      break
  }
  return group
}
