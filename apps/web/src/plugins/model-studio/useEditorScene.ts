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
 * themselves (scene/camera/orbit/transform/plateRoot/...) stay declared in EditorView —
 * other code reads them — and are threaded in here as params.
 */
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import * as THREE from 'three'
import { OrbitControls, TransformControls } from 'three-stdlib'
import { hasActiveOverlayViewer } from './lib/overlayViewerHold'
import { disposeObject3D, type TrianglePaintChannel } from './lib/threeMfScene'
import {
  EDITOR_HOME_VIEW_DIRECTION as EDITOR_HOME_VIEW,
  VIEW_PRESET_CONFIG,
  createViewCube,
  type ViewPreset
} from './lib/viewCube'
import {
  BRIM_EAR_MARKER_COLOR,
  BRIM_EAR_MARKER_NAME,
  computeFootprintCells,
  computePlacementWarnings,
  createRotationSnapGuides,
  DOWN_VECTOR,
  effectivePaintTool,
  footprintHitsExcludeZones,
  groupShapeSignature,
  ISO_UP,
  PAINT_CHANNEL_SPECS,
  paintChannelForGizmoMode,
  printableMeshBox,
  restObjectOnBed,
  rotorOf,
  selectionBoxSignature,
  syncBrimEarMarkerMatrices,
  updateHullFaceHighlight,
  type GeometryCache,
  type GizmoMode,
  type ImportGeometryCache,
  type PaintToolType,
  type PlacementWarning
} from './editorGeometry'
import { FOOTPRINT_CELL_MM, shiftFootprintCells } from './lib/arrange'
import { type EditorInstance, type EditorPlate } from './lib/editorModel'
import { type PartSelection } from './lib/selectionModel'
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
 * Editor default camera direction (offset from the bed centre to the camera): mostly
 * top-down but tilted toward the front, similar to Bambu Studio's prepare view.
 */
// Shared with the read-only G-code preview so both open at the same angle (see viewCube.ts).
const EDITOR_HOME_VIEW_DIRECTION = new THREE.Vector3(EDITOR_HOME_VIEW.x, EDITOR_HOME_VIEW.y, EDITOR_HOME_VIEW.z).normalize()

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
  interactionActiveRef: MutableRefObject<boolean>
  // Selection.
  selectedKeyRef: MutableRefObject<string | null>
  extraSelectedKeysRef: MutableRefObject<ReadonlyArray<string>>
  /** Selected PARTS of one object (BambuStudio volume-mode) — drives per-part highlight boxes. */
  partSelectionRef: MutableRefObject<PartSelection | null>
  allSelectedKeysRef: MutableRefObject<() => string[]>
  selectExclusiveRef: MutableRefObject<(key: string | null) => void>
  toggleAdditiveSelectionRef: MutableRefObject<(key: string) => void>
  selectedAddedPartKeyRef: MutableRefObject<string | null>
  /** Existing baked part currently holding the gizmo (counterpart of selectedAddedPartKey). */
  selectedBakedPartRef: MutableRefObject<{ objectId: number; componentObjectId: number } | null>
  setSelectedBakedPart: Dispatch<SetStateAction<{ objectId: number; componentObjectId: number } | null>>
  setSelectionHighlightRef: MutableRefObject<((group: THREE.Object3D | null) => void) | null>
  // Gizmo + transform write-back.
  gizmoModeRef: MutableRefObject<GizmoMode>
  setGizmoModeRef: MutableRefObject<Dispatch<SetStateAction<GizmoMode>>>
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
    phase: 'down' | 'move'
  ) => void>
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
  addMeasurePointRef: MutableRefObject<((point: { x: number; y: number; z: number }) => void) | null>
  recordHistoryRef: MutableRefObject<() => void>
  regenerateActiveThumbnailRef: MutableRefObject<(() => void) | null>
  /** Rebuild the place-on-face hull after a lay-flat re-orients the part (the hull bakes orientation). */
  rebuildFaceHullRef: MutableRefObject<() => void>
  openContextMenuRef: MutableRefObject<(menu: { x: number; y: number; key: string } | null) => void>
  suppressEditorEscapeRef: MutableRefObject<boolean>
  // Plain React values/setters/callbacks read by the effect.
  setSceneReady: Dispatch<SetStateAction<boolean>>
  setSelectedAddedPartKey: Dispatch<SetStateAction<string | null>>
  writeBackGroupTransform: (object: THREE.Object3D) => void
}

/**
 * Initialize renderer/camera/controls once a container exists, and own them for the
 * viewport's lifetime. The effect deliberately depends only on the containers and the
 * context-loss rebuild counter — never on the live editor values, which arrive as
 * stable refs through {@link EditorSceneParams} — so the renderer and its listeners
 * are built once and never torn down and rebuilt on an ordinary EditorView re-render.
 */
export function useEditorScene(params: EditorSceneParams): void {
  // Bumped after a lost WebGL context to rebuild the whole scene rig (the content effects
  // re-seed the plate when sceneReady cycles). Rate-capped in the loss handler.
  const [contextGeneration, setContextGeneration] = useState(0)
  const lastContextRebuildRef = useRef(0)
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
    selectedKeyRef,
    extraSelectedKeysRef,
    partSelectionRef,
    allSelectedKeysRef,
    selectExclusiveRef,
    toggleAdditiveSelectionRef,
    selectedAddedPartKeyRef,
    selectedBakedPartRef,
    setSelectedBakedPart,
    setSelectionHighlightRef,
    gizmoModeRef,
    setGizmoModeRef,
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
    recordHistoryRef,
    regenerateActiveThumbnailRef,
    rebuildFaceHullRef,
    openContextMenuRef,
    suppressEditorEscapeRef,
    setSceneReady,
    setSelectedAddedPartKey,
    writeBackGroupTransform
  } = params

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
    // coplanar surfaces — e.g. SVG/text parts resting flush on a backdrop, or stacked
    // duplicate parts — don't z-fight into a flickering, semi-transparent mess across the
    // wide 0.1..5000 depth range the bed + gizmos need.
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
    // Cap DPR at 2 (like the view cube): on a 3x-DPR phone or 4K display the
    // editor's AA + log-depth + 2048² shadow + always-on loop would otherwise
    // render ~9x the fragments — a large mobile GPU/battery/thermal cost.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)

    // A reclaimed WebGL context (GPU pressure, driver reset) leaves the canvas permanently
    // black. Rebuild the scene once by re-running this effect via contextGeneration — but
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
    orbit.target.set(0, 0, 20)
    orbit.update()
    orbitRef.current = orbit
    // This camera is brand new at the generic home pose (target (0,0,20) — the
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
    const selectionBoxValue = new THREE.Box3()
    const setSelectionHighlight = (group: THREE.Object3D | null) => {
      selectionTarget = group
      if (selectionBox) {
        scene.remove(selectionBox)
        selectionBox.geometry.dispose()
        ;(selectionBox.material as THREE.Material).dispose()
        selectionBox = null
      }
      if (group) {
        // Cheap (transformed-AABB) box on selection: the precise per-vertex walk froze selecting a
        // many-part high-poly object for a beat — the hitch when you drag an object that wasn't
        // already selected (the pointer-down selects it first). It is exact for an axis-aligned
        // object and only loosens slightly around a reoriented one, and the box is visual-only.
        selectionBoxValue.copy(printableMeshBox(group, false))
        selectionBoxSig = selectionBoxSignature(group)
        selectionBox = new THREE.Box3Helper(selectionBoxValue, new THREE.Color(0x35e07f))
        const material = selectionBox.material as THREE.LineBasicMaterial
        material.depthTest = false
        material.transparent = true
        selectionBox.renderOrder = 4
        scene.add(selectionBox)
      }
    }
    setSelectionHighlightRef.current = setSelectionHighlight

    // Dimmer outline boxes for the EXTRA selected instances (multi-select). Synced
    // every frame in animate() — membership from the ref, bounds via the cheap
    // transformed-AABB path so co-drags track without per-vertex walks.
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
          helper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x2c9e63))
          const material = helper.material as THREE.LineBasicMaterial
          material.depthTest = false
          material.transparent = true
          material.opacity = 0.7
          helper.renderOrder = 4
          extraSelectionBoxes.set(key, helper)
          scene.add(helper)
        }
        helper.box.copy(printableMeshBox(group, false))
      }
    }

    // Bright outline boxes around the SELECTED PARTS (part selection is geometry-level,
    // so the part lights up on every instance of the owning object on the plate). Synced
    // every frame like the extras; part groups are found by the partRef tag the plate
    // build stamps on them, and bounds use the group's transformed AABB (cheap path).
    const partSelectionBoxes = new Map<string, THREE.Box3Helper>()
    const syncPartSelectionBoxes = () => {
      // The bulk part selection, or the single baked part currently holding the gizmo.
      const baked = selectedBakedPartRef.current
      const selection = partSelectionRef.current
        ?? (baked ? { objectId: baked.objectId, componentObjectIds: [baked.componentObjectId] } : null)
      const wanted = new Map<string, THREE.Object3D>()
      if (selection) {
        for (const instance of activePlateRef.current?.instances ?? []) {
          const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
          if (ownerId !== selection.objectId) continue
          const group = groupByKeyRef.current.get(instance.key)
          if (!group) continue
          group.traverse((node) => {
            const ref = node.userData.partRef as { componentObjectId: number } | undefined
            if (ref && selection.componentObjectIds.includes(ref.componentObjectId)) {
              wanted.set(`${instance.key}:${ref.componentObjectId}`, node)
            }
          })
        }
      }
      for (const [key, helper] of partSelectionBoxes) {
        if (!wanted.has(key)) {
          scene.remove(helper)
          helper.geometry.dispose()
          ;(helper.material as THREE.Material).dispose()
          partSelectionBoxes.delete(key)
        }
      }
      for (const [key, partGroup] of wanted) {
        let helper = partSelectionBoxes.get(key)
        if (!helper) {
          helper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x35e07f))
          const material = helper.material as THREE.LineBasicMaterial
          material.depthTest = false
          material.transparent = true
          helper.renderOrder = 4
          partSelectionBoxes.set(key, helper)
          scene.add(helper)
        }
        helper.box.setFromObject(partGroup)
      }
    }

    // Frame the camera on the bed centre using a Bambu-style view preset.
    const applyViewPreset = (preset: ViewPreset) => {
      const config = VIEW_PRESET_CONFIG[preset]
      const distance = viewDistanceRef.current
      const target = new THREE.Vector3(bedCenterRef.current.x, bedCenterRef.current.y, 20)
      camera.up.set(config.up.x, config.up.y, config.up.z)
      camera.position.set(
        target.x + distance * config.direction.x,
        target.y + distance * config.direction.y,
        target.z + distance * config.direction.z
      )
      camera.lookAt(target)
      orbit.target.copy(target)
      orbit.update()
    }
    applyViewPresetRef.current = applyViewPreset

    // Default framing: bed-centred, mostly top-down but tilted to the front (Bambu-like).
    const frameDefaultView = () => {
      const distance = viewDistanceRef.current
      const target = new THREE.Vector3(bedCenterRef.current.x, bedCenterRef.current.y, 20)
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

    const viewCube = createViewCube(viewCubeContainer, (preset) => {
      applyViewPreset(preset)
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
    const transformEvents = transform as unknown as TransformControlsEvents
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
    // Did the drag that just ended change the object's ORIENTATION (rotate/scale)? A pure move keeps
    // the object axis-aligned, so its cheap transformed-AABB selection box is already exact — only a
    // rotate/scale needs the expensive per-vertex precise walk on the drop frame. Without this, every
    // drop of a high-poly / many-part object re-walked all vertices and froze for a beat.
    let lastDragChangedOrientation = false
    const throttledPanelSync = (group: THREE.Object3D) => {
      panelSyncTick += 1
      if (panelSyncTick % PANEL_SYNC_EVERY === 0) syncSelectedTransformRef.current?.(group)
    }

    /** The part the gizmo is attached to: an added part volume's mesh or a baked part's group. */
    const attachedPartMesh = (): THREE.Object3D | null => {
      const target = (transform as unknown as { object?: THREE.Object3D }).object
      return target && (typeof target.userData.addedPartKey === 'string' || target.userData.partRef != null) ? target : null
    }

    // Extras co-moved by the TRANSLATE gizmo (multi-select): per-group offsets from the
    // primary, captured at drag start.
    let gizmoCoDrag: Array<{ group: THREE.Group; dx: number; dy: number }> = []
    const beginGizmoCoDrag = () => {
      gizmoCoDrag = []
      const primaryKey = selectedKeyRef.current
      const primary = primaryKey ? groupByKeyRef.current.get(primaryKey) : null
      if (!primary || gizmoModeRef.current !== 'translate') return
      for (const key of extraSelectedKeysRef.current) {
        const group = groupByKeyRef.current.get(key)
        if (group) {
          // Bake a shearing co-dragged object first so its exactMatrix is cleared (the gizmo co-move
          // would otherwise be discarded on save) and group.position is valid to offset from.
          bakeExactMatrixRef.current(group)
          gizmoCoDrag.push({ group, dx: group.position.x - primary.position.x, dy: group.position.y - primary.position.y })
        }
      }
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
        // Snap a shearing object to editable T·S·R before the drag (it rendered an exact matrix
        // with matrixAutoUpdate off, which the gizmo can't move).
        const outerForBake = selectedOuterGroup()
        if (outerForBake) bakeExactMatrixRef.current(outerForBake)
        beginGizmoCoDrag()
      } else {
        gizmoCoDrag = []
      }
      // Added part volumes transform freely inside their object: no bed rest, no
      // group write-back — just persist the part's object-local placement.
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
            // frame (see onObjectChange) so this is a no-op for scale — no release jump.
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
    // single coloured axis) is used — TransformControls computes scale from the pointer
    // delta, not the object's position, so adjusting z here doesn't perturb the drag.
    const onObjectChange = () => {
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
      // Translate moves the whole multi-selection, preserving relative spacing.
      for (const extra of gizmoCoDrag) {
        extra.group.position.x = outer.position.x + extra.dx
        extra.group.position.y = outer.position.y + extra.dy
        writeBackGroupTransform(extra.group)
      }
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
    let bakedPartClickCandidate: { part: { objectId: number; componentObjectId: number }; x: number; y: number } | null = null
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
      // A body drag only translates, so the drop frame can keep the cheap (exact-for-translation)
      // selection box instead of re-walking every vertex.
      lastDragChangedOrientation = false
    }
    let towerDragObject: THREE.Object3D | null = null
    // Pointer-down position on empty space; deselect only happens on pointer-up if the
    // pointer barely moved (a click), so dragging to orbit keeps the selection + tool.
    let emptyPointerDown: { x: number; y: number } | null = null
    // Pointer-down position while the measure tool is active; a motionless release
    // places a measurement point, a drag orbits the camera as usual.
    let measureClickStart: { x: number; y: number } | null = null

    /**
     * Pick a measurement point under the cursor: the nearest mesh-surface hit
     * (snapped to a triangle corner within MEASURE_SNAP_PX, Bambu-style), falling
     * back to the bed plane near the plate.
     */
    const pickMeasurePoint = (event: PointerEvent): THREE.Vector3 | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const targets = Array.from(groupByKeyRef.current.values())
      const hit = raycaster.intersectObjects(targets, true)
        .find((entry) => entry.face && (entry.object as THREE.Mesh).isMesh && entry.object.name !== BRIM_EAR_MARKER_NAME)
      if (hit?.face) {
        const mesh = hit.object as THREE.Mesh
        const position = mesh.geometry.getAttribute('position')
        let snapped: THREE.Vector3 | null = null
        let snappedPx = MEASURE_SNAP_PX
        for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
          const vertex = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld)
          const projected = vertex.clone().project(camera)
          const px = rect.left + ((projected.x + 1) / 2) * rect.width
          const py = rect.top + ((1 - projected.y) / 2) * rect.height
          const distancePx = Math.hypot(px - event.clientX, py - event.clientY)
          if (distancePx < snappedPx) {
            snappedPx = distancePx
            snapped = vertex
          }
        }
        return snapped ?? hit.point.clone()
      }
      const bedPoint = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(bedPlane, bedPoint)) return null
      const bed = activePlateRef.current?.bed
      if (bed && (bedPoint.x < bed.minX - 5 || bedPoint.x > bed.maxX + 5
        || bedPoint.y < bed.minY - 5 || bedPoint.y > bed.maxY + 5)) return null
      return bedPoint
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
    const brushCursor = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 40),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide })
    )
    brushCursor.visible = false
    brushCursor.renderOrder = 6
    scene.add(brushCursor)
    // Sphere-brush cursor: a translucent ball CENTERED on the hit point, conveying the brush's 3D
    // reach (it paints every triangle within `radius` in 3D, wrapping around curves) — distinct from
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

    /** Raycast the selected instance's paintable (printed-part) meshes. */
    const paintHitOnSelected = (event: PointerEvent): { mesh: THREE.Mesh; point: THREE.Vector3; normal: THREE.Vector3; faceIndex: number | null } | null => {
      const selectedGroup = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
      if (!selectedGroup) return null
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const meshes: THREE.Mesh[] = []
      selectedGroup.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh && mesh.userData.supportPaintPart) meshes.push(mesh)
      })
      const hit = raycaster.intersectObjects(meshes, false).find((entry) => entry.face)
      if (!hit?.face) return null
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      return { mesh: hit.object as THREE.Mesh, point: hit.point, normal, faceIndex: hit.faceIndex ?? null }
    }

    const updateBrushCursor = (hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null) => {
      if (!hit) {
        brushCursor.visible = false
        brushSphereCursor.visible = false
        return
      }
      const earMode = gizmoModeRef.current === 'brimEars'
      const mode = paintBrushModeRef.current
      const channel = activePaintChannelRef.current
      // Fill/triangle/height pick faces rather than sweep a radius: no brush cursor. The sphere tool
      // gets a ball cursor; everything else with a radius (circle/cylinder, brim ears) gets the ring.
      let useSphere = false
      if (!earMode && channel) {
        const tool = effectivePaintTool(channel, paintToolRef.current)
        if (tool !== 'circle' && tool !== 'sphere') {
          brushCursor.visible = false
          brushSphereCursor.visible = false
          return
        }
        useSphere = tool === 'sphere'
      }
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
      // drags still orbit); nothing else — selection and drags are suspended.
      if (gizmoModeRef.current === 'measure') {
        measureClickStart = { x: event.clientX, y: event.clientY }
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
          updateBrushCursor(hit)
          return
        }
      }

      // Drag the prime tower if it was clicked (it isn't a selectable instance).
      const tower = primeTowerObjRef.current
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

      // Plain click on a multi-selection MEMBER keeps the selection (so the drag below
      // moves the whole set); a motionless release collapses to just that object. Tools
      // other than Move collapse immediately — they operate on a single primary.
      if (typeof key === 'string' && wasExtra) {
        if (gizmoModeRef.current !== 'translate') {
          selectExclusiveRef.current(key)
          return
        }
        collapseClickCandidate = { key, x: event.clientX, y: event.clientY }
        if (raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
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

      // Clicking a not-yet-selected object only selects it and falls back to Move,
      // so an active Rotate/Scale/Place-on-face tool is never applied by accident.
      if (!wasSelected) {
        setGizmoModeRef.current('translate')
        if (raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
          panelSyncTick = 0
          beginBodyDrag(group)
          orbit.enabled = false
          renderer.domElement.setPointerCapture(event.pointerId)
        }
        return
      }

      // Clicking an added part volume of the selected object hands it the gizmo;
      // clicking the object's body while a part is selected returns to the object.
      if (gizmoModeRef.current === 'translate' || gizmoModeRef.current === 'rotate' || gizmoModeRef.current === 'scale') {
        const hits = raycaster.intersectObject(group, true)
        const firstMesh = hits.find((hit) => (hit.object as THREE.Mesh).isMesh && hit.object.name !== BRIM_EAR_MARKER_NAME)
        const partKey = firstMesh?.object.userData.addedPartKey
        if (typeof partKey === 'string') {
          // Select (or keep) the part; its movement happens via the gizmo only, so
          // never fall through to the object body-drag.
          setSelectedBakedPart(null)
          setSelectedAddedPartKey(partKey)
          return
        }
        if (selectedAddedPartKeyRef.current) setSelectedAddedPartKey(null)
        // BambuStudio drill-down: a MOTIONLESS click on an already-selected multi-part
        // object selects the baked part under the cursor (resolved on pointer-up, so a
        // drag still moves the whole object). Single-part objects stay object-level.
        const partRef = firstMesh?.object.parent?.userData.partRef as { componentObjectId: number } | undefined
        if (partRef && extraSelectedKeysRef.current.length === 0) {
          const instance = activePlateRef.current?.instances.find((entry) => entry.key === key)
          if (instance && instance.source.kind === 'object' && instance.parts.length > 1) {
            bakedPartClickCandidate = {
              part: { objectId: instance.objectId, componentObjectId: partRef.componentObjectId },
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
          // so its rotor/position edits are ignored until baked to editable T·S·R — without this,
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
          // The hull bakes the part's orientation, so rebuild it for the new pose — otherwise the
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

    const onPointerMove = (event: PointerEvent) => {
      if (paintChannelForGizmoMode(gizmoModeRef.current) !== null || gizmoModeRef.current === 'brimEars') {
        const hit = paintHitOnSelected(event)
        updateBrushCursor(hit)
        if (paintingStroke) {
          if (hit) applyPaintStrokeRef.current?.(hit.mesh, hit.point, raycaster.ray.direction, hit.faceIndex, 'move')
          return
        }
      } else if (brushCursor.visible || brushSphereCursor.visible) {
        brushCursor.visible = false
        brushSphereCursor.visible = false
      }
      // Place-on-face: highlight the hull face under the pointer so the user sees exactly which
      // face they'll lay flat before clicking. (Hover only — selection still happens on pointerdown.)
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
      if (!bodyDragGroup && !towerDragObject) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      if (!raycaster.ray.intersectPlane(bedPlane, dragPoint)) return
      if (towerDragObject) {
        // Keep the tower's whole footprint on the bed AND out of unprintable zones — Bambu never
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
      // A real drag is no longer a collapse-to-single click.
      if (collapseClickCandidate) {
        const moved = Math.hypot(event.clientX - collapseClickCandidate.x, event.clientY - collapseClickCandidate.y)
        if (moved >= 5) collapseClickCandidate = null
      }
      throttledPanelSync(bodyDragGroup)
    }

    const endBodyDrag = (event: PointerEvent) => {
      if (measureClickStart) {
        const start = measureClickStart
        measureClickStart = null
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) {
          const point = pickMeasurePoint(event)
          if (point) addMeasurePointRef.current?.({ x: point.x, y: point.y, z: point.z })
        }
        return
      }
      if (paintingStroke) {
        paintingStroke = false
        interactionActiveRef.current = false
        orbit.enabled = true
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId)
        }
        regenerateActiveThumbnailRef.current?.()
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
        if (moved < 5) {
          setSelectedAddedPartKey(null)
          setSelectedBakedPart(bakedPartClickCandidate.part)
        }
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

    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', endBodyDrag)
    renderer.domElement.addEventListener('pointercancel', endBodyDrag)
    renderer.domElement.addEventListener('contextmenu', onContextMenu)

    let frame = 0
    let validationFrame = 0
    let wasInteracting = false
    // Last-applied inputs to applyPaintOverlayVisibility, so it only re-traverses on a real change.
    let lastPaintChannel: TrianglePaintChannel | null | undefined
    let lastPaintSelectedKey: string | null | undefined
    // Painted-triangle overlay visibility (BambuStudio parity + perf). Support/seam paint show ONLY
    // for the SELECTED object while their own tool is active — they're annotations, and a painted
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
      for (const [key, group] of groupByKeyRef.current) {
        const isSelected = key === selectedKey
        group.traverse((node) => {
          if (!(node as THREE.Mesh).isMesh || !node.userData.isPaintOverlay) return
          const channel = overlayChannelByName.get(node.name)
          node.visible = interacting ? false : channel === 'color' || (channel === active && isSelected)
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
          // Footprint rasterization is O(triangles) — brutal for a many-part high-poly object and,
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
    const animate = () => {
      // While a heavy overlay viewer (the 3D preview modal) is open above the editor, skip
      // all per-frame work: the modal covers this viewport, and rendering two full scenes
      // at once doubles the GPU load for nothing. The canvas keeps its last frame and the
      // loop resumes on the first frame after the overlay closes.
      if (hasActiveOverlayViewer()) {
        frame = requestAnimationFrame(animate)
        return
      }
      orbit.update()
      // Any active drag (gizmo, object body, or purge tower). Drives both the cheaper
      // selection-box bounds below and the deferred placement-warning recompute further down.
      const interacting = gizmoDragging || bodyDragGroup !== null || towerDragObject !== null
      const dragJustEnded = wasInteracting && !interacting
      const interactingChanged = interacting !== wasInteracting
      wasInteracting = interacting
      // Re-apply paint-overlay visibility (see helper above) whenever the active tool, the selection,
      // or the manipulation state changes — not every frame.
      const activePaintChannel = activePaintChannelRef.current
      const paintSelectedKey = selectedKeyRef.current
      if (interactingChanged || activePaintChannel !== lastPaintChannel || paintSelectedKey !== lastPaintSelectedKey) {
        applyPaintOverlayVisibility(interacting)
        lastPaintChannel = activePaintChannel
        lastPaintSelectedKey = paintSelectedKey
      }
      // Track the selected object's mesh bounds (Box3Helper fits itself to the box value in its
      // own updateMatrixWorld during render). The PRECISE walk (per-vertex) is the priciest
      // per-frame work for high-poly models, so: only recompute when the object actually moved
      // (idle selections / camera orbits skip it), and while dragging use the cheap transformed-
      // AABB path so high-poly drags stay smooth — then restore the precise box on the drop frame.
      if (selectionBox && selectionTarget) {
        const sig = selectionBoxSignature(selectionTarget)
        if (sig !== selectionBoxSig || dragJustEnded) {
          selectionBoxSig = sig
          // Precise (per-vertex) is only needed to hug a REORIENTED object. Mid-drag stays cheap; a
          // move-drop stays cheap too (translation keeps the box exact); only a rotate/scale drop —
          // or a non-drag change (undo, manual rotate) — pays the precise walk.
          const precise = interacting ? false : (dragJustEnded ? lastDragChangedOrientation : true)
          selectionBoxValue.copy(printableMeshBox(selectionTarget, precise))
        }
      }
      // Keep ear markers flat on the bed through rotations/scales (their matrices bake
      // the world transform, so they must re-bake whenever the instance moves). Only
      // the few groups that actually carry markers pay anything here.
      for (const group of groupByKeyRef.current.values()) syncBrimEarMarkerMatrices(group)
      syncExtraSelectionBoxes()
      syncPartSelectionBoxes()
      renderer.render(scene, camera)
      viewCube.sync(camera)
      // Re-check placement (~4x/sec) so collision/off-plate/floating/unprintable/tower
      // warnings stay current without wiring every mutation path. The recompute (footprint
      // rasterization + per-object Box3 builds) is skipped WHILE actively dragging an object,
      // the gizmo, or the purge tower — that per-tick work was stuttering drags. Movement is
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
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', endBodyDrag)
      renderer.domElement.removeEventListener('pointercancel', endBodyDrag)
      renderer.domElement.removeEventListener('contextmenu', onContextMenu)
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
      scene.remove(brushCursor)
      disposeObject3D(brushCursor)
      scene.remove(brushSphereCursor)
      disposeObject3D(brushSphereCursor)
      disposeObject3D(plateRoot)
      scene.remove(plateRoot)
      scene.remove(transform as unknown as THREE.Object3D)
      // Before forceContextLoss below, which fires webglcontextlost on our own canvas —
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
