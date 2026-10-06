/**
 * Owns the editor's WebGL viewport: the renderer, scene, camera, orbit + transform
 * controls, the pointer/select/drag/paint handlers, frame drawing and validation inputs,
 * resize handling, and full disposal on teardown. `lib/editorFrameLoop.ts` schedules frames;
 * `lib/editorSecondarySelectionBoxes.ts` owns the extra-object and part outlines.
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
import { createEditorMeasurePicker, type MeasurePick } from './lib/editorMeasurePicking'
import { createEditorMeasureInteraction } from './lib/editorMeasureInteraction'
import { pickEditorInstanceGroup } from './lib/editorObjectPicking'
import { createEditorTextPointerInteraction } from './lib/editorTextPointerInteraction'
import { createEditorPaintPointerInteraction } from './lib/editorPaintPointerInteraction'
import { aimEditorPointerRay } from './lib/editorPointerRay'
export type { MeasurePick } from './lib/editorMeasurePicking'
import {
  createViewportCameraRig,
  installOrbitPivotBehavior,
  type OrbitPivotBounds
} from './lib/viewportCamera'
import { guardTouchOrbitTransition } from './lib/touchOrbitGesture'
import * as THREE from 'three'
import { createWebglRenderer } from './lib/webglRenderer'
import { OrbitControls, TransformControls } from 'three-stdlib'
import { hasActiveOverlayViewer } from './lib/overlayViewerHold'
import { disposeObject3D, type TrianglePaintChannel } from './lib/threeMfScene'
import { createEditorPaintRegionPreview } from './lib/editorPaintRegionPreview'
import {
  EDITOR_HOME_VIEW_DIRECTION as EDITOR_HOME_VIEW,
  createViewCube,
  type ViewPreset
} from './lib/viewCube'
import {
  createRotationSnapGuides,
  effectivePaintTool,
  syncBrimEarMarkerMatrices,
  syncScreenSpaceOverlays,
  updateHullFaceHighlight,
  allowsSelectionPicking,
  type GeometryCache,
  type GizmoMode,
  type ImportGeometryCache,
  type PaintToolType,
  type PlacementWarning,
  type TextInteraction
} from './editorGeometry'
import { renderSelectionOverlay } from './lib/selectionBox'
import { createEditorPrimarySelectionBox } from './lib/editorPrimarySelectionBox'
import { createEditorSecondarySelectionBoxes } from './lib/editorSecondarySelectionBoxes'
import { createCutConnectorHover } from './lib/editorCutConnectorPicking'
import { createPointerClaim } from './lib/pointerClaim'
import { installEditorHoverExit } from './lib/editorHoverExit'
import { installEditorRenderTriggers } from './lib/editorRenderTriggers'
import { installEditorOrbitActivity } from './lib/editorOrbitActivity'
import { configureEditorTransformGizmo } from './lib/editorTransformGizmo'
import { createEditorViewFraming } from './lib/editorViewFraming'
import { createEditorLitScene, createEditorSceneCamera } from './lib/editorSceneSetup'
import { createEditorTransformInteraction } from './lib/editorTransformInteraction'
import { createEditorBodyDrag } from './lib/editorBodyDrag'
import { createEditorPartDrag } from './lib/editorPartDrag'
import { createEditorPrimeTowerDrag } from './lib/editorPrimeTowerDrag'
import { createEditorSelectionClicks } from './lib/editorSelectionClicks'
import { placeObjectOnFace } from './lib/editorPlaceOnFace'
import { createEditorFrameLoop } from './lib/editorFrameLoop'
import { createEditorSceneRenderPass } from './lib/editorSceneRenderPass'
import { disposeEditorSceneCaches, releaseEditorWebglCanvas } from './lib/editorSceneCleanup'
import { handleEditorPointerHoverMove } from './lib/editorPointerHoverMove'
import { installEditorPointerListeners } from './lib/editorPointerListeners'
import { createEditorActiveDragMove, createEditorPointerRelease } from './lib/editorPointerGestures'
import { handleEditorPartPointerPress } from './lib/editorPartPointerPress'
import { handleEditorObjectPointerPress } from './lib/editorObjectPointerPress'
import { handleEditorPreselectionPress } from './lib/editorPreselectionPress'
import { handleEditorSelectedObjectPress } from './lib/editorSelectedObjectPress'
import { createEditorPaintStroke } from './lib/editorPaintStroke'
import { createEditorPaintPicker } from './lib/editorPaintPicking'
import { createEditorMeasureHover } from './lib/editorMeasureHover'
import { createEditorBrushHover } from './lib/editorBrushHover'
import { createEditorPlacementWarningRecompute, type PlacementFootprintCache } from './lib/editorPlacementWarnings'
import { createEditorPaintOverlayVisibility } from './lib/editorPaintOverlayVisibility'
import { installEditorWindowListeners } from './lib/editorWindowListeners'
import { createEditorViewportResize } from './lib/editorViewportResize'
import { installEditorContextRecovery } from './lib/editorContextRecovery'
import { type EditorInstance, type EditorPlate } from './lib/editorModel'
import { type PartRef, type PartSelection } from './lib/selectionModel'
import { type SupportPaintBrushMode } from './lib/supportPaint'

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
  bedBoundsRef: MutableRefObject<OrbitPivotBounds | null>
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
  footprintCacheRef: MutableRefObject<PlacementFootprintCache>
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
    bedBoundsRef,
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

    // A refused WebGL context returns above. Publish scene refs only after the renderer exists;
    // otherwise other editor effects can see a camera and scene that were never mounted.
    const { scene, plateRoot } = createEditorLitScene()
    const camera = createEditorSceneCamera(
      container.clientWidth,
      container.clientHeight,
      EDITOR_HOME_VIEW_DIRECTION
    )
    sceneRef.current = scene
    cameraRef.current = camera

    // The listener's cleanup must precede forceContextLoss during teardown below.
    const releaseContextRecovery = installEditorContextRecovery({
      canvas: renderer.domElement,
      lastRebuildRef: lastContextRebuildRef,
      onRebuild: () => setContextGeneration((generation) => generation + 1)
    })

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
    const releaseTouchOrbitGuard = guardTouchOrbitTransition(renderer.domElement, orbit)
    orbitRef.current = orbit
    // This camera is brand new at the generic home pose (target (0,0,20): the
    // front-left corner of a Bambu bed). Clear the framed-view latch so the next
    // plate build reframes it on the bed centre: a key latched by the previous
    // scene/camera would otherwise skip the reframe and leave the view stuck
    // zoomed at the plate corner. The fresh camera is also not user-adjusted.
    framedViewKeyRef.current = null
    userAdjustedViewRef.current = false
    // Once the user orbits/pans, stop auto-reframing the home view on resize.
    const releaseOrbitActivity = installEditorOrbitActivity(orbit, () => {
      userAdjustedViewRef.current = true
      interactionActiveRef.current = true
    }, () => { interactionActiveRef.current = false })

    plateRootRef.current = plateRoot
    setSceneReady(true)

    // Rotation snap-guide lines, shown around the selected object while rotating.
    const snapGuides = createRotationSnapGuides()
    snapGuides.visible = false
    scene.add(snapGuides)

    // The controller owns the primary outline's deferred precise fit and disposal.
    const primarySelectionBox = createEditorPrimarySelectionBox(scene)
    const setSelectionHighlight = primarySelectionBox.set
    setSelectionHighlightRef.current = setSelectionHighlight

    const secondarySelectionBoxes = createEditorSecondarySelectionBoxes(scene)

    // The rig animates the camera; the framing adapter supplies this editor's bed-centred policy.
    const cameraRig = createViewportCameraRig(camera, orbit, () => requestRenderRef.current?.())
    const { applyViewDirection, applyViewPreset, frameDefaultView } = createEditorViewFraming({
      camera,
      orbit,
      rig: cameraRig,
      getBedCenter: () => bedCenterRef.current,
      getViewDistance: () => viewDistanceRef.current,
      planeZ: ORBIT_PIVOT_PLANE_Z,
      homeDirection: EDITOR_HOME_VIEW_DIRECTION
    })
    applyViewPresetRef.current = applyViewPreset
    frameDefaultViewRef.current = frameDefaultView

    const viewCube = createViewCube(viewCubeContainer, ({ region, reframe }) => {
      applyViewDirection(region.direction, { reframe })
      viewCube.sync(camera)
    })

    const transform = new TransformControls(camera, renderer.domElement)
    const releaseTransformGizmo = configureEditorTransformGizmo(transform)

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
    const transformInteraction = createEditorTransformInteraction({
      transform,
      orbit,
      multiPivot,
      snapGuides,
      getSelectedKey: () => selectedKeyRef.current,
      getSelectedKeys: () => allSelectedKeysRef.current(),
      groupFor: (key) => groupByKeyRef.current.get(key) ?? null,
      getMode: () => gizmoModeRef.current,
      bakeExactMatrix: (group) => bakeExactMatrixRef.current(group),
      writeBackGroupTransform,
      writeBackPartMesh: (part) => writeBackPartMeshRef.current(part),
      syncSelectedTransform: (group) => syncSelectedTransformRef.current?.(group),
      setRotationReadout: (degrees) => setRotationReadoutRef.current?.(degrees),
      regenerateActiveThumbnail: () => regenerateActiveThumbnailRef.current?.(),
      recordHistory: () => recordHistoryRef.current?.(),
      setInteractionActive: (active) => { interactionActiveRef.current = active }
    })
    scene.add(transform as unknown as THREE.Object3D)
    transformRef.current = transform

    // ---- Click-to-select + body-drag move on the bed plane -------------------
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const bedPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const dragPoint = new THREE.Vector3()
    const bodyDrag = createEditorBodyDrag({
      getSelectedKeys: () => allSelectedKeysRef.current(),
      groupFor: (key) => groupByKeyRef.current.get(key) ?? null,
      bakeExactMatrix: (group) => bakeExactMatrixRef.current(group),
      recordHistory: () => recordHistoryRef.current?.(),
      writeBackGroupTransform,
      reseatPivot: transformInteraction.reseatPivot,
      throttledPanelSync: transformInteraction.throttledPanelSync,
      markTranslationDrag: transformInteraction.markTranslationDrag
    })
    const partDrag = createEditorPartDrag({
      recordHistory: () => recordHistoryRef.current?.(),
      writeBackPartMesh: (mesh) => writeBackPartMeshRef.current?.(mesh),
      reseatPivot: transformInteraction.reseatPivot
    })
    const towerDrag = createEditorPrimeTowerDrag({
      getBed: () => activePlateRef.current?.bed ?? null,
      commitPosition: (x, y) => { movePrimeTowerRef.current?.(x, y) }
    })
    const selectionClicks = createEditorSelectionClicks({
      selectExclusive: (key) => selectExclusiveRef.current(key),
      selectBakedPart: setGizmoPart
    })
    // Selectable geometry claims its primary pointer in the capture phase, before OrbitControls can
    // enter a rotate/pan state. Empty-space presses still reach OrbitControls unchanged.
    const selectedObjectPointer = createPointerClaim(renderer.domElement, orbit)

    const measureHover = createEditorMeasureHover(scene, () => measurePicksRef.current)
    const pickMeasureFeature = createEditorMeasurePicker({
      canvas: renderer.domElement,
      camera,
      pointer,
      raycaster,
      bedPlane,
      getGroups: () => groupByKeyRef.current.values(),
      getCentreTargets: () => measureCentreTargetsRef.current,
      getPicks: () => measurePicksRef.current,
      getHoveredSource: () => measureHover.source,
      getBed: () => activePlateRef.current?.bed
    })
    const measureInteraction = createEditorMeasureInteraction({
      pick: (event) => pickMeasureFeature(event, event.shiftKey),
      add: (picked) => addMeasurePointRef.current?.(picked),
      setHover: (picked, pointMode) => measureHover.update(picked, pointMode),
      hasHover: () => measureHover.feature !== null,
      clearHover: measureHover.clear
    })

    const aimPointerRay = (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => {
      aimEditorPointerRay(renderer.domElement, camera, pointer, raycaster, event)
    }

    const pickInstanceGroup = (event: PointerEvent): THREE.Group | null => {
      aimPointerRay(event)
      return pickEditorInstanceGroup(raycaster, groupByKeyRef.current)
    }


    const paintPicker = createEditorPaintPicker({
      canvas: renderer.domElement,
      camera,
      pointer,
      raycaster,
      getSelectedGroup: () => selectedKeyRef.current
        ? groupByKeyRef.current.get(selectedKeyRef.current) ?? null
        : null
    })

    const paintStroke = createEditorPaintStroke({
      getTool: () => {
        const channel = activePaintChannelRef.current
        return channel ? effectivePaintTool(channel, paintToolRef.current) : 'circle'
      },
      getTargets: paintPicker.targets,
      hitAt: paintPicker.hitAt,
      apply: (hit, phase, previousPoint) => {
        applyPaintStrokeRef.current?.(
          hit.mesh,
          hit.point,
          raycaster.ray.direction,
          hit.faceIndex,
          phase,
          previousPoint
        )
      }
    })

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
      aimPointerRay(event)
      return raycaster.intersectObject(mesh, false).length > 0
    }

    const textPointer = createEditorTextPointerInteraction({
      canvas: renderer.domElement,
      overText,
      hitOnSelected: paintPicker.hitOnSelected,
      recordHistory: () => { recordHistoryRef.current?.() },
      setInteractionActive: (active) => { interactionActiveRef.current = active },
      setOrbitEnabled: (enabled) => { orbit.enabled = enabled },
      setTextInteraction: (state) => { setTextInteractionRef.current(state) },
      placeTextAt: (point, normal, phase) => { placeTextAtRef.current?.(point, normal, phase) },
      regenerateThumbnail: () => { regenerateActiveThumbnailRef.current?.() }
    })

    // A region tool draws the same fill its next click would apply. The preview owns the temporary
    // overlay and is cleared before scene teardown; live settings stay in the editor refs.
    const paintRegionPreview = createEditorPaintRegionPreview({
      getSettings: () => ({
        tool: paintToolRef.current,
        mode: paintBrushModeRef.current,
        filamentId: paintColorFilamentIdRef.current,
        filamentColors: filamentColorsRef.current
      }),
      previewRegion: (mesh, faceIndex) => previewPaintRegionRef.current?.(mesh, faceIndex) ?? null
    })

    const brushHover = createEditorBrushHover({
      scene,
      regionPreview: paintRegionPreview,
      getSettings: () => ({
        brimEars: gizmoModeRef.current === 'brimEars',
        channel: activePaintChannelRef.current,
        tool: paintToolRef.current,
        mode: paintBrushModeRef.current,
        radius: paintBrushRadiusRef.current,
        brimEarDiameter: brimEarDiameterRef.current,
        filamentId: paintColorFilamentIdRef.current,
        filamentColors: filamentColorsRef.current
      })
    })
    const paintPointer = createEditorPaintPointerInteraction({
      canvas: renderer.domElement,
      stroke: paintStroke,
      hitOnSelected: paintPicker.hitOnSelected,
      updateHover: brushHover.update,
      hoverVisible: () => brushHover.visible,
      clearHover: brushHover.clear,
      recordHistory: () => { recordHistoryRef.current?.() },
      setInteractionActive: (active) => { interactionActiveRef.current = active },
      setOrbitEnabled: (enabled) => { orbit.enabled = enabled },
      regenerateThumbnail: () => { regenerateActiveThumbnailRef.current?.() },
      paintCommitted: () => { paintCommittedRef.current?.() }
    })
    const cutConnectorHover = createCutConnectorHover({
      canvas: renderer.domElement,
      camera,
      pointer,
      raycaster,
      isActive: () => gizmoModeRef.current === 'cut' && cutConnectorModeRef.current,
      getSection: () => cutConnectorTargetsRef.current.section,
      showHover: (point) => hoverCutConnectorRef.current?.(point)
    })

    const onPointerDown = (event: PointerEvent) => {
      const gizmoControl = transform as unknown as { axis?: string | null }
      if (handleEditorPreselectionPress({
        event,
        mode: gizmoModeRef.current,
        gizmoAxis: gizmoControl.axis,
        cutConnectorMode: cutConnectorModeRef.current,
        cutConnectorTargets: cutConnectorTargetsRef.current,
        editCutConnector: (edit) => editCutConnectorsRef.current?.(edit),
        getSelectedGroup: () => selectedKeyRef.current
          ? groupByKeyRef.current.get(selectedKeyRef.current) ?? null
          : null,
        hitOnSelected: paintPicker.hitOnSelected,
        editBrimEar: (edit) => editSelectedBrimEarsRef.current?.(edit),
        beginMeasure: measureInteraction.begin,
        beginPaint: paintPointer.begin,
        beginText: textPointer.begin,
        tower: primeTowerObjRef.current,
        beginTowerDrag: towerDrag.begin,
        aimPointerRay,
        raycaster,
        bedPlane,
        dragPoint,
        canvas: renderer.domElement,
        orbit
      })) return

      const group = pickInstanceGroup(event)
      if (handleEditorObjectPointerPress({
        event,
        group,
        selectedKey: selectedKeyRef.current,
        extraSelectedKeys: extraSelectedKeysRef.current,
        getMode: () => gizmoModeRef.current,
        setMode: (mode) => setGizmoModeRef.current(mode),
        beginEmptyClick: selectionClicks.beginEmpty,
        beginCollapseClick: selectionClicks.beginCollapse,
        toggleAdditiveSelection: (key) => toggleAdditiveSelectionRef.current(key),
        selectExclusive: (key) => selectExclusiveRef.current(key),
        raycaster,
        bedPlane,
        dragPoint,
        resetPanelSync: transformInteraction.resetPanelSync,
        beginBodyDrag: bodyDrag.begin,
        beginCoDrag: bodyDrag.beginCoDrag,
        canvas: renderer.domElement,
        orbit
      })) return
      if (!group) return
      const key = group.userData.instanceKey

      if (handleEditorPartPointerPress({
        group,
        instanceKey: key,
        event,
        mode: gizmoModeRef.current,
        raycaster,
        bedPlane,
        dragPoint,
        canvas: renderer.domElement,
        orbit,
        findInstance: (instanceKey) => activePlateRef.current?.instances.find((entry) => entry.key === instanceKey),
        extraSelectionCount: extraSelectedKeysRef.current.length,
        selectedPart: gizmoPartRef.current,
        selectPart: setGizmoPart,
        beginBakedPart: selectionClicks.beginBakedPart,
        beginAddedPartDrag: partDrag.begin
      })) return

      handleEditorSelectedObjectPress({
        event,
        group,
        instanceKey: key,
        mode: gizmoModeRef.current,
        aimPointerRay,
        raycaster,
        faceHull: faceHullRef.current,
        placeOnFace: (hit) => placeObjectOnFace({
          group,
          hit,
          recordHistory: () => { recordHistoryRef.current?.() },
          bakeExactMatrix: (target) => { bakeExactMatrixRef.current(target) },
          writeBackGroupTransform
        }),
        afterPlaceOnFace: () => {
          syncSelectedTransformRef.current?.(group)
          regenerateActiveThumbnailRef.current?.()
          rebuildFaceHullRef.current()
        },
        bedPlane,
        dragPoint,
        resetPanelSync: transformInteraction.resetPanelSync,
        beginBodyDrag: bodyDrag.begin,
        beginCoDrag: bodyDrag.beginCoDrag,
        canvas: renderer.domElement,
        orbit
      })
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

    const moveActiveDrag = createEditorActiveDragMove({
      isBodyActive: () => bodyDrag.active,
      isPartActive: () => partDrag.active,
      isTowerActive: () => towerDrag.active,
      aimPointerRay,
      raycaster,
      bedPlane,
      dragPoint,
      moveTower: towerDrag.move,
      movePart: partDrag.move,
      moveBody: bodyDrag.move,
      onBodyDragMove: selectionClicks.onBodyDragMove
    })

    const onPointerMove = (event: PointerEvent) => {
      handleEditorPointerHoverMove({
        event,
        mode: gizmoModeRef.current,
        moveText: textPointer.move,
        updateCutHover: cutConnectorHover.update,
        movePaint: paintPointer.move,
        updateMeasureHover: measureInteraction.updateHover,
        faceHull: faceHullRef.current,
        aimPointerRay,
        raycaster,
        highlightFace: updateHullFaceHighlight,
        moveActiveDrag
      })
    }

    const endBodyDrag = createEditorPointerRelease({
      canvas: renderer.domElement,
      orbit,
      releaseSelectionClaim: selectedObjectPointer.release,
      finishMeasure: measureInteraction.finish,
      finishText: textPointer.finish,
      finishPaint: paintPointer.finish,
      finishSelectionClick: selectionClicks.finish,
      clearBodyPeers: bodyDrag.clearPeers,
      finishTower: towerDrag.finish,
      finishPart: partDrag.finish,
      finishBody: bodyDrag.finish,
      syncSelectedTransform: (target) => syncSelectedTransformRef.current?.(target),
      regenerateThumbnail: () => regenerateActiveThumbnailRef.current?.()
    })

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const group = pickInstanceGroup(event as unknown as PointerEvent)
      const key = group ? (group.userData.instanceKey as string) : null
      openContextMenuRef.current(key ? { x: event.clientX, y: event.clientY, key } : null)
    }

    const pointerListeners = installEditorPointerListeners(renderer.domElement, {
      claimSelectedObjectPointer,
      onPointerDown,
      onPointerMove,
      endBodyDrag,
      onContextMenu,
      installOrbitPivot: () => installOrbitPivotBehavior(
        renderer.domElement,
        orbit,
        cameraRig,
        () => bedBoundsRef.current
          ? { planeZ: ORBIT_PIVOT_PLANE_Z, bounds: bedBoundsRef.current }
          : null
      ),
      // A pointer can leave without another move, so clear previews on exit.
      installHoverExit: () => installEditorHoverExit(renderer.domElement, {
        clearBrushHover: brushHover.clear,
        clearMeasureHover: measureHover.clear,
        clearFaceHighlight: () => {
          const hull = faceHullRef.current
          if (hull) updateHullFaceHighlight(hull, null)
        },
        requestRender: () => requestRenderRef.current?.()
      })
    })

    // On-demand rendering. The viewport used to `renderer.render()` every frame at 60fps even when
    // nothing changed, pinning the GPU at 60-70% while the editor just sat open. Now a frame is
    // painted only when something actually needs it: `needsRender` (set on a camera move, a React
    // commit via requestRenderRef, or pointer motion over the canvas), an in-progress interaction
    // (smooth drags), the drag-end edge, or a low-rate safety tick that repaints anything an
    // un-instrumented mutation might have missed. 250ms is imperceptible on a static scene but drops
    // idle cost from 60fps to ~4fps. The rAF loop itself keeps running so orbit damping still
    // advances and the safety net stays alive.
    const paintOverlayVisibility = createEditorPaintOverlayVisibility({
      getGroups: () => groupByKeyRef.current,
      getState: () => ({
        activeChannel: activePaintChannelRef.current,
        selectedKey: selectedKeyRef.current,
        layersEditing: gizmoModeRef.current === 'layerHeight'
      })
    })
    // The viewport owns WHEN placement warnings run; the controller owns cache invalidation and
    // live-scene reads. The plate-build effect also invokes this callback after a rebuild.
    const runPlacementWarningRecompute = createEditorPlacementWarningRecompute({
      activePlateRef,
      groupByKeyRef,
      isInstancePrintedRef,
      instanceNozzlesRef,
      footprintCacheRef,
      primeTowerObjRef,
      lastWarningSigRef,
      placementWarningsSetterRef
    })
    recomputeWarningsRef.current = runPlacementWarningRecompute
    const renderScene = createEditorSceneRenderPass({
      syncPaintOverlays: paintOverlayVisibility.sync,
      updatePrimarySelection: (interacting, dragJustEnded) => primarySelectionBox.update({
        interacting,
        dragJustEnded,
        changedOrientation: transformInteraction.changedOrientation
      }),
      syncBrimEarMarkers: () => {
        // Markers carry baked world matrices, so each moved instance must refresh them before draw.
        for (const group of groupByKeyRef.current.values()) syncBrimEarMarkerMatrices(group)
      },
      syncSecondarySelections: () => secondarySelectionBoxes.sync({
        extraKeys: extraSelectedKeysRef.current,
        groups: groupByKeyRef.current,
        partSelection: partSelectionRef.current,
        gizmoPart: gizmoPartRef.current,
        instances: activePlateRef.current?.instances ?? [],
        primaryOwner: primarySelectionBox.visibleOwner()
      }),
      // Screen-sized annotations must use this frame's camera, including a still-tweening view.
      syncScreenAnnotations: () => syncScreenSpaceOverlays(scene, camera, renderer.domElement.clientHeight),
      renderScene: () => renderer.render(scene, camera),
      hasSecondarySelections: () => secondarySelectionBoxes.active,
      renderSelectionOutlines: () => renderSelectionOverlay(renderer, scene, camera),
      syncViewCube: () => viewCube.sync(camera)
    })
    const frameLoop = createEditorFrameLoop({
      // The 3D preview covers this canvas, so pause all per-frame work until it closes.
      isCovered: hasActiveOverlayViewer,
      advanceCamera: (now) => {
        // The camera swing must advance before OrbitControls derives its spherical state.
        const tweening = cameraRig.advance(now)
        // OrbitControls.lookAt would undo the swing's roll while it is in flight.
        if (!tweening) orbit.update()
        return tweening
      },
      isInteracting: () => transformInteraction.isDragging || bodyDrag.active || towerDrag.active,
      render: renderScene,
      recomputePlacementWarnings: runPlacementWarningRecompute
    })
    const requestRender = frameLoop.requestRender
    requestRenderRef.current = requestRender
    const releaseRenderTriggers = installEditorRenderTriggers(renderer.domElement, orbit, requestRender)
    frameLoop.start()

    const onResize = createEditorViewportResize({
      container,
      renderer,
      camera,
      userAdjusted: () => userAdjustedViewRef.current,
      frameDefaultView: () => frameDefaultViewRef.current?.(),
      requestRender
    })
    const releaseWindowListeners = installEditorWindowListeners({
      container,
      onResize,
      suppressEditorEscapeRef
    })

    return () => {
      frameLoop.dispose()
      // Drop the forced-recompute hook so a post-teardown call can't touch the disposed scene.
      recomputeWarningsRef.current = () => undefined
      releaseWindowListeners()
      // Take the owner layer back off the meshes: the scene outlives this effect across a rebuild,
      // so a stale owner would keep writing depth for an outline that no longer exists.
      secondarySelectionBoxes.dispose()
      requestRenderRef.current = null
      releaseRenderTriggers()
      releaseTouchOrbitGuard()
      pointerListeners.releaseOrbitPivot()
      cameraRig.dispose()
      pointerListeners.releaseCanvasListeners()
      textPointer.reset()
      paintPointer.reset()
      selectedObjectPointer.dispose()
      transformInteraction.dispose()
      transform.detach()
      releaseTransformGizmo()
      transform.dispose()
      releaseOrbitActivity()
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
      measureHover.dispose()
      measureInteraction.reset()
      brushHover.dispose()
      cutConnectorHover.dispose()
      disposeObject3D(plateRoot)
      scene.remove(plateRoot)
      scene.remove(transform as unknown as THREE.Object3D)
      scene.remove(multiPivot)
      if (multiPivotRef.current === multiPivot) multiPivotRef.current = null
      releaseEditorWebglCanvas({ releaseContextRecovery, renderer, container })
      sceneRef.current = null
      cameraRef.current = null
      orbitRef.current = null
      transformRef.current = null
      plateRootRef.current = null
      setSceneReady(false)
      groupByKey.clear()
      disposeEditorSceneCaches(geometryCache, importGeometryCache)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerContainer, viewCubeContainer, contextGeneration])
}
