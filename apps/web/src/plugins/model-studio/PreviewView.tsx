/**
 * Read-only 3D preview modal for a library file. Renders one of three content
 * modes for the selected plate: a sliced-gcode toolpath (with the layer scrubber
 * and the BS-style toolpath legend), a plated 3MF scene, or a single mesh (STL/STEP).
 * The editor is the editable counterpart; this view never mutates a `SceneEdit`.
 *
 * It owns a Three.js renderer "rig" created ONCE per open and reused across plate
 * switches and query refetches: recreating it per switch churned WebGL contexts
 * and could evict the editor's context underneath (see the model-studio WebGL
 * lifecycle notes). Render is on-demand (idle = no GPU work). It can preview a
 * live library file or an archived version, and shows a "Reload 3D view" overlay
 * to rebuild after a lost WebGL context.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, Checkbox, FormControl, FormLabel, IconButton, ModalClose, Option, Select, Sheet, Slider, Stack, Typography, Tooltip } from '@mui/joy'
import { choosePlateStripOrientation, EDITOR_GRID_GAP_PX, PLATE_STRIP_VERTICAL_THICKNESS } from './lib/editorChromeLayout'
import { useQuery } from '@tanstack/react-query'
import { isMeshLibraryFileKind } from '@printstream/shared'
import type { LibraryFile, LibraryThreeMfScene, ThreeMfIndex } from '@printstream/shared'
import * as THREE from 'three'
import { createWebglRenderer } from './lib/webglRenderer'
import { OrbitControls } from 'three-stdlib'
import { apiFetch } from '../../lib/apiClient'
import { buildApiUrl } from '../../lib/apiUrl'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { fitPerspectiveDepthRange, previewDepthRadius } from './lib/previewDepthRange'
import { previewChromeLayout, VIEW_CUBE_FOOTPRINT_PX } from './lib/previewChromeLayout'
import { buildLayeredGcodePreview, parseGcodeLayers, type GcodeMarkerVisibility, type GcodeStats, type GcodeValueRanges, type LayeredGcodePreview } from './lib/gcodePreview'
import type { ParsedGcodeLayers } from './lib/gcodePreview'
import { gcodeViewModeMetric, isGcodeViewMode, type GcodeViewMode } from './lib/gcodeViewModes'
import { scanGcodeToolpathConflicts, type GcodeToolpathConflict } from './lib/gcodeConflicts'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import { GcodeToolpathPanel } from './GcodeToolpathPanel'
import { AllPlatesStatsDialog } from './AllPlatesStatsDialog'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { DialogFileTitle } from '../../components/DialogFileTitle'
import { FullScreenDialogButton, MaximizeDialogButton } from '../../components/DialogPresentationToggles'
import { useDialogPresentationState } from '../../hooks/useDialogPresentationState'
import { LibraryPlateCardPicker } from '../../components/LibraryPlateSelect'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { createBedModelObject, loadBedModelGeometry } from './lib/bedModel'
import { useShowBedModel } from './lib/useShowBedModel'
import {
  createPreviewPlateSurface,
  disposeObject3D
} from './lib/threeMfScene'
import { fetchModelBytes, fetchModelText } from './lib/modelFetch'
import { acquireOverlayViewerHold } from './lib/overlayViewerHold'
import { MESH_PREVIEW_COLOR } from './lib/meshThumbnail'
import { parseStlGeometryAsync } from './lib/meshParseClient'
import { createLibraryThreeMfEntryBytesLoader, streamThreeMfSceneParts } from './lib/threeMfSceneStream'
import {
  BAMBU_THREE_MF_ISO_UP,
  EDITOR_HOME_VIEW_DIRECTION,
  VIEW_CUBE_EDGE_INSET,
  VIEW_CUBE_HINT,
  VIEW_CUBE_SIZE,
  VIEW_PRESET_CONFIG,
  computeOrthoFrameRadiusForDirection,
  createViewCube,
  type ViewPreset
} from './lib/viewCube'
import { createViewportCameraRig } from './lib/viewportCamera'
import { guardTouchOrbitTransition } from './lib/touchOrbitGesture'
import { safeFullscreenControlTop } from '../../lib/dialogPresentation'
import { ViewportBuildOverlay } from './ViewportBuildOverlay'
import { GCODE_SLIDER_END_INSET_PX, GcodeLayerSlider } from './GcodeLayerSlider'
import { GcodeScrubberValueChip } from './GcodeScrubberValueChip'
import { buildGcodeLayerEventMarkers, maxGcodeLayerHeightReference, type GcodeLayerEventMarker } from './lib/gcodeLayerEvents'
import { toThreeMfIndexDto } from '@printstream/shared/three-mf'
import { readInMemoryPlateGcode, type InMemoryGcodePreviewSource } from './lib/inMemoryGcodePreview'
import { useMobileViewport } from '../../components/useMobileViewport'

const PLATED_PREVIEW_GRID_SIZE = 320
/**
 * Module constant, not an inline literal: it is the fallback for a `useLocalStorageState` whose
 * value feeds an effect dependency, and a fresh object each render would re-run the marker effect
 * (and so the layer scrub) on every unrelated state change in this ~1400-line component.
 */
const NO_GCODE_MARKERS: GcodeMarkerVisibility = Object.freeze({})
/**
 * Vertical space the toolpath legend gives up while the conflict banner is showing: the banner's
 * own offset above the view cube, plus room for its wrapped text on a phone.
 */
const GCODE_CONFLICT_ALERT_RESERVE_PX = VIEW_CUBE_FOOTPRINT_PX + 96
/**
 * How long one slice of the toolpath-conflict scan may run before yielding to the browser.
 *
 * Comfortably inside a 60fps frame, so scrubbing stays smooth while the scan proceeds.
 */
const CONFLICT_SCAN_SLICE_MS = 8
/**
 * Zero is the valid "before the first move" replay position. A parsed layer's TOTAL remains
 * non-zero; conflating those values made move 1 impossible to watch appear.
 */
const GCODE_REPLAY_START = 0
/** Shared phone-row geometry so Layers and Moves give their sliders the same touch track. */
const HORIZONTAL_GCODE_SCRUBBER_SX = {
  minWidth: 0,
  minHeight: 44,
  // Phones keep the compact editor treatment; larger viewports restore a full spacing unit at
  // both ends. This is container padding, separate from the thumb's endpoint clearance.
  px: { xs: 0.5, sm: 1 },
  py: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 0.5
} as const
/** Fixed tracks prevent the canvas resizing once parsed G-code controls appear. */
const GCODE_HORIZONTAL_SCRUBBER_HEIGHT_PX = 44
/** 42px Joy touch target, 4px inline padding, and the outlined sheet's two borders. */
const GCODE_VERTICAL_SCRUBBER_WIDTH_PX = 48
// Normalized editor "home" direction, so the G-code preview opens at the same angle the full
// editor does (a slightly-elevated front view) instead of the iso corner.
const PREVIEW_HOME_VIEW_DIRECTION = (() => {
  const { x, y, z } = EDITOR_HOME_VIEW_DIRECTION
  const length = Math.hypot(x, y, z) || 1
  return { x: x / length, y: y / length, z: z / length }
})()

/**
 * The viewer's persistent renderer rig. Created ONCE per modal open (per preview mode) and
 * reused across plate switches and query-state flips, WebGL contexts are a capped
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
  /**
   * Radius of the loaded content's bounding sphere, which the loader re-centres on the origin.
   * Feeds the per-frame depth-range fit (see `lib/previewDepthRange.ts`); 0 until content loads.
   */
  contentRadius: number
  applyViewPreset: (preset: ViewPreset) => void
  syncViewCubeOrientation: () => void
  /**
   * Request a redraw. Rendering is on-demand: the loop only draws when the camera moved
   * (OrbitControls 'change') or something marked the scene dirty, a static preview costs
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
  const isMobile = useMobileViewport()
  const fileId = typeof props.previewFileId === 'string' ? props.previewFileId : null
  const inMemoryGcode = (props.inMemoryGcode as InMemoryGcodePreviewSource | undefined) ?? null
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
  const open = Boolean(fileId || inMemoryGcode)
  const [viewerContainer, setViewerContainer] = useState<HTMLDivElement | null>(null)
  const [viewCubeContainer, setViewCubeContainer] = useState<HTMLDivElement | null>(null)
  const [selectedPlate, setSelectedPlate] = useState(1)
  const [viewerState, setViewerState] = useState<{ loading: boolean; error: string | null }>({
    loading: true,
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
  /**
   * Why the 3D view is dead, when it is.
   *
   * 'lost': the context was reclaimed (GPU pressure, driver reset). Rebuilding the rig usually
   * works, so offer it.
   * 'refused': the browser would not GRANT a new context. Chrome blocks a page that has caused
   * repeated context loss ("Web page caused context loss and was blocked"), and no amount of
   * rebuilding gets one back: only a fresh document does. Retrying from here re-entered the same
   * overlay with the same button, so the recovery affordance looked broken at exactly the moment
   * it mattered.
   */
  const [viewerContextFailure, setViewerContextFailure] = useState<'lost' | 'refused' | null>(null)
  // Layered G-code preview (sliced-file navigation): the built preview is held in a ref
  // so the layer slider adjusts draw ranges without re-running the heavy viewer effect.
  const gcodePreviewRef = useRef<LayeredGcodePreview | null>(null)
  const [gcodeLayerCount, setGcodeLayerCount] = useState(0)
  const [gcodeTopLayer, setGcodeTopLayer] = useState(0)
  const [gcodeLayerHeightWidthReference, setGcodeLayerHeightWidthReference] = useState<string | null>(null)
  const [gcodeSingleLayer, setGcodeSingleLayer] = useState(false)
  const [mobileLegendOpen, setMobileLegendOpen] = useState(false)
  const [gcodeLayerEventMarkers, setGcodeLayerEventMarkers] = useState<GcodeLayerEventMarker[]>([])
  // Within-layer scrub (Bambu's horizontal move slider): null shows the whole top layer.
  const [gcodeMoveCount, setGcodeMoveCount] = useState(0)
  const [gcodeMoveEnd, setGcodeMoveEnd] = useState<number | null>(null)
  // Time/usage breakdown parsed from the plate's G-code (drives the toolpath legend).
  const [gcodeStats, setGcodeStats] = useState<GcodeStats | null>(null)
  // Whole-print extents for the range colour schemes, kept beside the stats they are parsed with.
  const [gcodeRanges, setGcodeRanges] = useState<GcodeValueRanges | null>(null)
  // Toolpath conflict, computed AFTER the preview is on screen (see the effect below).
  const [gcodeConflict, setGcodeConflict] = useState<GcodeToolpathConflict | null>(null)
  // The parse, held only until the conflict check has run over it. Nulled immediately afterwards,
  // because it pins the multi-MB position arrays the preview itself deliberately frees.
  const [gcodeConflictInput, setGcodeConflictInput] = useState<ParsedGcodeLayers | null>(null)
  const [gcodeStatsOpen, setGcodeStatsOpen] = useLocalStorageState(
    'bambu.preview.gcodeStatsOpen',
    true,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  // How the toolpath is coloured, and whether travel is drawn. Both are per-device preferences:
  // they describe how this person likes to READ a preview, not anything about the file, so they
  // follow `bambu.preview.*` like the panel's own collapsed state. An unknown stored mode (a build
  // that dropped one) falls back rather than leaving the picker on a value it cannot render.
  const [gcodeViewMode, setGcodeViewMode] = useLocalStorageState<GcodeViewMode>(
    'bambu.preview.gcodeViewMode',
    'feature',
    (raw) => (isGcodeViewMode(raw) ? raw : null),
    String
  )
  const [gcodeShowTravel, setGcodeShowTravel] = useLocalStorageState(
    'bambu.preview.gcodeShowTravel',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  // Retract / unretract / seam / wipe. Stored as one JSON object rather than four keys because
  // they are read and written together; an unparseable value falls back to all-off.
  const [gcodeMarkers, setGcodeMarkers] = useLocalStorageState<GcodeMarkerVisibility>(
    'bambu.preview.gcodeMarkers',
    NO_GCODE_MARKERS,
    (raw) => {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return null
        const record = parsed as Record<string, unknown>
        return {
          retract: record.retract === true,
          unretract: record.unretract === true,
          seam: record.seam === true,
          wipe: record.wipe === true
        }
      } catch {
        return null
      }
    },
    (value) => JSON.stringify(value)
  )
  // Collapsed plate strip (name-only chips, no thumbnails) mirrors the editor's
  // bambu.editor.plateStripCollapsed preference but is tracked separately.
  const [plateStripCollapsed, setPlateStripCollapsed] = useLocalStorageState(
    'bambu.preview.plateStripCollapsed',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  // Maximized frees the viewer from its fixed dvh band; full screen drops the plate picker and
  // header too. Both come from the shared dialog modes, which also own the rule that only the
  // maximized preference is remembered: see `hooks/useDialogPresentationState.ts`.
  const { presentation: requestedPresentation, maximized, setMaximized, fullScreen, setFullScreen } = useDialogPresentationState({
    maximizedStorageKey: 'bambu.preview.maximized'
  })
  // A phone's standard dialog is already full width; making its viewport shorter only creates a
  // second size with no useful distinction. Keep the desktop preference intact and force the
  // expanded shell on mobile. Full screen remains separate because it removes the dialog and
  // plate-picker chrome while keeping the G-code controls available around the viewport.
  const presentation = isMobile && requestedPresentation === 'standard'
    ? 'maximized'
    : requestedPresentation
  const [allPlatesStatsOpen, setAllPlatesStatsOpen] = useState(false)
  const [previewBodyNode, setPreviewBodyNode] = useState<HTMLDivElement | null>(null)
  const [previewBodySize, setPreviewBodySize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!previewBodyNode) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect
      if (!box) return
      setPreviewBodySize((current) => (
        Math.abs(current.width - box.width) < 1 && Math.abs(current.height - box.height) < 1
          ? current
          : { width: box.width, height: box.height }
      ))
    })
    observer.observe(previewBodyNode)
    return () => observer.disconnect()
  }, [previewBodyNode])
  const fileQuery = useQuery({
    queryKey: ['library-preview-file', fileId ?? 'missing'],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${fileId}`, { signal }),
    enabled: open && !fileOverride && !inMemoryGcode
  })
  const file = fileOverride ?? fileQuery.data?.file ?? null
  const previewMode = useMemo(() => inMemoryGcode ? 'plate-gcode' : resolvePreviewMode(file), [file, inMemoryGcode])
  // A caller can replace the preview source without unmounting the overlay. Mark that boundary
  // before paint so chrome derived from the previous file cannot flash while the new queries settle.
  useLayoutEffect(() => {
    setViewerState({ loading: true, error: null })
  }, [fileId, versionId, inMemoryGcode])
  const platesQuery = useQuery({
    queryKey: ['library-preview-plates', fileId ?? 'missing', versionId ?? 'current'],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBase}/plates`, { signal }),
    enabled: Boolean(open && fileId && !inMemoryGcode && !isMeshPreviewMode(previewMode)),
    staleTime: 60_000,
    refetchOnMount: 'always'
  })
  const sceneQuery = useQuery({
    queryKey: ['library-preview-scene', fileId ?? 'missing', versionId ?? 'current', selectedPlate],
    queryFn: ({ signal }) => apiFetch<LibraryThreeMfScene>(`${resourceBase}/scene?plate=${selectedPlate}`, { signal }),
    // Fetched for the plated 3MF scene AND the G-code preview: the G-code path renders
    // toolpaths, but reads the scene's `bed` to draw the printer's true plate (size +
    // nozzle-only exclude zones) instead of a generic square grid.
    enabled: Boolean(open && fileId && !inMemoryGcode && (previewMode === '3mf' || previewMode === 'plate-gcode')),
    staleTime: 60_000,
    refetchOnMount: 'always'
  })
  const inMemoryIndex = useMemo(
    () => inMemoryGcode ? toThreeMfIndexDto(inMemoryGcode.project.index) : null,
    [inMemoryGcode]
  )
  const platesData = inMemoryIndex ?? platesQuery.data
  const plates = useMemo(() => platesData?.plates ?? [], [platesData])
  const sceneData = inMemoryGcode?.project.sceneForPlate(selectedPlate) ?? sceneQuery.data

  // The 3D build plate, honouring the same preference the editor writes, a plate that looks one
  // way while editing and another while previewing the slice of that same file is exactly the
  // inconsistency this shares. The scene carries the printer it was placed for; a file whose
  // printer is unknown, or a printer with no bundled mesh, keeps the plain grid.
  const showBedModel = useShowBedModel()
  const scenePrinterModel = sceneData?.bed.printerModel ?? null
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
      signal: controller.signal,
      basePath: inMemoryGcode ? '/api/public/slicing/bed-model' : undefined
    }).then((geometry) => {
      if (controller.signal.aborted) geometry?.dispose()
      else replaceGeometry(geometry)
    })
    return () => controller.abort()
  }, [inMemoryGcode, open, showBedModel, scenePrinterModel])
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
  // options), or the containers remount. Plate switches and query-state flips reuse it:
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
    // Start in the same direction the loaded content will use. Starting plated scenes at a generic
    // vector made the first visible frames rotate rapidly when attachObject applied the real preset.
    const initialDirection = previewMode === 'plate-gcode'
      ? PREVIEW_HOME_VIEW_DIRECTION
      : VIEW_PRESET_CONFIG.iso.direction
    camera.position.set(
      initialDirection.x * 200,
      initialDirection.y * 200,
      initialDirection.z * 200
    )

    // Log depth only for the plated 3MF scene, whose coincident coplanar part surfaces
    // z-fight across the wide depth range. G-code toolpaths have no such geometry, and
    // logarithmic depth writes gl_FragDepth, which disables early-Z rejection, a real
    // per-fragment cost when the toolpath mesh runs to millions of double-sided triangles.
    let renderer: THREE.WebGLRenderer
    try {
      renderer = createWebglRenderer({ antialias: true, logarithmicDepthBuffer: isThreeMfScene })
    } catch {
      // The browser refused a context (blocked after repeated loss, GPU process still recovering,
      // or out of contexts). Distinct from a mid-session loss: retrying cannot help.
      setViewerContextFailure('refused')
      return
    }
    // Cap DPR at 2 (matching the editor / view cube) to bound GPU/battery cost
    // on high-DPI phones and 4K displays.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
    renderer.shadowMap.enabled = isThreeMfScene
    // See `useEditorScene`: the soft variant was removed in r185 and is rewritten to this one at
    // render time, so the preview names the type it actually gets and stays matched to the editor.
    renderer.shadowMap.type = THREE.PCFShadowMap
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    // Middle-drag PANS, matching the editor viewport and every CAD viewer; three.js defaults
    // the middle button to dolly, which just duplicates the wheel.
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }
    controls.enableDamping = true
    controls.dampingFactor = 0.28
    controls.enablePan = true
    // Zoom toward the POINTER, not the orbit target. OrbitControls dollies by a MULTIPLICATIVE
    // factor toward `target`, so each step covers less ground as you approach and the approach
    // asymptotes: reported as "the more I zoom in, the slower zooming becomes, to the point I
    // can't get as close as I'd like". `zoomToCursor` also walks the target toward the cursor, so
    // rotation stops swinging around the plate centre once you have zoomed into a detail.
    controls.zoomToCursor = true
    const releaseTouchOrbitGuard = guardTouchOrbitTransition(renderer.domElement, controls)

    let needsRender = true
    const rigState: PreviewRig = {
      scene,
      camera,
      controls,
      stlGrid: null,
      viewDistance: 200,
      platedFrameRadius: 1,
      platedContentSize: null,
      contentRadius: 0,
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

    // The SAME swing and pivot the editor uses; see `viewportCamera.ts` for why they are one
    // implementation rather than one each. `invalidate` marks the frame dirty, so an animating
    // camera keeps drawing while an idle preview still costs nothing.
    const cameraRig = createViewportCameraRig(camera, controls, rigState.invalidate)

    const applyViewDirection = (from: { x: number; y: number; z: number }) => {
      if (camera instanceof THREE.OrthographicCamera && rigState.platedContentSize) {
        const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
        rigState.platedFrameRadius = Math.max(
          computeOrthoFrameRadiusForDirection(rigState.platedContentSize, aspect, from),
          30
        )
        applyPlatedOrthoProjection()
      }
      // Always framed on the subject: this camera has no pan of its own to preserve, so unlike the
      // editor's there is no keep-my-view variant to offer. `camera.up` is left to the rig, which
      // pins it to world Z -- writing a preset's own up here re-based every later drag onto a
      // different axis, and the straight-down presets carry a hair of lean in their DIRECTION
      // instead (see `VIEW_PRESET_CONFIG`).
      cameraRig.swingTo({
        direction: from,
        target: new THREE.Vector3(0, 0, 0),
        distance: rigState.viewDistance
      })
    }
    rigState.applyViewPreset = (preset: ViewPreset) => applyViewDirection(VIEW_PRESET_CONFIG[preset].direction)

    // Double-click, the edges and corners, the modifiers and the hint all arrive through the shared
    // cube; `reframe` has nothing to opt out of here, since this camera always frames its subject.
    const viewCube = createViewCube(viewCubeContainer, ({ region }) => {
      applyViewDirection(region.direction)
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
      // BEFORE update(), and update() is SKIPPED while a swing runs: it ends in lookAt(target),
      // which would rebuild the roll from the direction every frame and undo the interpolation.
      const swinging = cameraRig.advance(performance.now())
      // update() re-applies damping and detects external camera moves; it fires 'change'
      // (-> invalidate) only when the camera actually moved, so an idle preview skips the
      // render below entirely, no steady-state GPU cost.
      if (!swinging) controls.update()
      if (needsRender) {
        needsRender = false
        // Refit the depth range to the content before every draw. The G-code preview renders with
        // a LINEAR depth buffer (log depth is off here on purpose, it costs early-Z on a
        // million-triangle toolpath mesh), so a fixed 0.1-to-10000 range resolves depth to about a
        // tenth of a millimetre at the framed distance: coarser than a layer, and far coarser than
        // the 0.01mm the grid and nozzle-only zones sit above the plate. Everything z-fought.
        if (camera instanceof THREE.PerspectiveCamera && rigState.contentRadius > 0) {
          const { near, far } = fitPerspectiveDepthRange(camera.position.distanceTo(controls.target), rigState.contentRadius)
          if (camera.near !== near || camera.far !== far) {
            camera.near = near
            camera.far = far
            camera.updateProjectionMatrix()
          }
        }
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
      setViewerContextFailure('lost')
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
    // viewer owns a live renderer, two full scenes must not render concurrently.
    const releaseOverlayHold = acquireOverlayViewerHold()

    setRig(rigState)

    return () => {
      releaseOverlayHold()
      setRig(null)
      cancelAnimationFrame(frame)
      // Before forceContextLoss below, which fires webglcontextlost on our own canvas:
      // the handler must not misread our deliberate teardown as a GPU failure.
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      window.removeEventListener('resize', onResize)
      resizeObserver?.disconnect()
      controls.removeEventListener('change', rigState.invalidate)
      releaseTouchOrbitGuard()
      cameraRig.dispose()
      controls.dispose()
      renderer.dispose()
      // Release the context immediately: contexts left to GC count against the browser's
      // live-context cap, and hitting the cap evicts the OLDEST live context: killing a
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
      (!inMemoryGcode && fileQuery.isLoading)
      || (!inMemoryGcode && !isMeshPreviewMode(previewMode) && platesQuery.isLoading)
      // Wait for the scene on both plated modes so the bed is known before the first draw.
      || (!inMemoryGcode && isPlatedPreview && sceneQuery.isLoading)
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

    if ((!fileId && !inMemoryGcode) || (!file && !inMemoryGcode) || !previewMode) {
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
      // Frame the model alone, but fit depth to everything we draw. The floor grid is
      // much wider than small models; excluding it clips its lines at the model's near/far planes.
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      rig.contentRadius = previewDepthRadius(
        sphere.radius,
        rig.stlGrid ? new THREE.Box3().setFromObject(rig.stlGrid) : undefined
      )
      const maxDimension = Math.max(size.x, size.y, size.z, 20)
      const distance = isPlatedPreview
        ? Math.max(sphere.radius * 3, maxDimension * 2, 120)
        : Math.max(maxDimension * 1.6, 80)
      rig.viewDistance = distance
      if (camera instanceof THREE.OrthographicCamera) {
        rig.platedContentSize = size.clone()
        camera.near = Math.max(distance / 20, 0.8)
        camera.far = Math.max(distance * 6, 1200)
      }
      // The perspective camera's planes are NOT set here: the render loop refits them to
      // `contentRadius` every frame, which is what keeps the toolpath layers and the bed overlays
      // out of one another's depth bucket at any zoom (see lib/previewDepthRange.ts).
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
    setGcodeLayerHeightWidthReference(null)
    setGcodeLayerEventMarkers([])
    setGcodeStats(null)
    setGcodeRanges(null)
    setGcodeConflict(null)
    setGcodeConflictInput(null)
    setSceneProgress(null)
    if (isMeshPreviewMode(previewMode)) {
      // Both STL and STEP load from /mesh: it returns STL bytes (STL verbatim, STEP
      // server-tessellated to BambuStudio-matched quality) through sendModelBuffer, so the
      // body is chunk-streamed + gzipped, it survives the Vite dev proxy (a raw /download
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
      // A library preview uses the stall-guarded web->API->bridge reader. The public editor
      // already holds the output archive, so it reads that private artifact directly in the tab.
      const gcodeText = inMemoryGcode
        ? Promise.resolve().then(() => readInMemoryPlateGcode(inMemoryGcode, selectedPlate))
        : fetchModelText(buildApiUrl(`${resourceBase}/plate-gcode?plate=${selectedPlate}`), {
            credentials: 'include',
            signal: loadAbortController.signal
          })
      void gcodeText
        .then((text) => {
          if (cancelled) return
          const parsed = parseGcodeLayers(text)
          if (parsed.layerCount === 0) throw new Error('This plate does not include previewable G-code geometry.')
          const preview = buildLayeredGcodePreview(parsed)
          gcodePreviewRef.current = preview
          setGcodeLayerCount(preview.layerCount)
          setGcodeLayerHeightWidthReference(maxGcodeLayerHeightReference(parsed.layerZ))
          const plate = plates.find((entry) => entry.index === selectedPlate) ?? plates[0]
          setGcodeLayerEventMarkers(buildGcodeLayerEventMarkers(parsed.layerZ, {
            pauses: plate?.pauses,
            filamentChanges: plate?.filamentChanges,
            projectFilaments: platesData?.projectFilaments
          }, {
            pauseLayers: parsed.pauseLayers,
            filamentChangeLayers: parsed.filamentChangeLayers
          }))
          setGcodeTopLayer(preview.layerCount - 1)
          setGcodeSingleLayer(false)
          setGcodeMoveEnd(null)
          // The visibility-aware effect below immediately replaces this baseline after the layer
          // count lands, without making a visibility toggle rebuild the parsed preview.
          setGcodeMoveCount(preview.moveCount(preview.layerCount - 1))
          setGcodeStats(parsed.stats)
          setGcodeRanges(parsed.ranges)
          setGcodeConflictInput(parsed)
          attachObject(buildPlateGcodePreviewObject(preview.object, sceneData?.bed ?? null, bedModel))
        })
        .catch(handleLoadError)
    } else {
      if (!sceneData) {
        setViewerState({ loading: false, error: 'No plated 3D scene is available for this 3MF.' })
        return
      }

      // Show the plate (correctly oriented) immediately, then stream the parts in off the main thread
      // so each model appears as it parses with an "N of M" bar, instead of the whole plate blocking
      // on one big synchronous DOM parse and popping in at once.
      const plateGroup = buildPlatePreviewBed(sceneData, bedModel)
      attachObject(plateGroup)
      void streamThreeMfSceneParts(createLibraryThreeMfEntryBytesLoader(resourceBase), sceneData, plateGroup, loadAbortController.signal, (done, total) => {
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
    inMemoryGcode,
    resourceBase,
    fileQuery.error,
    fileQuery.isLoading,
    fileQuery.isSuccess,
    platesQuery.isLoading,
    sceneData,
    sceneQuery.error,
    sceneQuery.isLoading,
    previewMode,
    selectedPlate,
    plates,
    platesData?.projectFilaments,
    // The bed mesh resolves asynchronously (and flips with the preference), so the content has to
    // rebuild when it lands, otherwise the plate keeps whichever surface it was first built with.
    bedModel
  ])

  // Track the chronological moves represented by the current visibility choices. Changing the
  // layer or the visible path kinds resets the within-layer scrub to "whole layer".
  useEffect(() => {
    if (gcodeLayerCount === 0) return
    setGcodeMoveEnd(null)
    setGcodeMoveCount(gcodePreviewRef.current?.moveCount(gcodeTopLayer, {
      showTravel: gcodeShowTravel,
      markers: gcodeMarkers
    }) ?? 0)
  }, [gcodeTopLayer, gcodeLayerCount, gcodeShowTravel, gcodeMarkers])

  // Apply the layer + move sliders to the built G-code preview (draw-range only; cheap).
  useEffect(() => {
    if (gcodeLayerCount === 0) return
    gcodePreviewRef.current?.setVisibleLayers(gcodeTopLayer, {
      single: gcodeSingleLayer,
      showTravel: gcodeShowTravel,
      markers: gcodeMarkers,
      moveEnd: gcodeMoveEnd == null ? undefined : Math.max(GCODE_REPLAY_START, gcodeMoveEnd)
    })
    // Draw ranges change what's on screen without a camera move; redraw.
    rig?.invalidate()
  }, [gcodeTopLayer, gcodeSingleLayer, gcodeShowTravel, gcodeMarkers, gcodeMoveEnd, gcodeLayerCount, rig])

  // Look for toolpath conflicts, in TIME SLICES after the preview has painted.
  //
  // The whole scan is about a second on a real 460k-segment plate. A plain `setTimeout` would only
  // move that off the opening frame, not break it up: the task itself is uninterruptible, so the
  // tab would still freeze for that whole second while the user is trying to scrub. The scan
  // yields per layer, and this drains it in short slices, so the preview stays interactive while
  // it answers a question almost every plate answers "no" to.
  //
  // It reads the parse's position arrays, so the parse is released the moment it finishes, and a
  // plate switch cancels a run in flight rather than letting a stale answer land on the new plate.
  useEffect(() => {
    if (!gcodeConflictInput) return
    let cancelled = false
    let handle: ReturnType<typeof setTimeout>
    const scan = scanGcodeToolpathConflicts(gcodeConflictInput)
    const pump = () => {
      if (cancelled) return
      const deadline = performance.now() + CONFLICT_SCAN_SLICE_MS
      let step = scan.next()
      while (!step.done && performance.now() < deadline) step = scan.next()
      if (step.done) {
        setGcodeConflict(step.value)
        setGcodeConflictInput(null)
        return
      }
      handle = setTimeout(pump, 0)
    }
    handle = setTimeout(pump, 0)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [gcodeConflictInput])

  // Apply the colour scheme. Separate from the scrub effect above because it is the expensive one
  // (a pass over every segment, ~25ms on a 460k-segment plate, plus an ~11 MiB colour re-upload)
  // and must not re-run on every drag of the layer slider.
  //
  // Travel visibility is folded into the dependency ONLY in the Speed view, because that is the
  // one metric whose range depends on it (`gcodeMetricRange`). Depending on it unconditionally
  // made every Travel toggle in the default Feature view rewrite all 460k segments with the
  // colours they already had and re-upload the buffer, for no visible change at all.
  const gcodeViewModeTravelKey = gcodeViewModeMetric(gcodeViewMode) === 'feedrate' ? gcodeShowTravel : false
  useEffect(() => {
    if (gcodeLayerCount === 0) return
    gcodePreviewRef.current?.setViewMode(gcodeViewMode, { showTravel: gcodeViewModeTravelKey })
    rig?.invalidate()
  }, [gcodeViewMode, gcodeViewModeTravelKey, gcodeLayerCount, rig])

  // A stale failure overlay must not survive a close/reopen of the modal. Reopening genuinely is
  // a fresh attempt even for 'refused': the block is per document, and the browser may have
  // recovered by then; if it has not, the next construction sets 'refused' again immediately.
  useEffect(() => {
    if (!open) setViewerContextFailure(null)
  }, [open])

  // Keyboard scrubbing (Bambu-style): Up/Down step the visible top layer, Left/Right scrub
  // moves within that layer: mirroring the on-screen layer and move sliders. Active only
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
          setGcodeMoveEnd((end) => Math.max((end ?? gcodeMoveCount) - 1, GCODE_REPLAY_START))
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

  let heading = '3D plate preview'
  if (previewMode === 'plate-gcode') heading = 'G-code preview'
  else if (isMeshPreviewMode(previewMode)) heading = '3D preview'
  const showPlatePicker = !isMeshPreviewMode(previewMode) && plates.length > 0

  // Either enlarged mode switches the body from a scrolling column to a flex column so the viewer
  // fills the freed height instead of keeping its fixed dvh band.
  const expanded = presentation !== 'standard'
  const showPreviewChrome = !fullScreen
  const gcodeOverlaysReady = previewMode === 'plate-gcode' && !viewerState.loading && !viewerState.error
  const showsGcodeLayerColumn = gcodeOverlaysReady && gcodeLayerCount > 1
  // Every parsed preview layer owns at least one extrusion move. Keep the rail present for that
  // one-move case: hiding it made the first layer look as though it contained no moves at all.
  const showsGcodeMovesStrip = gcodeOverlaysReady && gcodeMoveCount > 0
  const gcodeLayerCounterWidthReference = `${gcodeLayerCount}/${gcodeLayerCount}`
  const gcodeMoveCounterWidthReference = `${gcodeMoveCount}/${gcodeMoveCount}`
  const visibleGcodeMoveEnd = Math.max(GCODE_REPLAY_START, gcodeMoveEnd ?? gcodeMoveCount)
  const gcodeLayerHeight = gcodePreviewRef.current?.layerZ(gcodeTopLayer)
  const showMobileLegendButton = isMobile && gcodeOverlaysReady && Boolean(gcodeStats && gcodeRanges)
  // Reserve the eventual scrubber tracks while G-code parses so their arrival populates chrome
  // instead of resizing the WebGL canvas. Once loaded, a genuinely one-layer/empty file may drop
  // an inapplicable track, while normal multi-layer G-code keeps the exact reserved geometry.
  const reservesLoadingGcodeChrome = previewMode === 'plate-gcode' && viewerState.loading
  const laysOutGcodeLayerColumn = showsGcodeLayerColumn || reservesLoadingGcodeChrome
  const laysOutGcodeMovesStrip = showsGcodeMovesStrip || reservesLoadingGcodeChrome

  let gcodeGridColumns = 'minmax(0, 1fr)'
  if (laysOutGcodeLayerColumn && !isMobile) {
    gcodeGridColumns += ` ${GCODE_VERTICAL_SCRUBBER_WIDTH_PX}px`
  }

  const horizontalScrubberTrack = `${GCODE_HORIZONTAL_SCRUBBER_HEIGHT_PX}px`
  const gcodeGridRowTracks = ['minmax(0, 1fr)']
  if (isMobile && laysOutGcodeLayerColumn) gcodeGridRowTracks.unshift(horizontalScrubberTrack)
  if (laysOutGcodeMovesStrip) gcodeGridRowTracks.push(horizontalScrubberTrack)
  const gcodeGridRows = gcodeGridRowTracks.join(' ')
  const viewportGridRow = isMobile
    ? 1 + Number(laysOutGcodeLayerColumn)
    : 1
  const movesGridRow = viewportGridRow + 1
  // Where the controls that still float over the viewport sit. The scrubbers have their own grid
  // tracks outside the 3D area, so they no longer participate in corner collision arithmetic.
  const chrome = previewChromeLayout({ showLegendToggle: showMobileLegendButton })
  // Same rule the editor uses: the strip runs along whichever axis leaves the 3D area best
  // proportioned. There is no sidebar here, so the whole body width is the viewport's to spend.
  const plateStripOrientation = choosePlateStripOrientation({
    bodyWidth: previewBodySize.width,
    bodyHeight: previewBodySize.height,
    sidebarWidth: 0,
    gap: EDITOR_GRID_GAP_PX
  })
  /**
   * Only adapt the axis while EXPANDED, where the body is `flex: 1 1 0` and its box is set by the
   * dialog. Un-expanded the body is content-sized over a fixed-height 3D band, so its height
   * DEPENDS on whether the strip is a row: feeding that back into the chooser is a loop whose two
   * states can map to each other and flip-flop forever. It is also the right answer on the merits:
   * a fixed 62dvh band has no height for a rail to reclaim.
   */
  const platesVertical = showPlatePicker && expanded && plateStripOrientation === 'vertical'
  return (
    <>
      <Modal open onClose={onClose}>
      <ScrollableModalDialog
        variant="outlined"
        presentation={presentation}
        // Only the standard footprint is this view's to pick; the enlarged modes are the shared
        // geometry, applied over this by the shell.
        sx={{ width: { xs: '100%', md: 1120 }, maxWidth: '100%', ...(fullScreen ? { p: 0 } : null) }}
      >
        {/* Maximize resizes the DIALOG, so it belongs in the dialog's header. Its full-screen
            sibling does not: that enlarges the 3D area alone, so its toggle sits on the 3D area
            (below), the way the editor's viewport toolbar carries it. */}
        {showPreviewChrome && !isMobile && (
          <MaximizeDialogButton
            active={maximized}
            onToggle={setMaximized}
            sx={{ position: 'absolute', top: 12, right: 52, zIndex: 2 }}
          />
        )}
        {/* No `onClick`: Joy closes the dialog through the Modal's own `onClose` before it would
            reach one, so passing `onClose` here closed the preview twice per click. */}
        {showPreviewChrome && <ModalClose sx={{ top: 12, right: 12, zIndex: 2 }} />}
        {/* Extra right padding clears the header icons (maximize/shrink + close). */}
        {showPreviewChrome && (
          <DialogFileTitle title={heading} fileName={inMemoryGcode?.fileName ?? (file ? formatLibraryFileName(file.name) : null)} sx={{ pr: 12 }} />
        )}
        <ScrollableDialogBody
          ref={setPreviewBodyNode}
          sx={{
            pt: fullScreen ? 0 : 1.5,
            ...(expanded
              ? { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
              : null)
          }}
          contentSx={expanded
            ? { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }
            : undefined}
        >
          <Stack
            spacing={fullScreen ? 0 : 1.5}
            // The rail is a COLUMN beside the 3D area; a band stacks above it as before.
            direction={platesVertical ? 'row' : 'column'}
            sx={{ minWidth: 0, ...(expanded ? { flex: 1, minHeight: 0 } : null) }}
          >
            {showPlatePicker && inMemoryGcode && plates.length > 1 && showPreviewChrome && (
              <Sheet key="plate-select" variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
                <FormControl size="sm">
                  <FormLabel>Plate</FormLabel>
                  <Select
                    value={selectedPlate}
                    onChange={(_event, value) => { if (value != null) setSelectedPlate(value) }}
                  >
                    {plates.map((plate) => (
                      <Option key={plate.index} value={plate.index}>
                        {plate.name?.trim() || `Plate ${plate.index}`}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
              </Sheet>
            )}
            {showPlatePicker && fileId && !inMemoryGcode && showPreviewChrome && (
              <Sheet
                key="plate-strip"
                variant="outlined"
                sx={{ p: 1, borderRadius: 'sm', ...(platesVertical ? { width: PLATE_STRIP_VERTICAL_THICKNESS, flexShrink: 0, display: 'flex', minHeight: 0 } : null) }}
              >
                <Box sx={{ width: '100%', minWidth: 0, ...(platesVertical ? { display: 'flex', minHeight: 0 } : null) }}>
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
                    orientation={platesVertical ? 'vertical' : 'horizontal'}
                  />
                </Box>
              </Sheet>
            )}
            <Box
              key="viewer-grid"
              sx={{
                // The scrubbers are viewport CHROME, not viewport CONTENT: their own grid tracks
                // keep them from covering toolpaths and give the vertical rail a true centre line.
                height: expanded ? 'auto' : { xs: '50dvh', sm: '62dvh' },
                flex: expanded ? 1 : 'initial',
                minWidth: 0,
                minHeight: fullScreen ? 0 : { xs: 300, sm: 360 },
                gridTemplateColumns: gcodeGridColumns,
                gridTemplateRows: gcodeGridRows,
                gap: fullScreen ? 0 : 0.5,
                display: 'grid'
              }}
            >
              {showsGcodeMovesStrip && (
                <Sheet
                  variant="outlined"
                  sx={{
                    ...HORIZONTAL_GCODE_SCRUBBER_SX,
                    gridColumn: 1,
                    gridRow: movesGridRow,
                    borderRadius: fullScreen ? 0 : 'sm',
                    display: 'flex'
                  }}
                >
                  <Typography level="body-xs" textColor="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                    Moves
                  </Typography>
                  <Slider
                    size="sm"
                    min={GCODE_REPLAY_START}
                    max={gcodeMoveCount}
                    value={visibleGcodeMoveEnd}
                    onChange={(_event, value) => {
                      const next = typeof value === 'number' ? value : value[0] ?? GCODE_REPLAY_START
                      setGcodeMoveEnd(Math.max(GCODE_REPLAY_START, next))
                    }}
                    aria-label="G-code moves within the top layer"
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      mx: `${GCODE_SLIDER_END_INSET_PX}px`
                    }}
                  />
                  {!isMobile && (
                    <GcodeScrubberValueChip
                      value={`${visibleGcodeMoveEnd}/${gcodeMoveCount}`}
                      widthReference={gcodeMoveCounterWidthReference}
                    />
                  )}
                </Sheet>
              )}
              <Sheet
                variant="soft"
                sx={{
                  gridColumn: 1,
                  gridRow: viewportGridRow,
                  minWidth: 0,
                  minHeight: 0,
                  borderRadius: fullScreen ? 0 : 'md',
                  position: 'relative',
                  overflow: 'hidden',
                  bgcolor: '#0d1322'
                }}
              >
              <Box ref={setViewerContainer} sx={{ position: 'absolute', inset: 0 }} />
              {isMobile && gcodeOverlaysReady && (
                <Stack
                  direction="row"
                  spacing={0.5}
                  sx={{ position: 'absolute', top: 8, left: 8, zIndex: 1, flexWrap: 'wrap' }}
                >
                  <GcodeScrubberValueChip
                    value={`Layer ${gcodeTopLayer + 1}/${gcodeLayerCount}`}
                    widthReference={`Layer ${gcodeLayerCounterWidthReference}`}
                  />
                  {gcodeLayerHeight != null && gcodeLayerHeightWidthReference != null && (
                    <GcodeScrubberValueChip
                      value={`Z ${gcodeLayerHeight.toFixed(2)} mm`}
                      widthReference={`Z ${gcodeLayerHeightWidthReference}`}
                    />
                  )}
                  <GcodeScrubberValueChip
                    value={`Moves ${visibleGcodeMoveEnd}/${gcodeMoveCount}`}
                    widthReference={`Moves ${gcodeMoveCounterWidthReference}`}
                  />
                </Stack>
              )}
              {/* On the 3D area, not in the dialog header: this mode enlarges the viewport alone, so
                  the control belongs on the thing it resizes. The editor's viewport toolbar carries
                  its twin the same way. `soft` because `plain` disappears against the scene. */}
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  position: 'absolute',
                  top: safeFullscreenControlTop(fullScreen, chrome.fullScreenToggle.top),
                  right: chrome.fullScreenToggle.right,
                  zIndex: 2
                }}
              >
                {showMobileLegendButton && (
                  <Tooltip title="Toolpath legend and statistics">
                    <IconButton
                      size="sm"
                      variant="soft"
                      onClick={() => setMobileLegendOpen(true)}
                      aria-label="Show the toolpath legend"
                    >
                      <QueryStatsRoundedIcon />
                    </IconButton>
                  </Tooltip>
                )}
                <FullScreenDialogButton
                  active={fullScreen}
                  onToggle={setFullScreen}
                  contentLabel="3D only"
                  variant="soft"
                />
              </Stack>
              {viewerState.loading && (
                <ViewportBuildOverlay />
              )}
              {sceneProgress && !viewerState.loading && !viewerState.error && (
                <ViewportBuildOverlay progress={sceneProgress} />
              )}
              {viewerState.error && !viewerState.loading && (
                <Alert color="warning" variant="soft" sx={{ position: 'absolute', top: 16, left: 16, right: 16, zIndex: 1 }}>
                  {viewerState.error}
                </Alert>
              )}
              {viewerContextFailure && (
                // The WebGL context was reclaimed (GPU pressure, driver reset). The canvas
                // is permanently blank until rebuilt, so offer an explicit reload instead
                // of leaving a dead view.
                <Stack
                  spacing={1}
                  alignItems="center"
                  justifyContent="center"
                  sx={{ position: 'absolute', inset: 0, zIndex: 2, bgcolor: 'rgba(8, 11, 20, 0.6)', backdropFilter: 'blur(2px)' }}
                >
                  <Typography level="body-sm" textColor="neutral.200" sx={{ textAlign: 'center', px: 2 }}>
                    {viewerContextFailure === 'refused'
                      ? 'The browser has blocked new 3D views on this page. Reloading the page restores it.'
                      : 'The 3D view was interrupted by the browser.'}
                  </Typography>
                  {viewerContextFailure === 'refused' ? (
                    <Button size="sm" variant="soft" onClick={() => { window.location.reload() }}>
                      Reload page
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="soft"
                      onClick={() => {
                        setViewerContextFailure(null)
                        setRigGeneration((generation) => generation + 1)
                      }}
                    >
                      Reload 3D view
                    </Button>
                  )}
                </Stack>
              )}
              {!isMobile && previewMode === 'plate-gcode' && gcodeStats && gcodeRanges && !viewerState.loading && !viewerState.error && (
                <GcodeToolpathPanel
                  stats={gcodeStats}
                  ranges={gcodeRanges}
                  plate={plates.find((plate) => plate.index === selectedPlate) ?? null}
                  layerCount={gcodeLayerCount}
                  open={gcodeStatsOpen}
                  onToggle={() => setGcodeStatsOpen(!gcodeStatsOpen)}
                  viewMode={gcodeViewMode}
                  onViewModeChange={setGcodeViewMode}
                  showTravel={gcodeShowTravel}
                  onShowTravelChange={setGcodeShowTravel}
                  markers={gcodeMarkers}
                  onMarkersChange={setGcodeMarkers}
                  onShowAllPlates={plates.length > 1 ? () => setAllPlatesStatsOpen(true) : undefined}
                  // Room for the conflict banner stacked above the view cube, when there is one.
                  bottomReservePx={gcodeConflict ? GCODE_CONFLICT_ALERT_RESERVE_PX : 0}
                />
              )}
              {showMobileLegendButton && mobileLegendOpen && gcodeStats && gcodeRanges && (
                <GcodeToolpathPanel
                  stats={gcodeStats}
                  ranges={gcodeRanges}
                  plate={plates.find((plate) => plate.index === selectedPlate) ?? null}
                  layerCount={gcodeLayerCount}
                  open
                  onToggle={() => setMobileLegendOpen(false)}
                  viewMode={gcodeViewMode}
                  onViewModeChange={setGcodeViewMode}
                  showTravel={gcodeShowTravel}
                  onShowTravelChange={setGcodeShowTravel}
                  markers={gcodeMarkers}
                  onMarkersChange={setGcodeMarkers}
                  onShowAllPlates={plates.length > 1 ? () => setAllPlatesStatsOpen(true) : undefined}
                  presentation="cover"
                />
              )}
              {gcodeConflict && (
                <Alert
                  color="warning"
                  variant="soft"
                  startDecorator={<WarningRoundedIcon />}
                  sx={{ position: 'absolute', ...chrome.gcodeConflictAlert, zIndex: 1 }}
                >
                  <Typography level="body-xs">
                    Toolpath conflict on layer {gcodeConflict.layer + 1} ({gcodeConflict.layerZ.toFixed(2)} mm).
                    Two objects print through the same point at
                    X{gcodeConflict.point.x.toFixed(1)} Y{gcodeConflict.point.y.toFixed(1)}.
                    Move them further apart and slice again.
                  </Typography>
                </Alert>
              )}
              <Box
                sx={{
                  position: 'absolute',
                  left: VIEW_CUBE_EDGE_INSET,
                  bottom: VIEW_CUBE_EDGE_INSET,
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
              {showsGcodeLayerColumn && (
                <Sheet
                  variant="outlined"
                  sx={{
                    ...(isMobile ? HORIZONTAL_GCODE_SCRUBBER_SX : {
                      minHeight: 0,
                      px: 0.25,
                      py: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 0.5
                    }),
                    gridColumn: isMobile ? 1 : 2,
                    gridRow: isMobile ? 1 : '1 / -1',
                    borderRadius: fullScreen ? 0 : 'sm',
                    flexDirection: isMobile ? 'row' : 'column',
                    display: 'flex'
                  }}
                >
                  {isMobile && (
                    <Typography level="body-xs" textColor="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                      Layers
                    </Typography>
                  )}
                  {!isMobile && (
                    <GcodeScrubberValueChip
                      value={`${gcodeTopLayer + 1}/${gcodeLayerCount}`}
                      widthReference={gcodeLayerCounterWidthReference}
                      sideways
                    />
                  )}
                  {/* The layer's print height: what a pause or filament change in the editor keys on. */}
                  {!isMobile && gcodeLayerHeight != null && gcodeLayerHeightWidthReference != null && (
                    <GcodeScrubberValueChip
                      value={`${gcodeLayerHeight.toFixed(2)} mm`}
                      widthReference={gcodeLayerHeightWidthReference}
                      sideways
                    />
                  )}
                  <GcodeLayerSlider
                    layerCount={gcodeLayerCount}
                    value={gcodeTopLayer}
                    markers={gcodeLayerEventMarkers}
                    onChange={setGcodeTopLayer}
                    orientation={isMobile ? 'horizontal' : 'vertical'}
                  />
                  <Box
                    component="label"
                    sx={{
                      display: 'flex',
                      flexDirection: isMobile ? 'row' : 'column',
                      alignItems: 'center',
                      gap: 0.5,
                      flexShrink: 0,
                      cursor: 'pointer'
                    }}
                  >
                    <Typography
                      level="body-xs"
                      textColor="text.secondary"
                      sx={isMobile
                        ? { whiteSpace: 'nowrap' }
                        : {
                            writingMode: 'vertical-rl',
                            textOrientation: 'sideways',
                            transform: 'rotate(180deg)',
                            lineHeight: 1,
                            textAlign: 'center'
                          }}
                    >
                      Single
                    </Typography>
                    <Checkbox
                      size="sm"
                      checked={gcodeSingleLayer}
                      onChange={(event) => setGcodeSingleLayer(event.target.checked)}
                      slotProps={{ input: { 'aria-label': 'Show only the selected layer' } }}
                    />
                  </Box>
                </Sheet>
              )}
            </Box>
          </Stack>
        </ScrollableDialogBody>
      </ScrollableModalDialog>
      </Modal>
      {/*
        A SIBLING of the preview modal, never a child of its dialog. Both are BackAwareModals, and
        each owns one history entry; nesting the second inside the first (or closing the first to
        open it) desynchronises that stack, and the inner dialog shuts the moment it appears.
        See the note in `components/library/EditorSettingsDialog.tsx`.
      */}
      <AllPlatesStatsDialog
        open={allPlatesStatsOpen}
        onClose={() => setAllPlatesStatsOpen(false)}
        plates={plates}
        projectFilaments={platesData?.projectFilaments ?? []}
      />
    </>
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
      {/* Same hint as the editor's, from the same constant: the cube behaves identically in both,
          and two wordings for one control is how they drift. Shift is mentioned even though this
          preview always frames its subject, because the sentence describes the CUBE. */}
      <Tooltip title={VIEW_CUBE_HINT} placement="right" enterDelay={600}>
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
      </Tooltip>
    </Box>
  )
}

/**
 * `mesh` covers every format `/mesh` serves as a single un-plated mesh -- STL verbatim, and STEP,
 * OBJ, glTF and AMF converted server-side. They were previously two modes (`stl` and `step`) that
 * every consumer had to test for together via `isMeshPreviewMode`, which is a list that grows with
 * each format for no benefit: nothing here ever needed to know WHICH one it was, because the bytes
 * arriving are STL either way.
 */
type PreviewMode = 'mesh' | '3mf' | 'plate-gcode' | null

function resolvePreviewMode(file: LibraryFile | null): PreviewMode {
  if (!file) return null
  if (isMeshLibraryFileKind(file.kind)) return 'mesh'
  // A geometry-only 3MF has no plated scene to render, it previews as a single mesh,
  // exactly like STL (`/mesh` serves its extracted geometry as STL bytes).
  if (file.kind === '3mf') return file.geometryOnly === true ? 'mesh' : '3mf'
  if (file.kind === 'gcode') return 'plate-gcode'
  return null
}

function isMeshPreviewMode(mode: PreviewMode): boolean {
  return mode === 'mesh'
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
 * ORIGIN (its minimum corner), never its centre: see lib/bedModel.ts for why centring skews it.
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
function buildPlateGcodePreviewObject(
  object: THREE.Object3D,
  bed: LibraryThreeMfScene['bed'] | null,
  bedModel: THREE.BufferGeometry | null
): THREE.Object3D {
  // The layered parser already emits raw G-code coordinates (printer Z-up), matching the
  // Z-up plated scene, so, unlike three's Y-up GCodeLoader output, no rotation is needed.
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
