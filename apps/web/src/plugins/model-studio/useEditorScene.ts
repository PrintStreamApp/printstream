/**
 * Owns the editor's WebGL viewport: the renderer, scene, camera, orbit + transform
 * controls, the pointer/select/drag/paint handlers, the per-frame render + validation
 * loop, resize handling, and full disposal on teardown.
 *
 * Runs ONCE when the viewport container mounts (its dependency array is intentionally
 * just `[viewerContainer, viewCubeContainer]`, plus a context-loss rebuild counter). It
 * reads every live editor value through
 * stable refs/callbacks passed in by {@link EditorView}, so the long-lived render loop
 * and event handlers always see current state without re-subscribing. The scene refs
 * themselves (scene/camera/orbit/transform/plateRoot/...) stay declared in EditorView,
 * other code reads them, and are threaded in here as params.
 */
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { ensureMeshBvh } from './lib/meshBvh'
import {
  buildMeshCircleIndex,
  featureAtFace,
  isCircleCentrePick,
  sameMeasureFeature,
  transformMeasureFeature,
  STUDIO_FEATURE_HOVER_LIMIT,
  type MeasureFeature,
  type MeshCircleIndex
} from './lib/measureFeatures'
import { circleScreenZone, raySeesThroughCircle } from './lib/circleScreenZone'
import { createViewportCameraRig } from './lib/viewportCamera'
import * as THREE from 'three'
import { createWebglRenderer } from './lib/webglRenderer'
import { OrbitControls, TransformControls } from 'three-stdlib'
import { hasActiveOverlayViewer } from './lib/overlayViewerHold'
import { disposeObject3D, type TrianglePaintChannel } from './lib/threeMfScene'
import { buildTrianglePaintOverlay } from './lib/supportPaint'
import {
  EDITOR_HOME_VIEW_DIRECTION as EDITOR_HOME_VIEW,
  VIEW_PRESET_CONFIG,
  createViewCube,
  type ViewPreset
} from './lib/viewCube'
import {
  BRIM_EAR_MARKER_COLOR,
  BRIM_EAR_MARKER_NAME,
  isAddedPartMesh,
  isViewportAidMesh,
  computeFootprintCells,
  computePlacementWarnings,
  createRotationSnapGuides,
  DOWN_VECTOR,
  effectivePaintTool,
  footprintHitsExcludeZones,
  groupShapeSignature,
  ISO_UP,
  PAINT_CHANNEL_SPECS,
  paintOverlayVisible,
  paintChannelForGizmoMode,
  partGroupRef,
  printableMeshBox,
  restObjectOnBed,
  rotorOf,
  selectionBoxSignature,
  syncBrimEarMarkerMatrices,
  syncScreenSpaceOverlays,
  MEASURE_CIRCLE_FACE_LIMIT,
  MEASURE_POINT_COLORS,
  MEASURE_POINT_MODE_COLOR,
  SCREEN_SPACE_OVERLAY_KEY,
  createMeasureFeatureHighlight,
  updateHullFaceHighlight,
  allowsSelectionPicking,
  RESTING_GIZMO_MODE,
  type GeometryCache,
  type GizmoMode,
  type ImportGeometryCache,
  type PaintToolType,
  type PlacementWarning,
  type TextInteraction
} from './editorGeometry'
import {
  EXTRA_SELECTION_STYLE,
  PRIMARY_SELECTION_STYLE,
  createSelectionBox,
  createSelectionOwnerTracker,
  fitSelectionBox,
  renderSelectionOverlay
} from './lib/selectionBox'
import { FOOTPRINT_CELL_MM, shiftFootprintCells } from './lib/arrange'
import { createPointerClaim } from './lib/pointerClaim'
import { type EditorInstance, type EditorPlate } from './lib/editorModel'
import {
  applySelectionDelta,
  selectionDeltaFromProxy,
  selectionPivot,
  type MultiTransformMode,
  type SelectionMemberPose
} from './lib/multiSelectionTransform'
import { type PartRef, type PartSelection } from './lib/selectionModel'
import { type SupportPaintBrushMode } from './lib/supportPaint'

/**
 * `TransformControls` (the three-stdlib fork) is an `Object3D`, so its `.d.ts`
 * only types the standard `Object3DEventMap` keys. The custom `dragging-changed`
 * and `objectChange` events it dispatches are untyped, so we expose them through a
 * narrow listener interface to add/remove handlers without `as never` casts.
 */
type TransformControlsEvent = { value?: boolean }
type TransformControlsEvents = {
  addEventListener: (type: 'dragging-changed' | 'objectChange', listener: (event: TransformControlsEvent) => void) => void
  removeEventListener: (type: 'dragging-changed' | 'objectChange', listener: (event: TransformControlsEvent) => void) => void
}

/** Screen-space radius (px) within which a measure click snaps to a mesh corner. */
const MEASURE_SNAP_PX = 14

/**
 * Viewport distance (px) between the points a paint stroke is sampled at, and the ceiling on how
 * many one pointermove may produce.
 *
 * The sampling exists so a stroke FOLLOWS THE SURFACE: each sample is its own raycast, so a drag
 * across a curved face, over an edge, or from one volume onto another lands on the geometry that
 * is really under that part of the path instead of being interpolated through the air between two
 * far-apart hits. Coverage between samples is the swept cursor's job, not the sample rate's, which
 * is why exceeding the cap widens the spacing rather than dropping the tail: a flick still paints
 * an unbroken band, just tracked more coarsely. That is also why the spacing is looser than
 * BambuStudio's `resolution` of 1.0 -- at 1px a fast flick costs hundreds of raycasts and hundreds
 * of brush applications per event, and every one past the first few re-tests triangles the
 * capsule between them already covered.
 */
const PAINT_STROKE_SAMPLE_SPACING_PX = 3
const PAINT_STROKE_MAX_SAMPLES = 48

/**
 * Editor default camera direction (offset from the bed centre to the camera): mostly
 * top-down but tilted toward the front, similar to Bambu Studio's prepare view.
 */
// Shared with the read-only G-code preview so both open at the same angle (see viewCube.ts).
const EDITOR_HOME_VIEW_DIRECTION = new THREE.Vector3(EDITOR_HOME_VIEW.x, EDITOR_HOME_VIEW.y, EDITOR_HOME_VIEW.z).normalize()

/**
 * Height above the bed that the camera aims at, and the plane the orbit pivot is seated on.
 *
 * ONE constant for both on purpose. The framing looks slightly above the plate so models sit in the
 * middle of the view rather than low in it, and the pivot has to agree: seat it on a different
 * plane and the first rotate after a reframe slides the pivot along the view axis to reach that
 * other height, which reads as the centre of rotation jumping away from the middle of the bed.
 */
const ORBIT_PIVOT_PLANE_Z = 20


/**
 * Every EditorView-local value the scene effect reads. The scene-object refs and
 * callback-refs are declared in EditorView because other code there reads them too;
 * passing them as refs (not values) is what lets the render loop and event handlers
 * stay subscribed across EditorView re-renders while always seeing current state.
 * Module-level helpers/types the effect uses are imports above, not params.
 */
/**
 * One thing the measure tool has resolved, in WORLD space.
 *
 * `feature` is what gets measured; `source` is what the cursor was over. They differ only in point
 * mode, where the feature is a point ON the source -- and the panel needs both, because the label
 * reads "Point on circle" from the source while the arithmetic uses the point. Studio keeps the same
 * pair for the same reason (`SelectedFeatures::Item`, `GLGizmoMeasure.hpp:89`).
 *
 * The whole feature is carried rather than a bare point because none of it can be re-derived later:
 * once the click is over there is no mesh or face left to resolve it against.
 */
export interface MeasurePick {
  feature: MeasureFeature
  source: MeasureFeature
}

export interface EditorSceneParams {
  // Viewport DOM containers (also the effect's dependency array).
  viewerContainer: HTMLDivElement | null
  viewCubeContainer: HTMLDivElement | null
  // Scene object refs (declared and read in EditorView).
  sceneRef: MutableRefObject<THREE.Scene | null>
  cameraRef: MutableRefObject<THREE.PerspectiveCamera | null>
  orbitRef: MutableRefObject<OrbitControls | null>
  transformRef: MutableRefObject<TransformControls | null>
  plateRootRef: MutableRefObject<THREE.Group | null>
  geometryCacheRef: MutableRefObject<GeometryCache>
  importGeometryCacheRef: MutableRefObject<ImportGeometryCache>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  faceHullRef: MutableRefObject<THREE.Mesh | null>
  primeTowerObjRef: MutableRefObject<THREE.Object3D | null>
  // View framing.
  applyViewPresetRef: MutableRefObject<((preset: ViewPreset) => void) | null>
  frameDefaultViewRef: MutableRefObject<(() => void) | null>
  framedViewKeyRef: MutableRefObject<string | null>
  userAdjustedViewRef: MutableRefObject<boolean>
  viewDistanceRef: MutableRefObject<number>
  bedCenterRef: MutableRefObject<{ x: number; y: number }>
  interactionActiveRef: MutableRefObject<boolean>
  /**
   * The browser would not grant a WebGL context. Reported rather than thrown: an unguarded
   * constructor here takes the whole editor route down through the error boundary, losing the
   * user's unsaved session for what is a recoverable browser state. See the counterpart overlay
   * in `PreviewView`: Chrome blocks a page that has caused repeated context loss, and only a
   * fresh document lifts that, so the message says so instead of offering a retry that cannot work.
   */
  onContextRefused?: (message: string) => void
  // Selection.
  selectedKeyRef: MutableRefObject<string | null>
  extraSelectedKeysRef: MutableRefObject<ReadonlyArray<string>>
  /** Selected PARTS of one object (BambuStudio volume-mode): drives per-part highlight boxes. */
  partSelectionRef: MutableRefObject<PartSelection | null>
  allSelectedKeysRef: MutableRefObject<() => string[]>
  selectExclusiveRef: MutableRefObject<(key: string | null) => void>
  toggleAdditiveSelectionRef: MutableRefObject<(key: string) => void>
  /**
   * The single part currently holding the gizmo, of EITHER kind: a part baked into the project's
   * 3MF (by its ORDINAL within the object, never `componentObjectId`, which is a mesh reference and
   * does not identify a part) or a volume added this session (by its own key). See the note on
   * `gizmoPart` in `EditorView`.
   */
  gizmoPartRef: MutableRefObject<PartRef | null>
  setGizmoPart: Dispatch<SetStateAction<PartRef | null>>
  setSelectionHighlightRef: MutableRefObject<((group: THREE.Object3D | null) => void) | null>
  // Gizmo + transform write-back.
  gizmoModeRef: MutableRefObject<GizmoMode>
  setGizmoModeRef: MutableRefObject<Dispatch<SetStateAction<GizmoMode>>>
  /**
   * The multi-selection pivot proxy: an empty Object3D the gizmo attaches to when several
   * objects are selected, seated at the selection's pivot by `reattachGizmo` (its counterpart
   * in EditorView). The gizmo drives THIS object; each frame its delta is applied rigid-body
   * to every member. Created by the scene setup effect; null before the viewport mounts.
   */
  multiPivotRef: MutableRefObject<THREE.Object3D | null>
  bakeExactMatrixRef: MutableRefObject<(group: THREE.Object3D) => void>
  syncSelectedTransformRef: MutableRefObject<((object: THREE.Object3D) => void) | null>
  setRotationReadoutRef: MutableRefObject<((angleDeg: number | null) => void) | null>
  /** Persist a gizmo-dragged part's placement (session-added part mesh or baked part group). */
  writeBackPartMeshRef: MutableRefObject<(mesh: THREE.Object3D) => void>
  // Paint + brim ears.
  activePaintChannelRef: MutableRefObject<TrianglePaintChannel | null>
  paintBrushModeRef: MutableRefObject<SupportPaintBrushMode>
  paintBrushRadiusRef: MutableRefObject<number>
  paintColorFilamentIdRef: MutableRefObject<number | null>
  paintToolRef: MutableRefObject<PaintToolType>
  applyPaintStrokeRef: MutableRefObject<(
    mesh: THREE.Mesh,
    worldPoint: THREE.Vector3,
    worldDirection: THREE.Vector3,
    faceIndex: number | null,
    phase: 'down' | 'move',
    /** The stroke's previous world hit ON THIS MESH, which makes the dab a swept capsule. */
    previousWorldPoint?: THREE.Vector3 | null
  ) => void>
  /**
   * What a region-based paint tool would change if clicked at this face, for the hover preview.
   * Owned by `useEditorPaint` (it holds the codes); the scene only draws the answer.
   */
  previewPaintRegionRef: MutableRefObject<(
    mesh: THREE.Mesh,
    faceIndex: number | null
  ) => { codes: Record<number, string>; state: number } | null>
  /**
   * Put the text being edited where the pointer is on the model, with that face's own normal.
   *
   * Text is placed by POINTING at a surface, as BambuStudio does. A gizmo only yields a position,
   * and the surface then has to be inferred from it -- which resolves to whatever is nearest, so
   * text resting on a floor a few mm from a wall picks the WALL's normal and stands its glyphs on
   * end. Pointing names the face outright, so there is nothing to infer.
   */
  placeTextAtRef: MutableRefObject<
    (worldPoint: THREE.Vector3, worldNormal: THREE.Vector3, phase: 'start' | 'move') => void
  >
  /** The text being edited, hit-tested for hover and grab. Null when the tool is closed. */
  textMeshRef: MutableRefObject<THREE.Mesh | null>
  /** Reports how the text is being interacted with, which drives its highlight and the cursor. */
  setTextInteractionRef: MutableRefObject<(state: TextInteraction) => void>
  /** True while the cut tool is placing connectors, which re-purposes a click on the cut plane. */
  cutConnectorModeRef: MutableRefObject<boolean>
  /**
   * What a connector click may hit: the cut plane itself, and the markers already on it. Supplied
   * as objects rather than looked up by name because both live on the SCENE root beside the cut
   * plane, not under an instance group, so there is no subtree to traverse for them.
   */
  cutConnectorTargetsRef: MutableRefObject<{
    plane: THREE.Object3D | null
    section: THREE.Object3D | null
    markers: THREE.Object3D[]
  }>
  editCutConnectorsRef: MutableRefObject<(edit:
    | { kind: 'add'; worldPoint: THREE.Vector3 }
    | { kind: 'remove'; id: string }
  ) => void>
  /**
   * Where a connector would land, reported on every hover so the tool can ghost one there. Null when
   * the pointer is off the cut face. Called at pointer rate, so the consumer moves a mesh rather
   * than setting React state.
   */
  hoverCutConnectorRef: MutableRefObject<(worldPoint: THREE.Vector3 | null) => void>
  brimEarDiameterRef: MutableRefObject<number>
  editSelectedBrimEarsRef: MutableRefObject<(edit:
    | { kind: 'add'; group: THREE.Group; worldPoint: THREE.Vector3 }
    | { kind: 'remove'; index: number }
    | { kind: 'clear' }
  ) => void>
  filamentColorsRef: MutableRefObject<Record<number, string> | undefined>
  // Plate state + validation.
  activePlateRef: MutableRefObject<EditorPlate | null>
  isInstancePrintedRef: MutableRefObject<(instance: EditorInstance) => boolean>
  instanceNozzlesRef: MutableRefObject<(instance: EditorInstance) => Set<number>>
  footprintCacheRef: MutableRefObject<Map<string, { shapeSig: string; cells: Set<number>; baseX: number; baseY: number }>>
  lastWarningSigRef: MutableRefObject<string>
  placementWarningsSetterRef: MutableRefObject<Dispatch<SetStateAction<PlacementWarning[]>>>
  // Assigned here so callers (the plate-build effect) can force an immediate placement-warning
  // recompute after a rebuild, bypassing the rAF poll's per-frame gate.
  recomputeWarningsRef: MutableRefObject<() => void>
  // Tower + measure + history + thumbnails + context menu + escape.
  movePrimeTowerRef: MutableRefObject<((x: number, y: number) => void) | null>
  addMeasurePointRef: MutableRefObject<((pick: MeasurePick) => void) | null>
  /** The picks so far, so a hover can preview the colour the click would give it. */
  measurePicksRef: MutableRefObject<MeasurePick[]>
  /**
   * The drawn centre marker of each selected circle, paired with the slot it belongs to.
   *
   * Raycast AHEAD of the model, because it is the only route to a hole's centre that needs no hover
   * and so the only one a tap can take.
   */
  measureCentreTargetsRef: MutableRefObject<Array<{ object: THREE.Object3D; slot: number }>>
  recordHistoryRef: MutableRefObject<() => void>
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
  /**
   * Fired once when a paint STROKE ends. Paint mutates the editor state in place (a clone per
   * pointer-move would be brutal), so nothing keyed on state identity, the used-materials set
   * above all, would otherwise see it. See EditorView's paint revision.
   */
  paintCommittedRef: MutableRefObject<(() => void) | null>
  /** Rebuild the place-on-face hull after a lay-flat re-orients the part (the hull bakes orientation). */
  rebuildFaceHullRef: MutableRefObject<() => void>
  openContextMenuRef: MutableRefObject<(menu: { x: number; y: number; key: string } | null) => void>
  suppressEditorEscapeRef: MutableRefObject<boolean>
  // Plain React values/setters/callbacks read by the effect.
  setSceneReady: Dispatch<SetStateAction<boolean>>
  writeBackGroupTransform: (object: THREE.Object3D) => void
}

/**
 * Initialize renderer/camera/controls once a container exists, and own them for the
 * viewport's lifetime. The effect deliberately depends only on the containers and the
 * context-loss rebuild counter, never on the live editor values, which arrive as
 * stable refs through {@link EditorSceneParams}, so the renderer and its listeners
 * are built once and never torn down and rebuilt on an ordinary EditorView re-render.
 */
export function useEditorScene(params: EditorSceneParams): void {
  // Bumped after a lost WebGL context to rebuild the whole scene rig (the content effects
  // re-seed the plate when sceneReady cycles). Rate-capped in the loss handler.
  const [contextGeneration, setContextGeneration] = useState(0)
  const lastContextRebuildRef = useRef(0)
  // Lets code outside the render loop ask for a repaint (see the on-demand rendering note on the
  // loop). Wired up by the setup effect; null before the viewport mounts / after teardown.
  const requestRenderRef = useRef<(() => void) | null>(null)
  const {
    viewerContainer,
    viewCubeContainer,
    sceneRef,
    cameraRef,
    orbitRef,
    transformRef,
    plateRootRef,
    geometryCacheRef,
    importGeometryCacheRef,
    groupByKeyRef,
    faceHullRef,
    primeTowerObjRef,
    applyViewPresetRef,
    frameDefaultViewRef,
    framedViewKeyRef,
    userAdjustedViewRef,
    viewDistanceRef,
    bedCenterRef,
    interactionActiveRef,
    onContextRefused,
    selectedKeyRef,
    extraSelectedKeysRef,
    partSelectionRef,
    allSelectedKeysRef,
    selectExclusiveRef,
    toggleAdditiveSelectionRef,
    gizmoPartRef,
    setGizmoPart,
    setSelectionHighlightRef,
    gizmoModeRef,
    setGizmoModeRef,
    multiPivotRef,
    bakeExactMatrixRef,
    syncSelectedTransformRef,
    setRotationReadoutRef,
    writeBackPartMeshRef,
    activePaintChannelRef,
    paintBrushModeRef,
    paintBrushRadiusRef,
    paintColorFilamentIdRef,
    paintToolRef,
    applyPaintStrokeRef,
    previewPaintRegionRef,
    placeTextAtRef,
    textMeshRef,
    setTextInteractionRef,
    cutConnectorModeRef,
    cutConnectorTargetsRef,
    editCutConnectorsRef,
    hoverCutConnectorRef,
    brimEarDiameterRef,
    editSelectedBrimEarsRef,
    filamentColorsRef,
    activePlateRef,
    isInstancePrintedRef,
    instanceNozzlesRef,
    footprintCacheRef,
    lastWarningSigRef,
    placementWarningsSetterRef,
    recomputeWarningsRef,
    movePrimeTowerRef,
    addMeasurePointRef,
    measureCentreTargetsRef,
    measurePicksRef,
    recordHistoryRef,
    regenerateActiveThumbnailRef,
    paintCommittedRef,
    rebuildFaceHullRef,
    openContextMenuRef,
    suppressEditorEscapeRef,
    setSceneReady,
    writeBackGroupTransform
  } = params

  // A React commit to the editor almost always means a visible change (selection, material,
  // added/removed object, tool, paint, plate rebuild). Request one repaint per commit so the
  // on-demand loop reflects it immediately rather than waiting for its safety tick. This is cheap:
  // EditorView is deliberately kept from re-rendering during drags (LiveTransformPanel owns the
  // high-frequency transform values), so this fires only on genuine state changes.
  useEffect(() => {
    requestRenderRef.current?.()
  })

  // Initialize renderer/camera/controls once a container exists.
  useEffect(() => {
    if (!viewerContainer || !viewCubeContainer) return
    const container = viewerContainer
    // Snapshot the mutable ref maps so cleanup operates on the same instances.
    const groupByKey = groupByKeyRef.current
    const geometryCache = geometryCacheRef.current
    const importGeometryCache = importGeometryCacheRef.current

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0d1322')
    sceneRef.current = scene

    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
    const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 5000)
    camera.up.copy(ISO_UP)
    camera.position.set(
      EDITOR_HOME_VIEW_DIRECTION.x * 360,
      EDITOR_HOME_VIEW_DIRECTION.y * 360,
      EDITOR_HOME_VIEW_DIRECTION.z * 360
    )
    cameraRef.current = camera

    // Logarithmic depth buffer (matching the read-only plated PreviewView) so coincident
    // coplanar surfaces: e.g. SVG/text parts resting flush on a backdrop, or stacked
    // duplicate parts: don't z-fight into a flickering, semi-transparent mess across the
    // wide 0.1..5000 depth range the bed + gizmos need.
    let renderer: THREE.WebGLRenderer
    try {
      renderer = createWebglRenderer({ antialias: true, logarithmicDepthBuffer: true })
    } catch {
      onContextRefused?.('The browser has blocked new 3D views on this page. Reload the page to restore the editor view.')
      return
    }
    // Cap DPR at 2 (like the view cube): on a 3x-DPR phone or 4K display the
    // editor's AA + log-depth + 2048² shadow + always-on loop would otherwise
    // render ~9x the fragments, a large mobile GPU/battery/thermal cost.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
    renderer.shadowMap.enabled = true
    // PCF, not PCF_SOFT: three removed the soft variant in r185 and now rewrites the type to this
    // one on the first shadow render, warning as it goes. Naming it here is what we actually get,
    // rather than a setting that looks like soft shadows and is silently overridden. VSM is the
    // remaining soft option and is deliberately not taken -- it trades the hard edge for light
    // bleeding through thin walls, which this viewport is full of.
    renderer.shadowMap.type = THREE.PCFShadowMap
    container.appendChild(renderer.domElement)

    // A reclaimed WebGL context (GPU pressure, driver reset) leaves the canvas permanently
    // black. Rebuild the scene once by re-running this effect via contextGeneration, but
    // rate-capped: if the fresh context dies again within 30s, the device genuinely cannot
    // host the scene right now and rebuild-looping would only make the pressure worse.
    const onContextLost = (event: Event) => {
      event.preventDefault()
      const now = Date.now()
      if (now - lastContextRebuildRef.current < 30_000) return
      lastContextRebuildRef.current = now
      setContextGeneration((generation) => generation + 1)
    }
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)

    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.enableDamping = true
    orbit.dampingFactor = 0.28
    // See the same line in PreviewView: dollying toward `target` decelerates as you approach and
    // never quite arrives, and rotation orbits the plate centre rather than the detail under the
    // cursor. Zooming to the pointer fixes both, and matches what every CAD viewer does.
    // Middle-drag PANS. Three.js defaults the middle button to dolly, which duplicates the wheel
    // and leaves panning on the right button, where this editor's context menu already lives.
    // Middle-to-pan is also what BambuStudio and every CAD viewer do.
    orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
    orbit.zoomToCursor = true
    orbit.target.set(0, 0, ORBIT_PIVOT_PLANE_Z)
    orbit.update()
    orbitRef.current = orbit
    // This camera is brand new at the generic home pose (target (0,0,20): the
    // front-left corner of a Bambu bed). Clear the framed-view latch so the next
    // plate build reframes it on the bed centre: a key latched by the previous
    // scene/camera would otherwise skip the reframe and leave the view stuck
    // zoomed at the plate corner. The fresh camera is also not user-adjusted.
    framedViewKeyRef.current = null
    userAdjustedViewRef.current = false
    // Once the user orbits/pans, stop auto-reframing the home view on resize.
    orbit.addEventListener('start', () => {
      userAdjustedViewRef.current = true
      interactionActiveRef.current = true
    })
    orbit.addEventListener('end', () => { interactionActiveRef.current = false })

    // Lighting matches the read-only preview's plated-scene setup so both render identically.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x5d646b, 1.05))
    const dir = new THREE.DirectionalLight(0xffffff, 0.5)
    dir.position.set(1, 1, 1)
    dir.castShadow = true
    dir.shadow.mapSize.set(2048, 2048)
    dir.shadow.camera.near = 50
    dir.shadow.camera.far = 800
    dir.shadow.camera.left = -260
    dir.shadow.camera.right = 260
    dir.shadow.camera.top = 260
    dir.shadow.camera.bottom = -260
    dir.shadow.bias = -0.0004
    dir.shadow.normalBias = 0.04
    scene.add(dir)

    const keyLight = new THREE.DirectionalLight(0xfff2d8, 0.36)
    keyLight.position.set(-1.15, 0.8, 1.6)
    scene.add(keyLight)

    // Underside lift stays, but in near-neutral grey: the previous saturated
    // blues (0x7bc5ff / 0x5d98d1) tinted glossy angled faces visibly blue.
    const underLight = new THREE.DirectionalLight(0xb9c4cc, 0.12)
    underLight.position.set(-0.35, 0.2, -1)
    scene.add(underLight)

    const underFill = new THREE.AmbientLight(0x9aa4ad, 0.12)
    scene.add(underFill)

    const plateRoot = new THREE.Group()
    scene.add(plateRoot)
    plateRootRef.current = plateRoot
    setSceneReady(true)

    // Rotation snap-guide lines, shown around the selected object while rotating.
    const snapGuides = createRotationSnapGuides()
    snapGuides.visible = false
    scene.add(snapGuides)

    // Selection highlight: a bright box outline around the selected object, updated each
    // frame so it tracks moves/rotations/scales (Bambu-style cue). Driven by the precise
    // PRINTABLE mesh bounds (not BoxHelper's full-object AABB) so it hugs the geometry and
    // doesn't dip below the bed on the edge-outline decorations.
    let selectionBox: THREE.Box3Helper | null = null
    let selectionTarget: THREE.Object3D | null = null
    // Last transform the selection box was fitted to; lets animate() skip the precise
    // bounds recompute on frames where the selected object hasn't moved (see animate).
    let selectionBoxSig = ''
    // Frames to wait before revealing a new selection box with its precise fit. Counted down rather
    // than done immediately: landing the per-vertex walk on the selecting frame is the exact hitch
    // this delay exists to avoid. The provisional transformed-AABB fit stays hidden because it can
    // be dramatically larger than reoriented geometry. A drag in progress cancels the pending fit,
    // and a drop that re-fitted cheaply re-arms it.
    let selectionBoxPreciseFitDelay = 0
    const selectionBoxValue = new THREE.Box3()
    const setSelectionHighlight = (group: THREE.Object3D | null) => {
      selectionTarget = group
      if (selectionBox) {
        scene.remove(selectionBox)
        selectionBox.geometry.dispose()
        ;(selectionBox.material as THREE.Material).dispose()
        selectionBox = null
        selectionBoxPreciseFitDelay = 0
      }
      if (group) {
        // Seed the hidden helper cheaply. The precise per-vertex walk froze selection of a
        // many-part high-poly object for a beat, so it remains deferred; the transformed-AABB seed
        // can be dramatically loose around a reoriented object and therefore must not be painted.
        fitSelectionBox(selectionBoxValue, printableMeshBox(group, false))
        selectionBoxSig = selectionBoxSignature(group)
        // Upgrade before revealing it. The cheap box is a transformed local AABB, so on a
        // reoriented object it is the AABB of a rotated AABB and can be visibly larger than the
        // model. The delay preserves responsive selection without exposing that placeholder.
        selectionBoxPreciseFitDelay = 2
        selectionBox = createSelectionBox(selectionBoxValue, PRIMARY_SELECTION_STYLE)
        // Never paint the transformed-AABB placeholder. On the next settled frame the precise fit
        // reveals the helper at its final size, so selecting a reoriented object cannot flash a box
        // several times larger than the object before correcting itself.
        selectionBox.visible = false
        scene.add(selectionBox)
      }
    }
    setSelectionHighlightRef.current = setSelectionHighlight

    // Dimmer outline boxes for the EXTRA selected instances (multi-select). Synced
    // every frame in animate(): membership from the ref, bounds via the cheap
    // transformed-AABB path so co-drags track without per-vertex walks.
    // What each outline is allowed to be hidden BY. Re-declared every frame from the three box
    // collections below and diffed inside, so the layer walk costs nothing while a selection holds.
    const selectionOwners = createSelectionOwnerTracker()
    const syncSelectionOwners = () => {
      const owners = new Set<THREE.Object3D>()
      if (selectionBox?.visible && selectionTarget) owners.add(selectionTarget)
      for (const helper of extraSelectionBoxes.values()) {
        const owner = helper.userData.selectionOwner as THREE.Object3D | undefined
        if (owner) owners.add(owner)
      }
      for (const helper of partSelectionBoxes.values()) {
        const owner = helper.userData.selectionOwner as THREE.Object3D | undefined
        if (owner) owners.add(owner)
      }
      selectionOwners.sync(owners)
    }

    const extraSelectionBoxes = new Map<string, THREE.Box3Helper>()
    const syncExtraSelectionBoxes = () => {
      const extras = extraSelectedKeysRef.current
      for (const [key, helper] of extraSelectionBoxes) {
        if (!extras.includes(key) || !groupByKeyRef.current.has(key)) {
          scene.remove(helper)
          helper.geometry.dispose()
          ;(helper.material as THREE.Material).dispose()
          extraSelectionBoxes.delete(key)
        }
      }
      for (const key of extras) {
        const group = groupByKeyRef.current.get(key)
        if (!group) continue
        let helper = extraSelectionBoxes.get(key)
        if (!helper) {
          helper = createSelectionBox(new THREE.Box3(), EXTRA_SELECTION_STYLE)
          extraSelectionBoxes.set(key, helper)
          scene.add(helper)
        }
        helper.userData.selectionOwner = group
        fitSelectionBox(helper.box, printableMeshBox(group, false))
      }
    }

    // Bright outline boxes around the SELECTED PARTS (part selection is geometry-level,
    // so the part lights up on every instance of the owning object on the plate). Synced
    // every frame like the extras; part groups are found by the partRef tag the plate
    // build stamps on them, and bounds use the group's transformed AABB (cheap path).
    const partSelectionBoxes = new Map<string, THREE.Box3Helper>()
    const syncPartSelectionBoxes = () => {
      // The bulk part selection, or the single part currently holding the gizmo, of either kind.
      const gizmo = gizmoPartRef.current
      const selection = partSelectionRef.current
        ?? (gizmo ? { objectId: gizmo.objectId, members: [gizmo.member] } : null)
      const wanted = new Map<string, THREE.Object3D>()
      // Keyed separately because a body's bounds are COMPUTED, not read off one node (see below).
      const bodyBoxOwners = new Map<string, THREE.Object3D>()
      if (selection) {
        // Split once, outside the per-instance loop: the two kinds are found by DIFFERENT scans of
        // the scene graph, and which scan runs is a property of the selection, not of the instance.
        const bakedIndexes = selection.members.flatMap((m) => (m.kind === 'baked' ? [m.partIndex] : []))
        const addedKeys = new Set(selection.members.flatMap((m) => (m.kind === 'added' ? [m.key] : [])))
        const wantsBody = selection.members.some((m) => m.kind === 'body')
        for (const instance of activePlateRef.current?.instances ?? []) {
          const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
          if (ownerId !== selection.objectId) continue
          const group = groupByKeyRef.current.get(instance.key)
          if (!group) continue
          if (bakedIndexes.length > 0) {
            group.traverse((node) => {
              const ref = partGroupRef(node)
              if (ref && bakedIndexes.includes(ref.partIndex)) {
                // Keyed by the part's ORDINAL: several parts of one object can share a mesh id, and
                // keying on that collapsed their four selection boxes into one.
                wanted.set(`${instance.key}:${ref.partIndex}`, node)
              }
            })
          }
          // Session-added volumes -- primitives, imported solids and TEXT -- are tagged with their
          // own key rather than a baked ordinal, so the traverse above never matches them. They need
          // a box for the same reason the baked parts do: before the editor rested in Select, the
          // selected one was visible only because it carried the transform gizmo, so with no gizmo
          // attached there was nothing at all to show that a text part was selected.
          //
          // Scoped to the ROTOR's own children, not a traverse: this runs on every rendered frame,
          // so walking each object's part groups, edge outlines and paint overlays would be
          // thousands of node visits per frame while orbiting. An added volume is always a direct
          // child of an instance's rotor, so its children are the only place it can be.
          if (addedKeys.size > 0) {
            for (const node of rotorOf(group).children) {
              const addedKey = node.userData.addedPartKey
              if (typeof addedKey === 'string' && addedKeys.has(addedKey)) {
                wanted.set(`${instance.key}:added:${addedKey}`, node)
              }
            }
          }
          // The BODY is the one member with no node of its own: it is whatever the object owns
          // BESIDE its added volumes, so its box is unioned from those meshes rather than fitted to
          // a single group. Fitting the group instead would swallow the added parts and draw a box
          // around the whole object, which is exactly what a body selection must not look like.
          if (wantsBody) bodyBoxOwners.set(`${instance.key}:body`, group)
        }
      }

      for (const [key, helper] of partSelectionBoxes) {
        if (!wanted.has(key) && !bodyBoxOwners.has(key)) {
          scene.remove(helper)
          helper.geometry.dispose()
          ;(helper.material as THREE.Material).dispose()
          partSelectionBoxes.delete(key)
        }
      }
      for (const [key, partGroup] of wanted) {
        let helper = partSelectionBoxes.get(key)
        if (!helper) {
          helper = createSelectionBox(new THREE.Box3(), PRIMARY_SELECTION_STYLE)
          partSelectionBoxes.set(key, helper)
          scene.add(helper)
        }
        // The part this box belongs to, and so the only geometry allowed to hide it. Recorded here
        // because it is where the box and its part are known together; the overlay pass reads it back.
        helper.userData.selectionOwner = partGroup
        // With SEVERAL parts selected the outlines stop being depth-tested, because the overlay's
        // depth pre-pass cannot keep them apart: every owner writes into ONE shared buffer, so each
        // member's geometry hides every other member's outline, and the module header's "hidden by
        // its own geometry, never its siblings" silently stops holding the moment there is more than
        // one owner. Parts are routinely inside each other -- a connector sunk into the body it
        // belongs to is the normal case, not a corner one -- so the sibling that wins is usually the
        // biggest, and selecting a part alongside the main body showed only the body's box.
        //
        // Drawing the set on top costs the depth cue the header argues for (back edges show, so a
        // box reads as a cage), which is the right trade here: with a set selected, seeing WHICH
        // parts are in it is the whole question, and a box you cannot see answers nothing. A single
        // part keeps the depth test, so the common case is unchanged.
        ;(helper.material as THREE.LineBasicMaterial).depthTest = wanted.size + bodyBoxOwners.size <= 1
        fitSelectionBox(helper.box, new THREE.Box3().setFromObject(partGroup))
      }
      for (const [key, group] of bodyBoxOwners) {
        let helper = partSelectionBoxes.get(key)
        if (!helper) {
          helper = createSelectionBox(new THREE.Box3(), PRIMARY_SELECTION_STYLE)
          partSelectionBoxes.set(key, helper)
          scene.add(helper)
        }
        // Its own geometry only: the added volumes sit beside it under the same rotor and are what
        // the body is being distinguished FROM.
        const box = new THREE.Box3()
        group.traverse((node) => {
          const mesh = node as THREE.Mesh
          if (!mesh.isMesh || isViewportAidMesh(mesh) || isAddedPartMesh(mesh)) return
          box.expandByObject(mesh)
        })
        helper.userData.selectionOwner = group
        ;(helper.material as THREE.LineBasicMaterial).depthTest = wanted.size + bodyBoxOwners.size <= 1
        if (!box.isEmpty()) fitSelectionBox(helper.box, box)
      }
    }

    /**
     * Swing the camera to a view preset WITHOUT changing anything else about it.
     *
     * Two things it deliberately does not do, both of which it used to. It no longer writes
     * `camera.up` from the preset: `OrbitControls` measures its polar angle from `object.up`, so a
     * Top view's `(0, 1, 0)` silently re-based every later drag onto a different axis -- clicking a
     * face changed how the camera BEHAVED, not just where it was. World Z stays the up vector for
     * every preset, and the straight-down cases get their screen orientation from a hair of tilt
     * baked into the preset direction instead (see `VIEW_PRESET_CONFIG`), which `lookAt` resolves
     * the same way while leaving the orbit frame alone.
     *
     * And it no longer re-frames on the bed centre at the stored view distance, which threw away
     * the user's pan and zoom: a preset answers "look at this from the front", not "start over".
     * The pivot is grounded first so the swing happens about what is actually on screen, and the
     * current distance to it is preserved.
     */
    // The swing and the orbit pivot are SHARED with the read-only previews; see `viewportCamera.ts`
    // for why they cannot be a copy each.
    const cameraRig = createViewportCameraRig(camera, orbit, () => requestRenderRef.current?.())

    const applyViewDirection = (
      from: { x: number; y: number; z: number },
      { reframe }: { reframe: boolean } = { reframe: true }
    ) => {
      // A plain click doubles as "reset the view": you land square on the plate at the standard
      // zoom, which is what you want the great majority of the time. Shift keeps the current pivot
      // and distance EXACTLY, so you can turn around whatever you had zoomed in on -- and exactly
      // is the operative word, which is why nothing re-grounds the pivot here. Grounding is right
      // for a rotate DRAG; doing it on a Shift-click moves the target onto the plane without moving
      // the camera, so the hit distance silently becomes the new orbit radius and a run of clicks
      // walks the camera in and out.
      cameraRig.swingTo({
        direction: from,
        ...(reframe
          ? {
            target: new THREE.Vector3(bedCenterRef.current.x, bedCenterRef.current.y, ORBIT_PIVOT_PLANE_Z),
            distance: viewDistanceRef.current
          }
          : {})
      })
    }
    const applyViewPreset = (preset: ViewPreset) => applyViewDirection(VIEW_PRESET_CONFIG[preset].direction)
    applyViewPresetRef.current = applyViewPreset

    // Default framing: bed-centred, mostly top-down but tilted to the front (Bambu-like).
    const frameDefaultView = () => {
      // This writes the camera DIRECTLY rather than going through the rig, so an in-flight view-cube
      // swing would overwrite it on its next `advance()` and the reframe would vanish with no sign
      // it was asked for. Nothing else catches that: during a swing `orbit.update()` is skipped, so
      // no 'change' event fires and the caller's own "did the user adjust the view?" guard stays
      // false. Reframes arrive from a resize, a dialog transition and a plate switch, all of which
      // can land mid-swing.
      cameraRig.cancel()
      const distance = viewDistanceRef.current
      const target = new THREE.Vector3(bedCenterRef.current.x, bedCenterRef.current.y, ORBIT_PIVOT_PLANE_Z)
      camera.up.set(0, 0, 1)
      camera.position.set(
        target.x + distance * EDITOR_HOME_VIEW_DIRECTION.x,
        target.y + distance * EDITOR_HOME_VIEW_DIRECTION.y,
        target.z + distance * EDITOR_HOME_VIEW_DIRECTION.z
      )
      camera.lookAt(target)
      orbit.target.copy(target)
      orbit.update()
    }
    frameDefaultViewRef.current = frameDefaultView

    const viewCube = createViewCube(viewCubeContainer, ({ region, reframe }) => {
      applyViewDirection(region.direction, { reframe })
      viewCube.sync(camera)
    })

    const transform = new TransformControls(camera, renderer.domElement)
    // World space so the move/rotate gizmo stays aligned to the bed, not to a
    // reoriented object's local axes. (Scale is always local in TransformControls.)
    transform.setSpace('world')
    // Trim the gizmo handles to match Bambu: the translate gizmo keeps only the X/Y
    // arrows + the XY plane (no center "cube", and no Z handles since objects must
    // rest on the bed); the scale gizmo loses its center "cube" too.
    const gizmoInternals = (transform as unknown as {
      gizmo?: {
        gizmo?: Record<string, THREE.Object3D>
        picker?: Record<string, THREE.Object3D>
        helper?: Record<string, THREE.Object3D>
      }
    }).gizmo
    const dropByMode: Record<string, Set<string>> = {
      translate: new Set(['XYZ', 'Z', 'YZ', 'XZ']),
      scale: new Set(['XYZ'])
    }
    for (const set of [gizmoInternals?.gizmo, gizmoInternals?.picker, gizmoInternals?.helper]) {
      for (const mode of ['translate', 'scale'] as const) {
        const collection = set?.[mode]
        if (!collection) continue
        for (const child of [...collection.children]) {
          if (dropByMode[mode]?.has(child.name)) collection.remove(child)
        }
      }
    }
    // Pin the translate arrows to +X / +Y, the way BambuStudio draws them.
    //
    // TransformControls flips an axis arrow to whichever side faces the camera, keyed on its `eye`
    // vector -- which is `cameraPosition - objectPosition`, so it depends on where the OBJECT sits,
    // not just on the camera. The arrows therefore swap sides as a model crosses an invisible
    // boundary that itself moves with the camera angle, which reads as the gizmo glitching rather
    // than as a feature. Studio has no such thing: `GLGizmoMove3D` builds one fixed rotation per
    // axis and always draws the arrow the same way.
    //
    // Only the flip is undone. An EDGE-ON handle (its axis pointing at the camera, so the arrow
    // would be a dot, or a plane seen exactly edge-on) is still hidden by the library, which marks
    // that case with a 1e-10 scale -- a legitimate hide, and the one thing that distinguishes it
    // from a flip.
    //
    // EVERY handle of the translate gizmo, not just the arrowheads: an axis's shaft line carries the
    // same name as its arrow and flips with it, and the XY plane's square and its two edge lines
    // flip on both axes at once. Pinning only the arrowheads left the rest swapping sides around
    // them, which looks more broken than the original flip did.
    const pinTranslateHandles = () => {
      for (const group of [gizmoInternals?.gizmo?.translate, gizmoInternals?.picker?.translate]) {
        if (!group) continue
        for (const handle of group.children) {
          if (Math.abs(handle.scale.x) < 1e-9 || Math.abs(handle.scale.y) < 1e-9
            || Math.abs(handle.scale.z) < 1e-9) continue
          // The flip is a NEGATED scale component, plus hiding whichever of the forward/backward
          // arrow pair points the wrong way. Undo both: always the forward one, always positive.
          const flipped = handle.scale.x < 0 || handle.scale.y < 0 || handle.scale.z < 0
          if (flipped) {
            handle.scale.set(Math.abs(handle.scale.x), Math.abs(handle.scale.y), Math.abs(handle.scale.z))
            // Re-bake the matrix. This runs AFTER the library's own `super.updateMatrixWorld()`, so
            // the flipped scale is already composed into `matrixWorld` -- which is what the renderer
            // draws from. Writing `.scale` alone changed nothing visible, which is why the ARROWHEADS
            // looked pinned (their half of the flip is a `visible` flag, read at draw time) while the
            // shaft lines and the plane square, whose half is this scale, went on flipping.
            handle.updateMatrixWorld(true)
          }
          const tag = (handle as unknown as { tag?: string }).tag
          if (tag === 'fwd') handle.visible = true
          else if (tag === 'bwd') handle.visible = false
        }
      }
    }
    // Wrapped rather than called from the render loop: the flip happens inside the gizmo's own
    // `updateMatrixWorld`, which the renderer runs as part of `scene.updateMatrixWorld()`, so
    // anything done before `render` would simply be overwritten. A no-op if a future three-stdlib
    // stops exposing this, which loses the pinning but breaks nothing.
    const gizmoNode = gizmoInternals as unknown as { updateMatrixWorld?: (force?: boolean) => void } | undefined
    if (typeof gizmoNode?.updateMatrixWorld === 'function') {
      const libraryUpdate = gizmoNode.updateMatrixWorld
      gizmoNode.updateMatrixWorld = (force?: boolean) => {
        libraryUpdate(force)
        pinTranslateHandles()
      }
    }

    const transformEvents = transform as unknown as TransformControlsEvents
    // The multi-selection pivot proxy (see EditorSceneParams.multiPivotRef): parented at the
    // scene root so its transform IS the world delta, with no member's own transform involved.
    const multiPivot = new THREE.Group()
    multiPivot.name = 'multiSelectionPivot'
    scene.add(multiPivot)
    multiPivotRef.current = multiPivot
    // Disable orbit while dragging a gizmo so the camera does not fight the drag.
    // While the rotate gizmo drags, show the snap guides + angle readout.
    // The gizmo attaches to the outer group (move/scale) or its inner rotor (rotate),
    // but state + resting always operate on the outer group, resolved from the selection.
    const selectedOuterGroup = (): THREE.Group | null => {
      const key = selectedKeyRef.current
      return key ? groupByKeyRef.current.get(key) ?? null : null
    }
    // Mirroring the live transform into the manual-input panel is a React state update,
    // so doing it every gizmo/pointer frame re-renders the editor ~60x/sec. The 3D object
    // is mutated directly (the viewport stays smooth regardless), and every drag path
    // force-syncs the exact final values on release, so the panel can lag slightly mid-drag.
    // Throttle it to ~20 updates/sec to keep manipulation responsive on large scenes.
    const PANEL_SYNC_EVERY = 3
    let panelSyncTick = 0
    // True while a transform gizmo (move/rotate/scale) is being dragged. Combined with the
    // body- and tower-drag state below, it lets the validation loop skip its expensive
    // placement-warning recompute mid-drag and run it once when the drag finishes.
    let gizmoDragging = false
    // Did the drag that just ended change the object's ORIENTATION (rotate/scale)? It decides which
    // way the drop frame pays: a rotate/scale takes the per-vertex walk there and then, while a pure
    // move takes the cheap transformed-AABB and lets the delayed upgrade tighten it. Not because a
    // move leaves the box exact (it does not -- a cheap fit of an already-rotated object is the AABB
    // of a rotated AABB), but because deferring keeps the walk out of the gesture, which is what
    // stopped every drop of a high-poly / many-part object freezing for a beat.
    let lastDragChangedOrientation = false
    const throttledPanelSync = (group: THREE.Object3D) => {
      panelSyncTick += 1
      if (panelSyncTick % PANEL_SYNC_EVERY === 0) syncSelectedTransformRef.current?.(group)
    }

    /** The part the gizmo is attached to: an added part volume's mesh or a baked part's group. */
    const attachedPartMesh = (): THREE.Object3D | null => {
      const target = (transform as unknown as { object?: THREE.Object3D }).object
      return target && (typeof target.userData.addedPartKey === 'string' || partGroupRef(target)) ? target : null
    }

    // Multi-selection gizmo drag (the gizmo is attached to the pivot proxy): a drag-start
    // snapshot of every member and the proxy, so each frame recomputes the members' rigid-body
    // pose from scratch: Studio does the same from its `set_caches` snapshot; incremental
    // composition would accumulate error. See lib/multiSelectionTransform.ts for the semantics
    // and the two deliberate divergences (no Alt "independent" mode; unselected sibling
    // instances of a member's object are never re-oriented the way Studio's
    // synchronize_unselected_instances does: our linked copies keep independent placements).
    let multiDrag: {
      pivot: THREE.Vector3
      proxyStart: SelectionMemberPose
      members: Array<{ group: THREE.Group; start: SelectionMemberPose }>
    } | null = null

    const attachedToMultiPivot = (): boolean =>
      (transform as unknown as { object?: THREE.Object3D }).object === multiPivot

    const activeMultiMode = (): MultiTransformMode => {
      const mode = gizmoModeRef.current
      return mode === 'rotate' || mode === 'scale' ? mode : 'translate'
    }

    const poseOf = (object: THREE.Object3D): SelectionMemberPose => ({
      position: object.position.clone(),
      quaternion: rotorOf(object).quaternion.clone(),
      scale: object.scale.clone()
    })

    const beginMultiDrag = () => {
      multiDrag = null
      if (!attachedToMultiPivot()) return
      const members: Array<{ group: THREE.Group; start: SelectionMemberPose }> = []
      for (const key of allSelectedKeysRef.current()) {
        const group = groupByKeyRef.current.get(key)
        if (!group) continue
        // Bake a shearing member first so its exactMatrix is cleared (the rigid-body write-back
        // would otherwise be discarded on save) and its decomposed TRS is valid to snapshot.
        bakeExactMatrixRef.current(group)
        members.push({ group, start: poseOf(group) })
      }
      if (members.length === 0) return
      multiDrag = {
        pivot: multiPivot.position.clone(),
        proxyStart: { position: multiPivot.position.clone(), quaternion: multiPivot.quaternion.clone(), scale: multiPivot.scale.clone() },
        members
      }
    }

    /**
     * Re-seat the proxy on the (possibly just-moved) selection for the NEXT drag: pivot at the
     * mode's selection centre, identity rotation/unit scale so the next delta reads clean.
     * Cheap boxes on purpose, a precise per-vertex walk here is what the drop-frame
     * optimisation removed, and a few mm of pivot slop on a rotated hi-poly mesh is invisible.
     */
    const reseatMultiPivot = () => {
      const boxes: THREE.Box3[] = []
      for (const key of allSelectedKeysRef.current()) {
        const group = groupByKeyRef.current.get(key)
        if (group) boxes.push(printableMeshBox(group, false))
      }
      const pivot = selectionPivot(boxes, activeMultiMode())
      if (pivot) multiPivot.position.copy(pivot)
      multiPivot.quaternion.identity()
      multiPivot.scale.set(1, 1, 1)
    }

    const onDraggingChanged = (event: TransformControlsEvent) => {
      orbit.enabled = !event.value
      const dragging = Boolean(event.value)
      gizmoDragging = dragging
      interactionActiveRef.current = dragging
      // A rotate/scale gizmo drag reorients the object; a translate gizmo drag does not.
      if (dragging) lastDragChangedOrientation = gizmoModeRef.current === 'rotate' || gizmoModeRef.current === 'scale'
      // Snapshot once at drag start (onObjectChange fires per-frame, so not there).
      if (dragging) {
        panelSyncTick = 0
        recordHistoryRef.current?.()
        if (attachedToMultiPivot()) {
          beginMultiDrag()
        } else {
          // Snap a shearing object to editable T·S·R before the drag (it rendered an exact matrix
          // with matrixAutoUpdate off, which the gizmo can't move).
          const outerForBake = selectedOuterGroup()
          if (outerForBake) bakeExactMatrixRef.current(outerForBake)
        }
      }
      // Multi-selection drag via the pivot proxy: guides/readout track the PIVOT (where the
      // rotation actually happens), and the end-of-drag choreography runs per member.
      if (multiDrag) {
        if (dragging && gizmoModeRef.current === 'rotate') {
          snapGuides.position.copy(multiDrag.pivot)
          snapGuides.visible = true
          // Relative readout (Studio labels its multi-selection rotate field "Rotate (relative)"
          // and zeroes it at drag start), there is no single absolute angle for N members.
          setRotationReadoutRef.current?.(0)
        } else {
          snapGuides.visible = false
          setRotationReadoutRef.current?.(null)
        }
        if (!dragging) {
          for (const member of multiDrag.members) {
            // Always re-rest on drag end: rotating/scaling can move a member's lowest point
            // (Studio's ensure_on_bed / do_rotate re-drop). A pure translate keeps z, so this
            // is a no-op there.
            restObjectOnBed(member.group)
            writeBackGroupTransform(member.group)
          }
          const primary = selectedOuterGroup()
          if (primary) syncSelectedTransformRef.current?.(primary)
          // The selection moved: re-seat the pivot on its new centre for the next drag.
          reseatMultiPivot()
          multiDrag = null
          regenerateActiveThumbnailRef.current?.()
        }
        return
      }
      // Added part volumes transform freely inside their object: no bed rest, no
      // group write-back, just persist the part's object-local placement.
      const partMesh = attachedPartMesh()
      if (partMesh) {
        snapGuides.visible = false
        setRotationReadoutRef.current?.(null)
        if (!dragging) {
          writeBackPartMeshRef.current?.(partMesh)
          // Push the exact final placement to the manual panel (mid-drag syncs are throttled).
          syncSelectedTransformRef.current?.(partMesh)
          regenerateActiveThumbnailRef.current?.()
        }
        return
      }
      const outer = selectedOuterGroup()
      const rotating = dragging && gizmoModeRef.current === 'rotate'
      if (rotating && outer) {
        snapGuides.position.copy(outer.position)
        snapGuides.visible = true
        setRotationReadoutRef.current?.(THREE.MathUtils.radToDeg(rotorOf(outer).rotation.z))
      } else {
        snapGuides.visible = false
        setRotationReadoutRef.current?.(null)
        if (!dragging) {
          if (outer) {
            // Always re-rest on drag end: scaling/rotating can move the lowest point, so
            // pin the object's bottom back to the bed (no float). Scale also rests every
            // frame (see onObjectChange) so this is a no-op for scale, no release jump.
            restObjectOnBed(outer)
            writeBackGroupTransform(outer)
            syncSelectedTransformRef.current?.(outer)
          }
          regenerateActiveThumbnailRef.current?.()
        }
      }
    }
    transformEvents.addEventListener('dragging-changed', onDraggingChanged)
    // Write the live transform back into state and the manual-input panel as the user
    // drags. Scaling rests the object on the bed every frame so it grows UPWARD from the
    // bed (the bottom never leaves z=0), regardless of which handle (uniform white or a
    // single coloured axis) is used: TransformControls computes scale from the pointer
    // delta, not the object's position, so adjusting z here doesn't perturb the drag.
    const onObjectChange = () => {
      // Multi-selection: the gizmo drives the pivot proxy; apply its delta rigid-body to every
      // member, offsets orbit/scale about the pivot while each member's own orientation/scale
      // composes (Studio's transform_instance_relative). Recomputed from the drag-start
      // snapshot each frame, never accumulated.
      if (multiDrag) {
        const mode = activeMultiMode()
        const delta = selectionDeltaFromProxy(poseOf(multiPivot), multiDrag.proxyStart)
        for (const member of multiDrag.members) {
          const pose = applySelectionDelta(mode, member.start, delta, multiDrag.pivot)
          member.group.position.copy(pose.position)
          rotorOf(member.group).quaternion.copy(pose.quaternion)
          member.group.scale.copy(pose.scale)
          // Scale grows every member upward from the bed each frame, like the single path below.
          if (mode === 'scale') restObjectOnBed(member.group)
          writeBackGroupTransform(member.group)
        }
        const primary = selectedOuterGroup()
        if (primary) throttledPanelSync(primary)
        if (mode === 'rotate' && snapGuides.visible) {
          setRotationReadoutRef.current?.(THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(delta.rotation).z))
        }
        return
      }
      const partMesh = attachedPartMesh()
      if (partMesh) {
        writeBackPartMeshRef.current?.(partMesh)
        throttledPanelSync(partMesh)
        return
      }
      const outer = selectedOuterGroup()
      if (!outer) return
      if (gizmoModeRef.current === 'scale') restObjectOnBed(outer)
      writeBackGroupTransform(outer)
      throttledPanelSync(outer)
      if (gizmoModeRef.current === 'rotate' && snapGuides.visible) {
        setRotationReadoutRef.current?.(THREE.MathUtils.radToDeg(rotorOf(outer).rotation.z))
      }
    }
    transformEvents.addEventListener('objectChange', onObjectChange)
    scene.add(transform as unknown as THREE.Object3D)
    transformRef.current = transform

    // ---- Click-to-select + body-drag move on the bed plane -------------------
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const bedPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const dragOffset = new THREE.Vector3()
    const dragPoint = new THREE.Vector3()
    // A session-added part being dragged by its own mesh, the part-level twin of the object body
    // drag below. Studio allows this (`is_allow_drag_volume` is true in every mode but Cut); this
    // editor used to return early on a part click with "movement happens via the gizmo only", so a
    // part was the one thing on the plate you could see, select and not push around.
    let partDragMesh: THREE.Object3D | null = null
    let partDragRotor: THREE.Object3D | null = null
    let partDragRecorded = false
    const partDragOffset = new THREE.Vector3()
    let bodyDragGroup: THREE.Group | null = null
    // True once the active body-drag has recorded its undo checkpoint. The checkpoint is taken on
    // the FIRST real move (see onPointerMove), not on pointer-down, so a click that only selects an
    // object (no movement) never pushes a phantom history entry or marks the project dirty.
    let bodyDragRecorded = false
    // Other selected groups co-dragged with the grabbed one (multi-select moves), each
    // with its own bed-plane offset so relative spacing is preserved.
    let bodyDragExtras: Array<{ group: THREE.Group; offsetX: number; offsetY: number }> = []
    // A motionless click on a multi-selection member collapses the selection to it on
    // release; any real drag keeps the multi-selection.
    let collapseClickCandidate: { key: string; x: number; y: number } | null = null
    // BambuStudio drill-down: a motionless click on an already-selected multi-part object
    // selects the baked PART under the cursor on release; a drag moves the whole object.
    let bakedPartClickCandidate: { part: PartRef; x: number; y: number } | null = null
    /** Capture co-drag offsets for every selected group except the grabbed one. */
    const beginSelectionCoDrag = (grabbedKey: string) => {
      bodyDragExtras = allSelectedKeysRef.current()
        .filter((entry) => entry !== grabbedKey)
        .map((entry) => groupByKeyRef.current.get(entry))
        .filter((entry): entry is THREE.Group => Boolean(entry))
        .map((entry) => {
          // Bake a shearing co-dragged object to editable T·S·R first: it clears exactMatrix (so the
          // co-move actually persists on save) AND restores a valid group.position to offset from.
          bakeExactMatrixRef.current(entry)
          return { group: entry, offsetX: entry.position.x - dragPoint.x, offsetY: entry.position.y - dragPoint.y }
        })
    }
    /**
     * Start a body-drag of `group`: bake a shearing object to editable T·S·R first so its exactMatrix
     * is cleared (otherwise buildSceneEdit re-emits the stale pre-drag matrix and the move is silently
     * lost on save), then capture the grab offset from the now-valid group.position.
     */
    const beginBodyDrag = (group: THREE.Group) => {
      bakeExactMatrixRef.current(group)
      dragOffset.set(group.position.x - dragPoint.x, group.position.y - dragPoint.y, 0)
      bodyDragGroup = group
      bodyDragRecorded = false
      // A body drag only translates, so its drop frame takes the cheap fit rather than re-walking
      // every vertex; the upgrade two frames later is what tightens the result.
      lastDragChangedOrientation = false
    }
    let towerDragObject: THREE.Object3D | null = null
    // Pointer-down position on empty space; deselect only happens on pointer-up if the
    // pointer barely moved (a click), so dragging to orbit keeps the selection + tool.
    let emptyPointerDown: { x: number; y: number } | null = null
    // Pointer-down position while the measure tool is active; a motionless release
    // places a measurement point, a drag orbits the camera as usual.
    let measureClickStart: { x: number; y: number } | null = null
    // Whether the connector "drop one here" cursor is currently showing. Every other cursor this
    // handler sets is written on each move by the branch that owns it; the connector branch is
    // skipped entirely once its mode ends, so without this flag the canvas kept a `copy` cursor over
    // models, the bed and every later tool until something else happened to write the style.
    let connectorCursorShown = false
    // Selectable geometry claims its primary pointer in the capture phase, before OrbitControls can
    // enter a rotate/pan state. Empty-space presses still reach OrbitControls unchanged.
    const selectedObjectPointer = createPointerClaim(renderer.domElement, orbit)

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
     * Resolve what the measure cursor is over.
     *
     * Returns a feature in WORLD space: a vertex, an edge, a circle or the face itself, whichever is
     * nearest within reach. With `pointMode` the answer is instead a POINT on that feature, which is
     * Studio's Shift behaviour and how a free point on a face is still reachable.
     *
     * The bed is our own addition and has no Studio equivalent -- it resolves to a bare point, since
     * there is no mesh under the cursor to have features.
     */
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



    const pickMeasureFeature = (event: PointerEvent, pointMode: boolean): MeasurePick | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const targets = Array.from(groupByKeyRef.current.values())
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
      const centreHit = raycaster.intersectObjects(
        measureCentreTargetsRef.current.map((entry) => entry.object),
        false
      )[0]
      if (centreHit) {
        const slot = measureCentreTargetsRef.current.find((entry) => entry.object === centreHit.object)
        const circle = slot ? measurePicksRef.current[slot.slot]?.source : null
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
      const hoveredCircle = !pointMode && measureHoverSource?.kind === 'circle' ? measureHoverSource : null
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
      const bed = activePlateRef.current?.bed
      if (bed && (bedPoint.x < bed.minX - 5 || bedPoint.x > bed.maxX + 5
        || bedPoint.y < bed.minY - 5 || bedPoint.y > bed.maxY + 5)) return null
      const onBed: MeasureFeature = { kind: 'point', point: bedPoint }
      return { feature: onBed, source: onBed }
    }

    const pickInstanceGroup = (event: PointerEvent): THREE.Group | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const targets = Array.from(groupByKeyRef.current.values())
      const hits = raycaster.intersectObjects(targets, true)
      for (const hit of hits) {
        let node: THREE.Object3D | null = hit.object
        while (node) {
          if (typeof node.userData.instanceKey === 'string' && groupByKeyRef.current.has(node.userData.instanceKey)) {
            return node as THREE.Group
          }
          node = node.parent
        }
      }
      return null
    }


    // ---- Support-paint brush (pointer side) ----------------------------------
    // Ring cursor shown over the selected object's surface while the paint tool is
    // active; scaled to the brush radius and tinted by the brush mode.
    /**
     * What the measure cursor is over, drawn while the tool is active.
     *
     * The measure tool had no cursor at all once, which left two things invisible: that clicking does
     * anything, and WHAT it would pick -- and the second matters more here than for any other tool,
     * because the pick resolves to a whole FEATURE that may be nothing like the pixel under the
     * pointer. A hovered hole highlights as a ring and a centre; a hovered face highlights as its
     * whole border. Without that the user is guessing what a click will select.
     *
     * Rebuilt only when the resolved feature CHANGES, not per pointer move: the hover runs at pointer
     * rate and the feature under it is the same for most of those events, so rebuilding each time
     * would be scene churn for no visible difference.
     */
    const measureHoverGroup = new THREE.Group()
    // FLAGGED, and its highlights are flattened into it below: the sync walks the scene's top-level
    // children plus ONE level inside a flagged group, so a highlight added as a group of its own
    // puts its markers two levels down where nothing scales them -- they then render at their world
    // size, 1mm across, which passes for right at one zoom and grows with the model at every other.
    measureHoverGroup.userData[SCREEN_SPACE_OVERLAY_KEY] = true
    measureHoverGroup.renderOrder = 7
    scene.add(measureHoverGroup)
    let measureHoverFeature: MeasureFeature | null = null
    let measureHoverSource: MeasureFeature | null = null

    const clearMeasureHover = () => {
      for (const child of [...measureHoverGroup.children]) {
        measureHoverGroup.remove(child)
        disposeObject3D(child)
      }
      measureHoverFeature = null
      measureHoverSource = null
    }

    /**
     * The colour a hovered feature takes: the one the click WOULD assign.
     *
     * Studio's `hover_selection_color` (`GLGizmoMeasure.cpp:1290`). Without it every hover is the
     * same colour and nothing says which of the two slots is about to be filled -- which matters
     * most in the case that looks identical otherwise, hovering a feature that is ALREADY the first
     * selection, where the click deselects rather than adding a second.
     */
    const measureHoverColor = (feature: MeasureFeature, pointMode: boolean): number => {
      if (pointMode) return MEASURE_POINT_MODE_COLOR
      const picks = measurePicksRef.current
      const first = picks[0]
      const fillsFirstSlot = !first || sameMeasureFeature(first.feature, feature)
      return MEASURE_POINT_COLORS[fillsFirstSlot ? 0 : 1]!
    }

    /** Show a hover pick, or clear it when the pointer is over nothing measurable. */
    const updateMeasureHover = (picked: MeasurePick | null, pointMode = false) => {
      if (!picked) {
        if (measureHoverFeature) clearMeasureHover()
        return
      }
      if (sameMeasureFeature(measureHoverFeature, picked.feature)
        && sameMeasureFeature(measureHoverSource, picked.source)) return
      clearMeasureHover()
      measureHoverFeature = picked.feature
      measureHoverSource = picked.source
      // The SOURCE is drawn, so a hovered circle keeps its ring while its centre is being pointed at,
      // with the emphasis following which of the two the cursor is actually claiming.
      const highlight = createMeasureFeatureHighlight(
        picked.source,
        measureHoverColor(picked.feature, pointMode),
        isCircleCentrePick(picked.feature, picked.source) ? 'centre' : 'rim'
      )
      measureHoverGroup.add(...highlight.children)
    }

    const brushCursor = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 40),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide })
    )
    brushCursor.visible = false
    brushCursor.renderOrder = 6
    scene.add(brushCursor)
    // Sphere-brush cursor: a translucent ball CENTERED on the hit point, conveying the brush's 3D
    // reach (it paints every triangle within `radius` in 3D, wrapping around curves): distinct from
    // the flat ring the circle/cylinder brush uses. The fill is depth-tested so it reads as half-
    // buried in the surface; the wireframe is drawn on top so the full extent stays visible. Unit
    // radius, scaled to the brush radius like the ring.
    const brushSphereCursor = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide })
    )
    const brushSphereWire = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 16, 10)),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6, depthTest: false, depthWrite: false })
    )
    brushSphereWire.renderOrder = 7
    brushSphereCursor.add(brushSphereWire)
    brushSphereCursor.visible = false
    brushSphereCursor.renderOrder = 6
    scene.add(brushSphereCursor)
    let paintingStroke = false
    let textDragging = false
    /**
     * Where the stroke was last sampled, in viewport coordinates, and what it hit there.
     *
     * A pointermove reports where the pointer IS, not the path it took, so at any real drag speed
     * consecutive events are tens of pixels apart and dabbing at each leaves the event rate visible
     * as gaps in the stroke. BambuStudio interpolates between the two and projects each step onto
     * the model (`GLGizmoPainterBase::get_projected_mouse_positions`, "so there are no gaps in the
     * painted region"); this pair is that anchor.
     *
     * The HIT is kept separately from the screen position because it is also the swept dab's far
     * end, and it is dropped whenever the chain of contact breaks -- a sample that misses the model,
     * or one that lands on a different volume -- so a capsule can never span a gap the pointer
     * actually travelled OFF the model, nor two meshes' coordinate frames. Studio drops the same
     * anchor for the same reason (`m_last_mouse_click = Vec2d::Zero()` on a miss) and groups its
     * projected positions by `mesh_idx` before pairing them.
     */
    let paintStrokeAnchor: { x: number; y: number } | null = null
    let paintStrokeLastHit: { mesh: THREE.Mesh; point: THREE.Vector3 } | null = null

    /**
     * The selected instance's paintable (printed-part) meshes, indexed and ready to raycast.
     *
     * Collected once per pointer event rather than per interpolated stroke sample: a stroke can
     * cast dozens of rays for one event (see `paintStrokeSamples`) and the traversal is the same
     * answer every time within it.
     */
    const paintTargets = (): THREE.Mesh[] => {
      const selectedGroup = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
      if (!selectedGroup) return []
      const meshes: THREE.Mesh[] = []
      selectedGroup.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh && mesh.userData.supportPaintPart) meshes.push(mesh)
      })
      // Index on first use: the stock raycast walks every triangle, which a CPU profile put at
      // ~14% of paint-time samples. Built here rather than at scene-build so a plate full of
      // objects only pays for the one being painted.
      for (const mesh of meshes) ensureMeshBvh(mesh)
      return meshes
    }

    /** Raycast `meshes` at a viewport position, leaving `raycaster` holding that sample's ray. */
    const paintHitAt = (
      clientX: number,
      clientY: number,
      meshes: THREE.Mesh[]
    ): { mesh: THREE.Mesh; point: THREE.Vector3; normal: THREE.Vector3; faceIndex: number | null } | null => {
      if (meshes.length === 0) return null
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(meshes, false).find((entry) => entry.face)
      if (!hit?.face) return null
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      return { mesh: hit.object as THREE.Mesh, point: hit.point, normal, faceIndex: hit.faceIndex ?? null }
    }

    /** Raycast the selected instance's paintable (printed-part) meshes. */
    const paintHitOnSelected = (event: PointerEvent): { mesh: THREE.Mesh; point: THREE.Vector3; normal: THREE.Vector3; faceIndex: number | null } | null =>
      paintHitAt(event.clientX, event.clientY, paintTargets())

    /**
     * The viewport positions to sample this move at: the interpolated path from the stroke's anchor
     * to where the pointer now is, ending on the current position.
     *
     * The current position is always the LAST entry, so the anchor and the brush cursor end up
     * where the pointer actually is. The anchor itself is excluded because the previous move
     * already painted it.
     */
    const paintStrokeSamples = (toX: number, toY: number): Array<{ x: number; y: number }> => {
      const from = paintStrokeAnchor
      if (!from) return [{ x: toX, y: toY }]
      const travel = Math.hypot(toX - from.x, toY - from.y)
      const steps = Math.min(Math.ceil(travel / PAINT_STROKE_SAMPLE_SPACING_PX), PAINT_STROKE_MAX_SAMPLES)
      if (steps <= 1) return [{ x: toX, y: toY }]
      const samples: Array<{ x: number; y: number }> = []
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps
        samples.push({ x: from.x + (toX - from.x) * t, y: from.y + (toY - from.y) * t })
      }
      return samples
    }

    /**
     * Paint one pointer position, sampling the path from the last one so a fast drag paints a
     * continuous band rather than a row of dabs. Returns the final sample's hit, for the cursor.
     *
     * Only the BRUSH shapes sample and sweep. The fills and the single-triangle tool are seeded
     * from one triangle and are idempotent over the region they flood, so extra samples add no
     * coverage while multiplying a whole-mesh traversal per event; the height band is placed by the
     * click alone. Bambu's own capsule factory asserts the cursor is a circle or a sphere.
     */
    const paintStrokeTo = (
      clientX: number,
      clientY: number
    ): { mesh: THREE.Mesh; point: THREE.Vector3; normal: THREE.Vector3; faceIndex: number | null } | null => {
      const meshes = paintTargets()
      const channel = activePaintChannelRef.current
      const tool = channel ? effectivePaintTool(channel, paintToolRef.current) : 'circle'
      const sweeps = tool === 'circle' || tool === 'sphere'
      const samples = sweeps ? paintStrokeSamples(clientX, clientY) : [{ x: clientX, y: clientY }]
      let lastHit: { mesh: THREE.Mesh; point: THREE.Vector3; normal: THREE.Vector3; faceIndex: number | null } | null = null
      for (const sample of samples) {
        const hit = paintHitAt(sample.x, sample.y, meshes)
        if (!hit) {
          // The pointer left the model here, so the next dab starts a fresh contact rather than
          // sweeping across the gap it just crossed.
          paintStrokeLastHit = null
          continue
        }
        const previous = sweeps && paintStrokeLastHit?.mesh === hit.mesh ? paintStrokeLastHit.point : null
        applyPaintStrokeRef.current?.(hit.mesh, hit.point, raycaster.ray.direction, hit.faceIndex, 'move', previous)
        paintStrokeLastHit = { mesh: hit.mesh, point: hit.point.clone() }
        lastHit = hit
      }
      paintStrokeAnchor = { x: clientX, y: clientY }
      return lastHit
    }

    /**
     * Is the pointer over the text being edited?
     *
     * Tested against the TEXT, not the model, because that is what can be grabbed. Dragging from
     * anywhere on the model (which is what this replaced) also meant the model could not be orbited
     * while the tool was open, since every press started a text drag.
     */
    const overText = (event: PointerEvent): boolean => {
      const mesh = textMeshRef.current
      if (!mesh) return false
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      return raycaster.intersectObject(mesh, false).length > 0
    }

    /**
     * The hovered region a fill-style tool would paint, drawn on the mesh under the pointer.
     *
     * Smart fill, bucket and single-triangle pick a REGION rather than sweeping a radius, so the
     * brush ring says nothing about them and they used to show nothing at all: the user aimed a
     * fill blind and found out what it swallowed only after the click. The region comes from
     * `previewPaintRegionRef`, which runs the real fill against a copy, so this can never advertise
     * a different result than the click produces.
     *
     * Rebuilt only when the SEED changes (mesh, face, tool, mode, colour), because a flood plus a
     * re-mesh on every pointermove over one face is exactly the cost the measure and lay-flat hovers
     * already guard against this way. A settings change that alters the region without moving the
     * pointer (the smart-fill angle slider) shows on the next move rather than instantly, which is
     * the same trade those two make.
     */
    let paintRegionPreview: { host: THREE.Mesh; mesh: THREE.Mesh; key: string } | null = null
    const clearPaintRegionPreview = () => {
      if (!paintRegionPreview) return
      paintRegionPreview.host.remove(paintRegionPreview.mesh)
      disposeObject3D(paintRegionPreview.mesh)
      paintRegionPreview = null
    }
    const updatePaintRegionPreview = (
      mesh: THREE.Mesh | null,
      faceIndex: number | null,
      channel: TrianglePaintChannel
    ) => {
      if (!mesh || faceIndex == null) {
        clearPaintRegionPreview()
        return
      }
      const key = [
        mesh.uuid,
        faceIndex,
        paintToolRef.current,
        paintBrushModeRef.current,
        channel,
        paintColorFilamentIdRef.current ?? ''
      ].join(':')
      if (paintRegionPreview?.key === key) return
      clearPaintRegionPreview()
      const region = previewPaintRegionRef.current?.(mesh, faceIndex)
      if (!region) return
      const palette = PAINT_CHANNEL_SPECS[channel].palette
      // The colour the CLICK will produce, so the preview reads as "this is what you are about to
      // lay down" rather than as a generic selection highlight. An erase previews in the eraser's
      // own pale tone, since the state it is clearing is the one being removed.
      const previewHex = paintBrushModeRef.current === 'eraser'
        ? 0xe8edf4
        : channel === 'color'
          ? new THREE.Color(filamentColorsRef.current?.[paintColorFilamentIdRef.current ?? -1] ?? '#9aa4ad').getHex()
          : paintBrushModeRef.current === 'blocker' ? palette.blocker : palette.enforcer
      const overlay = buildTrianglePaintOverlay(
        mesh.geometry as THREE.BufferGeometry,
        region.codes,
        {
          palette,
          name: 'paint-region-preview',
          // `offsetFactor` is a polygon offset, and these run NEGATIVE (toward the camera): the
          // channels use -2..-5. One step beyond the strongest so the preview reads on top of paint
          // already there rather than z-fighting the thing it is previewing. A positive value puts
          // it BEHIND the surface, which renders nothing at all.
          offsetFactor: -6,
          colorForState: () => previewHex
        }
      )
      if (!overlay) return
      const material = overlay.material as THREE.MeshBasicMaterial
      // Semi-transparent: a preview must not be mistakable for paint that is already applied.
      material.transparent = true
      material.opacity = 0.55
      material.depthWrite = false
      overlay.renderOrder = 6
      mesh.add(overlay)
      paintRegionPreview = { host: mesh, mesh: overlay, key }
    }

    const updateBrushCursor = (
      hit: { point: THREE.Vector3; normal: THREE.Vector3; mesh?: THREE.Mesh; faceIndex?: number | null } | null
    ) => {
      if (!hit) {
        brushCursor.visible = false
        brushSphereCursor.visible = false
        clearPaintRegionPreview()
        return
      }
      const earMode = gizmoModeRef.current === 'brimEars'
      const mode = paintBrushModeRef.current
      const channel = activePaintChannelRef.current
      // A radius cursor is meaningless for the tools that pick a REGION, so they preview the region
      // itself instead. The sphere tool gets a ball cursor; everything else with a radius
      // (circle/cylinder, brim ears) gets the ring.
      let useSphere = false
      if (!earMode && channel) {
        const tool = effectivePaintTool(channel, paintToolRef.current)
        if (tool !== 'circle' && tool !== 'sphere') {
          brushCursor.visible = false
          brushSphereCursor.visible = false
          updatePaintRegionPreview(hit.mesh ?? null, hit.faceIndex ?? null, channel)
          return
        }
        useSphere = tool === 'sphere'
      }
      clearPaintRegionPreview()
      const palette = PAINT_CHANNEL_SPECS[channel ?? 'supports'].palette
      const colorModeHex = channel === 'color'
        ? new THREE.Color(filamentColorsRef.current?.[paintColorFilamentIdRef.current ?? -1] ?? '#9aa4ad').getHex()
        : null
      const cursorHex = earMode
        ? BRIM_EAR_MARKER_COLOR
        : mode === 'eraser'
          ? 0xe8edf4
          : channel === 'color' && colorModeHex != null
            ? colorModeHex
            : mode === 'blocker' ? palette.blocker : palette.enforcer
      if (useSphere) {
        // Centered on the hit point (the brush selects a 3D volume around it, not a surface disc).
        ;(brushSphereCursor.material as THREE.MeshBasicMaterial).color.setHex(cursorHex)
        ;(brushSphereWire.material as THREE.LineBasicMaterial).color.setHex(cursorHex)
        brushSphereCursor.position.copy(hit.point)
        brushSphereCursor.scale.setScalar(paintBrushRadiusRef.current)
        brushSphereCursor.visible = true
        brushCursor.visible = false
        return
      }
      ;(brushCursor.material as THREE.MeshBasicMaterial).color.setHex(cursorHex)
      if (earMode) {
        // Preview where the ear will actually land: flat on the bed under the pointer
        // (clicks project straight down, Bambu-style).
        brushCursor.position.set(hit.point.x, hit.point.y, 0.1)
        brushCursor.quaternion.identity()
      } else {
        brushCursor.position.copy(hit.point).addScaledVector(hit.normal, 0.05)
        brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal)
      }
      brushCursor.scale.setScalar(earMode ? brimEarDiameterRef.current / 2 : paintBrushRadiusRef.current)
      brushCursor.visible = true
      brushSphereCursor.visible = false
    }

    const onPointerDown = (event: PointerEvent) => {
      // Ignore non-primary buttons; let the gizmo claim hits on its handles.
      if (event.button !== 0) return
      const gizmoControl = transform as unknown as { axis?: string | null }
      if (gizmoControl.axis) return

      // Measure tool: a motionless click places a point (resolved on pointer-up so
      // drags still orbit); nothing else: selection and drags are suspended.
      if (gizmoModeRef.current === 'measure') {
        measureClickStart = { x: event.clientX, y: event.clientY }
        return
      }

      // Connector click: on a marker it removes that connector, on the cut plane it adds one.
      // Markers are tested FIRST and unconditionally, so a connector sitting over the plane can
      // always be taken back off -- the plane is behind every marker by construction, so a
      // nearest-hit-wins rule would make a connector unremovable the moment it was placed.
      if (gizmoModeRef.current === 'cut' && cutConnectorModeRef.current) {
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(pointer, camera)
        const { plane, section, markers } = cutConnectorTargetsRef.current
        const markerHit = raycaster.intersectObjects(markers, true)[0]
        if (markerHit) {
          let node: THREE.Object3D | null = markerHit.object
          while (node && typeof node.userData.connectorId !== 'string') node = node.parent
          const id = node?.userData.connectorId
          if (typeof id === 'string') {
            editCutConnectorsRef.current?.({ kind: 'remove', id })
            return
          }
        }
        // The visible cut FACE first. A hit there is inside the cross-section by construction, so
        // the placement is exact rather than projected onto an unbounded plane and checked after.
        if (section) {
          const sectionHit = raycaster.intersectObject(section, false)[0]
          if (sectionHit) {
            editCutConnectorsRef.current?.({ kind: 'add', worldPoint: sectionHit.point.clone() })
            return
          }
        }
        if (plane) {
          // Against the INFINITE plane the preview quad lies in, not the quad itself. Studio does the
          // same (`unproject_on_cut_plane` raycasts the clipping plane and then asks whether the hit
          // is inside a cut contour), and the difference is the whole usability of the tool: the quad
          // is a thin translucent sliver a few pixels tall on a model at normal zoom, so clicking the
          // MODEL -- the obvious thing to do -- missed it entirely and the click was refused. Which
          // reads as "connectors cannot be placed". Whether the point is actually ON the cross
          // section is a separate question, and `editCutConnectors` already answers it.
          plane.updateMatrixWorld()
          const normal = new THREE.Vector3(0, 0, 1).transformDirection(plane.matrixWorld).normalize()
          const origin = new THREE.Vector3().setFromMatrixPosition(plane.matrixWorld)
          const mathPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin)
          const hit = raycaster.ray.intersectPlane(mathPlane, new THREE.Vector3())
          if (hit) {
            editCutConnectorsRef.current?.({ kind: 'add', worldPoint: hit })
            return
          }
        }
        // Only a ray PARALLEL to the plane reaches here (an edge-on view). Still not a selection
        // change: the tool stays put rather than swapping the object out from under a half-placed
        // set of connectors.
        return
      }

      // Brim-ear click: clicking an existing ear removes it; clicking the model adds
      // one. Clicks that miss the selected object fall through to normal selection.
      if (gizmoModeRef.current === 'brimEars') {
        const selectedGroup = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
        if (selectedGroup) {
          const meshHit = paintHitOnSelected(event) // also aims the shared raycaster
          const markers: THREE.Object3D[] = []
          selectedGroup.traverse((node) => {
            if (node.name === BRIM_EAR_MARKER_NAME) markers.push(node)
          })
          const markerHit = raycaster.intersectObjects(markers, false)[0]
          const meshDistance = meshHit ? meshHit.point.distanceTo(raycaster.ray.origin) : Infinity
          if (markerHit && markerHit.distance <= meshDistance + 0.5) {
            const index = markerHit.object.userData.brimEarIndex
            if (typeof index === 'number') {
              editSelectedBrimEarsRef.current?.({ kind: 'remove', index })
              return
            }
          }
          if (meshHit) {
            editSelectedBrimEarsRef.current?.({ kind: 'add', group: selectedGroup, worldPoint: meshHit.point })
            return
          }
        }
      }

      // Paint stroke (support or seam brush): brush the selected object's surface.
      // History is recorded once per stroke; clicks that miss the object fall through
      // to normal selection.
      if (paintChannelForGizmoMode(gizmoModeRef.current) !== null) {
        const hit = paintHitOnSelected(event)
        if (hit) {
          recordHistoryRef.current?.()
          paintingStroke = true
          interactionActiveRef.current = true
          orbit.enabled = false
          renderer.domElement.setPointerCapture(event.pointerId)
          applyPaintStrokeRef.current?.(hit.mesh, hit.point, raycaster.ray.direction, hit.faceIndex, 'down')
          // Anchor the stroke here so the first move sweeps from the press rather than dabbing at
          // wherever the pointer had reached by the time the first move arrived.
          paintStrokeAnchor = { x: event.clientX, y: event.clientY }
          paintStrokeLastHit = { mesh: hit.mesh, point: hit.point.clone() }
          updateBrushCursor(hit)
          return
        }
      }

      // Text: point at the surface to place it, and keep placing while the pointer is held, so the
      // text slides across the model and re-shapes to whatever face is under the cursor.
      if (gizmoModeRef.current === 'text' && overText(event)) {
        const hit = paintHitOnSelected(event)
        if (hit) {
          recordHistoryRef.current?.()
          textDragging = true
          interactionActiveRef.current = true
          orbit.enabled = false
          renderer.domElement.setPointerCapture(event.pointerId)
          setTextInteractionRef.current('drag')
          renderer.domElement.style.cursor = 'grabbing'
          placeTextAtRef.current?.(hit.point.clone(), hit.normal.clone(), 'start')
          return
        }
      }

      // Drag the prime tower if it was clicked (it isn't a selectable instance, so direct drag is
      // its ONLY affordance -- there is no mode in which a gizmo attaches to it). That is why this
      // is not gated on Move like the body drags below: gating it there would leave the tower
      // immovable in the resting mode with nothing on screen to explain why. It is gated on the
      // picking modes only, so that a tool which ACTS on what it is pointed at (paint, cut,
      // lay-flat, measure) cannot slide the tower out from under its own stroke.
      const tower = allowsSelectionPicking(gizmoModeRef.current) ? primeTowerObjRef.current : null
      if (tower) {
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(pointer, camera)
        if (raycaster.intersectObject(tower, true).length > 0 && raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
          // History is recorded by updatePlates when the move is committed on pointer-up.
          dragOffset.set(tower.position.x - dragPoint.x, tower.position.y - dragPoint.y, 0)
          towerDragObject = tower
          orbit.enabled = false
          renderer.domElement.setPointerCapture(event.pointerId)
          return
        }
      }

      const group = pickInstanceGroup(event)
      if (!group) {
        // Defer the clear to pointer-up: a click on empty space deselects, but a
        // drag (orbiting the camera) must keep the current selection and tool.
        emptyPointerDown = { x: event.clientX, y: event.clientY }
        return
      }
      const key = group.userData.instanceKey
      const wasSelected = typeof key === 'string' && key === selectedKeyRef.current
      const wasExtra = typeof key === 'string' && extraSelectedKeysRef.current.includes(key)

      // Ctrl/Cmd-click toggles membership in the multi-selection and never drags.
      if (typeof key === 'string' && (event.ctrlKey || event.metaKey)) {
        toggleAdditiveSelectionRef.current(key)
        return
      }

      // Plain click on a multi-selection MEMBER keeps the selection; a motionless release collapses
      // to just that object. In Move the press also starts dragging the whole set. The modes that
      // cannot pick at all (paint, cut, lay-flat) collapse on the press instead, because they act on
      // a single primary and must not carry a set into the tool.
      if (typeof key === 'string' && wasExtra) {
        // Selection semantics follow BambuStudio, which groups its no-gizmo `Undefined` state with
        // Move/Rotate/Scale for `is_allow_multi_select_parts_or_objects` -- so EVERY picking mode
        // keeps the set. Spelled out as `!== 'translate'` this also collapsed a multi-selection the
        // moment you clicked a member in Rotate or Scale, losing a multi-rotate just set up.
        if (!allowsSelectionPicking(gizmoModeRef.current)) {
          selectExclusiveRef.current(key)
          return
        }
        collapseClickCandidate = { key, x: event.clientX, y: event.clientY }
        // Keeping the set is not the same as dragging it: the body drag is Move's alone. This
        // branch RETURNS below, so it never reaches the guard on the not-yet-selected path -- which
        // is how a press on a non-primary member slid the whole selection across the bed while
        // resting, the exact thing the mode exists to prevent.
        if (gizmoModeRef.current === 'translate' && raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
          panelSyncTick = 0
          beginBodyDrag(group)
          beginSelectionCoDrag(key)
          orbit.enabled = false
          renderer.domElement.setPointerCapture(event.pointerId)
        }
        return
      }
      if (typeof key === 'string') {
        if (wasSelected && extraSelectedKeysRef.current.length > 0) {
          collapseClickCandidate = { key, x: event.clientX, y: event.clientY }
        } else {
          selectExclusiveRef.current(key)
        }
      }

      // Clicking a not-yet-selected object selects it.
      if (!wasSelected) {
        // Drop a tool that ACTS on whatever it is pointed at (place-on-face, paint, cut) rather
        // than carrying it onto the object just clicked. The transform gizmos are exempt because
        // they need their handle grabbed, so selecting cannot trigger them -- this used to force
        // Move unconditionally, which knocked you out of Rotate for merely picking another object.
        if (!allowsSelectionPicking(gizmoModeRef.current)) setGizmoModeRef.current(RESTING_GIZMO_MODE)
        // Resting NEVER drags a body: that is the whole point of the mode, and it is our one
        // deliberate divergence from Studio, whose drag test (`GLCanvas3D.cpp:5807`) does not
        // require a gizmo. A drag here falls through to the orbit control instead.
        if (gizmoModeRef.current !== 'translate') return
        if (raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
          panelSyncTick = 0
          beginBodyDrag(group)
          orbit.enabled = false
          renderer.domElement.setPointerCapture(event.pointerId)
        }
        return
      }

      // Clicking an added part volume of the selected object selects it (and hands it the gizmo in
      // the transform modes); clicking the object's body while a part is selected returns to the
      // object. Drilling in is SELECTION, so it works in the resting mode too -- Studio groups its
      // no-gizmo state with the transform gizmos for exactly this (`allowsSelectionPicking`).
      if (allowsSelectionPicking(gizmoModeRef.current)) {
        const hits = raycaster.intersectObject(group, true)
        const firstMesh = hits.find((hit) => (hit.object as THREE.Mesh).isMesh && hit.object.name !== BRIM_EAR_MARKER_NAME)
        const partKey = firstMesh?.object.userData.addedPartKey
        if (typeof partKey === 'string') {
          // Select (or keep) the part; its movement happens via the gizmo only, so
          // never fall through to the object body-drag. The host id comes from the instance under
          // the cursor: a volume's own key does not name its owner, and the selection now addresses
          // every part as (object, member) so that the two kinds prune and clear by one rule.
          const hit = activePlateRef.current?.instances.find((entry) => entry.key === key)
          const hostId = hit
            ? (hit.source.kind === 'object' ? hit.objectId : hit.source.replacedObjectId ?? null)
            : null
          if (hostId != null) setGizmoPart({ objectId: hostId, member: { kind: 'added', key: partKey } })
          // ...and it can be dragged by its mesh, like the object it sits in. The part's transform
          // is expressed in its ROTOR's frame while the drag point is a world position on the bed
          // plane, so the grab offset is captured after converting into that frame; the move handler
          // converts each new drag point the same way. Only x/y are written, so a part keeps the
          // height it was given.
          const rotor = rotorOf(group)
          // The tagged node is the part's own mesh; a paint overlay hit lands on its CHILD, so walk
          // up one to the node whose transform is the part's.
          const picked = firstMesh?.object ?? null
          const grabbed = picked && isAddedPartMesh(picked)
            ? (typeof picked.userData.addedPartKey === 'string' ? picked : picked.parent)
            : null
          // Gated on Move for the same reason the object body drag is: resting NEVER drags, which is
          // the whole point of that mode. And `dragPoint` has to be COMPUTED here -- it is the bed
          // plane hit for this press, and the object path raycasts it before capturing its own grab
          // offset. Reading it without that left the offset built from a stale point, so the part
          // either jumped on the first move or refused to move at all.
          if (grabbed && gizmoModeRef.current === 'translate'
            && raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
            partDragMesh = grabbed
            partDragRotor = rotor
            partDragRecorded = false
            partDragOffset.copy(grabbed.position).sub(rotor.worldToLocal(dragPoint.clone()))
            orbit.enabled = false
            renderer.domElement.setPointerCapture(event.pointerId)
          }
          return
        }
        // Clicking the object body steps back up to the object from a VOLUME only. A baked part
        // stays put here, exactly as before: the drill-down below re-picks it on pointer-up, and
        // clearing it on the way through made a motionless click flicker the selection off and on.
        if (gizmoPartRef.current?.member.kind === 'added') setGizmoPart(null)
        // BambuStudio drill-down: a MOTIONLESS click on an already-selected multi-part
        // object selects the baked part under the cursor (resolved on pointer-up, so a
        // drag still moves the whole object). Single-part objects stay object-level.
        const partRef = firstMesh?.object.parent ? partGroupRef(firstMesh.object.parent) : null
        if (partRef && extraSelectedKeysRef.current.length === 0) {
          const instance = activePlateRef.current?.instances.find((entry) => entry.key === key)
          // Imports drill down too, their solids carry `importPartRef` and take the gizmo the
          // same way (see handleSelectPart), keyed by the import's synthetic object identity.
          const ownerId = instance
            ? (instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId ?? null)
            : null
          if (instance && ownerId != null && instance.parts.length > 1) {
            bakedPartClickCandidate = {
              part: { objectId: ownerId, member: { kind: 'baked', partIndex: partRef.partIndex } },
              x: event.clientX,
              y: event.clientY
            }
          }
        }
      }

      // Place on face: rotate the object so the clicked face lies flat on the bed.
      // Prefer the convex-hull overlay (exposes pseudo-faces over open ends); fall
      // back to the raw mesh if the hull is unavailable.
      if (gizmoModeRef.current === 'layFace') {
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(pointer, camera)
        const hull = faceHullRef.current
        const faceHit = (hull
          ? raycaster.intersectObject(hull, false)
          : raycaster.intersectObject(group, true)
        ).find((hit) => hit.face)
        if (faceHit?.face) {
          recordHistoryRef.current?.()
          // Read the clicked face's world normal BEFORE baking (the raycast hit reflects the
          // current visual). A shearing object renders an exact matrix with matrixAutoUpdate off,
          // so its rotor/position edits are ignored until baked to editable T·S·R, without this,
          // restObjectOnBed's position change is a no-op and the object floats. Mirrors the gizmo
          // drag / mutateSelectedGroup paths.
          const worldNormal = faceHit.face.normal.clone().transformDirection(faceHit.object.matrixWorld).normalize()
          bakeExactMatrixRef.current(group)
          // Reorient IN PLACE: the rotation spins the geometry about the group origin, so an off-centre
          // object (and especially a flip to the OPPOSITE face) swings sideways across the bed. Capture
          // the footprint's XY centre before, then translate it back after re-resting so "place on
          // face" only changes orientation + bed height, matching BambuStudio. Cheap AABB is enough
          // for a centre.
          const beforeBox = printableMeshBox(group, false)
          rotorOf(group).quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(worldNormal, DOWN_VECTOR))
          restObjectOnBed(group)
          const afterBox = printableMeshBox(group, false)
          // Guarded like restObjectOnBed: an object with no printable geometry has an empty box,
          // whose "centre" would be NaN and would corrupt the position.
          if (!beforeBox.isEmpty() && !afterBox.isEmpty()) {
            group.position.x += (beforeBox.min.x + beforeBox.max.x) / 2 - (afterBox.min.x + afterBox.max.x) / 2
            group.position.y += (beforeBox.min.y + beforeBox.max.y) / 2 - (afterBox.min.y + afterBox.max.y) / 2
          }
          writeBackGroupTransform(group)
          syncSelectedTransformRef.current?.(group)
          regenerateActiveThumbnailRef.current?.()
          // The hull bakes the part's orientation, so rebuild it for the new pose, otherwise the
          // hull + its highlight linger in the pre-lay-flat orientation.
          rebuildFaceHullRef.current()
        }
        return
      }

      // In Move mode, grab the body and drag it across the bed plane (co-dragging the
      // rest of a multi-selection).
      if (gizmoModeRef.current === 'translate') {
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(pointer, camera)
        if (raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
          panelSyncTick = 0
          beginBodyDrag(group)
          if (typeof key === 'string') beginSelectionCoDrag(key)
          orbit.enabled = false
          renderer.domElement.setPointerCapture(event.pointerId)
        }
      }
    }

    /**
     * Claim a selectable object's primary press before OrbitControls handles pointer-down.
     *
     * Selection itself remains in {@link onPointerDown}; this capture listener owns only gesture
     * arbitration. Transform handles are excluded because TransformControls owns those presses,
     * and non-selection tools keep their existing pointer behavior.
     */
    const claimSelectedObjectPointer = (event: PointerEvent) => {
      if (!allowsSelectionPicking(gizmoModeRef.current)) return
      const gizmoControl = transform as unknown as { axis?: string | null }
      selectedObjectPointer.claim(event, !gizmoControl.axis && Boolean(pickInstanceGroup(event)))
    }

    const onPointerMove = (event: PointerEvent) => {
      if (gizmoModeRef.current === 'text' && !textDragging) {
        const over = overText(event)
        setTextInteractionRef.current(over ? 'hover' : 'idle')
        renderer.domElement.style.cursor = over ? 'grab' : ''
      }
      if (textDragging) {
        const hit = paintHitOnSelected(event)
        // Off the model, the text stays where it was: sliding past an edge must not fling it.
        if (hit) placeTextAtRef.current?.(hit.point.clone(), hit.normal.clone(), 'move')
        return
      }
      // Connector hover: ghost the peg where it would land. Without it the cut face is a blank
      // surface that gives no sign a click will do anything, which is most of why the tool read as
      // unresponsive even once the face was visible.
      if (gizmoModeRef.current === 'cut' && cutConnectorModeRef.current) {
        const { section } = cutConnectorTargetsRef.current
        if (section) {
          const rect = renderer.domElement.getBoundingClientRect()
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
          raycaster.setFromCamera(pointer, camera)
          const hit = raycaster.intersectObject(section, false)[0]
          hoverCutConnectorRef.current?.(hit ? hit.point.clone() : null)
          renderer.domElement.style.cursor = hit ? 'copy' : ''
          connectorCursorShown = hit != null
        } else {
          hoverCutConnectorRef.current?.(null)
          if (connectorCursorShown) {
            renderer.domElement.style.cursor = ''
            connectorCursorShown = false
          }
        }
      } else if (connectorCursorShown) {
        renderer.domElement.style.cursor = ''
        connectorCursorShown = false
      }
      if (paintChannelForGizmoMode(gizmoModeRef.current) !== null || gizmoModeRef.current === 'brimEars') {
        if (paintingStroke) {
          // Painting owns the raycasts here: `paintStrokeTo` casts one per interpolated sample and
          // returns the last, so hit-testing the raw pointer position first would only duplicate
          // the final one. Hovering (not stroking) still needs its own, for the cursor.
          updateBrushCursor(paintStrokeTo(event.clientX, event.clientY))
          return
        }
        updateBrushCursor(paintHitOnSelected(event))
      } else if (brushCursor.visible || brushSphereCursor.visible) {
        brushCursor.visible = false
        brushSphereCursor.visible = false
      }
      // Measure: preview where the click lands, including whether it will snap to a corner.
      if (gizmoModeRef.current === 'measure') {
        updateMeasureHover(pickMeasureFeature(event, event.shiftKey), event.shiftKey)
      } else if (measureHoverFeature) {
        clearMeasureHover()
      }
      // Place-on-face: highlight the hull face under the pointer so the user sees exactly which
      // face they'll lay flat before clicking. (Hover only: selection still happens on pointerdown.)
      if (gizmoModeRef.current === 'layFace') {
        const hull = faceHullRef.current
        if (hull) {
          const rect = renderer.domElement.getBoundingClientRect()
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
          raycaster.setFromCamera(pointer, camera)
          const hit = raycaster.intersectObject(hull, false).find((entry) => entry.faceIndex != null)
          updateHullFaceHighlight(hull, hit && hit.faceIndex != null ? hit.faceIndex : null)
        }
      }
      // `partDragMesh` belongs in this gate: a part drag moves a mesh INSIDE an object, so it never
      // sets `bodyDragGroup`, and the handler used to return here before reaching it. That is why
      // dragging a part by its mesh did nothing at all.
      if (!bodyDragGroup && !towerDragObject && !partDragMesh) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      if (!raycaster.ray.intersectPlane(bedPlane, dragPoint)) return
      if (towerDragObject) {
        // Keep the tower's whole footprint on the bed AND out of unprintable zones: Bambu never
        // lets the purge tower leave the plate or sit in an excluded area. Clamp the centre to the
        // bed, then accept the new X/Y only if the resulting footprint clears every exclude zone
        // (tested per-axis so the tower slides along a zone edge instead of sticking).
        const bed = activePlateRef.current?.bed
        const halfW = (typeof towerDragObject.userData.towerWidth === 'number' ? towerDragObject.userData.towerWidth : 0) / 2
        const halfD = (typeof towerDragObject.userData.towerDepth === 'number' ? towerDragObject.userData.towerDepth : 0) / 2
        let centerX = dragPoint.x + dragOffset.x
        let centerY = dragPoint.y + dragOffset.y
        if (bed) {
          centerX = THREE.MathUtils.clamp(centerX, bed.minX + halfW, bed.maxX - halfW)
          centerY = THREE.MathUtils.clamp(centerY, bed.minY + halfD, bed.maxY - halfD)
          const zones = bed.excludeAreas
          const blocked = (cx: number, cy: number) =>
            footprintHitsExcludeZones(cx - halfW, cx + halfW, cy - halfD, cy + halfD, zones)
          if (blocked(centerX, towerDragObject.position.y)) centerX = towerDragObject.position.x
          if (blocked(centerX, centerY)) centerY = towerDragObject.position.y
        }
        towerDragObject.position.x = centerX
        towerDragObject.position.y = centerY
        return
      }
      if (partDragMesh && partDragRotor) {
        // Same undo rule as the object drag: the checkpoint lands on the first real move, so a
        // click that only selects the part leaves no phantom history entry.
        if (!partDragRecorded) {
          recordHistoryRef.current?.()
          partDragRecorded = true
        }
        const local = partDragRotor.worldToLocal(dragPoint.clone())
        partDragMesh.position.x = local.x + partDragOffset.x
        partDragMesh.position.y = local.y + partDragOffset.y
        writeBackPartMeshRef.current?.(partDragMesh)
        // The gizmo hangs off the pivot proxy, so it needs re-seating for the same reason the object
        // drag does, or it stays where the part was when the drag began.
        reseatMultiPivot()
        return
      }
      if (!bodyDragGroup) return
      // Snapshot for undo on the first real move (not on pointer-down): taken before the move is
      // applied, so undo restores the pre-drag layout. A select-only click never reaches here, so
      // it leaves no phantom checkpoint / dirty flag.
      if (!bodyDragRecorded) {
        recordHistoryRef.current?.()
        bodyDragRecorded = true
      }
      bodyDragGroup.position.x = dragPoint.x + dragOffset.x
      bodyDragGroup.position.y = dragPoint.y + dragOffset.y
      writeBackGroupTransform(bodyDragGroup)
      for (const extra of bodyDragExtras) {
        extra.group.position.x = dragPoint.x + extra.offsetX
        extra.group.position.y = dragPoint.y + extra.offsetY
        writeBackGroupTransform(extra.group)
      }
      // Bring the gizmo along. It hangs off the PIVOT PROXY, never off the dragged group -- one
      // selected object composes exactly as many do, so the proxy is used at any count -- and a body
      // drag moves the groups directly, leaving the proxy (and so the gizmo) at the position the
      // selection had when the drag started. A gizmo drag has the opposite shape: the proxy IS what
      // moves, and `reseatMultiPivot` only ran at the end of one, so the body-drag path never
      // re-seated at all and the gizmo simply stayed behind.
      //
      // Every frame rather than on release, because the gizmo trailing the model for the length of a
      // drag is the visible half of the bug. It is the cheap transformed-AABB fit, the same one the
      // drop-frame optimisation left in place, so this costs a box per selected object per frame.
      reseatMultiPivot()
      // A real drag is no longer a collapse-to-single click.
      if (collapseClickCandidate) {
        const moved = Math.hypot(event.clientX - collapseClickCandidate.x, event.clientY - collapseClickCandidate.y)
        if (moved >= 5) collapseClickCandidate = null
      }
      throttledPanelSync(bodyDragGroup)
    }

    const endBodyDrag = (event: PointerEvent) => {
      selectedObjectPointer.release(event)
      if (measureClickStart) {
        const start = measureClickStart
        measureClickStart = null
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) {
          // The whole FEATURE travels with the click, not just a point: it is what the panel names,
          // what the highlight draws, and what the measurement is taken between. None of it can be
          // re-derived later, since by then there is no mesh or face to resolve it against.
          const picked = pickMeasureFeature(event, event.shiftKey)
          if (picked) addMeasurePointRef.current?.(picked)
        }
        return
      }
      if (textDragging) {
        textDragging = false
        interactionActiveRef.current = false
        orbit.enabled = true
        setTextInteractionRef.current(overText(event) ? 'hover' : 'idle')
        renderer.domElement.style.cursor = overText(event) ? 'grab' : ''
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId)
        }
        regenerateActiveThumbnailRef.current?.()
        return
      }
      if (paintingStroke) {
        paintingStroke = false
        // The next stroke starts its own contact chain; a stale anchor would make its first dab
        // sweep all the way from wherever the last one ended.
        paintStrokeAnchor = null
        paintStrokeLastHit = null
        interactionActiveRef.current = false
        orbit.enabled = true
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId)
        }
        regenerateActiveThumbnailRef.current?.()
        // One bump per stroke: paint mutated state in place, so consumers keyed on state identity
        // (the used-materials set -> remove guard + prime tower) need an explicit signal.
        paintCommittedRef.current?.()
        return
      }
      // Empty-space click (negligible movement) clears the selection; a drag (orbiting) keeps it.
      if (emptyPointerDown) {
        const moved = Math.hypot(event.clientX - emptyPointerDown.x, event.clientY - emptyPointerDown.y)
        emptyPointerDown = null
        if (moved < 5) selectExclusiveRef.current(null)
      }
      // A motionless click on a multi-selection member collapses the selection to it.
      if (collapseClickCandidate) {
        const moved = Math.hypot(event.clientX - collapseClickCandidate.x, event.clientY - collapseClickCandidate.y)
        if (moved < 5) selectExclusiveRef.current(collapseClickCandidate.key)
        collapseClickCandidate = null
      }
      // A motionless click on a selected multi-part object drills into the baked part.
      if (bakedPartClickCandidate) {
        const moved = Math.hypot(event.clientX - bakedPartClickCandidate.x, event.clientY - bakedPartClickCandidate.y)
        if (moved < 5) setGizmoPart(bakedPartClickCandidate.part)
        bakedPartClickCandidate = null
      }
      bodyDragExtras = []
      if (towerDragObject) {
        const width = typeof towerDragObject.userData.towerWidth === 'number' ? towerDragObject.userData.towerWidth : 0
        const depth = typeof towerDragObject.userData.towerDepth === 'number' ? towerDragObject.userData.towerDepth : width
        movePrimeTowerRef.current?.(towerDragObject.position.x - width / 2, towerDragObject.position.y - depth / 2)
        towerDragObject = null
        orbit.enabled = true
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId)
        }
        return
      }
      if (partDragMesh) {
        // The panel reads the PART's placement while a part holds the gizmo, so it is synced from
        // the part, not from the object it sits in.
        syncSelectedTransformRef.current?.(partDragMesh)
        partDragMesh = null
        partDragRotor = null
        orbit.enabled = true
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId)
        }
        regenerateActiveThumbnailRef.current?.()
        return
      }
      if (!bodyDragGroup) return
      // Push the exact final transform to the panel (mid-drag syncs are throttled).
      syncSelectedTransformRef.current?.(bodyDragGroup)
      bodyDragGroup = null
      orbit.enabled = true
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId)
      }
      regenerateActiveThumbnailRef.current?.()
    }

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const group = pickInstanceGroup(event as unknown as PointerEvent)
      const key = group ? (group.userData.instanceKey as string) : null
      openContextMenuRef.current(key ? { x: event.clientX, y: event.clientY, key } : null)
    }

    /**
     * Re-seat the orbit pivot on whatever the drag is about to turn around.
     *
     * Registered AFTER `onPointerDown` on purpose, so it sees the `orbit.enabled = false` that
     * handler writes for a gizmo drag, a paint stroke or a tool click, and leaves those alone.
     * Studio resolves its pivot the same way, on the press rather than per move.
     *
     * Touch counts because `OrbitControls.touches.ONE` is a rotate; a second finger turns the
     * gesture into a pan or a dolly, by which point the pivot is already seated and harmless.
     */
    const onPointerDownGroundPivot = (event: PointerEvent) => {
      if (!orbit.enabled) return
      if (event.pointerType !== 'touch' && event.button !== 0) return
      cameraRig.groundPivot(ORBIT_PIVOT_PLANE_Z)
    }

    renderer.domElement.addEventListener('pointerdown', claimSelectedObjectPointer, true)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerdown', onPointerDownGroundPivot)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    // The pointer leaving the canvas fires no move, so anything drawn UNDER it has to be cleared
    // here or it simply stays. Harmless for the brush ring; not for the fill preview, which is a
    // coloured region and reads as paint that has already been applied.
    const onPointerLeave = () => {
      brushCursor.visible = false
      brushSphereCursor.visible = false
      clearPaintRegionPreview()
      // Every hover visual, not just the paint ones: the measure highlight has no other clear path
      // either, so a hole hovered on the way to the side panel stayed ringed over the model.
      updateMeasureHover(null, false)
      const hull = faceHullRef.current
      if (hull) updateHullFaceHighlight(hull, null)
      requestRenderRef.current?.()
    }
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    renderer.domElement.addEventListener('pointerup', endBodyDrag)
    renderer.domElement.addEventListener('pointercancel', endBodyDrag)
    renderer.domElement.addEventListener('contextmenu', onContextMenu)

    let frame = 0
    let validationFrame = 0
    let wasInteracting = false
    // On-demand rendering. The viewport used to `renderer.render()` every frame at 60fps even when
    // nothing changed, pinning the GPU at 60-70% while the editor just sat open. Now a frame is
    // painted only when something actually needs it: `needsRender` (set on a camera move, a React
    // commit via requestRenderRef, or pointer motion over the canvas), an in-progress interaction
    // (smooth drags), the drag-end edge, or a low-rate safety tick that repaints anything an
    // un-instrumented mutation might have missed. 250ms is imperceptible on a static scene but drops
    // idle cost from 60fps to ~4fps. The rAF loop itself keeps running so orbit damping still
    // advances and the safety net stays alive.
    const IDLE_RENDER_INTERVAL_MS = 250
    let needsRender = true
    let lastRenderStamp = Number.NEGATIVE_INFINITY
    const requestRender = () => { needsRender = true }
    requestRenderRef.current = requestRender
    // Camera moves (drag, wheel, and every damping-settle frame) fire this; that is what keeps a
    // released orbit smooth without a full-time render loop.
    orbit.addEventListener('change', requestRender)
    // Pointer motion over the canvas drives visuals React never sees: the paint brush cursor, hover
    // highlight, the measure-tool preview. Painting is not an "interaction" in the drag sense, so
    // without this those would only refresh on the safety tick.
    const onPointerMoveRender = () => requestRender()
    renderer.domElement.addEventListener('pointermove', onPointerMoveRender)
    // Last-applied inputs to applyPaintOverlayVisibility, so it only re-traverses on a real change.
    let lastPaintChannel: TrianglePaintChannel | null | undefined
    let lastPaintSelectedKey: string | null | undefined
    // Tracked separately from the paint channel because layers editing has NO channel: entering it
    // from Move leaves `activePaintChannel` null both before and after, so keying the re-apply on
    // the channel alone would never notice the mode that hides colour paint.
    let lastLayersEditing: boolean | undefined
    // Painted-triangle overlay visibility (BambuStudio parity + perf). Support/seam paint show ONLY
    // for the SELECTED object while their own tool is active, they're annotations, and a painted
    // part's overlay is a very dense mesh (100k+ leaf sub-triangles at the 0.2mm split limit) that
    // tanks the frame rate if drawn all the time. Colour paint always shows (it IS the print's
    // colour). Everything is dropped mid-manipulation (drag/gizmo/tower) so it can't make a move
    // choppy. The paint data is untouched. Re-applied only when one of those inputs changes (below),
    // so the traversal cost is negligible.
    const overlayChannelByName = new Map<string, TrianglePaintChannel>(
      (Object.entries(PAINT_CHANNEL_SPECS) as Array<[TrianglePaintChannel, { overlayName: string }]>)
        .map(([channel, spec]) => [spec.overlayName, channel])
    )
    const applyPaintOverlayVisibility = (interacting: boolean) => {
      const active = activePaintChannelRef.current
      const selectedKey = selectedKeyRef.current
      // Colour paint is normally shown in every mode, because it IS the print's colour rather than
      // an annotation. Layers editing is the exception: its thickness shading is the whole point of
      // that mode, and a paint overlay is lifted 0.05mm PROUD of the surface, so it would sit on top
      // of the very feedback the user switched modes to read.
      const layersEditing = gizmoModeRef.current === 'layerHeight'
      for (const [key, group] of groupByKeyRef.current) {
        const isSelected = key === selectedKey
        group.traverse((node) => {
          if (!(node as THREE.Mesh).isMesh || !node.userData.isPaintOverlay) return
          const channel = overlayChannelByName.get(node.name)
          node.visible = interacting || layersEditing
            ? false
            : channel != null && paintOverlayVisible(channel, active, isSelected)
        })
      }
    }
    // Recompute the placement warnings (collision / off-plate / floating / unprintable / tower)
    // from the live scene and push them to state only when the set changes. Reads refs only, so
    // it is safe to call both from the rAF poll below and on demand (the plate-build effect calls
    // it via recomputeWarningsRef after a rebuild). The CALLER owns the "skip while dragging" gate.
    const runPlacementWarningRecompute = () => {
      const plate = activePlateRef.current
      let warnings: PlacementWarning[] = []
      if (plate) {
        const footprints = new Map<string, Set<number>>()
        for (const instance of plate.instances) {
          const group = groupByKeyRef.current.get(instance.key)
          if (!group || !isInstancePrintedRef.current(instance)) continue
          // Footprint rasterization is O(triangles): brutal for a many-part high-poly object and,
          // forced on every drop, the freeze after dragging one around the plate. It only depends on
          // SHAPE (orientation+scale), so a pure move keeps the cached cells and just shifts them by
          // the whole-cell translation delta (O(cells)); only a rotate/scale (shape sig change)
          // re-rasterizes. Shift from the ORIGINAL rasterization each time so rounding never drifts.
          const shapeSig = groupShapeSignature(group)
          const cached = footprintCacheRef.current.get(instance.key)
          let cells: Set<number>
          if (cached && cached.shapeSig === shapeSig) {
            const dCellX = Math.round((group.position.x - cached.baseX) / FOOTPRINT_CELL_MM)
            const dCellY = Math.round((group.position.y - cached.baseY) / FOOTPRINT_CELL_MM)
            cells = shiftFootprintCells(cached.cells, dCellX, dCellY)
          } else {
            cells = computeFootprintCells(group)
            footprintCacheRef.current.set(instance.key, { shapeSig, cells, baseX: group.position.x, baseY: group.position.y })
          }
          footprints.set(instance.key, cells)
        }
        // Purge/prime tower footprint in world (== plate-local) coords, read from the
        // live object so a dragged tower is tracked. Only present on multi-filament plates.
        let towerRect: { minX: number; maxX: number; minY: number; maxY: number } | null = null
        const tower = primeTowerObjRef.current
        if (tower) {
          const halfW = (typeof tower.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0) / 2
          const halfD = (typeof tower.userData.towerDepth === 'number' ? tower.userData.towerDepth : 0) / 2
          if (halfW > 0 && halfD > 0) {
            const center = tower.getWorldPosition(new THREE.Vector3())
            towerRect = { minX: center.x - halfW, maxX: center.x + halfW, minY: center.y - halfD, maxY: center.y + halfD }
          }
        }
        warnings = computePlacementWarnings(groupByKeyRef.current, plate, isInstancePrintedRef.current, footprints, instanceNozzlesRef.current, towerRect)
      }
      const signature = JSON.stringify(warnings)
      if (signature !== lastWarningSigRef.current) {
        lastWarningSigRef.current = signature
        placementWarningsSetterRef.current(warnings)
      }
    }
    recomputeWarningsRef.current = runPlacementWarningRecompute
    const animate = (now = 0) => {
      // While a heavy overlay viewer (the 3D preview modal) is open above the editor, skip
      // all per-frame work: the modal covers this viewport, and rendering two full scenes
      // at once doubles the GPU load for nothing. The canvas keeps its last frame and the
      // loop resumes on the first frame after the overlay closes.
      if (hasActiveOverlayViewer()) {
        frame = requestAnimationFrame(animate)
        return
      }
      // BEFORE `orbit.update()`, which re-derives its spherical state from wherever the camera now
      // is, so the swing composes with the controls instead of fighting them.
      const tweening = cameraRig.advance(now)
      // Skipped WHILE a swing is in flight: `OrbitControls.update()` ends in `lookAt(target)`, which
      // would recompute the roll from the direction every frame and undo the interpolation. There is
      // no user input to damp meanwhile, and the swing lands on exactly the orientation `lookAt`
      // would produce, so the controls pick up seamlessly on the first frame after it finishes.
      // Advances orbit damping and fires 'change' (-> requestRender) on any camera movement.
      if (!tweening) orbit.update()
      // Any active drag (gizmo, object body, or purge tower). Drives both the cheaper
      // selection-box bounds below and the deferred placement-warning recompute further down.
      const interacting = gizmoDragging || bodyDragGroup !== null || towerDragObject !== null
      const dragJustEnded = wasInteracting && !interacting
      const interactingChanged = interacting !== wasInteracting
      wasInteracting = interacting
      // Paint them only when needed (see the on-demand note above): a pending request, a live drag,
      // its end edge, or the safety tick. Everything below feeds the frame, so it is gated too.
      const shouldRender = needsRender || interacting || tweening || dragJustEnded || (now - lastRenderStamp) >= IDLE_RENDER_INTERVAL_MS
      let wantAnotherFrame = false
      if (shouldRender) {
        // Re-apply paint-overlay visibility (see helper above) whenever the active tool, the selection,
        // or the manipulation state changes, not every frame.
        const activePaintChannel = activePaintChannelRef.current
        const paintSelectedKey = selectedKeyRef.current
        const layersEditing = gizmoModeRef.current === 'layerHeight'
        if (interactingChanged || activePaintChannel !== lastPaintChannel || paintSelectedKey !== lastPaintSelectedKey
          || layersEditing !== lastLayersEditing) {
          applyPaintOverlayVisibility(interacting)
          lastPaintChannel = activePaintChannel
          lastPaintSelectedKey = paintSelectedKey
          lastLayersEditing = layersEditing
        }
        // Track the selected object's mesh bounds (Box3Helper fits itself to the box value in its
        // own updateMatrixWorld during render). The PRECISE walk (per-vertex) is the priciest
        // per-frame work for high-poly models, so: only recompute when the object actually moved
        // (idle selections / camera orbits skip it), and while dragging use the cheap transformed-
        // AABB path so high-poly drags stay smooth, then restore the precise box on the drop frame.
        if (selectionBox && selectionTarget) {
          const sig = selectionBoxSignature(selectionTarget)
          // A drop re-fits immediately -- cheap for a translation, precise for a reorientation --
          // and a CHEAP one then re-arms the upgrade to correct itself. The cheap fit is a fresh
          // transformed-AABB, not a translated copy of the box that was there, so on a reoriented
          // object it re-inflates: rotate an object (tight box), nudge it 5mm in Move, and the box
          // balloons again with nothing pending to correct it. "Translation keeps the box exact"
          // only holds if the box being carried was already precise, and after a cheap fit it is
          // not. A rotate/scale drop is exempt because it already walked the vertices below: arming
          // it there bought an identical box for a second full walk two frames later, on the very
          // gesture over the very geometry (high-poly, many-part) the cheap path exists to protect.
          if (dragJustEnded && !lastDragChangedOrientation) selectionBoxPreciseFitDelay = 2
          // A live drag cancels a pending upgrade rather than paying for it mid-gesture; otherwise
          // count down and take the precise walk on a settled frame.
          let upgrade = false
          if (selectionBoxPreciseFitDelay > 0) {
            if (interacting) {
              selectionBoxPreciseFitDelay = 0
            } else {
              selectionBoxPreciseFitDelay -= 1
              upgrade = selectionBoxPreciseFitDelay === 0
              // Keep the loop awake so the upgrade lands next frame rather than at the idle tick.
              // Applied AFTER the reset below, which would otherwise clear it in the same frame.
              if (!upgrade) wantAnotherFrame = true
            }
          }
          if (sig !== selectionBoxSig || dragJustEnded || upgrade) {
            selectionBoxSig = sig
            // Precise (per-vertex) is only needed to hug a REORIENTED object. Mid-drag stays cheap,
            // and so does the drop frame of a pure move -- that one is corrected by the upgrade the
            // re-arm above scheduled, rather than by paying for the walk inside the gesture.
            // An upgrade frame is ALWAYS precise -- it exists for nothing else, and letting the
            // drag answer win here would consume the countdown on a cheap fit and leave the loose
            // box with nothing pending.
            const precise = interacting ? false : (dragJustEnded && !upgrade ? lastDragChangedOrientation : true)
            fitSelectionBox(selectionBoxValue, printableMeshBox(selectionTarget, precise))
            // A newly selected object starts hidden. Reveal it only after a precise fit, whether
            // that is the deferred settled-frame upgrade or a rotate/scale drop that already pays
            // for exact bounds. Pure-move drops remain hidden until their deferred precise fit.
            if (precise) selectionBox.visible = true
          }
        }
        // Keep ear markers flat on the bed through rotations/scales (their matrices bake
        // the world transform, so they must re-bake whenever the instance moves). Only
        // the few groups that actually carry markers pay anything here.
        for (const group of groupByKeyRef.current.values()) syncBrimEarMarkerMatrices(group)
        syncExtraSelectionBoxes()
        syncPartSelectionBoxes()
        syncSelectionOwners()
        // Annotations sized in screen pixels are re-scaled for THIS frame's camera, just before the
        // draw that shows them, so a swing or a zoom cannot leave one a frame stale.
        syncScreenSpaceOverlays(scene, camera, renderer.domElement.clientHeight)
        renderer.render(scene, camera)
        // Outlines are on their own layer, so the pass above drew none of them. Skipped outright
        // with nothing selected, which is when its two extra scene walks would buy nothing.
        if (selectionOwners.active) renderSelectionOverlay(renderer, scene, camera)
        viewCube.sync(camera)
        needsRender = wantAnotherFrame
        lastRenderStamp = now
      }
      // Re-check placement (~4x/sec) so collision/off-plate/floating/unprintable/tower
      // warnings stay current without wiring every mutation path. The recompute (footprint
      // rasterization + per-object Box3 builds) is skipped WHILE actively dragging an object,
      // the gizmo, or the purge tower, that per-tick work was stuttering drags. Movement is
      // still constrained live in the pointer handlers (e.g. the tower stays on the plate and
      // out of exclude zones); only the advisory warnings are deferred. They refresh on the
      // exact frame the drag ends (the interacting→idle edge), not just on the next 15-frame tick.
      validationFrame += 1
      if (!interacting && (dragJustEnded || validationFrame % 15 === 0)) runPlacementWarningRecompute()
      frame = requestAnimationFrame(animate)
    }
    animate()

    const onResize = () => {
      const w = Math.max(container.clientWidth, 1)
      const h = Math.max(container.clientHeight, 1)
      // Re-apply the capped DPR so moving to a different-density display updates it.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      // Until the user manually moves the camera, keep the home view framed to the
      // current size. This re-centers after the dialog open-transition settles and
      // when the viewport is revealed by switching back from the Settings tab
      // (where it was display:none with zero size).
      if (!userAdjustedViewRef.current && container.clientWidth > 1) {
        frameDefaultViewRef.current?.()
      }
      // A resize with a still camera would otherwise wait for the safety tick to repaint at the
      // new size (a visible stretch/gap for up to a frame-interval).
      requestRender()
    }
    window.addEventListener('resize', onResize)
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(container)

    // Joy's menu click-away only fires on left click, so a right click leaves split-button
    // and filament menus open. Joy ignores synthetic mouse events but closes a menu on
    // Escape, so dispatch Escape to each open listbox before the context menu appears.
    // That Escape bubbles up to the editor Modal too, which would otherwise close the whole
    // editor; suppress the Modal's escape-close for the duration of the synchronous dispatch.
    const onGlobalContextMenu = () => {
      suppressEditorEscapeRef.current = true
      try {
        for (const listbox of document.querySelectorAll('[role="menu"]')) {
          listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
        }
      } finally {
        suppressEditorEscapeRef.current = false
      }
    }
    window.addEventListener('contextmenu', onGlobalContextMenu, true)

    return () => {
      cancelAnimationFrame(frame)
      // Drop the forced-recompute hook so a post-teardown call can't touch the disposed scene.
      recomputeWarningsRef.current = () => undefined
      window.removeEventListener('resize', onResize)
      window.removeEventListener('contextmenu', onGlobalContextMenu, true)
      resizeObserver.disconnect()
      // Take the owner layer back off the meshes: the scene outlives this effect across a rebuild,
      // so a stale owner would keep writing depth for an outline that no longer exists.
      selectionOwners.dispose()
      requestRenderRef.current = null
      orbit.removeEventListener('change', requestRender)
      cameraRig.dispose()
      renderer.domElement.removeEventListener('pointermove', onPointerMoveRender)
      renderer.domElement.removeEventListener('pointerdown', claimSelectedObjectPointer, true)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerdown', onPointerDownGroundPivot)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', endBodyDrag)
      renderer.domElement.removeEventListener('pointercancel', endBodyDrag)
      renderer.domElement.removeEventListener('contextmenu', onContextMenu)
      selectedObjectPointer.dispose()
      transformEvents.removeEventListener('dragging-changed', onDraggingChanged)
      transformEvents.removeEventListener('objectChange', onObjectChange)
      transform.detach()
      transform.dispose()
      orbit.dispose()
      viewCube.dispose()
      // A teardown mid-drag would otherwise leave the flag stuck true and starve
      // background thumbnail builds for the rest of the session.
      interactionActiveRef.current = false
      if (applyViewPresetRef.current === applyViewPreset) applyViewPresetRef.current = null
      if (frameDefaultViewRef.current === frameDefaultView) frameDefaultViewRef.current = null
      setSelectionHighlight(null)
      if (setSelectionHighlightRef.current === setSelectionHighlight) setSelectionHighlightRef.current = null
      scene.remove(snapGuides)
      disposeObject3D(snapGuides)
      clearMeasureHover()
      scene.remove(measureHoverGroup)
      scene.remove(brushCursor)
      clearPaintRegionPreview()
      disposeObject3D(brushCursor)
      scene.remove(brushSphereCursor)
      disposeObject3D(brushSphereCursor)
      disposeObject3D(plateRoot)
      scene.remove(plateRoot)
      scene.remove(transform as unknown as THREE.Object3D)
      scene.remove(multiPivot)
      if (multiPivotRef.current === multiPivot) multiPivotRef.current = null
      // Before forceContextLoss below, which fires webglcontextlost on our own canvas,
      // a deliberate teardown must not be misread as a GPU failure and trigger a rebuild.
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      renderer.dispose()
      // Release the WebGL context now rather than at canvas GC time: browsers cap live
      // contexts and evict the oldest when the cap is hit, so a lingering disposed
      // context can get a healthy viewer's context killed.
      renderer.forceContextLoss()
      container.removeChild(renderer.domElement)
      sceneRef.current = null
      cameraRef.current = null
      orbitRef.current = null
      transformRef.current = null
      plateRootRef.current = null
      setSceneReady(false)
      groupByKey.clear()
      // Drop cached geometry; it is re-fetched if the editor is reopened. Values are
      // promises (in-flight dedupe), so dispose on settle; failures dispose nothing.
      for (const entry of geometryCache.values()) {
        entry.then((map) => { for (const geometry of map.values()) geometry.dispose() }).catch(() => {})
      }
      geometryCache.clear()
      for (const entry of importGeometryCache.values()) {
        entry.then((geometry) => geometry.dispose()).catch(() => {})
      }
      importGeometryCache.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerContainer, viewCubeContainer, contextGeneration])
}
