/**
 * Read-only 3D preview modal for a library file. Renders one of three content
 * modes for the selected plate: a sliced-gcode toolpath (with the layer scrubber
 * and BS-style stats panel), a plated 3MF scene, or a single mesh (STL/STEP).
 * The editor is the editable counterpart; this view never mutates a `SceneEdit`.
 *
 * It owns a Three.js renderer "rig" created ONCE per open and reused across plate
 * switches and query refetches — recreating it per switch churned WebGL contexts
 * and could evict the editor's context underneath (see the model-studio WebGL
 * lifecycle notes). Render is on-demand (idle = no GPU work). It can preview a
 * live library file or an archived version, and shows a "Reload 3D view" overlay
 * to rebuild after a lost WebGL context.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, DialogContent, Divider, IconButton, LinearProgress, ModalClose, Sheet, Slider, Stack, Switch, Typography, Tooltip } from '@mui/joy'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded'
import CloseFullscreenRoundedIcon from '@mui/icons-material/CloseFullscreenRounded'
import { useQuery } from '@tanstack/react-query'
import type { LibraryFile, LibraryThreeMfScene, ThreeMfIndex } from '@printstream/shared'
import * as THREE from 'three'
import { OrbitControls } from 'three-stdlib'
import { apiFetch } from '../../lib/apiClient'
import { buildApiUrl } from '../../lib/apiUrl'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { buildLayeredGcodePreview, GCODE_FEATURE_COLORS, GCODE_FEATURE_NAMES, parseGcodeLayers, type GcodeStats, type LayeredGcodePreview } from './lib/gcodePreview'
import { formatSecondsDuration } from '../../lib/time'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { DialogFileTitle } from '../../components/DialogFileTitle'
import { LibraryPlateCardPicker } from '../../components/LibraryPlateSelect'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { createBedModelObject, loadBedModelGeometry } from './lib/bedModel'
import { useShowBedModel } from './lib/useShowBedModel'
import {
  createPreviewPlateSurface,
  createThreeMfMatrix,
  createThreeMfPartObject,
  disposeObject3D
} from './lib/threeMfScene'
import { fetchModelBytes, fetchModelText } from './lib/modelFetch'
import { acquireOverlayViewerHold } from './lib/overlayViewerHold'
import { MESH_PREVIEW_COLOR } from './lib/meshThumbnail'
import { parseStlGeometryAsync, parseThreeMfModelEntryAsync } from './lib/meshParseClient'
import {
  BAMBU_THREE_MF_ISO_UP,
  EDITOR_HOME_VIEW_DIRECTION,
  VIEW_CUBE_SIZE,
  VIEW_PRESET_CONFIG,
  computePlatedOrthoFrameRadius,
  createViewCube,
  type ViewPreset
} from './lib/viewCube'

const PLATED_PREVIEW_GRID_SIZE = 320
// Normalized editor "home" direction, so the G-code preview opens at the same angle the full
// editor does (a slightly-elevated front view) instead of the iso corner.
const PREVIEW_HOME_VIEW_DIRECTION = (() => {
  const { x, y, z } = EDITOR_HOME_VIEW_DIRECTION
  const length = Math.hypot(x, y, z) || 1
  return { x: x / length, y: y / length, z: z / length }
})()

/**
 * The viewer's persistent renderer rig. Created ONCE per modal open (per preview mode) and
 * reused across plate switches and query-state flips — WebGL contexts are a capped
 * browser-wide resource, so only the previewed content is swapped per load, never the
 * renderer/canvas. The framing fields are mutable shared state between the rig's resize
 * handler and the content loader (which learns the model bounds).
 */
interface PreviewRig {
  scene: THREE.Scene
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera
  controls: OrbitControls
  /** Floor grid shown in mesh (STL/STEP) mode; the content load rests it under the model. */
  stlGrid: THREE.GridHelper | null
  /** Camera distance used by {@link applyViewPreset}; set from the loaded model's bounds. */
  viewDistance: number
  /** Ortho half-extent framing the plated 3MF scene (kept in sync with resizes). */
  platedFrameRadius: number
  /** Bounds of the framed plated content; null until a plated scene has loaded. */
  platedContentSize: THREE.Vector3 | null
  applyViewPreset: (preset: ViewPreset) => void
  syncViewCubeOrientation: () => void
  /**
   * Request a redraw. Rendering is on-demand: the loop only draws when the camera moved
   * (OrbitControls 'change') or something marked the scene dirty — a static preview costs
   * no GPU time. Content changes (object attach, streamed part, draw-range scrub, resize)
   * must invalidate.
   */
  invalidate: () => void
}

/**
 * Modal 3D previewer for STL files, plated 3MF projects, and
 * plate-scoped printer-ready 3MF/G-code files.
 */
export function PreviewView(props: Record<string, unknown>) {
  const fileId = typeof props.previewFileId === 'string' ? props.previewFileId : null
  // Archived-version mode: read the version's bytes through the versioned
  // resource routes and take the file metadata from the caller (there is no
  // version-detail endpoint) so nothing touches the current file.
  const versionId = typeof props.previewVersionId === 'string' ? props.previewVersionId : null
  const fileOverride = (props.previewFile as LibraryFile | undefined) ?? null
  const resourceBase = versionId ? `/api/library/versions/${versionId}` : `/api/library/${fileId}`
  const requestedPlateIndex = typeof props.previewPlateIndex === 'number' && Number.isInteger(props.previewPlateIndex) && props.previewPlateIndex > 0
    ? props.previewPlateIndex
    : null
  const onClose = typeof props.onPreviewClose === 'function' ? props.onPreviewClose as (() => void) : undefined
  const open = Boolean(fileId)
  const [viewerContainer, setViewerContainer] = useState<HTMLDivElement | null>(null)
  const [viewCubeContainer, setViewCubeContainer] = useState<HTMLDivElement | null>(null)
  const [selectedPlate, setSelectedPlate] = useState(1)
  const [viewerState, setViewerState] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null
  })
  // Per-part progress for the plated 3MF scene: the bed + camera are shown first, then parts stream
  // in off the main thread (worker-parsed), so this drives an "N of M" bar like the full editor.
  // null = no streaming in progress (single-mesh modes never set it).
  const [sceneProgress, setSceneProgress] = useState<{ done: number; total: number } | null>(null)
  // The persistent renderer rig (see PreviewRig). Held in state so the content effect
  // below re-runs once the rig exists.
  const [rig, setRig] = useState<PreviewRig | null>(null)
  // Bumped by the "Reload 3D view" action after a lost WebGL context to rebuild the rig.
  const [rigGeneration, setRigGeneration] = useState(0)
  const [contextLost, setContextLost] = useState(false)
  // Layered G-code preview (sliced-file navigation): the built preview is held in a ref
  // so the layer slider adjusts draw ranges without re-running the heavy viewer effect.
  const gcodePreviewRef = useRef<LayeredGcodePreview | null>(null)
  const [gcodeLayerCount, setGcodeLayerCount] = useState(0)
  const [gcodeTopLayer, setGcodeTopLayer] = useState(0)
  const [gcodeSingleLayer, setGcodeSingleLayer] = useState(false)
  // Within-layer scrub (Bambu's horizontal move slider): null shows the whole top layer.
  const [gcodeMoveCount, setGcodeMoveCount] = useState(0)
  const [gcodeMoveEnd, setGcodeMoveEnd] = useState<number | null>(null)
  // Time/usage breakdown parsed from the plate's G-code (BS-style stats panel).
  const [gcodeStats, setGcodeStats] = useState<GcodeStats | null>(null)
  const [gcodeStatsOpen, setGcodeStatsOpen] = useLocalStorageState(
    'bambu.preview.gcodeStatsOpen',
    true,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  // Collapsed plate strip (name-only chips, no thumbnails) mirrors the editor's
  // bambu.editor.plateStripCollapsed preference but is tracked separately.
  const [plateStripCollapsed, setPlateStripCollapsed] = useLocalStorageState(
    'bambu.preview.plateStripCollapsed',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  // Expanded mode sizes the dialog like the full editor (96vw/96dvh) and lets the
  // viewer fill the freed height instead of keeping its fixed dvh band.
  const [maximized, setMaximized] = useLocalStorageState(
    'bambu.preview.maximized',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )

  const fileQuery = useQuery({
    queryKey: ['library-preview-file', fileId ?? 'missing'],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${fileId}`, { signal }),
    enabled: open && !fileOverride
  })
  const file = fileOverride ?? fileQuery.data?.file ?? null
  const previewMode = useMemo(() => resolvePreviewMode(file), [file])
  const platesQuery = useQuery({
    queryKey: ['library-preview-plates', fileId ?? 'missing', versionId ?? 'current'],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBase}/plates`, { signal }),
    enabled: Boolean(open && fileId && !isMeshPreviewMode(previewMode)),
    staleTime: 60_000,
    refetchOnMount: 'always'
  })
  const sceneQuery = useQuery({
    queryKey: ['library-preview-scene', fileId ?? 'missing', versionId ?? 'current', selectedPlate],
    queryFn: ({ signal }) => apiFetch<LibraryThreeMfScene>(`${resourceBase}/scene?plate=${selectedPlate}`, { signal }),
    // Fetched for the plated 3MF scene AND the G-code preview: the G-code path renders
    // toolpaths, but reads the scene's `bed` to draw the printer's true plate (size +
    // nozzle-only exclude zones) instead of a generic square grid.
    enabled: Boolean(open && fileId && (previewMode === '3mf' || previewMode === 'plate-gcode')),
    staleTime: 60_000,
    refetchOnMount: 'always'
  })
  const plates = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data])

  // The 3D build plate, honouring the same preference the editor writes — a plate that looks one
  // way while editing and another while previewing the slice of that same file is exactly the
  // inconsistency this shares. The scene carries the printer it was placed for; a file whose
  // printer is unknown, or a printer with no bundled mesh, keeps the plain grid.
  const showBedModel = useShowBedModel()
  const scenePrinterModel = sceneQuery.data?.bed.printerModel ?? null
  const [bedModelGeometry, setBedModelGeometry] = useState<THREE.BufferGeometry | null>(null)
  useEffect(() => {
    // Mirrors EditorView: the CACHED original is disposed when replaced, which is safe because
    // every rendered bed is a clone of it, so a live plate is never pulled out from under a scene.
    const replaceGeometry = (next: THREE.BufferGeometry | null) => {
      setBedModelGeometry((previous) => {
        if (previous && previous !== next) previous.dispose()
        return next
      })
    }
    if (!open || !showBedModel || !scenePrinterModel) {
      replaceGeometry(null)
      return undefined
    }
    const controller = new AbortController()
    void loadBedModelGeometry({
      printerModel: scenePrinterModel,
      // The preview has no slicer target of its own; the API falls back to the default target.
      slicerTargetId: null,
      signal: controller.signal
    }).then((geometry) => {
      if (controller.signal.aborted) geometry?.dispose()
      else replaceGeometry(geometry)
    })
    return () => controller.abort()
  }, [open, showBedModel, scenePrinterModel])
  const bedModel = showBedModel ? bedModelGeometry : null

  useEffect(() => {
    setSelectedPlate(requestedPlateIndex ?? 1)
  }, [fileId, requestedPlateIndex])

  useEffect(() => {
    if (isMeshPreviewMode(previewMode)) {
      setSelectedPlate(1)
      return
    }
    if (plates.length === 0) {
      setSelectedPlate(requestedPlateIndex ?? 1)
      return
    }
    if (!plates.some((plate) => plate.index === selectedPlate)) {
      setSelectedPlate(plates[0]?.index ?? requestedPlateIndex ?? 1)
    }
  }, [plates, previewMode, requestedPlateIndex, selectedPlate])

  // Renderer rig lifecycle: one WebGL context pair (viewer + view cube) per open, torn
  // down only when the modal closes, the preview mode changes (different camera/renderer
  // options), or the containers remount. Plate switches and query-state flips reuse it —
  // recreating contexts on those churned against the browser's live-context cap, and the
  // resulting oldest-context eviction is what "crashed" this viewer or the editor under it.
  useEffect(() => {
    if (!open || !viewerContainer || !viewCubeContainer || !previewMode) return

    const isThreeMfScene = previewMode === '3mf'
    const isPlatedPreview = previewMode === '3mf' || previewMode === 'plate-gcode'

    const container = viewerContainer
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0d1322')

    const initialAspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
    // Only the plated 3MF scene uses an orthographic camera; the G-code preview uses a
    // perspective camera (45° FOV) so it matches the full editor's camera, not a flat ortho view.
    const camera = isThreeMfScene
      ? new THREE.OrthographicCamera(-initialAspect, initialAspect, 1, -1, 0.1, 5000)
      : new THREE.PerspectiveCamera(45, initialAspect, 0.1, 5000)
    // Every preview mode renders a Z-up world (the floor grid / plate surface is built for +Z up), so
    // set camera.up BEFORE the first frame. Previously only the plated modes did this, so an STL/STEP
    // preview rendered its first frames with three's default Y-up and the floor grid flashed as a
    // vertical wall until the model finished loading and applyViewPreset('iso') corrected the camera.
    camera.up.set(BAMBU_THREE_MF_ISO_UP.x, BAMBU_THREE_MF_ISO_UP.y, BAMBU_THREE_MF_ISO_UP.z)
    if (isPlatedPreview) {
      camera.position.set(150, 150, 200)
    } else {
      // Open mesh previews already pointing down the iso corner so the bed reads as a floor on frame
      // one; attachObject re-frames to the model bounds (same iso preset) once the mesh loads.
      const isoDirection = VIEW_PRESET_CONFIG.iso.direction
      camera.position.set(isoDirection.x * 200, isoDirection.y * 200, isoDirection.z * 200)
    }

    // Log depth only for the plated 3MF scene, whose coincident coplanar part surfaces
    // z-fight across the wide depth range. G-code toolpaths have no such geometry, and
    // logarithmic depth writes gl_FragDepth — which disables early-Z rejection, a real
    // per-fragment cost when the toolpath mesh runs to millions of double-sided triangles.
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: isThreeMfScene })
    } catch {
      // The browser refused a context (GPU process still recovering from a crash, or the
      // device is out of contexts). Land on the same overlay as a mid-session loss so the
      // user can retry, instead of throwing into the route error boundary.
      setContextLost(true)
      return
    }
    // Cap DPR at 2 (matching the editor / view cube) to bound GPU/battery cost
    // on high-DPI phones and 4K displays.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
    renderer.shadowMap.enabled = isThreeMfScene
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.28
    controls.enablePan = true

    let needsRender = true
    const rigState: PreviewRig = {
      scene,
      camera,
      controls,
      stlGrid: null,
      viewDistance: 200,
      platedFrameRadius: 1,
      platedContentSize: null,
      applyViewPreset: () => undefined,
      syncViewCubeOrientation: () => undefined,
      invalidate: () => {
        needsRender = true
      }
    }
    // Camera movement (user orbit/pan/zoom, damping tail, and programmatic moves detected
    // by controls.update()) marks the frame dirty.
    controls.addEventListener('change', rigState.invalidate)

    const applyPlatedOrthoProjection = () => {
      if (!(camera instanceof THREE.OrthographicCamera)) return
      const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
      const halfHeight = aspect >= 1 ? rigState.platedFrameRadius : rigState.platedFrameRadius / aspect
      const halfWidth = aspect >= 1 ? rigState.platedFrameRadius * aspect : rigState.platedFrameRadius
      camera.left = -halfWidth
      camera.right = halfWidth
      camera.top = halfHeight
      camera.bottom = -halfHeight
      camera.updateProjectionMatrix()
    }

    rigState.applyViewPreset = (preset: ViewPreset) => {
      const config = VIEW_PRESET_CONFIG[preset]
      if (camera instanceof THREE.OrthographicCamera && rigState.platedContentSize) {
        const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
        rigState.platedFrameRadius = Math.max(computePlatedOrthoFrameRadius(rigState.platedContentSize, aspect, preset), 30)
        applyPlatedOrthoProjection()
      }
      camera.up.set(config.up.x, config.up.y, config.up.z)
      camera.position.set(
        rigState.viewDistance * config.direction.x,
        rigState.viewDistance * config.direction.y,
        rigState.viewDistance * config.direction.z
      )
      camera.lookAt(0, 0, 0)
      controls.target.set(0, 0, 0)
      controls.update()
    }

    const viewCube = createViewCube(viewCubeContainer, (preset) => {
      rigState.applyViewPreset(preset)
      viewCube.sync(camera)
    })
    rigState.syncViewCubeOrientation = () => {
      viewCube.sync(camera)
    }

    scene.add(new THREE.HemisphereLight(0xffffff, isPlatedPreview ? 0x5d646b : 0x202030, isPlatedPreview ? 1.05 : 0.9))
    const dir = new THREE.DirectionalLight(0xffffff, isPlatedPreview ? 0.5 : 0.6)
    dir.position.set(1, 1, 1)
    if (isThreeMfScene) {
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
    }
    scene.add(dir)
    if (!isPlatedPreview) {
      // THREE.GridHelper lies in the XZ plane (Three's default Y-up world). This
      // preview is Z-up (applyViewPreset('iso') sets camera.up to +Z), so an
      // unrotated grid stands up as a vertical wall beside the model. Rotate it
      // into the XY plane so it reads as a horizontal floor; it is lowered to the
      // model's base once the mesh loads (size is unknown until then).
      const stlGrid = new THREE.GridHelper(320, 16, 0x2a6f66, 0x223042)
      stlGrid.rotation.x = Math.PI / 2
      scene.add(stlGrid)
      rigState.stlGrid = stlGrid
    } else {
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
    }

    let frame = 0
    const animate = () => {
      // update() re-applies damping and detects external camera moves; it fires 'change'
      // (-> invalidate) only when the camera actually moved, so an idle preview skips the
      // render below entirely — no steady-state GPU cost.
      controls.update()
      if (needsRender) {
        needsRender = false
        viewCube.sync(camera)
        renderer.render(scene, camera)
      }
      frame = requestAnimationFrame(animate)
    }
    animate()

    // A lost context (GPU pressure, driver reset, background reclaim) leaves the canvas
    // permanently black with no event to the app by default. Surface it with a reload
    // action instead: the retry bumps rigGeneration, which rebuilds the rig AND the
    // content (the content effect depends on the rig), so nothing relies on three's
    // automatic restore path (the G-code preview frees its CPU-side buffers after upload,
    // which that path would need).
    const onContextLost = (event: Event) => {
      event.preventDefault()
      cancelAnimationFrame(frame)
      setContextLost(true)
    }
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)

    const onResize = () => {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
        camera.updateProjectionMatrix()
      } else {
        applyPlatedOrthoProjection()
      }
      rigState.invalidate()
    }
    window.addEventListener('resize', onResize)
    // The container also resizes without a window resize (the expand/shrink toggle,
    // the plate strip collapsing in expanded mode), so watch it directly too.
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
    resizeObserver?.observe(container)

    // Pause the editor's render loop (when this modal sits above it) for as long as this
    // viewer owns a live renderer — two full scenes must not render concurrently.
    const releaseOverlayHold = acquireOverlayViewerHold()

    setRig(rigState)

    return () => {
      releaseOverlayHold()
      setRig(null)
      cancelAnimationFrame(frame)
      // Before forceContextLoss below, which fires webglcontextlost on our own canvas —
      // the handler must not misread our deliberate teardown as a GPU failure.
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      window.removeEventListener('resize', onResize)
      resizeObserver?.disconnect()
      controls.removeEventListener('change', rigState.invalidate)
      controls.dispose()
      renderer.dispose()
      // Release the context immediately: contexts left to GC count against the browser's
      // live-context cap, and hitting the cap evicts the OLDEST live context — killing a
      // healthy viewer (often the editor scene under this modal).
      renderer.forceContextLoss()
      viewCube.dispose()
      container.removeChild(renderer.domElement)
      viewCubeContainer.replaceChildren()
    }
  }, [open, previewMode, viewerContainer, viewCubeContainer, rigGeneration])

  // Content lifecycle: fetch/parse/attach the previewed object into the persistent rig's
  // scene. Runs per plate switch and per query resolution; never touches the renderer.
  useEffect(() => {
    if (!open) return

    const isThreeMfScene = previewMode === '3mf'
    const isPlatedPreview = previewMode === '3mf' || previewMode === 'plate-gcode'

    if (
      fileQuery.isLoading
      || (!isMeshPreviewMode(previewMode) && platesQuery.isLoading)
      // Wait for the scene on both plated modes so the bed is known before the first draw.
      || (isPlatedPreview && sceneQuery.isLoading)
    ) {
      setViewerState({ loading: true, error: null })
      return
    }

    if (fileQuery.error instanceof Error) {
      setViewerState({ loading: false, error: fileQuery.error.message })
      return
    }

    if (isThreeMfScene && sceneQuery.error instanceof Error) {
      setViewerState({ loading: false, error: sceneQuery.error.message })
      return
    }

    if (!fileId || !file || !previewMode) {
      if (fileQuery.isSuccess) {
        setViewerState({ loading: false, error: '3D preview is only available for STL and 3MF library files.' })
      }
      return
    }

    // The rig effect above creates the rig once the preview mode is known; this effect
    // re-runs when it lands (rig is a dependency).
    if (!rig) return
    const { scene, camera, controls } = rig

    let previewObject: THREE.Object3D | null = null
    let cancelled = false
    const loadAbortController = new AbortController()

    const handleLoadError = (error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : 'Unable to load the 3D preview.'
      setViewerState({ loading: false, error: message })
    }

    const attachObject = (object: THREE.Object3D) => {
      if (cancelled) {
        disposeObject3D(object)
        return
      }

      const box = new THREE.Box3().setFromObject(object)
      if (box.isEmpty()) {
        disposeObject3D(object)
        setViewerState({ loading: false, error: 'This file does not include previewable 3D data.' })
        return
      }

      const center = box.getCenter(new THREE.Vector3())
      object.position.sub(center)
      previewObject = object
      scene.add(object)

      const size = box.getSize(new THREE.Vector3())
      if (rig.stlGrid) {
        // Rest the floor grid under the now-centred model.
        rig.stlGrid.position.z = -size.z / 2
      }
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      const maxDimension = Math.max(size.x, size.y, size.z, 20)
      const distance = isPlatedPreview
        ? Math.max(sphere.radius * 3, maxDimension * 2, 120)
        : Math.max(maxDimension * 1.6, 80)
      rig.viewDistance = distance
      if (camera instanceof THREE.OrthographicCamera) {
        rig.platedContentSize = size.clone()
        camera.near = Math.max(distance / 20, 0.8)
        camera.far = Math.max(distance * 6, 1200)
      } else {
        camera.near = 0.1
        camera.far = Math.max(distance * 20, 5000)
        camera.updateProjectionMatrix()
      }
      if (previewMode === 'plate-gcode') {
        // Open the G-code preview from the editor's home angle (shared direction) so it matches
        // the full editor's view rather than the iso corner. Orbit/view-cube still work after.
        camera.up.set(BAMBU_THREE_MF_ISO_UP.x, BAMBU_THREE_MF_ISO_UP.y, BAMBU_THREE_MF_ISO_UP.z)
        camera.position.set(
          PREVIEW_HOME_VIEW_DIRECTION.x * distance,
          PREVIEW_HOME_VIEW_DIRECTION.y * distance,
          PREVIEW_HOME_VIEW_DIRECTION.z * distance
        )
        camera.lookAt(0, 0, 0)
        controls.target.set(0, 0, 0)
        controls.update()
      } else {
        rig.applyViewPreset('iso')
      }
      rig.syncViewCubeOrientation()
      rig.invalidate()
      setViewerState({ loading: false, error: null })
    }

    setViewerState({ loading: true, error: null })
    // Reset the layered-G-code slider; it's repopulated when a plate's G-code loads.
    gcodePreviewRef.current = null
    setGcodeLayerCount(0)
    setGcodeStats(null)
    setSceneProgress(null)
    if (isMeshPreviewMode(previewMode)) {
      // Both STL and STEP load from /mesh: it returns STL bytes (STL verbatim, STEP
      // server-tessellated to BambuStudio-matched quality) through sendModelBuffer, so the
      // body is chunk-streamed + gzipped — it survives the Vite dev proxy (a raw /download
      // pipe stalls on large bodies), gets ETag/304 caching, and is gated on view (not
      // download) permission, which is the right scope for a preview.
      const meshUrl = buildApiUrl(`${resourceBase}/mesh`)
      // Fetch via the stall-guarded, abortable reader so a rapid plate/file switch cancels the
      // download (STLLoader.load uses its own un-abortable XHR, which kept running and wasting
      // bandwidth/CPU after the viewer moved on), then tessellate off the main thread via the worker
      // pool (parseStlGeometryAsync) so a large STL/STEP no longer freezes the UI while it parses.
      void fetchModelBytes(meshUrl, { credentials: 'include', signal: loadAbortController.signal })
        .then((bytes) => parseStlGeometryAsync(bytes))
        .then((geometry) => {
          if (cancelled) {
            geometry.dispose()
            return
          }
          const material = new THREE.MeshStandardMaterial({ color: MESH_PREVIEW_COLOR, metalness: 0.1, roughness: 0.6 })
          attachObject(new THREE.Mesh(geometry, material))
        })
        .catch(handleLoadError)
    } else if (previewMode === 'plate-gcode') {
      // Stall-guarded: the gcode body can be large and fans out web->API->bridge,
      // so a wedged transport mid-body must surface an error instead of spinning.
      void fetchModelText(buildApiUrl(`${resourceBase}/plate-gcode?plate=${selectedPlate}`), {
        credentials: 'include',
        signal: loadAbortController.signal
      })
        .then((text) => {
          if (cancelled) return
          const parsed = parseGcodeLayers(text)
          if (parsed.layerCount === 0) throw new Error('This plate does not include previewable G-code geometry.')
          const preview = buildLayeredGcodePreview(parsed)
          gcodePreviewRef.current = preview
          setGcodeLayerCount(preview.layerCount)
          setGcodeTopLayer(preview.layerCount - 1)
          setGcodeSingleLayer(false)
          setGcodeMoveEnd(null)
          setGcodeMoveCount(preview.moveCount(preview.layerCount - 1))
          setGcodeStats(parsed.stats)
          attachObject(buildPlateGcodePreviewObject(preview.object, sceneQuery.data?.bed ?? null, bedModel))
        })
        .catch(handleLoadError)
    } else {
      const sceneData = sceneQuery.data
      if (!sceneData) {
        setViewerState({ loading: false, error: 'No plated 3D scene is available for this 3MF.' })
        return
      }

      // Show the plate (correctly oriented) immediately, then stream the parts in off the main thread
      // so each model appears as it parses with an "N of M" bar — instead of the whole plate blocking
      // on one big synchronous DOM parse and popping in at once.
      const plateGroup = buildPlatePreviewBed(sceneData, bedModel)
      attachObject(plateGroup)
      void streamThreeMfSceneParts(resourceBase, sceneData, plateGroup, loadAbortController.signal, (done, total) => {
        if (cancelled) return
        setSceneProgress(done >= total ? null : { done, total })
        // Parts land in the scene without any camera move; redraw to show them.
        rig.invalidate()
      }).then(
        () => {
          if (cancelled) return
          // Re-fit now that the parts are in: the bed-only frame can clip a tall model at the top of
          // the iso ortho view (the frame radius is computed from the framed object's bounds).
          if (camera instanceof THREE.OrthographicCamera && previewObject) {
            const contentBox = new THREE.Box3().setFromObject(previewObject)
            if (!contentBox.isEmpty()) {
              rig.platedContentSize = contentBox.getSize(new THREE.Vector3())
              rig.applyViewPreset('iso')
              rig.syncViewCubeOrientation()
            }
          }
        },
        handleLoadError
      )
    }

    return () => {
      cancelled = true
      loadAbortController.abort()
      if (previewObject) {
        scene.remove(previewObject)
        disposeObject3D(previewObject)
        rig.invalidate()
      }
      gcodePreviewRef.current = null
    }
  }, [
    rig,
    open,
    file,
    fileId,
    resourceBase,
    fileQuery.error,
    fileQuery.isLoading,
    fileQuery.isSuccess,
    platesQuery.isLoading,
    sceneQuery.data,
    sceneQuery.error,
    sceneQuery.isLoading,
    previewMode,
    selectedPlate,
    // The bed mesh resolves asynchronously (and flips with the preference), so the content has to
    // rebuild when it lands — otherwise the plate keeps whichever surface it was first built with.
    bedModel
  ])

  // Track the scrubbable move count of the current top layer; changing layers resets the
  // within-layer scrub to "whole layer".
  useEffect(() => {
    if (gcodeLayerCount === 0) return
    setGcodeMoveEnd(null)
    setGcodeMoveCount(gcodePreviewRef.current?.moveCount(gcodeTopLayer) ?? 0)
  }, [gcodeTopLayer, gcodeLayerCount])

  // Apply the layer + move sliders to the built G-code preview (draw-range only; cheap).
  useEffect(() => {
    if (gcodeLayerCount === 0) return
    gcodePreviewRef.current?.setVisibleLayers(gcodeTopLayer, {
      single: gcodeSingleLayer,
      moveEnd: gcodeMoveEnd ?? undefined
    })
    // Draw ranges change what's on screen without a camera move; redraw.
    rig?.invalidate()
  }, [gcodeTopLayer, gcodeSingleLayer, gcodeMoveEnd, gcodeLayerCount, rig])

  // A stale context-lost overlay must not survive a close/reopen of the modal.
  useEffect(() => {
    if (!open) setContextLost(false)
  }, [open])

  // Keyboard scrubbing (Bambu-style): Up/Down step the visible top layer, Left/Right scrub
  // moves within that layer — mirroring the on-screen layer and move sliders. Active only
  // while a layered G-code preview is shown and focus isn't in a form control.
  useEffect(() => {
    if (previewMode !== 'plate-gcode' || gcodeLayerCount === 0) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      switch (event.key) {
        case 'ArrowUp':
          setGcodeTopLayer((layer) => Math.min(layer + 1, gcodeLayerCount - 1))
          break
        case 'ArrowDown':
          setGcodeTopLayer((layer) => Math.max(layer - 1, 0))
          break
        case 'ArrowRight':
          // null === "whole layer" (max); stepping past the last move snaps back to it.
          setGcodeMoveEnd((end) => {
            const next = (end ?? gcodeMoveCount) + 1
            return next >= gcodeMoveCount ? null : next
          })
          break
        case 'ArrowLeft':
          setGcodeMoveEnd((end) => Math.max((end ?? gcodeMoveCount) - 1, 0))
          break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewMode, gcodeLayerCount, gcodeMoveCount])

  if (!open || !onClose) return null

  const heading = isMeshPreviewMode(previewMode) ? '3D preview' : '3D plate preview'
  const showPlatePicker = !isMeshPreviewMode(previewMode) && plates.length > 0

  // Expanded mode pins the dialog to the full editor's footprint (96vw/96dvh) and
  // switches the body from a scrolling column to a flex column so the viewer fills
  // the freed height (no scrolling needed at a fixed dialog height).
  const BodyContainer = maximized ? DialogContent : ScrollableDialogBody

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog
        variant="outlined"
        sx={maximized
          // minHeight, not height: inside ModalOverflow, Joy pins a centered dialog to
          // `height: max-content` (higher specificity than sx), which would collapse the
          // flex body; min-height wins over that at computed-value time.
          ? { width: '96vw', maxWidth: '100%', minHeight: '96dvh' }
          : { width: { xs: '100%', md: 1120 }, maxWidth: '100%' }}
      >
        <Tooltip title={maximized ? 'Shrink preview' : 'Expand preview'}>
          <IconButton
            aria-label={maximized ? 'Shrink preview' : 'Expand preview'}
            variant="plain"
            color="neutral"
            size="sm"
            onClick={() => setMaximized(!maximized)}
            sx={{ position: 'absolute', top: 12, right: 52, zIndex: 2 }}
          >
            {maximized ? <CloseFullscreenRoundedIcon fontSize="small" /> : <OpenInFullRoundedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <ModalClose onClick={onClose} sx={{ top: 12, right: 12 }} />
        {/* Extra right padding clears both header icons (expand/shrink + close). */}
        <DialogFileTitle title={heading} fileName={file ? formatLibraryFileName(file.name) : null} sx={{ pr: 12 }} />
        <BodyContainer sx={{ pt: 1.5, ...(maximized ? { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' } : null) }}>
          <Stack spacing={1.5} sx={{ minWidth: 0, ...(maximized ? { flex: 1, minHeight: 0 } : null) }}>
            {showPlatePicker && fileId && (
              <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
                <Box sx={{ width: '100%', minWidth: 0 }}>
                  <LibraryPlateCardPicker
                    fileId={fileId}
                    resourceBasePath={resourceBase}
                    thumbnailVersion={file?.uploadedAt ?? null}
                    plates={plates}
                    value={selectedPlate}
                    onChange={setSelectedPlate}
                    label={null}
                    collapsed={plateStripCollapsed}
                    onToggleCollapsed={() => setPlateStripCollapsed(!plateStripCollapsed)}
                  />
                </Box>
              </Sheet>
            )}
            <Sheet
              variant="soft"
              sx={{
                // Expanded: fill whatever height the plate strip leaves; normal: fixed band.
                height: maximized ? 'auto' : { xs: '50dvh', sm: '62dvh' },
                flex: maximized ? 1 : 'initial',
                minHeight: { xs: 300, sm: 360 },
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 'md',
                bgcolor: '#0d1322'
              }}
            >
              <Box ref={setViewerContainer} sx={{ position: 'absolute', inset: 0 }} />
              {viewerState.loading && (
                <Stack
                  spacing={1}
                  alignItems="center"
                  justifyContent="center"
                  sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(8, 11, 20, 0.42)', backdropFilter: 'blur(2px)' }}
                >
                  <CircularProgress size="sm" />
                  <Typography level="body-sm" textColor="neutral.200">Loading 3D preview…</Typography>
                </Stack>
              )}
              {sceneProgress && !viewerState.loading && !viewerState.error && (
                // Slim top bar while the plate's parts stream in (the bed is already shown beneath).
                <Sheet
                  variant="soft"
                  sx={{
                    position: 'absolute',
                    top: 12,
                    left: 12,
                    right: 12,
                    zIndex: 2,
                    px: 1.5,
                    py: 0.75,
                    borderRadius: 'md',
                    bgcolor: 'rgba(13, 19, 34, 0.72)',
                    backdropFilter: 'blur(2px)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25
                  }}
                >
                  <CircularProgress size="sm" />
                  <Typography level="body-xs" textColor="neutral.200" sx={{ whiteSpace: 'nowrap' }}>
                    Loading models… {sceneProgress.done} of {sceneProgress.total}
                  </Typography>
                  <LinearProgress
                    determinate
                    value={(sceneProgress.done / Math.max(sceneProgress.total, 1)) * 100}
                    sx={{ flex: 1 }}
                  />
                </Sheet>
              )}
              {viewerState.error && !viewerState.loading && (
                <Alert color="warning" variant="soft" sx={{ position: 'absolute', top: 16, left: 16, right: 16, zIndex: 1 }}>
                  {viewerState.error}
                </Alert>
              )}
              {contextLost && (
                // The WebGL context was reclaimed (GPU pressure, driver reset). The canvas
                // is permanently blank until rebuilt, so offer an explicit reload instead
                // of leaving a dead view.
                <Stack
                  spacing={1}
                  alignItems="center"
                  justifyContent="center"
                  sx={{ position: 'absolute', inset: 0, zIndex: 2, bgcolor: 'rgba(8, 11, 20, 0.6)', backdropFilter: 'blur(2px)' }}
                >
                  <Typography level="body-sm" textColor="neutral.200">
                    The 3D view was interrupted by the browser.
                  </Typography>
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => {
                      setContextLost(false)
                      setRigGeneration((generation) => generation + 1)
                    }}
                  >
                    Reload 3D view
                  </Button>
                </Stack>
              )}
              {previewMode === 'plate-gcode' && gcodeLayerCount > 1 && !viewerState.loading && !viewerState.error && (
                <Sheet
                  variant="soft"
                  sx={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    bottom: 12,
                    zIndex: 1,
                    px: 1,
                    py: 1.5,
                    borderRadius: 'md',
                    bgcolor: 'rgba(13, 19, 34, 0.72)',
                    backdropFilter: 'blur(2px)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 1
                  }}
                >
                  <Chip size="sm" variant="soft" color="neutral">{gcodeTopLayer + 1}/{gcodeLayerCount}</Chip>
                  {/* The layer's print height: what a pause or filament change in the editor keys on. */}
                  {gcodePreviewRef.current && (
                    <Chip size="sm" variant="soft" color="neutral">
                      {Number(gcodePreviewRef.current.layerZ(gcodeTopLayer).toFixed(2))} mm
                    </Chip>
                  )}
                  <Slider
                    orientation="vertical"
                    size="sm"
                    min={0}
                    max={gcodeLayerCount - 1}
                    value={gcodeTopLayer}
                    onChange={(_event, value) => setGcodeTopLayer(typeof value === 'number' ? value : value[0] ?? 0)}
                    aria-label="G-code layer"
                    sx={{ flex: 1, minHeight: 120 }}
                  />
                  <Switch
                    size="sm"
                    checked={gcodeSingleLayer}
                    onChange={(event) => setGcodeSingleLayer(event.target.checked)}
                    slotProps={{ input: { 'aria-label': 'Show only the selected layer' } }}
                  />
                  <Typography level="body-xs" textColor="neutral.300" sx={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                    Single layer
                  </Typography>
                </Sheet>
              )}
              {previewMode === 'plate-gcode' && gcodeMoveCount > 1 && !viewerState.loading && !viewerState.error && (
                // Top edge: the bottom-left corner belongs to the view cube and the right
                // edge to the layer panel, so the move scrubber gets the top strip
                // (stopping short of the layer panel's column).
                <Sheet
                  variant="soft"
                  sx={{
                    position: 'absolute',
                    left: 12,
                    right: { xs: 88, sm: 96 },
                    top: 12,
                    zIndex: 1,
                    px: 1.5,
                    py: 0.75,
                    borderRadius: 'md',
                    bgcolor: 'rgba(13, 19, 34, 0.72)',
                    backdropFilter: 'blur(2px)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1
                  }}
                >
                  <Typography level="body-xs" textColor="neutral.300" sx={{ whiteSpace: 'nowrap' }}>
                    Moves
                  </Typography>
                  <Slider
                    size="sm"
                    min={0}
                    max={gcodeMoveCount}
                    value={gcodeMoveEnd ?? gcodeMoveCount}
                    onChange={(_event, value) => setGcodeMoveEnd(typeof value === 'number' ? value : value[0] ?? 0)}
                    aria-label="G-code moves within the top layer"
                    sx={{ flex: 1, minWidth: 0 }}
                  />
                  <Chip size="sm" variant="soft" color="neutral">
                    {gcodeMoveEnd ?? gcodeMoveCount}/{gcodeMoveCount}
                  </Chip>
                </Sheet>
              )}
              {previewMode === 'plate-gcode' && gcodeStats && !viewerState.loading && !viewerState.error && (
                <GcodeStatsPanel
                  stats={gcodeStats}
                  plate={plates.find((plate) => plate.index === selectedPlate) ?? null}
                  layerCount={gcodeLayerCount}
                  open={gcodeStatsOpen}
                  onToggle={() => setGcodeStatsOpen(!gcodeStatsOpen)}
                />
              )}
              <Box
                sx={{
                  position: 'absolute',
                  left: { xs: -18, sm: 0 },
                  bottom: { xs: -18, sm: 0 },
                  zIndex: (theme) => theme.zIndex.tooltip,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start'
                }}
              >
                <ViewCubeControl
                  onSetContainer={setViewCubeContainer}
                  disabled={viewerState.loading || Boolean(viewerState.error)}
                />
              </Box>
            </Sheet>
          </Stack>
        </BodyContainer>
      </ScrollableModalDialog>
    </Modal>
  )
}

/**
 * BS-style slice stats overlay for the G-code preview: total time, layer count and
 * height, per-feature time breakdown (colour-keyed to the toolpath palette), and
 * filament usage. Feature times are the parser's feedrate estimate NORMALIZED so the
 * total matches the slicer's own prediction (slice_info `prediction`, else the gcode
 * header estimate) — proportions from the moves, authority from the slicer.
 */
function GcodeStatsPanel({
  stats,
  plate,
  layerCount,
  open,
  onToggle
}: {
  stats: GcodeStats
  plate: ThreeMfIndex['plates'][number] | null
  layerCount: number
  open: boolean
  onToggle: () => void
}) {
  const authoritativeTotal = plate?.prediction ?? stats.headerTotalSeconds ?? stats.totalSeconds
  const scale = stats.totalSeconds > 0 && authoritativeTotal > 0 ? authoritativeTotal / stats.totalSeconds : 1
  const rows = stats.featureSeconds
    .map((seconds, role) => ({ role, seconds: seconds * scale, extrusionMm: stats.featureExtrusionMm[role] ?? 0 }))
    .filter((row) => row.seconds >= 0.5)
    .sort((left, right) => right.seconds - left.seconds)
  const travelSeconds = stats.travelSeconds * scale
  const percentOf = (seconds: number) => authoritativeTotal > 0 ? `${Math.max(1, Math.round((seconds / authoritativeTotal) * 100))}%` : ''
  const usedFilaments = (plate?.filaments ?? []).filter((filament) => filament.usedGrams != null && filament.usedGrams > 0)
  if (!open) {
    return (
      <Tooltip title="Print statistics">
        <IconButton
          size="sm"
          variant="soft"
          onClick={onToggle}
          aria-label="Show print statistics"
          sx={{ position: 'absolute', left: 12, top: 72, zIndex: 1, bgcolor: 'rgba(13, 19, 34, 0.72)', backdropFilter: 'blur(2px)' }}
        >
          <QueryStatsRoundedIcon />
        </IconButton>
      </Tooltip>
    )
  }
  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute',
        left: 12,
        // Below the Moves scrubber strip (top: 12 + its height), never over it.
        top: 72,
        zIndex: 1,
        px: 1.25,
        py: 1,
        borderRadius: 'md',
        bgcolor: 'rgba(13, 19, 34, 0.78)',
        backdropFilter: 'blur(2px)',
        width: 'min(248px, calc(100% - 110px))',
        maxHeight: 'calc(100% - 140px)',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5
      }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        onClick={onToggle}
        sx={{ cursor: 'pointer', userSelect: 'none' }}
        aria-label="Collapse print statistics"
      >
        <Typography level="title-sm" textColor="neutral.100">Print statistics</Typography>
        <Tooltip title="Collapse">
          <IconButton size="sm" variant="plain" aria-label="Hide print statistics">
            <ExpandLessRoundedIcon />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack direction="row" justifyContent="space-between" spacing={1}>
        <Typography level="body-xs" textColor="neutral.300">Total time</Typography>
        <Typography level="body-xs" fontWeight="lg" textColor="neutral.100">
          {formatSecondsDuration(Math.round(authoritativeTotal))}
        </Typography>
      </Stack>
      <Stack direction="row" justifyContent="space-between" spacing={1}>
        <Typography level="body-xs" textColor="neutral.300">Layers</Typography>
        <Typography level="body-xs" textColor="neutral.100">{layerCount} · {stats.maxZ.toFixed(1)} mm</Typography>
      </Stack>
      {(plate?.weight != null || stats.filamentMm > 0) && (
        <Stack direction="row" justifyContent="space-between" spacing={1}>
          <Typography level="body-xs" textColor="neutral.300">Filament</Typography>
          <Typography level="body-xs" textColor="neutral.100">
            {plate?.weight != null ? `${plate.weight.toFixed(1)} g` : ''}
            {plate?.weight != null && stats.filamentMm > 0 ? ' · ' : ''}
            {stats.filamentMm > 0 ? `${(stats.filamentMm / 1000).toFixed(2)} m` : ''}
          </Typography>
        </Stack>
      )}
      {usedFilaments.length > 1 && usedFilaments.map((filament) => (
        <Stack key={filament.id} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: filament.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
            <Typography level="body-xs" textColor="neutral.300" noWrap>
              {filament.filamentName ?? filament.filamentType ?? `Filament ${filament.id}`}
            </Typography>
          </Stack>
          <Typography level="body-xs" textColor="neutral.100">{filament.usedGrams!.toFixed(1)} g</Typography>
        </Stack>
      ))}
      {rows.length > 0 && (
        <>
          <Divider sx={{ my: 0.25 }} />
          {rows.map((row) => (
            <Stack key={row.role} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: `#${(GCODE_FEATURE_COLORS[row.role] ?? 0x888888).toString(16).padStart(6, '0')}` }} />
                <Typography level="body-xs" textColor="neutral.300" noWrap>{GCODE_FEATURE_NAMES[row.role] ?? 'Other'}</Typography>
              </Stack>
              <Typography level="body-xs" textColor="neutral.100" sx={{ whiteSpace: 'nowrap' }}>
                {formatSecondsDuration(Math.max(1, Math.round(row.seconds)))} · {percentOf(row.seconds)}
              </Typography>
            </Stack>
          ))}
          {travelSeconds >= 0.5 && (
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: 'neutral.600' }} />
                <Typography level="body-xs" textColor="neutral.300">Travel</Typography>
              </Stack>
              <Typography level="body-xs" textColor="neutral.100" sx={{ whiteSpace: 'nowrap' }}>
                {formatSecondsDuration(Math.max(1, Math.round(travelSeconds)))} · {percentOf(travelSeconds)}
              </Typography>
            </Stack>
          )}
        </>
      )}
    </Sheet>
  )
}

function ViewCubeControl({
  onSetContainer,
  disabled
}: {
  onSetContainer: (node: HTMLDivElement | null) => void
  disabled: boolean
}) {
  return (
    <Box
      sx={{
        position: 'relative',
        width: VIEW_CUBE_SIZE,
        height: VIEW_CUBE_SIZE,
        pointerEvents: disabled ? 'none' : 'auto'
      }}
    >
      <Box
        ref={onSetContainer}
        aria-label="Preview orientation cube"
        sx={{
          width: VIEW_CUBE_SIZE,
          height: VIEW_CUBE_SIZE,
          '& canvas': {
            display: 'block'
          }
        }}
      />
    </Box>
  )
}

type PreviewMode = 'stl' | 'step' | '3mf' | 'plate-gcode' | null

function resolvePreviewMode(file: LibraryFile | null): PreviewMode {
  if (!file) return null
  if (file.kind === 'stl') return 'stl'
  if (file.kind === 'step') return 'step'
  // A geometry-only 3MF has no plated scene to render — it previews as a single mesh,
  // exactly like STL (`/mesh` serves its extracted geometry as STL bytes).
  if (file.kind === '3mf') return file.geometryOnly === true ? 'stl' : '3mf'
  if (file.kind === 'gcode') return 'plate-gcode'
  return null
}

/** STL and STEP both render as a single un-plated mesh (STEP is tessellated to STL server-side). */
function isMeshPreviewMode(mode: PreviewMode): boolean {
  return mode === 'stl' || mode === 'step'
}

/** Build just the plate surface (bed + exclude zones) so it can be shown before any parts load. */
function buildPlatePreviewBed(scene: LibraryThreeMfScene, bedModel: THREE.BufferGeometry | null): THREE.Group {
  const plateGroup = new THREE.Group()
  plateGroup.add(buildPreviewPlateSurface({
    minX: scene.bed.minX,
    maxX: scene.bed.maxX,
    minY: scene.bed.minY,
    maxY: scene.bed.maxY,
    excludeAreas: scene.bed.excludeAreas
  }, bedModel))
  return plateGroup
}

/**
 * The plate surface for a preview, with the modelled 3D bed under it when one is loaded.
 *
 * Matches the editor's treatment exactly (`EditorView`): with a bed model the flat surface fill is
 * dropped and the coordinate ticks move to the rear edge, so the mesh reads as the plate rather
 * than competing with a painted-on square. The mesh is positioned from the printable area's
 * ORIGIN (its minimum corner), never its centre — see lib/bedModel.ts for why centring skews it.
 */
function buildPreviewPlateSurface(
  bed: { minX: number; maxX: number; minY: number; maxY: number; excludeAreas: LibraryThreeMfScene['bed']['excludeAreas'] },
  bedModel: THREE.BufferGeometry | null
): THREE.Object3D {
  const width = Math.max(bed.maxX - bed.minX, 1)
  const depth = Math.max(bed.maxY - bed.minY, 1)
  const surface = createPreviewPlateSurface({
    width,
    depth,
    centerX: (bed.minX + bed.maxX) / 2,
    centerY: (bed.minY + bed.maxY) / 2,
    excludeAreas: bed.excludeAreas,
    showSurfaceFill: !bedModel,
    axisLabelEdge: bedModel ? 'rear' : 'front'
  })
  if (bedModel) surface.add(createBedModelObject({ geometry: bedModel, originX: bed.minX, originY: bed.minY }))
  return surface
}

/**
 * Stream a plated 3MF scene's parts into an already-attached `plateGroup`, mirroring the editor's
 * load: each model entry is fetched through the stall-guarded reader and parsed off the main thread
 * (worker pool, DOM fallback), and parts are added as their entry resolves so they appear
 * incrementally with progress. Parts share the group's transform, so they land relative to the bed
 * exactly as a one-shot build would. Throws if no part yields previewable geometry.
 */
async function streamThreeMfSceneParts(
  resourceBase: string,
  scene: LibraryThreeMfScene,
  plateGroup: THREE.Object3D,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  const partsByEntry = new Map<string, LibraryThreeMfScene['parts']>()
  for (const part of scene.parts) {
    const list = partsByEntry.get(part.entryPath)
    if (list) list.push(part)
    else partsByEntry.set(part.entryPath, [part])
  }

  const total = scene.parts.length
  let done = 0
  let placed = 0
  onProgress(0, total)

  await Promise.all([...partsByEntry.entries()].map(async ([entryPath, parts]) => {
    const bytes = await fetchModelBytes(
      buildApiUrl(`${resourceBase}/scene-entry?path=${encodeURIComponent(entryPath)}`),
      { credentials: 'include', signal }
    )
    const modelMap = await parseThreeMfModelEntryAsync(bytes)
    if (signal.aborted) {
      // The viewer moved on (plate/file switch) — drop the freshly parsed geometry rather than
      // attaching it to a group that's about to be disposed.
      for (const geometry of modelMap.values()) geometry.dispose()
      return
    }
    for (const part of parts) {
      const geometry = modelMap.get(part.objectId)
      done += 1
      if (geometry) {
        plateGroup.add(createThreeMfPartObject(geometry, {
          // Parts without an extruder render in the DEFAULT filament, like Bambu Studio.
          color: part.color ?? scene.projectFilaments?.[0]?.color ?? null,
          transform: createThreeMfMatrix(part.transform),
          colorPaintFilaments: scene.projectFilaments ?? null
        }))
        placed += 1
      }
      onProgress(done, total)
    }
  }))

  if (placed === 0) {
    throw new Error('This plate does not include previewable mesh geometry.')
  }
}

function buildPlateGcodePreviewObject(
  object: THREE.Object3D,
  bed: LibraryThreeMfScene['bed'] | null,
  bedModel: THREE.BufferGeometry | null
): THREE.Object3D {
  // The layered parser already emits raw G-code coordinates (printer Z-up), matching the
  // Z-up plated scene — so, unlike three's Y-up GCodeLoader output, no rotation is needed.
  object.updateMatrixWorld(true)

  const bounds = new THREE.Box3().setFromObject(object)
  if (bounds.isEmpty()) {
    disposeObject3D(object)
    throw new Error('This plate does not include previewable G-code geometry.')
  }

  const plateGroup = new THREE.Group()
  if (bed) {
    // Real printer plate (absolute bed coordinates): the G-code is authored in bed space, so
    // the surface spans the machine's true footprint and exclude zones rather than a generic
    // square centred on the toolpaths (which read as a small A1-style bed for an H2D plate).
    plateGroup.add(buildPreviewPlateSurface(bed, bedModel))
  } else {
    // Fallback when the scene/bed is unavailable: a generic square grid under the toolpaths.
    const center = bounds.getCenter(new THREE.Vector3())
    plateGroup.add(createPreviewPlateSurface({
      width: PLATED_PREVIEW_GRID_SIZE,
      depth: PLATED_PREVIEW_GRID_SIZE,
      centerX: center.x,
      centerY: center.y
    }))
  }
  plateGroup.add(object)
  return plateGroup
}

