/**
 * Interactive 3D plate editor (Bambu Studio "prepare" stage).
 *
 * Loads every plate of a 3MF project and lets the user arrange instances across
 * plates (move/rotate/scale, add/duplicate/delete, auto-arrange/orient), edit
 * materials and per-object overrides, paint supports/seams/colour, plane-cut and
 * split objects, add part volumes, place brim ears, schedule per-layer filament
 * changes, and measure — then hands back a `SceneEdit` (the locked shared
 * contract) on apply. Heavy: lazy-loaded by the `SlicingEditorAction` slot button
 * via `React.lazy`.
 *
 * Transform convention: each instance group's matrix is seeded by decomposing the
 * scene's plate-local 12-element transform (position/quaternion/scale, Euler XYZ).
 * On apply we read each group's position/rotation(Euler XYZ)/scale straight into
 * the `SceneEdit` instance — the backend recomposes M = T * R(eulerXYZ) * S. Values
 * stay plate-local (plate origin is never baked in).
 */
import { type ComponentProps, lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  LinearProgress,
  DialogActions,
  Drawer,
  IconButton,
  Input,
  Link,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import OpenWithRoundedIcon from '@mui/icons-material/OpenWith'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import ViewListRoundedIcon from '@mui/icons-material/ViewListRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import RedoRoundedIcon from '@mui/icons-material/RedoRounded'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import { useQuery } from '@tanstack/react-query'
import * as THREE from 'three'
import { OrbitControls, TransformControls } from 'three-stdlib'
import type {
  LibraryFile,
  LibraryFolder,
  LibraryThreeMfScene,
  ProcessSettingOverrides,
  SceneEdit,
  SceneEditAddedPartSubtype,
  SceneEditPartSubtype,
  StagedImport,
  ThreeMfIndex
} from '@printstream/shared'
import { PER_OBJECT_PROCESS_KEYS } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { resolveProjectFilamentColorName } from '../../lib/filamentColor'
import { buildApiUrl } from '../../lib/apiUrl'
import { toast } from '../../lib/toast'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { EmptyState } from '../../components/EmptyState'
import { LibraryFilePickerDialog } from '../../components/LibraryFilePickerDialog'
import { LibraryDestinationDialog } from '../../components/LibraryDestinationDialog'
import { splitLibraryFileNameForRename } from '../../lib/libraryDisplay'
import { useMobileViewport } from '../../components/useMobileViewport'
import { SliceSettingsPanel, type SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import {
  createPreviewPlateSurface,
  createThreeMfMatrix,
  createThreeMfPartObject,
  disposeObject3D,
  getGeometryTrianglePaint,
  isModifierVolumeSubtype
} from './lib/threeMfScene'
import { arrangePlateItems, FOOTPRINT_CELL_MM, footprintCellKey } from './lib/arrange'
import { PRIMITIVE_LABELS, primitivePartSoup, primitiveTriangleSoup, type PrimitiveKind } from './lib/primitives'
import {
  buildTrianglePaintOverlay,
  decodeWholeTriangleColorState
} from './lib/supportPaint'
import {
  VIEW_CUBE_SIZE,
  type ViewPreset
} from './lib/viewCube'
import { createPlateThumbnailRenderer, type PlateThumbnailRenderer } from './lib/plateThumbnail'
import {
  buildSceneEdit,
  duplicateInstance,
  fillPlateFromScene,
  findFreePlatePosition,
  instanceFromStagedImport,
  replaceInstanceGeometry,
  reindexPlates,
  effectiveAddedParts,
  effectiveBrimEars,
  effectiveFilamentChanges,
  effectivePauses,
  nextInstanceKey,
  seedEditorState,
  seedEmptyEditorState,
  supportPaintKey,
  type EditorAddedPart,
  type EditorBrimEar,
  type EditorFilamentChange,
  type EditorPause,
  type EditorInstance,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'
import {
  fetchImportMesh,
  stageImportFromFile,
  stageImportFromLibrary
} from './lib/editorImports'
import { fetchModelBytes } from './lib/modelFetch'
import { parseStlGeometryAsync, parseThreeMfModelEntryAsync } from './lib/meshParseClient'
import {
  collectWorldTriangles,
  cutTriangleSoup,
  rebaseTriangleSoup,
  splitTriangleSoup,
  triangleSoupToBinaryStl,
  type CutAxis
} from './lib/meshCut'
import {
  ADDED_PART_MESH_NAME,
  ADDED_PART_SPECS,
  ADDED_PART_SUBTYPES,
  applyLayerBandOverlays,
  bedsEqual,
  BRIM_EAR_MARKER_COLOR,
  BRIM_EAR_MARKER_NAME,
  buildFaceHullOverlay,
  computeFootprintCells,
  createMeasureLabelSprite,
  createPrimeTowerObject,
  CUT_AXIS_SIDES,
  DOWN_VECTOR,
  evictGeometryCache,
  FILAMENT_CHANGE_MAX_BANDS,
  LAYER_PAUSE_MAX_STRIPES,
  GEOMETRY_CACHE_MAX_ENTRIES,
  KEY_MOVE_STEP,
  KEY_MOVE_STEP_FINE,
  KEY_MOVE_STEP_LARGE,
  KEY_ROTATE_STEP,
  largestHullFaceNormal,
  nextPaint,
  PAINT_CHANNEL_SPECS,
  paintChannelForGizmoMode,
  printableMeshBox,
  rasterizePolygonCells,
  restObjectOnBed,
  ROTATE_SNAP_COARSE,
  ROTATE_SNAP_FINE,
  rotorOf,
  setObjectPrintedStyle,
  syncBrimEarMarkerMatrices,
  touchCacheEntry,
  zoneRequiredNozzle,
  type LayerBandUniforms,
  type GeometryCache,
  type GizmoMode,
  type ImportGeometryCache,
  type PlacementWarning,
  type SelectedTransform
} from './editorGeometry'
import {
  AddModelMenu,
  FilamentOptionContent,
  GizmoToolbar,
  isImportableLibraryFile,
  KeyboardHelpButton,
  ModelList,
  PlatePausesSection,
  PlateThumbnailStrip,
  SaveSplitButton,
  SliceSplitButton,
  TOOL_PANEL_TOP,
  TransformPanel
} from './editorPanels'
import { BrimEarsPanel } from './BrimEarsPanel'
import { CutToolPanel } from './CutToolPanel'
import { EditorContextMenu } from './EditorContextMenu'
import { EditorPartContextMenu } from './EditorPartContextMenu'
import {
  prunePartSelection,
  rangePartSelection,
  rangeSlice,
  togglePartInSelection,
  type PartSelection
} from './lib/selectionModel'
import { MeasurePanel } from './MeasurePanel'
import { PaintToolPanel } from './PaintToolPanel'
import { useEditorHistory } from './useEditorHistory'
import { useEditorPaint } from './useEditorPaint'
import { useEditorSave } from './useEditorSave'
import { useEditorScene } from './useEditorScene'

/**
 * The 1-based filament ids referenced as support material by a process-override map
 * (`support_filament` / `support_interface_filament`). `'0'` / non-positive means "use the
 * default", i.e. no specific material — those are ignored. Used to count support materials as
 * "in use" for the material remove-guard.
 */
function supportFilamentRefs(overrides: Record<string, string | string[]> | undefined): number[] {
  if (!overrides) return []
  const ids: number[] = []
  for (const key of ['support_filament', 'support_interface_filament']) {
    const raw = overrides[key]
    const value = Array.isArray(raw) ? raw[0] : raw
    const id = value != null ? Number.parseInt(value, 10) : Number.NaN
    if (Number.isInteger(id) && id > 0) ids.push(id)
  }
  return ids
}

// Code-split the heavy process-settings catalog (validation + full settings catalogue) out of the
// editor chunk; it loads only when a settings dialog is first opened. A LOCAL Suspense wrapper means
// that first open suspends just the dialog, not the whole editor (which sits under an ancestor
// Suspense via the slot's lazy load). Matches LibraryView's treatment of the same component.
const ProcessSettingsDialogImpl = lazy(() => import('../../components/ProcessSettingsDialog'))
function ProcessSettingsDialog(props: ComponentProps<typeof ProcessSettingsDialogImpl>) {
  return (
    <Suspense fallback={null}>
      <ProcessSettingsDialogImpl {...props} />
    </Suspense>
  )
}

interface EditorViewProps {
  /** Source project to edit, or null for a brand-new empty project. */
  baseFileId: string | null
  /**
   * The base is a brand-new project's throwaway scaffold (a hidden 3MF). The scaffold provides
   * the bed/settings so geometry still loads from it, but saving must NOT overwrite it: the
   * editor shows "New Project" and its Save prompts for a name + destination (Save as new).
   */
  isNewProject?: boolean
  /**
   * Archived version of `baseFileId` to edit (history dialog's Edit flow). Scenes and
   * geometry load from the version's bytes; saving still creates a NEW version of the
   * parent file rather than mutating this one.
   */
  baseVersionId?: string | null
  /** Pre-existing edit to resume from (currently used only to know an edit was active). */
  currentEdit?: SceneEdit | null
  /** Plate to open on (1-based); the editor still loads and shows every plate. */
  initialPlateIndex?: number
  /** Target printer model selected in the slice dialog; overrides the bed + zones. */
  targetPrinterModel?: string
  /** Slice-time apply (only present when launched from the slice dialog). */
  onApply?: (edit: SceneEdit) => void
  /** Library folder + bridge to save new files into (from the host context). */
  folderId?: string | null
  bridgeId?: string | null
  /** Called after a successful save with the resulting library file. */
  onSaved?: (file: { id: string; name: string }) => void
  onClose: () => void
  /**
   * Per-object override access (only present when launched from the slice dialog).
   * The editor's Objects tab shows a "Per-object settings" button that opens the
   * host's dialog, which stacks above the editor. The global process/preset and
   * all other slice settings live in the shared `sliceConfig` panel.
   */
  objectOverrideCount?: number
  hasPlateObjects?: boolean
  canEditSettings?: boolean
  onEditObjectSettings?: () => void
  /**
   * Full slice-settings controller (printer/process/filament/plate-type/nozzle)
   * shared with the slim slicing dialog. When present, the editor renders the
   * shared `SliceSettingsPanel` in its "Settings" tab and can slice/print directly.
   */
  sliceConfig?: SliceSettingsController
  /** Whether the slice's printer/process/filament settings are complete. */
  canSlice?: boolean
  /** When the Slice button is disabled, a short reason shown as its tooltip. */
  sliceDisabledReason?: string
  /** A slice job is in flight (drives the Slice button's loading state). */
  slicing?: boolean
  /** Slice a single 1-based plate without persisting a project; the host opens a results dialog that can save/print. */
  onSlice?: (opts: { plate: number; sceneEdit: SceneEdit }) => void
}

/**
 * The three-stdlib `TransformControls` snap setters are typed to accept only
 * `number`, but the runtime accepts `null` to disable snapping (matching upstream
 * three.js). Expose them through a narrow interface that permits `null`.
 */
type TransformControlsSnap = {
  setRotationSnap: (snap: number | null) => void
  setTranslationSnap: (snap: number | null) => void
  setScaleSnap: (snap: number | null) => void
}

/** Stable empty per-object overrides so the override editor doesn't re-fetch each render. */
const EMPTY_OBJECT_OVERRIDES: ProcessSettingOverrides = {}

function EditorView({
  baseFileId,
  isNewProject: isNewProjectScaffold = false,
  baseVersionId = null,
  initialPlateIndex,
  targetPrinterModel,
  onApply,
  folderId = null,
  bridgeId = null,
  onSaved,
  onClose,
  sliceConfig,
  canSlice = false,
  sliceDisabledReason,
  slicing = false,
  onSlice
}: EditorViewProps) {
  // `hasNoBaseFile` gates DATA loading (a fileless project seeds empty, skipping the scene
  // queries). A scaffold-backed new project DOES have a base file (it carries the bed/settings),
  // so it still loads — only the SAVE/heading behaviour treats it as new.
  const hasNoBaseFile = baseFileId === null
  const isNewProject = hasNoBaseFile || isNewProjectScaffold
  // Versioned resource routes serve an archived version's bytes; everything geometry-
  // related reads through this base so the editor shows the version, not the current file.
  const resourceBase = baseVersionId ? `/api/library/versions/${baseVersionId}` : `/api/library/${baseFileId}`
  const { confirm, promptText } = usePromptDialog()
  const [viewerContainer, setViewerContainer] = useState<HTMLDivElement | null>(null)
  const [viewCubeContainer, setViewCubeContainer] = useState<HTMLDivElement | null>(null)
  const [state, setState] = useState<EditorState | null>(null)
  const [activePlateIndex, setActivePlateIndex] = useState(1)
  // Keep the shared slice controller's selected plate in sync with the editor's
  // active plate, so plate-scoped settings (per-object overrides, the "not on this
  // plate" material hints, the output filename) target the plate being viewed.
  // The controller defaults to "all plates" (selectedPlate 0), which otherwise
  // hides the per-object button. Setters from useState are stable.
  const sliceSetPlateMode = sliceConfig?.setPlateMode
  const sliceSetPlateNumber = sliceConfig?.setPlateNumber
  useEffect(() => {
    if (!sliceSetPlateMode || !sliceSetPlateNumber) return
    sliceSetPlateMode('single')
    sliceSetPlateNumber(String(activePlateIndex))
  }, [activePlateIndex, sliceSetPlateMode, sliceSetPlateNumber])
  // Live per-filament colors from the slice settings; objects are tied to a
  // filament, so editing a material's color recolors its meshes in the preview.
  // `filamentColors` only changes identity when a color actually changes, so it's
  // safe in the mesh-builder deps below.
  const filamentColors = sliceConfig?.filamentColors
  const filamentColorsRef = useRef(filamentColors)
  filamentColorsRef.current = filamentColors
  // Ref-backed so paint-overlay callbacks can resolve live colours without rebinding.
  const resolveColorFilamentIdRef = useRef<(id: number | null) => number | null>(() => null)
  const filamentMaterialOptionIds = sliceConfig?.filamentMaterialOptionIds
  const materialOptions = sliceConfig?.materialOptions
  // Live recolour after a material is removed: a part referencing a now-gone material
  // shows material 1's colour (the backend reassigns it to material 1 at save/slice).
  const projectFilamentIds = useMemo(
    () => new Set((sliceConfig?.projectFilaments ?? []).map((filament) => filament.projectFilamentId)),
    [sliceConfig?.projectFilaments]
  )
  const fallbackFilamentId = sliceConfig?.projectFilaments?.[0]?.projectFilamentId ?? null
  const resolveColorFilamentId = useCallback(
    (id: number | null): number | null => (id != null && projectFilamentIds.has(id) ? id : fallbackFilamentId),
    [projectFilamentIds, fallbackFilamentId]
  )
  resolveColorFilamentIdRef.current = resolveColorFilamentId
  // Map a colour-paint code to the LIVE colour of its filament (split codes -> null,
  // rendered with the mixed tint). Read via ref-backed lookups so overlay callbacks
  // stay referentially stable.
  const colorPaintStateColor = useCallback((state: number): number | null => {
    const filamentId = resolveColorFilamentIdRef.current(state)
    const hex = filamentId != null ? filamentColorsRef.current?.[filamentId] : undefined
    return hex ? new THREE.Color(hex).getHex() : null
  }, [])

  // Material choices for the reassignment pickers (live colour + label per material).
  // The label tracks the user's CURRENT material selection (type/name) rather than the
  // project's baked label, so a just-added/changed material reads correctly.
  const filamentOptions = useMemo<FilamentOption[]>(
    () => (sliceConfig?.projectFilaments ?? []).map((filament) => {
      const optionId = filamentMaterialOptionIds?.[filament.projectFilamentId]
      const option = optionId ? materialOptions?.find((entry) => entry.id === optionId) ?? null : null
      const color = filamentColors?.[filament.projectFilamentId] ?? filament.color
      return {
        id: filament.projectFilamentId,
        color,
        label: option?.materialType ?? option?.label ?? filament.label,
        colorName: resolveProjectFilamentColorName({
          color,
          filamentName: option?.label ?? filament.label,
          filamentType: option?.materialType ?? null
        })
      }
    }),
    [sliceConfig?.projectFilaments, filamentColors, filamentMaterialOptionIds, materialOptions]
  )
  const platesQuery = useQuery({
    queryKey: ['library-editor-plates', baseFileId, baseVersionId ?? 'current'],
    enabled: !hasNoBaseFile,
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBase}/plates`, { signal }),
    staleTime: 60_000
  })

  // BambuStudio parity: a project must have a material, and a material in use can't be removed.
  // `usedFilamentIds` is the live set of materials referenced by any object/part, layer filament
  // change, colour paint, OR support setting (across every plate); `hasMaterials` whether the
  // project has any material at all. Support materials count even though no geometry references
  // them directly: the baked `support_filament`/`support_interface_filament` (from the loaded
  // index) plus any live session override of those settings. We track the OBJECT side and the
  // SUPPORT side separately so the remove-blocked copy can be accurate — `supportOnlyFilamentIds`
  // is the materials used ONLY for supports (no object/part/layer/paint reference), which earn the
  // "used for supports" wording rather than "used by an object". Both are derived through a stable
  // string key so they only change identity when the materials actually in use change — not on
  // every drag — so they can gate the memoized settings-panel controller.
  const bakedSupportFilamentIds = platesQuery.data?.supportFilamentIds
  const sessionSupportOverrides = sliceConfig?.perObjectSettings
  const usageKey = useMemo(() => {
    const objectIds = new Set<number>()
    const supportIds = new Set<number>()
    for (const plate of state?.plates ?? []) {
      for (const instance of plate.instances) {
        if (instance.filamentId != null) objectIds.add(instance.filamentId)
        for (const part of instance.parts) if (part.filamentId != null) objectIds.add(part.filamentId)
      }
      // Layer-based filament changes reference materials too.
      for (const change of effectiveFilamentChanges(plate)) objectIds.add(change.filamentId)
    }
    // Colour-painted triangles reference a material via their whole-triangle paint code.
    for (const channel of [state?.colorPaint]) {
      for (const codes of Object.values(channel ?? {})) {
        for (const code of Object.values(codes)) {
          const filamentId = decodeWholeTriangleColorState(code)
          if (filamentId != null) objectIds.add(filamentId)
        }
      }
    }
    // Support materials: baked project support (from the loaded 3MF) plus any in-session override
    // of the support_filament / support_interface_filament settings (global or per-object).
    for (const id of bakedSupportFilamentIds ?? []) supportIds.add(id)
    if (sessionSupportOverrides) {
      for (const id of supportFilamentRefs(sessionSupportOverrides.globalOverrides)) supportIds.add(id)
      for (const overrides of Object.values(sessionSupportOverrides.value)) {
        for (const id of supportFilamentRefs(overrides)) supportIds.add(id)
      }
    }
    const sortJoin = (ids: Set<number>) => [...ids].sort((left, right) => left - right).join(',')
    return `${sortJoin(objectIds)}|${sortJoin(supportIds)}`
  }, [state, bakedSupportFilamentIds, sessionSupportOverrides])
  const { usedFilamentIds, supportOnlyFilamentIds } = useMemo(() => {
    const [objectStr = '', supportStr = ''] = usageKey.split('|')
    const objectIds = new Set(objectStr ? objectStr.split(',').map(Number) : [])
    const supportIds = new Set(supportStr ? supportStr.split(',').map(Number) : [])
    return {
      usedFilamentIds: new Set<number>([...objectIds, ...supportIds]),
      supportOnlyFilamentIds: new Set<number>([...supportIds].filter((id) => !objectIds.has(id)))
    }
  }, [usageKey])
  const hasMaterials = (sliceConfig?.projectFilaments?.length ?? 0) > 0

  // Flips true once the Three.js scene/plate root exist, so the plate-build effect
  // re-runs and renders the initial plate even though `activePlateIndex` is stable
  // (the canvas only mounts after data loads, so the scene is created after the
  // first build attempt would otherwise have bailed).
  const [sceneReady, setSceneReady] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate')
  // Cut tool: plane axis + offset (world mm), the selected object's range along that axis,
  // sides to keep, and the staging-in-flight flag for the Cut button. The offset is kept raw
  // while typing; consumers clamp it to the range.
  const [cutAxis, setCutAxis] = useState<CutAxis>('z')
  const [cutOffset, setCutOffset] = useState(0)
  const [cutRange, setCutRange] = useState<{ min: number; max: number } | null>(null)
  const [cutKeepUpper, setCutKeepUpper] = useState(true)
  const [cutKeepLower, setCutKeepLower] = useState(true)
  const [cutting, setCutting] = useState(false)
  const clampedCutOffset = cutRange ? Math.min(Math.max(cutOffset, cutRange.min), cutRange.max) : cutOffset
  // Measure tool: up to two picked points (world mm). Clicks snap to nearby mesh
  // corners (MEASURE_SNAP_PX); a third click starts a new measurement. The scene
  // overlay and the readout panel both derive from these points.
  const [measurePoints, setMeasurePoints] = useState<Array<{ x: number; y: number; z: number }>>([])
  const addMeasurePointRef = useRef<((point: { x: number; y: number; z: number }) => void) | null>(null)
  addMeasurePointRef.current = (point) => {
    setMeasurePoints((prev) => (prev.length >= 2 ? [point] : [...prev, point]))
  }
  // Leaving the tool or switching plates discards the measurement.
  useEffect(() => {
    if (gizmoMode !== 'measure') setMeasurePoints([])
  }, [gizmoMode])
  useEffect(() => {
    setMeasurePoints([])
  }, [activePlateIndex])
  const measureDelta = useMemo(() => {
    const [a, b] = measurePoints
    if (!a || !b) return null
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dz = b.z - a.z
    return { dx, dy, dz, distance: Math.hypot(dx, dy, dz) }
  }, [measurePoints])
  // Brim-ear tool: diameter (mm) of newly placed ears.
  const [brimEarDiameter, setBrimEarDiameter] = useState(8)
  const brimEarDiameterRef = useRef(brimEarDiameter)
  brimEarDiameterRef.current = brimEarDiameter
  // Added part volume (negative part/modifier/blocker) currently selected for
  // transform; the move/rotate/scale gizmo attaches to the part mesh instead of the
  // object while set.
  const [selectedAddedPartKey, setSelectedAddedPartKey] = useState<string | null>(null)
  const selectedAddedPartKeyRef = useRef(selectedAddedPartKey)
  selectedAddedPartKeyRef.current = selectedAddedPartKey
  const [viewerError, setViewerError] = useState<string | null>(null)
  // True while the active plate's models are still being built into the 3D scene.
  const [viewportBuilding, setViewportBuilding] = useState(false)
  // Object-build progress for the viewport overlay, so the user can tell how far along the
  // plate's models are rather than staring at an indeterminate spinner. Null until the build
  // effect knows the instance count (or when there's nothing to build).
  const [buildProgress, setBuildProgress] = useState<{ done: number; total: number } | null>(null)
  // True while the current build appends models to the LIVE plate one-by-one (a plate switch or
  // the first open) rather than swapping in a finished plate atomically. Drives the lighter,
  // non-blocking progress chip so the models are clearly visible as they pop in.
  const [buildIncremental, setBuildIncremental] = useState(false)
  const [placementWarnings, setPlacementWarnings] = useState<PlacementWarning[]>([])
  const placementWarningsSetterRef = useRef(setPlacementWarnings)
  // Dismissing the warnings panel hides the CURRENT set of issues (keyed by the same
  // JSON signature the validator dedupes on); any change to the set shows it again.
  const [dismissedWarningsSig, setDismissedWarningsSig] = useState<string | null>(null)
  const placementWarningsSig = useMemo(() => JSON.stringify(placementWarnings), [placementWarnings])
  const placementWarningsVisible = placementWarnings.length > 0 && placementWarningsSig !== dismissedWarningsSig
  const lastWarningSigRef = useRef('')
  // Forces an immediate placement-warning recompute, bypassing the rAF poll's per-frame gate.
  // The poll (in useEditorScene) only refreshes warnings ~4x/sec and is skipped while a drag
  // flag is set; the plate-build effect calls this right after a rebuild so undo/redo/delete/
  // duplicate reflect in the warning panel instantly instead of lagging (or, if a drag flag is
  // ever left stuck, never catching up). Assigned by useEditorScene.
  const recomputeWarningsRef = useRef<() => void>(() => undefined)
  // Cached XY footprint cell-sets per instance, keyed by transform signature so
  // collision checks only re-rasterize objects that actually moved.
  const footprintCacheRef = useRef<Map<string, { sig: string; cells: Set<number> }>>(new Map())
  const [importing, setImporting] = useState(false)
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
  // When set, the next picked library file / uploaded local file replaces this instance's
  // geometry in place (Replace flow) instead of adding a new model to the plate.
  const [replaceTargetKey, setReplaceTargetKey] = useState<string | null>(null)
  // Per-object process overrides now live inline in the sidebar object list (no
  // separate dialog/button); the active object's override editor is a sub-dialog.
  const perObject = sliceConfig?.perObjectSettings ?? null
  // Which instances actually print (BambuStudio's per-object "Printable" toggle). This is
  // an editor-owned per-instance flag carried through moves/duplicates and baked into the
  // SceneEdit, so it stays correct across plate changes — unlike the slice dialog's per-plate
  // object selection, which is keyed off the static baked index.
  const isInstancePrinted = useCallback((instance: EditorInstance) => instance.printable, [])
  const isInstancePrintedRef = useRef(isInstancePrinted)
  isInstancePrintedRef.current = isInstancePrinted
  // Object(s) whose per-object process overrides are being edited. Multiple ids = the
  // bulk context-menu action: the dialog seeds from the first and applies to all.
  const [editingObject, setEditingObject] = useState<{ ids: ReadonlyArray<number>; name: string } | null>(null)
  // Normal part(s) of one multi-part object whose per-part process overrides are being
  // edited. Multiple ids = the part-selection bulk action (seed from first, apply to all).
  const [editingPart, setEditingPart] = useState<{ objectId: number; componentObjectIds: ReadonlyArray<number>; name: string } | null>(null)
  // Modifier part whose per-volume process overrides are being edited (dialog open).
  const [editingPartKey, setEditingPartKey] = useState<string | null>(null)
  const editingObjectOverrides = useMemo(
    () => (editingObject && perObject ? perObject.value[String(editingObject.ids[0])] ?? EMPTY_OBJECT_OVERRIDES : EMPTY_OBJECT_OVERRIDES),
    [editingObject, perObject]
  )
  // Sidebar view: the shared slice settings vs. the model/per-object list (Bambu-style).
  // Only meaningful when launched with slice settings (sliceConfig present); Settings
  // is the default since configuring the slice is the primary task.
  const [sidebarTab, setSidebarTab] = useState<'objects' | 'settings'>('settings')
  const isMobile = useMobileViewport()
  // On phones the 3D view and settings can't sit side by side, so the user toggles
  // between them; the model/per-object list lives in a slide-up bottom sheet.
  const [mobileView, setMobileView] = useState<'view' | 'settings'>('view')
  const [objectsSheetOpen, setObjectsSheetOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Live transform of the selected instance (mm / degrees / percent) for the
  // manual-input panel. Mirrors the gizmo and updates as the user drags.
  const [selectedTransform, setSelectedTransform] = useState<SelectedTransform | null>(null)
  // Per-axis uniform scale lock for the manual scale inputs.
  const [uniformScale, setUniformScale] = useState(true)
  // Rotation readout shown while the rotate gizmo or body-rotate is dragging.
  const [rotationReadout, setRotationReadout] = useState<number | null>(null)
  // Per-plate thumbnail data URLs, keyed by plate index (live plate-strip previews).
  const [plateThumbnails, setPlateThumbnails] = useState<Record<number, string>>({})
  // Live (client-rendered) thumbnails keyed by plate index — only set for plates the user
  // has opened/edited. Read via a ref at save time to know which plates to re-render.
  const plateThumbnailsRef = useRef(plateThumbnails)
  plateThumbnailsRef.current = plateThumbnails

  // The editable state mutates outside React (gizmo drags write into Three.js
  // groups); a ref keeps the latest pointers available to the render loop and to
  // the Apply handler without re-binding the whole scene on every change.
  const stateRef = useRef<EditorState | null>(null)
  stateRef.current = state

  // Bumped to force a plate re-render after a history restore even when the instance set is
  // unchanged (e.g. undoing a move); also bumped by other scene mutations, so it lives here
  // rather than inside useEditorHistory (which only writes it, via setRebuildToken).
  const [rebuildToken, setRebuildToken] = useState(0)
  // Bumped to rebuild ONLY the place-on-face hull (not the whole plate) after a lay-flat re-orients
  // the part — the hull bakes the rotor's rotation in group-local space, so it must be rebuilt to
  // follow the new orientation instead of lingering stale.
  const [faceHullToken, setFaceHullToken] = useState(0)
  const rebuildFaceHullRef = useRef<() => void>(() => undefined)
  rebuildFaceHullRef.current = () => setFaceHullToken((token) => token + 1)
  // Latest controller, so the save handlers read the current machine selection (retarget
  // target / slicer version) without a stale closure or being re-created every render.
  const sliceConfigRef = useRef(sliceConfig)
  sliceConfigRef.current = sliceConfig

  // ---- Undo/redo history -----------------------------------------------------
  // Undo/redo stacks plus unsaved-edit ("dirty") tracking, and the material add/remove
  // wrapper, live in useEditorHistory; the component just feeds it the state refs/setters.
  const {
    dirtyRef,
    markSaved,
    hasUnsavedChanges,
    canUndo,
    canRedo,
    undo,
    redo,
    undoRef,
    redoRef,
    recordHistory,
    recordHistoryRef,
    recordMaterialsHistory,
    sliceConfigForPanel
  } = useEditorHistory({
    stateRef,
    setState,
    setSelectedKey,
    setActivePlateIndex,
    setRebuildToken,
    sliceConfig,
    usedFilamentIds,
    supportOnlyFilamentIds
  })

  // Base file metadata for the "Save As" suggested name (defaults to the source name so
  // saving a copy keeps a recognizable name).
  const baseFileQuery = useQuery({
    queryKey: ['library-file', baseFileId],
    enabled: baseFileId !== null,
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${baseFileId}`, { signal }),
    staleTime: 60_000
  })
  // Destination for "Save As": the bridge/folder the editor was opened against (the New 3MF
  // flow passes these; the slice flow leaves bridgeId null and the API save falls back to the
  // source file's bridge). Folders are only fetched when we know the bridge.
  const saveAsBridgeId = bridgeId
  const saveAsInitialFolderId = bridgeId ? folderId : null
  const saveAsSuggestedName = baseFileQuery.data ? splitLibraryFileNameForRename(baseFileQuery.data.file.name).baseName : ''
  const editorFoldersQuery = useQuery({
    queryKey: ['library-folders', saveAsBridgeId ?? 'none'],
    enabled: saveAsBridgeId !== null,
    queryFn: ({ signal }) => apiFetch<{ folders: LibraryFolder[] }>(`/api/library/folders?bridgeId=${encodeURIComponent(saveAsBridgeId!)}`, { signal }),
    staleTime: 60_000
  })

  const plateIndices = useMemo(
    () => (platesQuery.data?.plates ?? []).map((plate) => plate.index),
    [platesQuery.data]
  )

  // Plates whose source 3MF carries an embedded PNG thumbnail. The plate strip shows that
  // cheap image for plates the user hasn't opened, so a large multi-plate project no longer
  // has to fetch + render every plate's geometry up front just to fill the selector.
  const platesWithEmbeddedThumbnail = useMemo(
    () => new Set((platesQuery.data?.plates ?? []).filter((plate) => plate.hasThumbnail).map((plate) => plate.index)),
    [platesQuery.data]
  )
  const embeddedPlateThumbnailUrl = useCallback(
    (plateIndex: number): string | null => (
      platesWithEmbeddedThumbnail.has(plateIndex) ? `${resourceBase}/thumbnail?plate=${plateIndex}` : null
    ),
    [platesWithEmbeddedThumbnail, resourceBase]
  )

  // The plate the editor will open on: the host's pre-selected plate when it exists,
  // otherwise the first plate. Its scene loads FIRST so the user is never kept waiting on
  // plates they can't see; the rest stream in behind it (#28).
  //
  // Frozen after the first resolution: this only governs which plate loads first on open. The
  // editor mirrors the active plate back to the host's plate-number (for slicing), which feeds
  // back in as `initialPlateIndex` — if `preferredPlateIndex` followed that, every plate switch
  // would re-key and refetch the "initial" scene, flip the load gate, and reload the viewport.
  const frozenPreferredPlateRef = useRef<number | null>(null)
  const preferredPlateIndex = useMemo(() => {
    if (frozenPreferredPlateRef.current !== null) return frozenPreferredPlateRef.current
    if (plateIndices.length === 0) return null
    const resolved = initialPlateIndex != null && plateIndices.includes(initialPlateIndex)
      ? initialPlateIndex
      : plateIndices[0]!
    frozenPreferredPlateRef.current = resolved
    return resolved
  }, [plateIndices, initialPlateIndex])

  const fetchPlateScene = useCallback((plateIndex: number, signal?: AbortSignal) => {
    const modelParam = targetPrinterModel ? `&printerModel=${encodeURIComponent(targetPrinterModel)}` : ''
    return apiFetch<LibraryThreeMfScene>(
      `${resourceBase}/scene?plate=${plateIndex}${modelParam}`,
      { signal }
    )
  }, [resourceBase, targetPrinterModel])

  const initialSceneQuery = useQuery({
    queryKey: ['library-editor-scene-initial', baseFileId, baseVersionId ?? 'current', preferredPlateIndex ?? 0, targetPrinterModel ?? ''],
    enabled: !hasNoBaseFile && preferredPlateIndex !== null,
    staleTime: 60_000,
    queryFn: ({ signal }) => fetchPlateScene(preferredPlateIndex!, signal)
  })
  const initialSceneSettled = initialSceneQuery.isSuccess || initialSceneQuery.isError
  const restPlateIndices = useMemo(
    () => plateIndices.filter((index) => index !== preferredPlateIndex),
    [plateIndices, preferredPlateIndex]
  )
  const restScenesQuery = useQuery({
    queryKey: ['library-editor-scenes-rest', baseFileId, baseVersionId ?? 'current', restPlateIndices.join(','), targetPrinterModel ?? ''],
    // Held back until the visible plate's scene settles so its fetch is never contended.
    enabled: !hasNoBaseFile && restPlateIndices.length > 0 && initialSceneSettled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const scenes = new Map<number, LibraryThreeMfScene>()
      // Bound the fan-out: a naive Promise.all over all rest plates fires N simultaneous /scene
      // requests on open, each forcing a full server-side root-model parse — an N-wide spike right
      // when the editor is mounting. A small worker pool turns that burst into a throttled trickle
      // (each plate's parse is cheap and now server-cached, so re-selecting one is free).
      const REST_SCENE_CONCURRENCY = 3
      const queue = [...restPlateIndices]
      const worker = async () => {
        for (;;) {
          const plateIndex = queue.shift()
          if (plateIndex === undefined) return
          scenes.set(plateIndex, await fetchPlateScene(plateIndex, signal))
        }
      }
      await Promise.all(Array.from({ length: Math.min(REST_SCENE_CONCURRENCY, restPlateIndices.length) }, worker))
      return scenes
    }
  })

  // Every scene loaded so far, by plate index.
  const scenesByPlate = useMemo(() => {
    const scenes = new Map<number, LibraryThreeMfScene>()
    if (restScenesQuery.data) for (const [plateIndex, scene] of restScenesQuery.data) scenes.set(plateIndex, scene)
    if (initialSceneQuery.data && preferredPlateIndex !== null) scenes.set(preferredPlateIndex, initialSceneQuery.data)
    return scenes
  }, [initialSceneQuery.data, restScenesQuery.data, preferredPlateIndex])

  // Plates that were seeded before their scene arrived; filled by the merge effect below.
  const pendingScenePlatesRef = useRef<Set<number>>(new Set())

  // Seed: a single empty plate for a new project, or the loaded base project. Only the
  // visible plate's scene is required; other plates seed empty and fill as scenes arrive.
  // Guard on `stateRef` (not inside the setState updater) so the seeding side effects
  // (active plate, pending-scene set) run once and the updater stays pure.
  useEffect(() => {
    if (stateRef.current) return
    if (hasNoBaseFile) {
      const seeded = seedEmptyEditorState()
      setActivePlateIndex(seeded.plates[0]?.index ?? 1)
      setState(seeded)
      return
    }
    if (!platesQuery.data || !initialSceneSettled) return
    const seeded = seedEditorState(platesQuery.data, scenesByPlate)
    pendingScenePlatesRef.current = new Set(
      seeded.plates.map((plate) => plate.index).filter((index) => !scenesByPlate.has(index))
    )
    setActivePlateIndex(preferredPlateIndex ?? seeded.plates[0]?.index ?? 1)
    setState(seeded)
  }, [hasNoBaseFile, platesQuery.data, initialSceneSettled, scenesByPlate, preferredPlateIndex])

  // Apply arriving scenes to the live state in ONE pass: fill plates that were seeded
  // before their scene loaded (only still-empty plates, so a user edit on a seemingly
  // empty plate is never clobbered; not an undoable edit), and keep every plate's bed +
  // unprintable zones in sync with the selected target printer (the scene queries refetch
  // when `targetPrinterModel` changes — it's in their keys). These MUST stay one effect:
  // `stateRef.current` only updates on render, so two sibling effects deriving next-state
  // from it on the same `scenesByPlate` change would have the second overwrite the first
  // (which is exactly how late-loaded plates briefly shipped empty).
  useEffect(() => {
    const snapshot = stateRef.current
    if (scenesByPlate.size === 0 || !snapshot) return
    // Decide what to change from a snapshot (so the pending-ref mutation happens exactly
    // once, not inside the updater where StrictMode would double-invoke it), then apply
    // via a FUNCTIONAL updater that maps over the latest `prev`. Other effects keyed on
    // the same `scenesByPlate` change also setState in this flush; if each spread a stale
    // `stateRef.current` snapshot, the last writer would clobber the others (this is how
    // late-loaded plates ended up empty — the per-part re-hydrate effect overwrote the
    // plate fill). Composing over `prev` makes the writes additive.
    const filledPlates = new Map<number, EditorPlate>()
    const nextBeds = new Map<number, EditorPlate['bed']>()
    for (const plate of snapshot.plates) {
      const scene = scenesByPlate.get(plate.index)
      if (!scene) continue
      if (pendingScenePlatesRef.current.has(plate.index)) {
        pendingScenePlatesRef.current.delete(plate.index)
        if (plate.instances.length === 0) {
          filledPlates.set(plate.index, fillPlateFromScene(plate, scene))
          continue
        }
      }
      const nextBed = {
        minX: scene.bed.minX, maxX: scene.bed.maxX, minY: scene.bed.minY, maxY: scene.bed.maxY,
        excludeAreas: scene.bed.excludeAreas
      }
      if (!bedsEqual(plate.bed, nextBed)) nextBeds.set(plate.index, nextBed)
    }
    if (filledPlates.size === 0 && nextBeds.size === 0) return
    setState((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        plates: prev.plates.map((plate) => {
          const filled = filledPlates.get(plate.index)
          if (filled) return filled
          const bed = nextBeds.get(plate.index)
          return bed ? { ...plate, bed } : plate
        })
      }
    })
    setRebuildToken((token) => token + 1)
  }, [scenesByPlate])

  // Re-seed the per-object PROCESS gear from overrides saved in the 3MF, so reopening a project
  // shows the per-object settings you saved (not an empty gear). One-shot per object: never
  // re-seed an object already seeded this session, and never clobber a session edit. Seeds via
  // the raw onChange (not markDirty) so reopening doesn't look like an unsaved change.
  const seededProcessOverrideObjectIdsRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    const perObj = sliceConfigRef.current?.perObjectSettings
    if (!perObj || scenesByPlate.size === 0) return
    const current = perObj.value
    const additions: Record<string, Record<string, string | string[]>> = {}
    for (const scene of scenesByPlate.values()) {
      for (const instance of scene.instances) {
        if (!instance.processOverrides) continue
        if (seededProcessOverrideObjectIdsRef.current.has(instance.objectId)) continue
        seededProcessOverrideObjectIdsRef.current.add(instance.objectId)
        if (current[String(instance.objectId)]) continue
        additions[String(instance.objectId)] = { ...instance.processOverrides }
      }
    }
    if (Object.keys(additions).length > 0) perObj.onChange({ ...current, ...additions })
  }, [scenesByPlate])

  // Re-seed the per-PART PROCESS gear from overrides saved in the 3MF (parity with the
  // per-object re-seed above, but for part-scoped settings, which live on editor state
  // rather than the borrowed slice controller). One-shot per `objectId:componentObjectId`;
  // never clobber a session edit; seeds without marking the project dirty.
  const seededPartProcessKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const current = stateRef.current
    if (scenesByPlate.size === 0 || !current) return
    const additions: Record<string, Record<string, string>> = {}
    for (const scene of scenesByPlate.values()) {
      for (const instance of scene.instances) {
        for (const part of instance.parts) {
          if (!part.processOverrides || Object.keys(part.processOverrides).length === 0) continue
          const key = supportPaintKey(instance.objectId, part.componentObjectId)
          if (seededPartProcessKeysRef.current.has(key)) continue
          seededPartProcessKeysRef.current.add(key)
          if (current.partProcessOverrides?.[key]) continue
          additions[key] = { ...part.processOverrides }
        }
      }
    }
    if (Object.keys(additions).length === 0) return
    // Functional updater so this composes with the plate-fill effect that also runs on
    // this `scenesByPlate` change — a `{ ...stateRef.current }` spread here would clobber
    // the freshly-filled plates with the pre-fill snapshot.
    setState((prev) => prev
      ? { ...prev, partProcessOverrides: { ...(prev.partProcessOverrides ?? {}), ...additions } }
      : prev)
  }, [scenesByPlate])

  const activePlate = useMemo(
    () => state?.plates.find((plate) => plate.index === activePlateIndex) ?? null,
    [state, activePlateIndex]
  )
  const activePlateRef = useRef<EditorPlate | null>(null)
  activePlateRef.current = activePlate
  // The support brush only paints in-project parts (imports/cut halves are baked as
  // fresh meshes whose client/server triangle order isn't contractually aligned yet).
  const paintTargetIsObject = useMemo(() => {
    if (!selectedKey) return false
    const instance = activePlate?.instances.find((entry) => entry.key === selectedKey)
    return instance?.source.kind === 'object'
  }, [activePlate, selectedKey])
  // The plate's filament count from the parsed index (authoritative for multi-color,
  // incl. single objects whose parts use different filaments).
  const activePlateFilamentCountRef = useRef(0)
  activePlateFilamentCountRef.current = platesQuery.data?.plates
    .find((plate) => plate.index === activePlateIndex)?.filaments.length ?? 0
  // filamentId -> nozzleId (1 = left, 2 = right) for the active plate, so per-object
  // nozzle reach can be checked against the labeled nozzle-only zones.
  const filamentNozzleRef = useRef<Map<number, number>>(new Map())
  {
    const map = new Map<number, number>()
    const indexPlate = platesQuery.data?.plates.find((plate) => plate.index === activePlateIndex)
    for (const filament of indexPlate?.filaments ?? []) {
      if (typeof filament.nozzleId === 'number') map.set(filament.id, filament.nozzleId)
    }
    filamentNozzleRef.current = map
  }
  // The set of nozzles an instance uses (across its parts), via the filament map.
  const instanceNozzlesRef = useRef<(instance: EditorInstance) => Set<number>>(() => new Set())
  instanceNozzlesRef.current = (instance: EditorInstance) => {
    const nozzles = new Set<number>()
    const map = filamentNozzleRef.current
    const addFilament = (filamentId: number | null) => {
      if (filamentId == null) return
      const nozzle = map.get(filamentId)
      if (nozzle != null) nozzles.add(nozzle)
    }
    addFilament(instance.filamentId)
    for (const part of instance.parts) addFilament(part.filamentId)
    return nozzles
  }

  // ---- Three.js scene wiring -------------------------------------------------
  // Persistent Three.js handles for the lifetime of the viewport.
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const orbitRef = useRef<OrbitControls | null>(null)
  const transformRef = useRef<TransformControls | null>(null)
  const plateRootRef = useRef<THREE.Group | null>(null)
  const geometryCacheRef = useRef<GeometryCache>(new Map())
  const importGeometryCacheRef = useRef<ImportGeometryCache>(new Map())
  // Maps instance key -> Three.js group, so selection/gizmo can find the object.
  const groupByKeyRef = useRef<Map<string, THREE.Group>>(new Map())
  // View-cube preset applier, rebound by the init effect once the camera exists.
  const applyViewPresetRef = useRef<((preset: ViewPreset) => void) | null>(null)
  // Frames the default Bambu-style home view (rebound by the init effect).
  const frameDefaultViewRef = useRef<(() => void) | null>(null)
  // True once the user manually orbits/pans, so auto-reframing on resize stops.
  const userAdjustedViewRef = useRef(false)
  // True while a camera orbit/pan or gizmo drag is in flight; background work
  // (non-active plate thumbnail builds) backs off so interactions stay smooth.
  const interactionActiveRef = useRef(false)
  // Sets/clears the selection outline highlight (rebound by the init effect).
  const setSelectionHighlightRef = useRef<((group: THREE.Object3D | null) => void) | null>(null)
  // Camera framing distance, sized to the active plate's bed.
  const viewDistanceRef = useRef(360)
  // Last plate index the camera was re-framed for, so adding/removing models on
  // the current plate does not reset the user's camera.
  // Identifies the plate + bed the camera was last framed on; reframing when EITHER changes keeps
  // the view centred after a printer change (which moves/resizes the bed under the same plate).
  const framedViewKeyRef = useRef<string | null>(null)
  // Bed centre of the active plate (plate-local frame == world frame), so the
  // camera frames the bed and body-drag stays on the bed plane.
  const bedCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  // Latest selection key + gizmo mode for non-React pointer/keyboard handlers.
  const selectedKeyRef = useRef<string | null>(null)
  selectedKeyRef.current = selectedKey
  // Additional selected instances (Ctrl/Cmd-click multi-select). The primary
  // (`selectedKey`) keeps driving the gizmo/panels; extras follow group moves,
  // delete/duplicate, and the Assemble action.
  const [extraSelectedKeys, setExtraSelectedKeys] = useState<ReadonlyArray<string>>([])
  const extraSelectedKeysRef = useRef(extraSelectedKeys)
  extraSelectedKeysRef.current = extraSelectedKeys
  // Selected PARTS of one object (BambuStudio volume-mode). Mutually exclusive with the
  // object selection above — selecting either kind clears the other (never mixed), and
  // parts only multi-select within one object (rules in lib/selectionModel.ts). Geometry-
  // level (objectId+componentObjectId), so it means "this part on every copy".
  const [partSelection, setPartSelection] = useState<PartSelection | null>(null)
  const partSelectionRef = useRef(partSelection)
  partSelectionRef.current = partSelection
  // Shift-range anchors: the last plainly/Ctrl-clicked object row and part row.
  const objectAnchorKeyRef = useRef<string | null>(null)
  const partAnchorRef = useRef<{ objectId: number; componentObjectId: number } | null>(null)
  /** Replace the whole selection with one key (plain click semantics). */
  const selectExclusive = useCallback((key: string | null) => {
    setSelectedKey(key)
    setExtraSelectedKeys((current) => (current.length > 0 ? [] : current))
    setPartSelection((current) => (current ? null : current))
    if (key) objectAnchorKeyRef.current = key
  }, [])
  const selectExclusiveRef = useRef(selectExclusive)
  selectExclusiveRef.current = selectExclusive
  /** Ctrl/Cmd-click semantics: toggle a key in/out of the selection. */
  const toggleAdditiveSelection = useCallback((key: string) => {
    const primary = selectedKeyRef.current
    const extras = extraSelectedKeysRef.current
    setPartSelection((current) => (current ? null : current))
    objectAnchorKeyRef.current = key
    if (primary === key) {
      const [next, ...rest] = extras
      setSelectedKey(next ?? null)
      setExtraSelectedKeys(rest)
    } else if (extras.includes(key)) {
      setExtraSelectedKeys(extras.filter((entry) => entry !== key))
    } else if (primary) {
      setExtraSelectedKeys([...extras, key])
    } else {
      setSelectedKey(key)
    }
  }, [])
  const toggleAdditiveSelectionRef = useRef(toggleAdditiveSelection)
  toggleAdditiveSelectionRef.current = toggleAdditiveSelection
  /** Every selected instance key, primary first. */
  const allSelectedKeys = useCallback((): string[] => {
    const primary = selectedKeyRef.current
    return primary ? [primary, ...extraSelectedKeysRef.current] : []
  }, [])
  const allSelectedKeysRef = useRef(allSelectedKeys)
  allSelectedKeysRef.current = allSelectedKeys
  // Extras only ever reference instances on the ACTIVE plate; prune on plate switch,
  // deletions, and primary changes (the primary must never also be an extra).
  useEffect(() => {
    setExtraSelectedKeys((current) => {
      if (current.length === 0) return current
      const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
      const valid = new Set(plate?.instances.map((entry) => entry.key) ?? [])
      const next = current.filter((key) => valid.has(key) && key !== selectedKey)
      return next.length === current.length ? current : next
    })
  }, [activePlateIndex, state, selectedKey])
  // Part selection follows the project: drop parts whose owning object (on any plate —
  // part identity is geometry-level) or the parts themselves vanished (delete/undo/replace).
  useEffect(() => {
    setPartSelection((current) => {
      if (!current) return current
      const owner = state?.plates.flatMap((plate) => plate.instances).find((instance) => {
        const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
        return ownerId === current.objectId
      })
      return prunePartSelection(current, owner ? owner.parts.map((part) => part.componentObjectId) : null)
    })
  }, [state])
  const gizmoModeRef = useRef<GizmoMode>(gizmoMode)
  gizmoModeRef.current = gizmoMode
  const setGizmoModeRef = useRef(setGizmoMode)
  setGizmoModeRef.current = setGizmoMode
  // Convex-hull overlay shown while the "place on face" tool is active.
  const faceHullRef = useRef<THREE.Mesh | null>(null)
  // The active plate's prime-tower marker (draggable).
  const primeTowerObjRef = useRef<THREE.Object3D | null>(null)
  // Index of the plate the viewport last started building, so a rebuild can tell a genuine
  // plate switch (defer for a loading indicator) from a same-plate rebuild (build immediately,
  // no partial-then-reload flicker — e.g. when slice-config/filament data settles after open).
  const prevBuiltPlateIndexRef = useRef<number | null>(null)
  // Commits a dragged prime-tower position back into state (rebound below).
  const movePrimeTowerRef = useRef<((x: number, y: number) => void) | null>(null)

  // Right-click context menu, anchored at the cursor: on an object (viewport or object
  // row) or on the selected part(s) of one object (part rows in the list).
  const [contextMenu, setContextMenu] = useState<
    | ({ x: number; y: number } & (
      | { kind: 'object'; key: string }
      | { kind: 'parts'; objectId: number; componentObjectIds: ReadonlyArray<number> }
    ))
    | null
  >(null)
  const openContextMenuRef = useRef<(menu: { x: number; y: number; key: string } | null) => void>(() => {})
  openContextMenuRef.current = (menu) => {
    if (!menu) {
      setContextMenu(null)
      return
    }
    // Right-clicking a member keeps the multi-selection (the menu offers bulk actions);
    // any other object becomes the sole selection first (BambuStudio behaviour).
    if (!allSelectedKeysRef.current().includes(menu.key)) selectExclusiveRef.current(menu.key)
    setContextMenu({ x: menu.x, y: menu.y, kind: 'object', key: menu.key })
  }
  // The context menu is a bare anchored Menu (no Dropdown), so it lacks Joy's built-in
  // click-away/Escape handling — wire it up below. `contextMenuListboxRef` is the menu's
  // listbox (for outside-click detection); the open + escape-suppress refs let the editor
  // Modal ignore the Escape we (or a re-right-click) dispatch to close the menu, so a right
  // click never tears down the whole editor.
  const contextMenuListboxRef = useRef<HTMLDivElement | null>(null)
  const contextMenuOpenRef = useRef(false)
  contextMenuOpenRef.current = contextMenu !== null
  const suppressEditorEscapeRef = useRef(false)
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onPointerDown = (event: PointerEvent) => {
      const listbox = contextMenuListboxRef.current
      if (listbox && event.target instanceof Node && listbox.contains(event.target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    // Capture pointerdown so an outside click closes the menu before it reaches other handlers;
    // a re-right-click closes it here too (then `onContextMenu` reopens it at the new spot).
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])
  // Offscreen renderer used to snapshot plate thumbnails.
  const thumbnailRendererRef = useRef<PlateThumbnailRenderer | null>(null)
  // Latest panel-sync + rotation-readout callbacks for non-React handlers.
  const syncSelectedTransformRef = useRef<((object: THREE.Object3D) => void) | null>(null)
  const setRotationReadoutRef = useRef<((angleDeg: number | null) => void) | null>(null)
  setRotationReadoutRef.current = setRotationReadout
  const regenerateActiveThumbnailRef = useRef<(() => void) | null>(null)

  // NOTE: cache-owned fetches deliberately take no AbortSignal. The promise is shared
  // across builds (prefetch + sequential assembly, superseding rebuilds), so tying it
  // to one build's signal let that build's teardown abort a fetch a NEWER build was
  // awaiting — the model never appeared and the AbortError surfaced as an error toast.
  // Builds cancel by checking their own `cancelled` flag after each await; a fetch
  // that outlives every consumer just completes into the cache (or evicts on failure).
  const fetchGeometry = useCallback((entryPath: string) => {
    const cache = geometryCacheRef.current
    const existing = cache.get(entryPath)
    if (existing) {
      touchCacheEntry(cache, entryPath, existing)
      return existing
    }
    const promise = (async () => {
      // Stall-guarded read: a wedged transport that commits a response then hangs mid-body
      // must fail loudly (so the viewport shows an error/retry) rather than freeze the build.
      const bytes = await fetchModelBytes(
        buildApiUrl(`${resourceBase}/scene-entry?path=${encodeURIComponent(entryPath)}`),
        { credentials: 'include' }
      )
      // Parse + process off the main thread (worker pool) so a huge object (50MB+ of mesh XML)
      // doesn't freeze the editor while it builds — falls back to a main-thread parse on worker error.
      return parseThreeMfModelEntryAsync(bytes)
    })()
    cache.set(entryPath, promise)
    evictGeometryCache(cache, GEOMETRY_CACHE_MAX_ENTRIES, (map) => { for (const geometry of map.values()) geometry.dispose() })
    // A failed load must not poison the cache for the next attempt.
    promise.catch(() => {
      if (cache.get(entryPath) === promise) cache.delete(entryPath)
    })
    return promise
  }, [resourceBase])

  const fetchImportGeometry = useCallback((importId: string, partIndex?: number) => {
    const cache = importGeometryCacheRef.current
    // A multi-solid import fetches each solid separately; cache them under distinct keys.
    const cacheKey = partIndex == null ? importId : `${importId}#${partIndex}`
    const existing = cache.get(cacheKey)
    if (existing) {
      touchCacheEntry(cache, cacheKey, existing)
      return existing
    }
    const promise = (async () => {
      const buffer = await fetchImportMesh(importId, partIndex)
      // Parse off the main thread (worker pool); falls back to a main-thread parse on worker error.
      return parseStlGeometryAsync(new Uint8Array(buffer))
    })()
    cache.set(cacheKey, promise)
    evictGeometryCache(cache, GEOMETRY_CACHE_MAX_ENTRIES, (geometry) => geometry.dispose())
    promise.catch(() => {
      if (cache.get(cacheKey) === promise) cache.delete(cacheKey)
    })
    return promise
  }, [])

  // Rebinds below (defined after buildInstanceGroup); a ref so the builder can
  // attach brim-ear markers without a circular declaration.
  const setGroupBrimEarMarkersRef = useRef<((group: THREE.Group, ears: EditorBrimEar[]) => void) | null>(null)

  // Build the Three.js group for one instance from its cached geometry.
  const buildInstanceGroup = useCallback(
    async (instance: EditorInstance): Promise<THREE.Group | null> => {
      const group = new THREE.Group()
      group.userData.instanceKey = instance.key
      // Rotation lives on an inner "rotor" group so the outer group carries only
      // position + scale. With the rotation applied *inside* the scale, the scale
      // gizmo (attached to the unrotated outer group) scales along the bed axes,
      // not the model's rotated axes.
      const rotor = new THREE.Group()
      group.add(rotor)
      group.userData.rotor = rotor
      // Prefer the live material color for this object's filament; fall back to the
      // color baked into the source scene.
      const meshFilamentId = resolveColorFilamentIdRef.current(instance.filamentId)
      // Colours are read via the ref (not the `filamentColors` prop) so buildInstanceGroup is stable
      // w.r.t. colour edits — a swatch change recolours in place (see the recolor effect) instead of
      // re-running this whole builder and rebuilding the plate. Each coloured mesh is tagged with its
      // resolved filament id + a static fallback so that effect can recompute its live colour.
      const meshColor = (meshFilamentId != null && filamentColorsRef.current?.[meshFilamentId]) || instance.color
      // Full geometry->world transform (the placement applied to the group below) so the
      // shared part builder computes bed clearance — and thus picks the same material and
      // edge outlines as the read-only preview.
      const placement = instance.exactMatrix
        ? createThreeMfMatrix(instance.exactMatrix)
        : new THREE.Matrix4().compose(
          instance.position,
          new THREE.Quaternion().setFromEuler(instance.rotation),
          instance.scale
        )

      if (instance.source.kind === 'import') {
        const importId = instance.source.importId
        if (instance.parts.length > 1) {
          // Multi-solid import (STEP assembly): each solid is fetched by index and added at its
          // own coordinates (the per-part STL is already in assembly space), coloured by its
          // own filament so a multi-material assembly renders correctly.
          const partGeometries = await Promise.all(
            instance.parts.map(async (part, index) => ({ part, geometry: await fetchImportGeometry(importId, index) }))
          )
          for (const { part, geometry } of partGeometries) {
            const partFilamentId = resolveColorFilamentIdRef.current(part.filamentId)
            const partColor = (partFilamentId != null && filamentColorsRef.current?.[partFilamentId]) || part.color || meshColor
            // subtype: an import solid retyped via "Change type" (e.g. to a modifier volume)
            // renders translucent like a baked part of that type.
            const partGroup = createThreeMfPartObject(geometry, { color: partColor, clearanceTransform: placement, subtype: part.subtype })
            if (!isModifierVolumeSubtype(part.subtype)) {
              const partMesh = partGroup.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true)
              if (partMesh) {
                applyLayerBandOverlays(partMesh.material as THREE.Material, layerBandUniformsRef.current)
                partMesh.userData.recolor = { filamentId: partFilamentId, fallbackColor: part.color || instance.color }
              }
            }
            rotor.add(partGroup)
          }
        } else {
          // Single mesh from the staged binary STL, no per-part transform.
          const geometry = await fetchImportGeometry(importId)
          const importGroup = createThreeMfPartObject(geometry, { color: meshColor, clearanceTransform: placement })
          const importMesh = importGroup.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true)
          if (importMesh) {
            applyLayerBandOverlays(importMesh.material as THREE.Material, layerBandUniformsRef.current)
            importMesh.userData.recolor = { filamentId: meshFilamentId, fallbackColor: instance.color }
          }
          rotor.add(importGroup)
        }
      } else {
        let placedParts = 0
        // Fetch every part entry CONCURRENTLY (the promise cache dedupes shared
        // entries); meshes are then assembled in part order so the group's children
        // stay deterministic. Serial awaits here made multi-part objects load at one
        // network round-trip per part.
        const partEntries = await Promise.all(
          instance.parts.map(async (part) => ({ part, geometries: await fetchGeometry(part.entryPath) }))
        )
        for (const { part, geometries } of partEntries) {
          const geometry = geometries.get(part.componentObjectId)
          if (!geometry) continue
          const partTransform = createThreeMfMatrix(part.transform)
          // Each part can use a different filament than the object; colour it by its
          // own filament so multi-material objects render correctly.
          const partFilamentId = resolveColorFilamentIdRef.current(part.filamentId)
          const partColor = (partFilamentId != null && filamentColorsRef.current?.[partFilamentId]) || part.color || meshColor
          const partGroup = createThreeMfPartObject(geometry, {
            color: partColor,
            transform: partTransform,
            clearanceTransform: placement.clone().multiply(partTransform),
            subtype: part.subtype
          })
          // Part identity for the part-selection highlight (owner comes from the
          // enclosing instance group's key; see syncPartSelectionBoxes).
          partGroup.userData.partRef = { componentObjectId: part.componentObjectId }
          // Printed parts (not blocker/enforcer/modifier volumes) are paintable with the
          // support/seam brushes; tag the mesh and show any existing paint as overlays.
          // Bambu marks ordinary parts subtype="normal_part", so test via the predicate.
          if (!isModifierVolumeSubtype(part.subtype)) {
            const paintableMesh = partGroup.children.find(
              (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true
            )
            if (paintableMesh) {
              applyLayerBandOverlays(paintableMesh.material as THREE.Material, layerBandUniformsRef.current)
              paintableMesh.userData.recolor = { filamentId: partFilamentId, fallbackColor: part.color || instance.color }
              paintableMesh.userData.supportPaintPart = {
                objectId: instance.objectId,
                componentObjectId: part.componentObjectId
              }
              for (const channel of ['supports', 'seam', 'color'] as const) {
                const spec = PAINT_CHANNEL_SPECS[channel]
                const sessionCodes = stateRef.current?.[spec.stateKey]?.[supportPaintKey(instance.objectId, part.componentObjectId)]
                const codes = sessionCodes ?? getGeometryTrianglePaint(paintableMesh.geometry as THREE.BufferGeometry, channel)
                if (codes && Object.keys(codes).length > 0) {
                  const overlay = buildTrianglePaintOverlay(paintableMesh.geometry as THREE.BufferGeometry, codes, {
                    palette: spec.palette,
                    name: spec.overlayName,
                    offsetFactor: spec.offsetFactor,
                    ...(channel === 'color' ? { colorForState: colorPaintStateColor } : {})
                  })
                  if (overlay) paintableMesh.add(overlay)
                }
              }
            }
          }
          rotor.add(partGroup)
          placedParts += 1
        }
        if (placedParts === 0) {
          disposeObject3D(group)
          return null
        }
      }
      if (instance.exactMatrix) {
        // Shearing foreign object: render its exact matrix verbatim (T·S·R can't reproduce it).
        // The rotor stays identity; the first transform edit bakes this to TRS (see bakeExactMatrix).
        group.matrixAutoUpdate = false
        group.matrix.copy(placement)
        group.matrixWorldNeedsUpdate = true
      } else {
        group.matrixAutoUpdate = true
        group.position.copy(instance.position)
        group.scale.copy(instance.scale)
        rotor.rotation.copy(instance.rotation)
      }
      if (instance.source.kind === 'object') {
        setGroupBrimEarMarkersRef.current?.(group, effectiveBrimEars(stateRef.current, instance))
        if (instance.source.kind === 'object') setGroupAddedPartMeshesRef.current?.(group, instance)
      }
      return group
    },
    // resolveColorFilamentId is read via its ref (not a dep) so a late filament/slice-config
    // settle on open doesn't recreate this builder and trigger a redundant second plate rebuild
    // — colours are applied/refreshed by the dedicated recolor effect, not by rebuilding geometry.
    [colorPaintStateColor, fetchGeometry, fetchImportGeometry]
  )

  // ---- Triangle painting (support + seam brushes) -------------------------------
  // The support/seam/colour brush settings + the apply/refresh/clear paint logic live
  // in useEditorPaint; the component feeds it the gizmo mode, live filament colours, the
  // shared colour-code resolver, and the state/group/selection/history refs it reads.
  // Kept as one object so the floating PaintToolPanel can take the whole controller as a prop
  // (it needs ~20 of these fields); the individual names below preserve the rest of EditorView.
  const paint = useEditorPaint({
    gizmoMode,
    filamentColors,
    colorPaintStateColor,
    stateRef,
    groupByKeyRef,
    selectedKeyRef,
    activePlateRef,
    recordHistoryRef,
    regenerateActiveThumbnailRef
  })
  const {
    paintBrushModeRef,
    paintBrushRadiusRef,
    paintToolRef,
    paintColorFilamentId,
    setPaintColorFilamentId,
    paintColorFilamentIdRef,
    activePaintChannel,
    activePaintChannelRef,
    refreshPaintOverlaysRef,
    applyPaintStrokeRef
  } = paint

  // The selected added part volume, for the floating part panel. The state object is
  // mutated in place (paint idiom), but every selection change re-renders, so reading
  // through the current key stays fresh.
  const selectedAddedPart = useMemo(() => {
    if (!selectedAddedPartKey || !state?.addedParts) return null
    for (const parts of Object.values(state.addedParts)) {
      const part = parts.find((entry) => entry.key === selectedAddedPartKey)
      if (part) return part
    }
    return null
  }, [selectedAddedPartKey, state])

  // ---- Added part volumes ----------------------------------------------------------

  /** Replace an instance group's added-part meshes (translucent volumes on the rotor). */
  const setGroupAddedPartMeshes = useCallback((group: THREE.Group, instance: EditorInstance) => {
    const rotor = rotorOf(group)
    for (const child of rotor.children.filter((entry) => entry.name === ADDED_PART_MESH_NAME)) {
      rotor.remove(child)
      disposeObject3D(child)
    }
    for (const part of effectiveAddedParts(stateRef.current, instance)) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(part.soup.slice(), 3))
      geometry.computeVertexNormals()
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: ADDED_PART_SPECS[part.subtype].color,
          transparent: true,
          opacity: 0.45,
          roughness: 0.5,
          metalness: 0,
          depthWrite: false
        })
      )
      mesh.name = ADDED_PART_MESH_NAME
      mesh.position.copy(part.position)
      mesh.rotation.copy(part.rotation)
      mesh.scale.copy(part.scale)
      mesh.userData.addedPartKey = part.key
      // Aids, not printed geometry: excluded from bed-rest, selection box, footprints.
      mesh.userData.isModifier = true
      mesh.renderOrder = 3
      rotor.add(mesh)
    }
  }, [])
  const setGroupAddedPartMeshesRef = useRef(setGroupAddedPartMeshes)
  setGroupAddedPartMeshesRef.current = setGroupAddedPartMeshes

  /** Re-derive every built group's added-part meshes from the current editor state. */
  const refreshAddedPartMeshes = useCallback(() => {
    for (const [key, group] of groupByKeyRef.current) {
      const instance = activePlateRef.current?.instances.find((entry) => entry.key === key)
      if (!instance || instance.source.kind !== 'object') continue
      setGroupAddedPartMeshes(group, instance)
    }
  }, [setGroupAddedPartMeshes])
  const refreshAddedPartMeshesRef = useRef(refreshAddedPartMeshes)
  refreshAddedPartMeshesRef.current = refreshAddedPartMeshes

  /** Persist a gizmo-dragged part mesh's transform into the editor state. */
  const writeBackAddedPart = useCallback((mesh: THREE.Object3D) => {
    const state = stateRef.current
    const key = mesh.userData.addedPartKey
    if (!state?.addedParts || typeof key !== 'string') return
    for (const parts of Object.values(state.addedParts)) {
      const part = parts.find((entry) => entry.key === key)
      if (part) {
        part.position.copy(mesh.position)
        part.rotation.copy(mesh.rotation)
        part.scale.copy(mesh.scale)
        return
      }
    }
  }, [])
  const writeBackAddedPartRef = useRef(writeBackAddedPart)
  writeBackAddedPartRef.current = writeBackAddedPart

  // ---- Brim ears -----------------------------------------------------------------

  /** Replace an instance group's ear markers (translucent discs childed to the rotor). */
  const setGroupBrimEarMarkers = useCallback((group: THREE.Group, ears: EditorBrimEar[]) => {
    const rotor = (group.userData.rotor as THREE.Group | undefined) ?? group
    for (const child of rotor.children.filter((entry) => entry.name === BRIM_EAR_MARKER_NAME)) {
      rotor.remove(child)
      disposeObject3D(child)
    }
    ears.forEach((ear, index) => {
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(ear.radius, ear.radius, 1, 24),
        new THREE.MeshStandardMaterial({
          color: BRIM_EAR_MARKER_COLOR,
          transparent: true,
          opacity: 0.75,
          roughness: 0.5,
          metalness: 0,
          depthWrite: false
        })
      )
      marker.name = BRIM_EAR_MARKER_NAME
      marker.userData.brimEarIndex = index
      marker.userData.brimEarLocal = { x: ear.x, y: ear.y, z: ear.z }
      marker.renderOrder = 2
      // The marker's matrix is fully baked by syncBrimEarMarkerMatrices (flat on the
      // bed, world-scale radius) — local position/rotation/scale are never used.
      marker.matrixAutoUpdate = false
      rotor.add(marker)
    })
    syncBrimEarMarkerMatrices(group)
  }, [])
  setGroupBrimEarMarkersRef.current = setGroupBrimEarMarkers

  /** Re-derive every built group's ear markers from the current editor state. */
  const refreshBrimEarMarkers = useCallback(() => {
    for (const [key, group] of groupByKeyRef.current) {
      const instance = activePlateRef.current?.instances.find((entry) => entry.key === key)
      if (!instance || instance.source.kind !== 'object') continue
      setGroupBrimEarMarkers(group, effectiveBrimEars(stateRef.current, instance))
    }
  }, [setGroupBrimEarMarkers])
  const refreshBrimEarMarkersRef = useRef(refreshBrimEarMarkers)
  refreshBrimEarMarkersRef.current = refreshBrimEarMarkers

  /** Apply one ear edit (add at an object-local point / remove by index / clear). */
  const editSelectedBrimEars = useCallback((edit:
    | { kind: 'add'; group: THREE.Group; worldPoint: THREE.Vector3 }
    | { kind: 'remove'; index: number }
    | { kind: 'clear' }
  ) => {
    const state = stateRef.current
    const instance = activePlateRef.current?.instances.find((entry) => entry.key === selectedKeyRef.current)
    if (!state || !instance || instance.source.kind !== 'object') return
    recordHistoryRef.current?.()
    const current = effectiveBrimEars(state, instance)
    let next: EditorBrimEar[]
    if (edit.kind === 'add') {
      const rotor = (edit.group.userData.rotor as THREE.Group | undefined) ?? edit.group
      rotor.updateWorldMatrix(true, false)
      // Bambu rule: the clicked surface point drops straight down to the bed — brim
      // ears are first-layer features, so a click anywhere on a side wall places the
      // ear underneath it (world z just below the bed, matching GLGizmoBrimEars).
      const world = edit.worldPoint.clone()
      world.z = -0.0001
      const local = rotor.worldToLocal(world)
      next = [...current, { x: local.x, y: local.y, z: local.z, radius: brimEarDiameterRef.current / 2 }]
    } else if (edit.kind === 'remove') {
      next = current.filter((_, index) => index !== edit.index)
    } else {
      next = []
    }
    if (!state.brimEars) state.brimEars = {}
    state.brimEars[instance.objectId] = next
    refreshBrimEarMarkers()
    regenerateActiveThumbnailRef.current?.()
  }, [refreshBrimEarMarkers, recordHistoryRef])
  const editSelectedBrimEarsRef = useRef(editSelectedBrimEars)
  editSelectedBrimEarsRef.current = editSelectedBrimEars

  // Undo/redo restores a cloned state (new paint/ear identities): rebuild overlays and
  // ear markers so the viewport matches the restored state. Cheap when nothing is set.
  useEffect(() => {
    refreshPaintOverlaysRef.current()
    refreshBrimEarMarkersRef.current()
    refreshAddedPartMeshesRef.current()
    // Part meshes are rebuilt with new identities; re-aim the gizmo at the new mesh.
    reattachGizmoRef.current()
  }, [state, filamentColors, refreshPaintOverlaysRef])

  /** Copy a dragged group's transform into the matching editor instance (in place). */
  const writeBackGroupTransform = useCallback((object: THREE.Object3D) => {
    const key = object.userData.instanceKey
    if (typeof key !== 'string') return
    const current = stateRef.current
    if (!current) return
    for (const plate of current.plates) {
      const instance = plate.instances.find((entry) => entry.key === key)
      if (!instance) continue
      const rotation = rotorOf(object).rotation
      instance.position.copy(object.position)
      instance.rotation.copy(rotation)
      instance.scale.copy(object.scale)
      return
    }
  }, [])

  /**
   * Snap a shearing (exact-matrix) object to the editor's editable T·S·R form before a transform
   * edit. It rendered its exact matrix verbatim (rotor identity, matrixAutoUpdate off); restore the
   * decomposed translate/scale/rotation onto the group + rotor and drop the exact matrix so the
   * gizmo/manual edits drive it normally. No-op for the common (non-shearing) case.
   */
  const bakeExactMatrix = useCallback((group: THREE.Object3D) => {
    const key = group.userData.instanceKey
    if (typeof key !== 'string') return
    const instance = stateRef.current?.plates.flatMap((plate) => plate.instances).find((entry) => entry.key === key)
    if (!instance?.exactMatrix) return
    instance.exactMatrix = undefined
    group.matrixAutoUpdate = true
    group.position.copy(instance.position)
    group.scale.copy(instance.scale)
    rotorOf(group).rotation.copy(instance.rotation)
  }, [])
  const bakeExactMatrixRef = useRef(bakeExactMatrix)
  bakeExactMatrixRef.current = bakeExactMatrix

  // Initialize renderer/camera/controls once a container exists (the scene effect lives
  // in useEditorScene; EditorView still owns the refs/callbacks it reads).
  useEditorScene({
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
    setSelectionHighlightRef,
    gizmoModeRef,
    setGizmoModeRef,
    bakeExactMatrixRef,
    syncSelectedTransformRef,
    setRotationReadoutRef,
    writeBackAddedPartRef,
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
  })

  /** Mirror a group's transform into the manual-input panel (plate-local frame). */
  const syncSelectedTransform = useCallback((object: THREE.Object3D) => {
    const rotation = rotorOf(object).rotation
    setSelectedTransform({
      position: { x: object.position.x, y: object.position.y, z: object.position.z },
      rotationDeg: {
        x: THREE.MathUtils.radToDeg(rotation.x),
        y: THREE.MathUtils.radToDeg(rotation.y),
        z: THREE.MathUtils.radToDeg(rotation.z)
      },
      scalePct: { x: object.scale.x * 100, y: object.scale.y * 100, z: object.scale.z * 100 }
    })
  }, [])
  syncSelectedTransformRef.current = syncSelectedTransform

  // Rebuild the viewport whenever the active plate changes or its instance set
  // changes (add/remove/duplicate). Gizmo drags mutate Three.js groups directly,
  // so they do NOT trigger a rebuild.
  const activeInstanceKeys = useMemo(
    () => activePlate?.instances.map((instance) => instance.key).join(',') ?? '',
    [activePlate]
  )

  // When the viewport container changes (e.g. the responsive layout swaps the 3D
  // view between the desktop sidebar grid and the mobile stack), the scene is torn
  // down and rebuilt. sceneReady round-trips false→true within one commit, so the
  // plate-build effect below wouldn't see a change; bump rebuildToken to force it.
  useEffect(() => {
    if (viewerContainer) setRebuildToken((token) => token + 1)
  }, [viewerContainer])

  useEffect(() => {
    const scene = sceneRef.current
    const plateRoot = plateRootRef.current
    if (!scene || !plateRoot || !activePlate) return

    let cancelled = false
    const abort = new AbortController()
    setViewerError(null)
    setViewportBuilding(true)

    // Bed dimensions for the active plate, drawn at the bed's true centre so the grid
    // spans [minX,maxX]x[minY,maxY]. Instances stay in the same plate-local frame
    // (their decomposed positions), so objects sit on the grid. World == plate-local.
    const bedWidth = Math.max(activePlate.bed.maxX - activePlate.bed.minX, 1)
    const bedDepth = Math.max(activePlate.bed.maxY - activePlate.bed.minY, 1)
    const bedCenterX = (activePlate.bed.minX + activePlate.bed.maxX) / 2
    const bedCenterY = (activePlate.bed.minY + activePlate.bed.maxY) / 2
    bedCenterRef.current = { x: bedCenterX, y: bedCenterY }
    // Re-frame the iso view on the new bed centre when the plate changes, sizing distance to
    // the bed. Adding/removing models on the same plate keeps the current camera.
    viewDistanceRef.current = Math.max(bedWidth, bedDepth) * 1.6
    const isPlateSwitch = prevBuiltPlateIndexRef.current !== null && prevBuiltPlateIndexRef.current !== activePlateIndex
    prevBuiltPlateIndexRef.current = activePlateIndex
    // Reframe on a genuine plate switch, and when the plate OR its bed changes (e.g.
    // switching target printer resizes/moves the bed). Adding/removing models on the same
    // plate+bed keeps the user's current camera. The plate-switch check is deliberate
    // belt-and-braces over the key compare: index reuse (plate reorder/delete) can leave a
    // stale latched key matching the new plate, which must not skip the switch reframe.
    const viewKey = `${activePlateIndex}|${bedCenterX},${bedCenterY},${bedWidth},${bedDepth}`
    // Reframe the camera SYNCHRONOUSLY here (not at the async swap below). frameDefaultView
    // only reads the bed centre/distance refs set just above — it's independent of the geometry
    // — and on open the build effect can run several times while slice-config/filament data
    // settles. If the reframe waited for the swap, the first run would latch the view key but
    // get superseded before swapping, and the surviving run (key already latched) would skip the
    // reframe entirely, leaving the initial plate framed on the default camera.
    if (isPlateSwitch || framedViewKeyRef.current !== viewKey) {
      // Don't latch the key while this plate's scene is still loading: it is framed on the
      // borrowed/placeholder bed, and if the real bed differs the post-fill rebuild must still
      // see a key change and reframe.
      if (!pendingScenePlatesRef.current.has(activePlateIndex)) framedViewKeyRef.current = viewKey
      frameDefaultViewRef.current?.()
    }

    // Render strategy turns on whether the live plate is EMPTY:
    //  - A genuine plate switch clears it (just below), and the first open starts empty: build
    //    straight onto the live plateRoot and reveal each model as it finishes, so loading reads
    //    as steady progress instead of one late pop-in — and we never hold two plates' geometry
    //    at once (lower peak memory on a switch).
    //  - When the plate already has content (same-plate add/remove/duplicate, or a settling
    //    rebuild on open) build into a DETACHED staging group and swap it in atomically once
    //    complete. That path never flashes the plate empty when a build is superseded mid-flight
    //    (slice-config/filament settling, a rapid switch); a superseded staged build just discards
    //    its group and the visible plate is untouched.
    if (isPlateSwitch) {
      // Empty the previous plate from the live view immediately rather than leaving its models up
      // while the new plate loads: detach the gizmo and dispose the old meshes. The destination
      // plate's empty bed is added just below; models then populate onto it.
      transformRef.current?.detach()
      disposeObject3D(plateRoot)
      plateRoot.clear()
      groupByKeyRef.current.clear()
      primeTowerObjRef.current = null
    }
    const incremental = groupByKeyRef.current.size === 0
    setBuildIncremental(incremental)
    // Publish the load count SYNCHRONOUSLY (before the async build's first paint/prefetch) so the
    // progress bar shows the real total from the first frame — otherwise a partly-loaded plate reads
    // as finished while the count is still null. Count per-PART (the actual download units, mirroring
    // the prefetch fan-out below), not per-object, so a single multi-solid assembly still shows
    // granular progress instead of a stuck "1 of 1". The prefetch bumps `done` as each part settles.
    const totalLoadUnits = activePlate.instances.reduce((sum, instance) => sum + (
      instance.source.kind === 'import'
        ? (instance.parts.length > 1 ? instance.parts.length : 1)
        : instance.parts.length
    ), 0)
    setBuildProgress(totalLoadUnits > 0 ? { done: 0, total: totalLoadUnits } : null)
    if (incremental && !plateRoot.children.some((child) => child.userData?.isBedSurface)) {
      // Show the destination plate's empty bed straight away; models append onto it as they build.
      const liveBed = createPreviewPlateSurface({ width: bedWidth, depth: bedDepth, centerX: bedCenterX, centerY: bedCenterY, excludeAreas: activePlate.bed.excludeAreas })
      liveBed.userData.isBedSurface = true
      plateRoot.add(liveBed)
    }

    void (async () => {
      // Incremental: add straight to the live plateRoot (already bearing its bed). Atomic: assemble
      // in a detached staging group (with its own bed) and swap it in at the end.
      const staging = incremental ? null : new THREE.Group()
      const target = staging ?? plateRoot
      if (staging) {
        const bedSurface = createPreviewPlateSurface({ width: bedWidth, depth: bedDepth, centerX: bedCenterX, centerY: bedCenterY, excludeAreas: activePlate.bed.excludeAreas })
        // Tagged so the thumbnail renderer hides it (Bambu-style model-only thumbnails).
        bedSurface.userData.isBedSurface = true
        staging.add(bedSurface)
      }
      const builtGroups = new Map<string, THREE.Group>()
      let builtTower: THREE.Object3D | null = null
      // Only the detached staging group is ours to discard on cancel; live (incremental) models
      // already on plateRoot are reconciled by the next build's swap/clear or by scene teardown.
      const discardStaging = () => { if (staging) disposeObject3D(staging) }

      // Paint once before the (potentially heavy) geometry work so the loading indicator shows
      // immediately rather than after the first object's synchronous build.
      await nextPaint()
      if (cancelled) { discardStaging(); return }

      // Advance the progress bar as each part download settles (success OR failure), so the
      // indicator reflects real download progress — even for one big multi-part assembly. Guarded on
      // `cancelled` so a superseded build never writes progress for a plate the user left.
      let loadedUnits = 0
      const bumpLoaded = () => {
        if (cancelled) return
        loadedUnits += 1
        setBuildProgress(totalLoadUnits > 0 ? { done: loadedUnits, total: totalLoadUnits } : null)
      }
      // Warm the geometry caches for everything on the plate up front. fetchModelBytes caps how
      // many downloads actually run at once, so firing them all here just front-runs the sequential
      // build below without oversubscribing the connection pool (which used to trip the stall guard).
      for (const instance of activePlate.instances) {
        if (instance.source.kind === 'import') {
          const importId = instance.source.importId
          if (instance.parts.length > 1) {
            instance.parts.forEach((_part, index) => fetchImportGeometry(importId, index).then(bumpLoaded, bumpLoaded))
          } else {
            fetchImportGeometry(importId).then(bumpLoaded, bumpLoaded)
          }
        } else {
          for (const part of instance.parts) fetchGeometry(part.entryPath).then(bumpLoaded, bumpLoaded)
        }
      }
      const instances = activePlate.instances
      let lastPaintAt = performance.now()
      for (let instanceIndex = 0; instanceIndex < instances.length; instanceIndex += 1) {
        const instance = instances[instanceIndex]!
        try {
          const group = await buildInstanceGroup(instance)
          if (cancelled) {
            if (group) disposeObject3D(group)
            discardStaging()
            return
          }
          if (group) {
            // Rest every object on the bed as it's built and persist the corrected z into state
            // (in place, like writeBack — no re-render). Objects must sit on the bed for slicing,
            // and this guarantees nothing is ever displayed floating/sunk — so a later move/scale
            // never "snaps" it to the bed (the long-standing jump bug).
            restObjectOnBed(group)
            instance.position.z = group.position.z
            setObjectPrintedStyle(group, isInstancePrintedRef.current(instance))
            target.add(group)
            builtGroups.set(instance.key, group)
            // Incremental: register each model live as it lands so a superseding rebuild sees the
            // plate is non-empty and takes the atomic-swap path (no duplicate, no empty flash).
            if (incremental) groupByKeyRef.current.set(instance.key, group)
          }
        } catch (error) {
          if (cancelled || abort.signal.aborted) { discardStaging(); return }
          setViewerError(error instanceof Error ? error.message : 'Unable to load model geometry.')
        }
        // Yield so the view paints (each model appears as it lands in incremental mode) and input
        // stays responsive while a multi-object plate builds. Throttled to ~frame cadence so a
        // quick plate isn't slowed by needless waits.
        if (instanceIndex < instances.length - 1 && performance.now() - lastPaintAt > 24) {
          await nextPaint()
          if (cancelled) { discardStaging(); return }
          lastPaintAt = performance.now()
        }
      }
      if (cancelled) { discardStaging(); return }
      // Now that the plate's models are present, size the prime tower to the print height (its
      // depth depends on height) and place it on the bed — but only when the plate actually
      // prints more than one filament, since that's the only time a purge/prime tower is
      // generated. Use the plate's authoritative filament list (a single object can be
      // multi-filament via its parts, so counting distinct per-instance filaments under-counts).
      if (activePlate.primeTower && activePlateFilamentCountRef.current >= 2) {
        const bounds = new THREE.Box3()
        let printHeight = 0
        for (const group of builtGroups.values()) {
          bounds.setFromObject(group)
          if (!bounds.isEmpty()) printHeight = Math.max(printHeight, bounds.max.z)
        }
        builtTower = createPrimeTowerObject(activePlate.primeTower, activePlateFilamentCountRef.current, printHeight || 30)
        target.add(builtTower)
      }

      if (staging) {
        // ---- Atomic swap: replace the visible plate with the freshly built one in one frame. ----
        transformRef.current?.detach()
        disposeObject3D(plateRoot)
        plateRoot.clear()
        while (staging.children.length > 0) plateRoot.add(staging.children[0]!)
        groupByKeyRef.current.clear()
        for (const [key, group] of builtGroups) groupByKeyRef.current.set(key, group)
      }
      // Incremental builds are already live (groupByKeyRef was populated as each model landed).
      primeTowerObjRef.current = builtTower
      // Re-attach the gizmo to the selected instance if it is on this plate.
      reattachGizmo()
      // All of this plate's models are now in the scene — refresh placement warnings now so a
      // rebuild-driven change (undo/redo, delete, duplicate, plate switch) reflects in the panel
      // immediately rather than on the next rAF poll tick (which can lag, or never arrive if a
      // drag flag was left stuck). The poll remains as a backstop for non-rebuild moves.
      recomputeWarningsRef.current()
      setBuildProgress(null)
      setBuildIncremental(false)
      setViewportBuilding(false)
      // Snapshot this plate now that its contents are present.
      regenerateActivePlateThumbnail()
    })()

    return () => {
      cancelled = true
      abort.abort()
      // A superseded/cancelled build returns early without clearing the building flag; reset it
      // here so it never sticks "true" (which would leave controls disabled on a ready viewport).
      // The next effect run sets it true again synchronously, so there's no flicker.
      setViewportBuilding(false)
      setBuildProgress(null)
      setBuildIncremental(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlateIndex, activeInstanceKeys, buildInstanceGroup, sceneReady, rebuildToken])

  const reattachGizmo = useCallback(() => {
    const transform = transformRef.current
    if (!transform) return
    const group = selectedKey ? groupByKeyRef.current.get(selectedKey) : null
    setSelectionHighlightRef.current?.(group ?? null)
    if (!group) {
      transform.detach()
      setSelectedTransform(null)
      return
    }
    // The "place on face", "cut", and "paint supports" tools have no gizmo (layFace
    // lays a clicked face down; cut drives a plane via its panel; paint brushes the
    // mesh directly); the move/rotate/scale gizmos attach normally. Rotate attaches
    // to the inner rotor (so it spins the model); move/scale attach to the outer
    // group (so scaling is along the bed axes, and the gizmo's scale handles aren't
    // rotated).
    if (gizmoMode === 'layFace' || gizmoMode === 'cut' || gizmoMode === 'brimEars' || gizmoMode === 'measure' || paintChannelForGizmoMode(gizmoMode) !== null) {
      transform.detach()
    } else if (selectedAddedPartKey) {
      // A selected added part volume takes the gizmo (object-local transform).
      let partMesh: THREE.Object3D | null = null
      group.traverse((node) => {
        if (!partMesh && node.userData.addedPartKey === selectedAddedPartKey) partMesh = node
      })
      if (partMesh) {
        transform.attach(partMesh)
        transform.setMode(gizmoMode)
      } else {
        transform.attach(gizmoMode === 'rotate' ? rotorOf(group) : group)
        transform.setMode(gizmoMode)
      }
    } else {
      transform.attach(gizmoMode === 'rotate' ? rotorOf(group) : group)
      transform.setMode(gizmoMode)
    }
    syncSelectedTransform(group)
  }, [selectedKey, gizmoMode, selectedAddedPartKey, syncSelectedTransform])

  const reattachGizmoRef = useRef(reattachGizmo)
  reattachGizmoRef.current = reattachGizmo

  // Keep the gizmo synced to the current selection + mode.
  useEffect(() => {
    reattachGizmo()
  }, [reattachGizmo])

  // Selecting a different instance always drops back to object-level transform.
  useEffect(() => {
    setSelectedAddedPartKey(null)
  }, [selectedKey])

  // Re-dim instances whose print toggle changed, without rebuilding the plate.
  useEffect(() => {
    for (const [key, group] of groupByKeyRef.current) {
      const instance = activePlate?.instances.find((entry) => entry.key === key)
      if (instance) setObjectPrintedStyle(group, isInstancePrinted(instance))
    }
  }, [isInstancePrinted, activePlate, rebuildToken])

  // Show the convex-hull face overlay while "place on face" is active so the user
  // can pick a face to lay down — including pseudo-faces over open ends.
  useEffect(() => {
    if (gizmoMode !== 'layFace' || !selectedKey) return undefined
    const group = groupByKeyRef.current.get(selectedKey)
    if (!group) return undefined
    const hull = buildFaceHullOverlay(group)
    if (!hull) return undefined
    group.add(hull)
    faceHullRef.current = hull
    return () => {
      group.remove(hull)
      // disposeObject3D recurses, so the hovered-face highlight (fill + outline children) is freed too.
      disposeObject3D(hull)
      if (faceHullRef.current === hull) faceHullRef.current = null
    }
  }, [gizmoMode, selectedKey, rebuildToken, faceHullToken])

  // Show a translucent world-space cut plane over the selected object while the Cut tool
  // is active, oriented perpendicular to the chosen axis; the cut panel drives its offset.
  const cutPlaneMeshRef = useRef<THREE.Mesh | null>(null)
  useEffect(() => {
    if (gizmoMode !== 'cut' || !selectedKey) { setCutRange(null); return undefined }
    const scene = sceneRef.current
    const group = groupByKeyRef.current.get(selectedKey)
    if (!scene || !group) { setCutRange(null); return undefined }
    const box = printableMeshBox(group)
    if (box.isEmpty()) { setCutRange(null); return undefined }
    setCutRange({ min: box.min[cutAxis], max: box.max[cutAxis] })
    setCutOffset((box.min[cutAxis] + box.max[cutAxis]) / 2)
    const margin = 6
    const size = new THREE.Vector3().subVectors(box.max, box.min)
    // PlaneGeometry lies in XY (normal +Z); rotate it so its normal matches the cut axis,
    // sizing each span to the object's extent along the in-plane world axes.
    const geometry = cutAxis === 'x'
      ? new THREE.PlaneGeometry(size.z + margin * 2, size.y + margin * 2)
      : cutAxis === 'y'
        ? new THREE.PlaneGeometry(size.x + margin * 2, size.z + margin * 2)
        : new THREE.PlaneGeometry(size.x + margin * 2, size.y + margin * 2)
    const plane = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false })
    )
    if (cutAxis === 'x') plane.rotation.y = Math.PI / 2
    if (cutAxis === 'y') plane.rotation.x = Math.PI / 2
    plane.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2)
    plane.renderOrder = 4
    scene.add(plane)
    cutPlaneMeshRef.current = plane
    return () => {
      scene.remove(plane)
      plane.geometry.dispose()
      ;(plane.material as THREE.Material).dispose()
      if (cutPlaneMeshRef.current === plane) cutPlaneMeshRef.current = null
    }
  }, [gizmoMode, selectedKey, cutAxis, rebuildToken])

  useEffect(() => {
    if (cutPlaneMeshRef.current) cutPlaneMeshRef.current.position[cutAxis] = clampedCutOffset
  }, [clampedCutOffset, cutAxis])

  // Measure overlay: endpoint markers, a connecting line, and a floating distance
  // label. Lives on the scene root (not plateRoot) so plate thumbnails never
  // include it; rebuilt whenever the picked points change.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || gizmoMode !== 'measure' || measurePoints.length === 0) return undefined
    const group = new THREE.Group()
    for (const point of measurePoints) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0x7fb8ff, depthTest: false })
      )
      marker.position.set(point.x, point.y, point.z)
      marker.renderOrder = 7
      group.add(marker)
    }
    const [a, b] = measurePoints
    if (a && b) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a.x, a.y, a.z),
          new THREE.Vector3(b.x, b.y, b.z)
        ]),
        new THREE.LineBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.9, depthTest: false })
      )
      line.renderOrder = 7
      group.add(line)
      const label = createMeasureLabelSprite(`${Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z).toFixed(2)} mm`)
      if (label) {
        label.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2 + 4)
        group.add(label)
      }
    }
    scene.add(group)
    return () => {
      scene.remove(group)
      disposeObject3D(group)
    }
  }, [measurePoints, gizmoMode, sceneReady, rebuildToken])

  // Rotation snapping: coarse (45 deg) while a modifier is held, finer (15 deg)
  // otherwise. Translate/scale stay free. Re-applied whenever the mode changes.
  useEffect(() => {
    const transform = transformRef.current as unknown as TransformControlsSnap | null
    if (!transform) return
    transform.setTranslationSnap(null)
    transform.setScaleSnap(null)
    transform.setRotationSnap(gizmoMode === 'rotate' ? ROTATE_SNAP_FINE : null)
  }, [gizmoMode])

  // Coarse rotation snap while Shift is held during rotate mode.
  useEffect(() => {
    if (gizmoMode !== 'rotate') return
    const setSnap = (coarse: boolean) => {
      const snap = transformRef.current as unknown as TransformControlsSnap | null
      snap?.setRotationSnap(coarse ? ROTATE_SNAP_COARSE : ROTATE_SNAP_FINE)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Shift') setSnap(true) }
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Shift') setSnap(false) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [gizmoMode])

  // ---- Plate thumbnails ------------------------------------------------------
  // A single offscreen renderer for plate snapshots, created lazily on first use.
  const getThumbnailRenderer = useCallback((): PlateThumbnailRenderer => {
    let renderer = thumbnailRendererRef.current
    if (!renderer) {
      renderer = createPlateThumbnailRenderer()
      thumbnailRendererRef.current = renderer
    }
    return renderer
  }, [])

  useEffect(() => () => {
    thumbnailRendererRef.current?.dispose()
    thumbnailRendererRef.current = null
  }, [])

  /** Snapshot the live active plate (uses the already-built `plateRoot`). */
  const regenerateActivePlateThumbnail = useCallback(() => {
    const plateRoot = plateRootRef.current
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plateRoot || !plate) return
    try {
      const url = getThumbnailRenderer().render(plateRoot, plate.bed)
      setPlateThumbnails((current) => ({ ...current, [plate.index]: url }))
    } catch {
      // Thumbnail rendering is best-effort; ignore failures.
    } finally {
      // `render` re-parents the group out of the editor scene; restore it.
      const scene = sceneRef.current
      if (scene && plateRoot.parent !== scene) scene.add(plateRoot)
    }
  }, [activePlateIndex, getThumbnailRenderer])
  regenerateActiveThumbnailRef.current = regenerateActivePlateThumbnail

  /**
   * Render a fresh thumbnail for EVERY plate from the current arrangement and return them
   * as base64 PNGs for embedding in a saved 3MF / sliced gcode. The live per-plate regen is
   * keyed on the instance set (`platesSignature`), so it does not refire when objects are
   * merely moved/rotated/scaled — capturing here at save/slice time guarantees the persisted
   * output's thumbnail matches the real layout instead of a stale one. Also refreshes the
   * live plate-strip previews as a side effect.
   */
  const captureAllPlateThumbnails = useCallback(
    async (current: EditorState): Promise<Array<{ plateIndex: number; png: string }>> => {
      const renderer = getThumbnailRenderer()
      const out: Array<{ plateIndex: number; png: string }> = []
      for (const plate of current.plates) {
        if (plate.index <= 0) continue
        // Only re-render plates the user has actually opened — they have a live thumbnail and
        // their geometry is already cached, so this is cheap. Unopened plates are skipped: the
        // bake (embedPlateThumbnails) preserves their original embedded PNG, so a large
        // multi-plate project never loads every plate's geometry just to save.
        if (!plateThumbnailsRef.current[plate.index]) continue
        const group = new THREE.Group()
        try {
          for (const instance of plate.instances) {
            const built = await buildInstanceGroup(instance)
            if (built) group.add(built)
          }
          const url = renderer.render(group, plate.bed)
          setPlateThumbnails((existing) => ({ ...existing, [plate.index]: url }))
          const png = url.replace(/^data:image\/png;base64,/, '')
          if (png.length > 0) out.push({ plateIndex: plate.index, png })
        } catch {
          // Best-effort per plate; a failed plate just keeps its previous thumbnail.
        } finally {
          disposeObject3D(group)
        }
      }
      return out
    },
    [buildInstanceGroup, getThumbnailRenderer]
  )

  // Non-active plates no longer render in the background to fill the plate strip — that made
  // large multi-plate projects fetch + build every plate's geometry up front (very janky).
  // The strip shows each plate's embedded PNG thumbnail until the user opens it; a plate gets
  // a live client-rendered thumbnail only once it's the active plate (regenerateActivePlateThumbnail).

  // ---- State mutations -------------------------------------------------------
  // Shared band-shader uniforms: every part material reads these, so editing the
  // panel recolours the whole plate immediately.
  const layerBandUniformsRef = useRef<LayerBandUniforms>({
    uFcCount: { value: 0 },
    uFcHeights: { value: new Array(FILAMENT_CHANGE_MAX_BANDS).fill(0) },
    uFcColors: { value: Array.from({ length: FILAMENT_CHANGE_MAX_BANDS }, () => new THREE.Color('#9aa4ad')) },
    uPauseCount: { value: 0 },
    uPauseHeights: { value: new Array(LAYER_PAUSE_MAX_STRIPES).fill(0) }
  })
  useEffect(() => {
    const uniforms = layerBandUniformsRef.current
    const changes = activePlate
      ? [...effectiveFilamentChanges(activePlate)].sort((left, right) => left.z - right.z).slice(0, FILAMENT_CHANGE_MAX_BANDS)
      : []
    uniforms.uFcCount.value = changes.length
    changes.forEach((change, index) => {
      uniforms.uFcHeights.value[index] = change.z
      const colorFilamentId = resolveColorFilamentId(change.filamentId)
      uniforms.uFcColors.value[index]!.set(
        (colorFilamentId != null && filamentColors?.[colorFilamentId]) || '#9aa4ad'
      )
    })
    const pauses = activePlate ? effectivePauses(activePlate).slice(0, LAYER_PAUSE_MAX_STRIPES) : []
    uniforms.uPauseCount.value = pauses.length
    pauses.forEach((pause, index) => {
      uniforms.uPauseHeights.value[index] = pause.z
    })
  }, [activePlate, state, filamentColors, resolveColorFilamentId])

  // Default the colour brush to the second material (painting with the first is a
  // no-op visually) once options are known or when the chosen one disappears.
  useEffect(() => {
    if (paintColorFilamentId != null && filamentOptions.some((option) => option.id === paintColorFilamentId)) return
    setPaintColorFilamentId(filamentOptions[1]?.id ?? filamentOptions[0]?.id ?? null)
  }, [filamentOptions, paintColorFilamentId, setPaintColorFilamentId])

  /** Replace the active plate's layer-based filament changes (history-recorded). */
  const setActivePlateFilamentChanges = useCallback((changes: EditorFilamentChange[]) => {
    updatePlates((plates) => plates.map((plate) => (
      plate.index === activePlateIndex ? { ...plate, filamentChangesOverride: changes } : plate
    )))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlateIndex])

  /** Replace the active plate's layer pauses (history-recorded). */
  const setActivePlatePauses = useCallback((pauses: EditorPause[]) => {
    updatePlates((plates) => plates.map((plate) => (
      plate.index === activePlateIndex ? { ...plate, pausesOverride: pauses } : plate
    )))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlateIndex])

  const updatePlates = useCallback((updater: (plates: EditorPlate[]) => EditorPlate[]) => {
    recordHistory()
    setState((current) => {
      if (!current) return current
      // Spread `...current` so the session-only fields kept on the state object — support/seam/
      // colour paint, brim ears, and added part volumes (all mutated in place via stateRef) —
      // survive a plate-structure edit instead of being silently dropped.
      return { ...current, plates: updater(current.plates) }
    })
    // Force the plate to rebuild so position-only / colour-only edits (auto-arrange,
    // filament reassignment) re-sync the 3D groups; key changes (add/delete) already do.
    setRebuildToken((token) => token + 1)
  }, [recordHistory])

  const handleSelect = useCallback((key: string, modifiers?: { additive?: boolean; range?: boolean }) => {
    if (modifiers?.range) {
      // Shift-click: select the contiguous run of object rows from the anchor (the last
      // plainly/Ctrl-clicked row) to the target; the anchor stays the primary.
      const ordered = activePlateRef.current?.instances.map((instance) => instance.key) ?? []
      const [primary, ...rest] = rangeSlice(ordered, objectAnchorKeyRef.current, key)
      setSelectedKey(primary ?? key)
      setExtraSelectedKeys(rest)
      setPartSelection((current) => (current ? null : current))
      return
    }
    if (modifiers?.additive) {
      toggleAdditiveSelection(key)
      return
    }
    if (selectedKeyRef.current === key) selectExclusive(null)
    else selectExclusive(key)
  }, [toggleAdditiveSelection, selectExclusive])

  // Part-row selection (BambuStudio volume-mode, rules in lib/selectionModel.ts): plain
  // click selects one part, Ctrl toggles siblings, Shift ranges between siblings, and a
  // part of a different object CONVERTS the selection. Entering part mode always leaves
  // object mode.
  const handleSelectPart = useCallback((objectId: number, componentObjectId: number, modifiers: { additive: boolean; range: boolean }) => {
    setSelectedKey(null)
    setExtraSelectedKeys((current) => (current.length > 0 ? [] : current))
    setPartSelection((current) => {
      if (modifiers.range) {
        const owner = stateRef.current?.plates.flatMap((plate) => plate.instances).find((instance) => {
          const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
          return ownerId === objectId
        })
        const ordered = owner?.parts.map((part) => part.componentObjectId) ?? [componentObjectId]
        return rangePartSelection(objectId, ordered, partAnchorRef.current, componentObjectId)
      }
      partAnchorRef.current = { objectId, componentObjectId }
      if (modifiers.additive) return togglePartInSelection(current, objectId, componentObjectId)
      // Plain click on the sole selected part deselects it (parity with object rows).
      if (current && current.objectId === objectId
        && current.componentObjectIds.length === 1 && current.componentObjectIds[0] === componentObjectId) {
        return null
      }
      return { objectId, componentObjectIds: [componentObjectId] }
    })
  }, [])

  // Right-click on list rows: keep the selection when clicking a member (bulk menu),
  // otherwise select just the clicked row first — same rule as the viewport.
  const handleObjectRowContextMenu = useCallback((key: string, position: { x: number; y: number }) => {
    if (!allSelectedKeysRef.current().includes(key)) selectExclusive(key)
    setContextMenu({ ...position, kind: 'object', key })
  }, [selectExclusive])
  const handlePartRowContextMenu = useCallback((objectId: number, componentObjectId: number, position: { x: number; y: number }) => {
    let selection = partSelectionRef.current
    if (!selection || selection.objectId !== objectId || !selection.componentObjectIds.includes(componentObjectId)) {
      selection = { objectId, componentObjectIds: [componentObjectId] }
      setSelectedKey(null)
      setExtraSelectedKeys((current) => (current.length > 0 ? [] : current))
      setPartSelection(selection)
      partAnchorRef.current = { objectId, componentObjectId }
    }
    setContextMenu({ ...position, kind: 'parts', objectId, componentObjectIds: selection.componentObjectIds })
  }, [])

  // Reassign the filament of a set of object parts (keyed by objectId+componentObjectId).
  // Filament is a property of the object's part, shared across instances/plates, so we
  // update every matching part. The 3D preview recolours from part.filamentId.
  const reassignFilament = useCallback((targets: Array<{ objectId: number; componentObjectId: number }>, filamentId: number) => {
    if (targets.length === 0) return
    const targetSet = new Set(targets.map((target) => `${target.objectId}:${target.componentObjectId}`))
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) => {
        // Object parts key on the Bambu object id; multi-solid import parts key on the import's
        // synthetic object identity (replacedObjectId) so a not-yet-saved assembly is reassignable.
        const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
        if (ownerId == null) return instance
        let changed = false
        const parts = instance.parts.map((part) => {
          if (targetSet.has(`${ownerId}:${part.componentObjectId}`)) {
            changed = true
            return { ...part, filamentId }
          }
          return part
        })
        if (!changed) return instance
        return { ...instance, parts, filamentId: parts[0]?.filamentId ?? instance.filamentId }
      })
    })))
  }, [updatePlates])

  // Change parts' Bambu volume type (BambuStudio's "Change type": normal / negative /
  // modifier / support blocker / enforcer), for one part or a whole part selection. The
  // type is a property of the object's part — shared across instances and plates — so it
  // is recorded once per part in partTypeChanges (for the bake) and reflected onto every
  // matching part.subtype (for the list and the viewport, which restyles on the rebuild).
  const handleChangePartTypes = useCallback((targets: ReadonlyArray<{ objectId: number; componentObjectId: number }>, subtype: SceneEditPartSubtype) => {
    if (targets.length === 0) return
    const targetSet = new Set(targets.map((target) => `${target.objectId}:${target.componentObjectId}`))
    recordHistory()
    setState((current) => {
      if (!current) return current
      const plates = current.plates.map((plate) => ({
        ...plate,
        instances: plate.instances.map((instance) => {
          // Object parts key on the Bambu object id; import parts on the import's synthetic
          // object identity (replacedObjectId) — same ownership rule as filament reassignment.
          const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
          if (ownerId == null || !instance.parts.some((part) => targetSet.has(`${ownerId}:${part.componentObjectId}`))) return instance
          return {
            ...instance,
            parts: instance.parts.map((part) => targetSet.has(`${ownerId}:${part.componentObjectId}`) ? { ...part, subtype } : part)
          }
        })
      }))
      const partTypeChanges = { ...(current.partTypeChanges ?? {}) }
      for (const target of targets) partTypeChanges[supportPaintKey(target.objectId, target.componentObjectId)] = subtype
      return { ...current, plates, partTypeChanges }
    })
    setRebuildToken((token) => token + 1)
  }, [recordHistory])

  // Rename an object (Bambu groups by object, so the new label applies to every
  // instance of it). Marks the object as renamed so buildSceneEdit emits an override.
  const handleRenameObject = useCallback(async (key: string) => {
    const current = stateRef.current
    const target = current?.plates.flatMap((plate) => plate.instances).find((instance) => instance.key === key)
    if (!target) return
    const name = await promptText({
      title: 'Rename object',
      label: 'Object name',
      initialValue: target.name,
      // Imported objects keep their mesh-file extension; select only the basename.
      initialSelection: { start: 0, end: splitLibraryFileNameForRename(target.name).baseName.length },
      confirmLabel: 'Rename'
    })
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === target.name) return
    const sameObject = (instance: EditorInstance): boolean =>
      target.source.kind === 'import'
        ? instance.source.kind === 'import' && instance.source.importId === target.source.importId
        : instance.source.kind === 'object' && instance.objectId === target.objectId
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) =>
        sameObject(instance) ? { ...instance, name: trimmed, nameOverridden: true } : instance
      )
    })))
  }, [promptText, updatePlates])

  // Place a freshly created instance at a free spot on the active plate, then add it.
  const addInstanceToActivePlate = useCallback((instance: EditorInstance) => {
    // BambuStudio parity: a project must have a material before any object (import, primitive,
    // cut/split half) can be added. This is the single chokepoint for every add path.
    if ((sliceConfigRef.current?.projectFilaments?.length ?? 0) === 0) {
      toast.error('Add a material to the project before adding objects.')
      return
    }
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (plate) {
      const spot = findFreePlatePosition(plate)
      instance.position.set(spot.x, spot.y, instance.position.z)
    }
    updatePlates((plates) =>
      plates.map((plate) =>
        plate.index === activePlateIndex ? { ...plate, instances: [...plate.instances, instance] } : plate
      )
    )
    setSelectedKey(instance.key)
  }, [activePlateIndex, updatePlates])

  // Persist a dragged prime tower's new lower-left corner into the active plate.
  const handleMovePrimeTower = useCallback((cornerX: number, cornerY: number) => {
    updatePlates((plates) => plates.map((plate) =>
      plate.index === activePlateIndex && plate.primeTower
        ? { ...plate, primeTower: { ...plate.primeTower, x: cornerX, y: cornerY } }
        : plate
    ))
  }, [activePlateIndex, updatePlates])
  movePrimeTowerRef.current = handleMovePrimeTower

  /** Add an import-backed instance onto the active plate from a staged foreign model. */
  const addStagedImport = useCallback((staged: StagedImport) => {
    // The material guard lives in addInstanceToActivePlate (the shared add chokepoint).
    addInstanceToActivePlate(instanceFromStagedImport(staged))
  }, [addInstanceToActivePlate])

  /**
   * Apply the Cut tool: split the selected object's world-space mesh at the plane, stage each
   * kept half as a foreign import (binary STL, capped cross-sections), and replace the original
   * instance with the halves in one undoable step. The lower half stays exactly in place; a kept
   * upper half rests on the bed at a free spot beside it.
   */
  const handlePerformCut = useCallback(async () => {
    const key = selectedKey
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = key ? groupByKeyRef.current.get(key) : undefined
    if (!key || !plate || !instance || !group) return
    const { upper, lower } = cutTriangleSoup(collectWorldTriangles(group), cutAxis, clampedCutOffset)
    const sides = CUT_AXIS_SIDES[cutAxis]
    const halves = [
      cutKeepLower && lower.length > 0 ? { soup: lower, suffix: sides.lower } : null,
      cutKeepUpper && upper.length > 0 ? { soup: upper, suffix: sides.upper } : null
    ].filter((half): half is { soup: Float32Array; suffix: string } => half !== null)
    if (halves.length === 0) {
      toast.error('Nothing to keep — move the cut plane or keep at least one side.')
      return
    }
    setCutting(true)
    try {
      const staged = await Promise.all(halves.map(async (half) => {
        const { offset } = rebaseTriangleSoup(half.soup)
        const stl = triangleSoupToBinaryStl(half.soup)
        const file = new File([stl], `${instance.name} (${half.suffix}).stl`, { type: 'application/octet-stream' })
        return { import: await stageImportFromFile(file), offset }
      }))
      const replacements = staged.map(({ import: stagedImport, offset }, index) => {
        const next = instanceFromStagedImport(stagedImport)
        next.position.set(offset.x, offset.y, 0)
        next.filamentId = instance.filamentId
        next.printable = instance.printable
        if (index > 0) {
          const spot = findFreePlatePosition(plate)
          next.position.set(spot.x, spot.y, 0)
        }
        return next
      })
      updatePlates((plates) => plates.map((entry) =>
        entry.index === activePlateIndex
          ? { ...entry, instances: [...entry.instances.filter((item) => item.key !== key), ...replacements] }
          : entry
      ))
      setSelectedKey(replacements[0]!.key)
      setGizmoMode('translate')
      toast.success(`Cut ${instance.name} into ${replacements.length === 2 ? 'two parts' : 'one part'}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to cut the model.')
    } finally {
      setCutting(false)
    }
  }, [selectedKey, activePlateIndex, cutAxis, clampedCutOffset, cutKeepLower, cutKeepUpper, updatePlates])

  /**
   * Split the selected object into its connected mesh components (Bambu's "split to
   * objects"): each shell becomes its own import-backed instance, replacing the
   * original in one undoable step. Parts keep their world XY spots and rest on the bed.
   */
  const handleSplitToObjects = useCallback(async (key: string) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = groupByKeyRef.current.get(key)
    if (!plate || !instance || !group) return
    const parts = splitTriangleSoup(collectWorldTriangles(group))
    if (parts.length < 2) {
      toast.error(`${instance.name} is already a single connected part.`)
      return
    }
    if (parts.length > 50) {
      toast.error(`${instance.name} has ${parts.length} shells — too many to split into objects.`)
      return
    }
    setImporting(true)
    try {
      const staged = await Promise.all(parts.map(async (soup, index) => {
        const { offset } = rebaseTriangleSoup(soup)
        const stl = triangleSoupToBinaryStl(soup)
        const file = new File([stl], `${instance.name} (part ${index + 1}).stl`, { type: 'application/octet-stream' })
        return { import: await stageImportFromFile(file), offset }
      }))
      const replacements = staged.map(({ import: stagedImport, offset }) => {
        const next = instanceFromStagedImport(stagedImport)
        next.position.set(offset.x, offset.y, 0)
        next.filamentId = instance.filamentId
        next.printable = instance.printable
        return next
      })
      updatePlates((plates) => plates.map((entry) =>
        entry.index === activePlateIndex
          ? { ...entry, instances: [...entry.instances.filter((item) => item.key !== key), ...replacements] }
          : entry
      ))
      setSelectedKey(replacements[0]!.key)
      toast.success(`Split ${instance.name} into ${replacements.length} objects.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to split the model.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, updatePlates])

  /**
   * Add a new part volume (negative part / modifier / support blocker / enforcer)
   * inside an object: a cube sized to the object, placed at its centre, staged as an
   * import so the save bakes it in as a `<component>` with the Bambu subtype. The
   * part is selected immediately so the gizmo can position it.
   */
  const handleAddPartVolume = useCallback(async (key: string, subtype: SceneEditAddedPartSubtype) => {
    const state = stateRef.current
    const plate = state?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = groupByKeyRef.current.get(key)
    if (!state || !instance || !group) return
    if (instance.source.kind !== 'object') {
      toast.error('Save the project first, then add parts to this imported model.')
      return
    }
    const spec = ADDED_PART_SPECS[subtype]
    const box = printableMeshBox(group)
    const maxDim = box.isEmpty() ? 20 : Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    const size = Math.min(20, Math.max(4, maxDim * 0.25))
    setImporting(true)
    try {
      const soup = primitivePartSoup(size)
      const stl = triangleSoupToBinaryStl(soup)
      const staged = await stageImportFromFile(new File([stl], `${spec.label}.stl`, { type: 'application/octet-stream' }))
      recordHistoryRef.current?.()
      const rotor = rotorOf(group)
      rotor.updateWorldMatrix(true, false)
      const centerLocal = box.isEmpty()
        ? new THREE.Vector3()
        : rotor.worldToLocal(box.getCenter(new THREE.Vector3()))
      const part: EditorAddedPart = {
        key: nextInstanceKey(),
        importId: staged.importId,
        subtype,
        name: spec.label,
        position: centerLocal,
        rotation: new THREE.Euler(),
        scale: new THREE.Vector3(1, 1, 1),
        soup
      }
      if (!state.addedParts) state.addedParts = {}
      ;(state.addedParts[instance.objectId] ??= []).push(part)
      refreshAddedPartMeshes()
      setSelectedAddedPartKey(part.key)
      setGizmoMode('translate')
      regenerateActiveThumbnailRef.current?.()
      toast.success(`Added a ${spec.label.toLowerCase()} — drag it into position.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to add the part.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, refreshAddedPartMeshes, recordHistoryRef])

  /**
   * Change an added part volume's subtype (negative part / modifier / support blocker /
   * enforcer). Added parts live in the in-place-mutated `addedParts` session map, so after
   * the mutation the state identity is refreshed to re-render the panel, and the viewport
   * meshes are rebuilt to pick up the subtype's colour.
   */
  const handleChangeAddedPartType = useCallback((key: string, subtype: SceneEditAddedPartSubtype) => {
    const state = stateRef.current
    const part = Object.values(state?.addedParts ?? {}).flat().find((entry) => entry.key === key)
    if (!state || !part || part.subtype === subtype) return
    recordHistoryRef.current?.()
    part.subtype = subtype
    refreshAddedPartMeshes()
    regenerateActiveThumbnailRef.current?.()
    setState((current) => (current ? { ...current } : current))
  }, [refreshAddedPartMeshes, recordHistoryRef])

  /** Remove the currently selected added part volume. */
  const handleRemoveAddedPart = useCallback(() => {
    const state = stateRef.current
    const key = selectedAddedPartKeyRef.current
    if (!state?.addedParts || !key) return
    recordHistoryRef.current?.()
    for (const [objectId, parts] of Object.entries(state.addedParts)) {
      const next = parts.filter((part) => part.key !== key)
      if (next.length !== parts.length) state.addedParts[Number(objectId)] = next
    }
    setSelectedAddedPartKey(null)
    refreshAddedPartMeshes()
    regenerateActiveThumbnailRef.current?.()
  }, [refreshAddedPartMeshes, recordHistoryRef])

  /**
   * Assemble (the inverse of "Split to objects"): merge every selected object into ONE
   * import-backed instance at its combined world position. Each source object survives
   * as a disconnected shell inside the merged mesh, so "Split to objects" recovers the
   * pieces exactly.
   */
  const handleAssembleSelection = useCallback(async () => {
    const keys = allSelectedKeysRef.current()
    if (keys.length < 2) return
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    const members = keys
      .map((key) => ({ instance: plate.instances.find((entry) => entry.key === key), group: groupByKeyRef.current.get(key) }))
      .filter((entry): entry is { instance: EditorInstance; group: THREE.Group } => Boolean(entry.instance && entry.group))
    if (members.length < 2) return
    setImporting(true)
    try {
      const soups = members.map((member) => collectWorldTriangles(member.group))
      const combined = new Float32Array(soups.reduce((sum, soup) => sum + soup.length, 0))
      let writeOffset = 0
      for (const soup of soups) {
        combined.set(soup, writeOffset)
        writeOffset += soup.length
      }
      const { offset } = rebaseTriangleSoup(combined)
      const stl = triangleSoupToBinaryStl(combined)
      const file = new File([stl], `${members[0]!.instance.name} (assembled).stl`, { type: 'application/octet-stream' })
      const staged = await stageImportFromFile(file)
      const next = instanceFromStagedImport(staged)
      next.position.set(offset.x, offset.y, 0)
      next.filamentId = members[0]!.instance.filamentId
      next.printable = members.every((member) => member.instance.printable)
      const keySet = new Set(keys)
      updatePlates((plates) => plates.map((entry) =>
        entry.index === activePlateIndex
          ? { ...entry, instances: [...entry.instances.filter((item) => !keySet.has(item.key)), next] }
          : entry
      ))
      setExtraSelectedKeys([])
      setSelectedKey(next.key)
      setGizmoMode('translate')
      toast.success(`Assembled ${members.length} objects into one.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to assemble the selected objects.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, updatePlates])

  const handleImportFromLibrary = useCallback(async (libraryFileId: string) => {
    setLibraryPickerOpen(false)
    setImporting(true)
    try {
      const staged = await stageImportFromLibrary(libraryFileId, undefined)
      addStagedImport(staged)
      toast.success(`Imported ${staged.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to import the selected model.')
    } finally {
      setImporting(false)
    }
  }, [addStagedImport])

  const handleImportFile = useCallback(async (file: File) => {
    setImporting(true)
    try {
      const staged = await stageImportFromFile(file)
      addStagedImport(staged)
      toast.success(`Imported ${staged.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to import the model file.')
    } finally {
      setImporting(false)
    }
  }, [addStagedImport])

  /**
   * Swap an object's geometry for a freshly staged foreign model, BambuStudio "Replace
   * with…" style: every copy of the object is swapped (geometry is shared by an object's
   * instances), each keeping its own placement, plus the object's material, printability,
   * and name (see {@link replaceInstanceGeometry}). For an in-project object the swap retains
   * its identity (`replacedObjectId`) so its per-object process overrides follow the new mesh
   * at slice time. The replacements are import-backed; one undoable step (via `updatePlates`).
   */
  const handleReplaceWithStaged = useCallback((key: string, staged: StagedImport) => {
    const target = stateRef.current?.plates.flatMap((plate) => plate.instances).find((entry) => entry.key === key)
    if (!target) return
    // The original object's id is retained for the slicer when replacing an in-project object
    // (or an already-replaced one); a plain import has no in-project identity to keep.
    const replacedObjectId = target.source.kind === 'object' ? target.objectId : target.source.replacedObjectId
    // Which instances belong to the same object as `target` (all its copies get the new mesh).
    const isMember = (instance: EditorInstance): boolean => {
      if (target.source.kind === 'object') {
        return instance.source.kind === 'object' && instance.objectId === target.objectId
      }
      if (target.source.replacedObjectId != null) {
        return instance.source.kind === 'import' && instance.source.replacedObjectId === target.source.replacedObjectId
      }
      return instance.source.kind === 'import'
        && instance.source.replacedObjectId == null
        && instance.source.importId === target.source.importId
    }
    let selectedReplacementKey: string | null = null
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) => {
        if (!isMember(instance)) return instance
        const replacement = replaceInstanceGeometry(instance, staged, replacedObjectId)
        if (instance.key === key) selectedReplacementKey = replacement.key
        return replacement
      })
    })))
    if (selectedReplacementKey) {
      setExtraSelectedKeys([])
      setSelectedKey(selectedReplacementKey)
      setGizmoMode('translate')
    }
  }, [updatePlates])

  /** Replace `key`'s geometry with an uploaded local model file. */
  const handleReplaceFromFile = useCallback(async (key: string, file: File) => {
    setImporting(true)
    try {
      const staged = await stageImportFromFile(file)
      handleReplaceWithStaged(key, staged)
      toast.success(`Replaced with ${staged.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to replace the model.')
    } finally {
      setImporting(false)
    }
  }, [handleReplaceWithStaged])

  /** Replace `key`'s geometry with a model picked from the library. */
  const handleReplaceFromLibrary = useCallback(async (key: string, libraryFileId: string) => {
    setLibraryPickerOpen(false)
    setReplaceTargetKey(null)
    setImporting(true)
    try {
      const staged = await stageImportFromLibrary(libraryFileId, undefined)
      handleReplaceWithStaged(key, staged)
      toast.success(`Replaced with ${staged.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to replace the model.')
    } finally {
      setImporting(false)
    }
  }, [handleReplaceWithStaged])

  /** Add a built-in primitive (cube/cylinder/sphere/cone) at a free spot on the plate. */
  const handleAddPrimitive = useCallback(async (kind: PrimitiveKind) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    setImporting(true)
    try {
      const stl = triangleSoupToBinaryStl(primitiveTriangleSoup(kind))
      const file = new File([stl], `${PRIMITIVE_LABELS[kind]}.stl`, { type: 'application/octet-stream' })
      const staged = await stageImportFromFile(file)
      const instance = instanceFromStagedImport(staged)
      const spot = findFreePlatePosition(plate)
      instance.position.set(spot.x, spot.y, 0)
      addInstanceToActivePlate(instance)
      toast.success(`Added a ${PRIMITIVE_LABELS[kind].toLowerCase()}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to add the primitive.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, addInstanceToActivePlate])

  /** The whole selection when `key` belongs to it, else just `key`. */
  const selectionFor = useCallback((key: string): string[] => {
    const selection = allSelectedKeysRef.current()
    return selection.includes(key) ? selection : [key]
  }, [])

  const handleDuplicate = useCallback((key: string) => {
    const keys = selectionFor(key)
    let cloneKey: string | null = null
    updatePlates((plates) =>
      plates.map((plate) => {
        if (plate.index !== activePlateIndex) return plate
        let next = plate
        for (const target of keys) {
          const source = next.instances.find((entry) => entry.key === target)
          if (!source) continue
          const clone = duplicateInstance(source)
          const spot = findFreePlatePosition(next)
          clone.position.set(spot.x, spot.y, clone.position.z)
          cloneKey = clone.key
          next = { ...next, instances: [...next.instances, clone] }
        }
        return next
      })
    )
    if (cloneKey) selectExclusive(cloneKey)
  }, [activePlateIndex, updatePlates, selectionFor, selectExclusive])

  const handleDelete = useCallback((key: string) => {
    // Deleting any member of a multi-selection deletes the whole selection.
    const keySet = new Set(selectionFor(key))
    updatePlates((plates) =>
      plates.map((plate) =>
        plate.index === activePlateIndex
          ? { ...plate, instances: plate.instances.filter((entry) => !keySet.has(entry.key)) }
          : plate
      )
    )
    setSelectedKey((current) => (current && keySet.has(current) ? null : current))
    setExtraSelectedKeys((current) => current.filter((entry) => !keySet.has(entry)))
  }, [activePlateIndex, updatePlates, selectionFor])

  /**
   * Move an instance — or, when it belongs to the multi-selection, the whole selection —
   * from the active plate to another plate, each placed at a free spot.
   */
  const handleMoveToPlate = useCallback((key: string, targetIndex: number) => {
    const keySet = new Set(selectionFor(key))
    updatePlates((plates) => {
      const source = plates.find((plate) => plate.index === activePlateIndex)
      const target = plates.find((plate) => plate.index === targetIndex)
      const moving = source?.instances.filter((entry) => keySet.has(entry.key)) ?? []
      if (!target || moving.length === 0) return plates
      let nextTarget = target
      for (const instance of moving) {
        const spot = findFreePlatePosition(nextTarget)
        const moved: EditorInstance = { ...instance, position: instance.position.clone() }
        moved.position.x = spot.x
        moved.position.y = spot.y
        nextTarget = { ...nextTarget, instances: [...nextTarget.instances, moved] }
      }
      return plates.map((plate) => {
        if (plate.index === activePlateIndex) return { ...plate, instances: plate.instances.filter((entry) => !keySet.has(entry.key)) }
        if (plate.index === targetIndex) return nextTarget
        return plate
      })
    })
    setSelectedKey((current) => (current && keySet.has(current) ? null : current))
    setExtraSelectedKeys((current) => current.filter((entry) => !keySet.has(entry)))
  }, [activePlateIndex, updatePlates, selectionFor])

  /** Set (not toggle) the Printable flag on a set of instances — the bulk context-menu action. */
  const handleSetPrintableSelection = useCallback((keys: ReadonlyArray<string>, printable: boolean) => {
    const keySet = new Set(keys)
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((entry) =>
        keySet.has(entry.key) && entry.printable !== printable ? { ...entry, printable } : entry)
    })))
  }, [updatePlates])

  /**
   * Assign one material to EVERY part of the clicked object — or of the whole selection
   * when it belongs to one (the context menu's bulk "Change material").
   */
  const reassignSelectionFilament = useCallback((key: string, filamentId: number) => {
    const keySet = new Set(selectionFor(key))
    const targets: Array<{ objectId: number; componentObjectId: number }> = []
    for (const instance of activePlateRef.current?.instances ?? []) {
      if (!keySet.has(instance.key)) continue
      const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
      if (ownerId == null) continue
      for (const part of instance.parts) targets.push({ objectId: ownerId, componentObjectId: part.componentObjectId })
    }
    reassignFilament(targets, filamentId)
  }, [selectionFor, reassignFilament])

  /**
   * Open per-object process settings for the clicked object — or the whole selection when
   * it belongs to one (bulk: the dialog seeds from the first object and applies to all).
   */
  const openObjectSettingsFor = useCallback((key: string) => {
    const keySet = new Set(selectionFor(key))
    const ids: number[] = []
    let firstName = ''
    for (const instance of activePlateRef.current?.instances ?? []) {
      if (!keySet.has(instance.key)) continue
      const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
      if (ownerId == null || ids.includes(ownerId)) continue
      ids.push(ownerId)
      if (!firstName) firstName = instance.name
    }
    if (ids.length === 0) return
    setEditingObject({ ids, name: ids.length > 1 ? `${ids.length} objects` : firstName })
  }, [selectionFor])

  /** Open per-part process settings for the current part selection (bulk when several). */
  const openPartSettingsForSelection = useCallback(() => {
    const selection = partSelectionRef.current
    if (!selection || selection.componentObjectIds.length === 0) return
    const owner = stateRef.current?.plates.flatMap((plate) => plate.instances).find((instance) => {
      const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
      return ownerId === selection.objectId
    })
    const first = owner?.parts.find((part) => part.componentObjectId === selection.componentObjectIds[0])
    const name = selection.componentObjectIds.length > 1
      ? `${selection.componentObjectIds.length} parts`
      : (first?.name ?? 'Part')
    setEditingPart({ objectId: selection.objectId, componentObjectIds: [...selection.componentObjectIds], name })
  }, [])

  /**
   * Toggle an instance's BambuStudio "Printable" flag. Per-instance (by key) so individual
   * copies can be skipped; the change flows through state, so the re-dim effect greys/ungreys
   * the viewport and {@link buildSceneEdit} writes `printable="0"` on the build item (kept in
   * the saved 3MF, excluded from the slice).
   */
  const handleTogglePrintable = useCallback((key: string) => {
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((entry) =>
        entry.key === key ? { ...entry, printable: !entry.printable } : entry)
    })))
  }, [updatePlates])

  /**
   * Auto-arrange: pack the active plate's models centre-out by their TRUE rasterized
   * footprints (the placement-warning grid), so concave parts nest instead of
   * reserving their whole bounding box. The usable area shrinks to what every
   * object's nozzle can reach; unprintable zones and the prime tower are blocked
   * cells. Items that cannot fit stay where they are and are reported.
   */
  const handleArrangeAll = useCallback(() => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate || plate.instances.length === 0) return
    const items: Array<{ key: string; cells: number[] }> = []
    for (const instance of plate.instances) {
      const group = groupByKeyRef.current.get(instance.key)
      if (!group) continue
      const cells = computeFootprintCells(group)
      if (cells.size === 0) continue
      items.push({ key: instance.key, cells: [...cells] })
    }
    if (items.length === 0) return
    const gap = 6

    // Shrink the usable area to the region every object's nozzle can reach and that
    // is actually printable, so auto-arrange never parks a part where it can't print.
    // Nozzle reach is derived from the labeled nozzle-only zones: a left nozzle (1)
    // can't enter the right-only zone and vice versa.
    let leftMaxX = plate.bed.maxX
    let rightMinX = plate.bed.minX
    let safeMinX = plate.bed.minX
    let safeMaxX = plate.bed.maxX
    const safeMinY = plate.bed.minY
    const safeMaxY = plate.bed.maxY
    for (const zone of plate.bed.excludeAreas) {
      let zx0 = Infinity, zx1 = -Infinity
      for (const point of zone.polygon) {
        zx0 = Math.min(zx0, point.x); zx1 = Math.max(zx1, point.x)
      }
      const required = zoneRequiredNozzle(zone.label)
      if (required === 2) leftMaxX = Math.min(leftMaxX, zx0)
      else if (required === 1) rightMinX = Math.max(rightMinX, zx1)
      // Truly unprintable zones are blocked cell-by-cell below — no rect shrinking,
      // so a corner cutout doesn't cost the whole edge strip.
    }
    for (const instance of plate.instances) {
      const nozzles = instanceNozzlesRef.current(instance)
      if (nozzles.has(1)) safeMaxX = Math.min(safeMaxX, leftMaxX)
      if (nozzles.has(2)) safeMinX = Math.max(safeMinX, rightMinX)
    }

    // Block truly unprintable zones cell-by-cell (any shape, anywhere on the plate)
    // and the prime tower's current footprint.
    const blockedCells = new Set<number>()
    for (const zone of plate.bed.excludeAreas) {
      if (zoneRequiredNozzle(zone.label) != null) continue // handled via the safe rect
      for (const cell of rasterizePolygonCells(zone.polygon)) blockedCells.add(cell)
    }
    const tower = primeTowerObjRef.current
    if (tower) {
      const halfW = (typeof tower.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0) / 2
      const halfD = (typeof tower.userData.towerDepth === 'number' ? tower.userData.towerDepth : 0) / 2
      if (halfW > 0 && halfD > 0) {
        const center = tower.getWorldPosition(new THREE.Vector3())
        for (let cx = Math.floor((center.x - halfW) / FOOTPRINT_CELL_MM); cx <= Math.floor((center.x + halfW) / FOOTPRINT_CELL_MM); cx += 1) {
          for (let cy = Math.floor((center.y - halfD) / FOOTPRINT_CELL_MM); cy <= Math.floor((center.y + halfD) / FOOTPRINT_CELL_MM); cy += 1) {
            blockedCells.add(footprintCellKey(cx, cy))
          }
        }
      }
    }

    const result = arrangePlateItems(items, {
      bed: { minX: safeMinX, maxX: safeMaxX, minY: safeMinY, maxY: safeMaxY },
      blockedCells,
      spacingMm: gap
    })
    if (result.moves.size === 0) {
      toast.error('No room to arrange the models on this plate.')
      return
    }
    updatePlates((plates) => plates.map((entry) => entry.index !== activePlateIndex ? entry : {
      ...entry,
      instances: entry.instances.map((instance) => {
        const move = result.moves.get(instance.key)
        if (!move) return instance
        const position = instance.position.clone()
        position.x += move.dx
        position.y += move.dy
        // Moving a shearing object bakes it to T·S·R (drop the exact matrix) so it renders/saves
        // at its new position rather than the original baked-in one.
        return { ...instance, position, exactMatrix: undefined }
      })
    }))
    if (result.unplaced.length > 0) {
      toast.error(`${result.unplaced.length} model${result.unplaced.length === 1 ? '' : 's'} did not fit and stayed in place.`)
    }
  }, [activePlateIndex, updatePlates])

  const handleDropToBed = useCallback(() => {
    if (!selectedKey) return
    const group = groupByKeyRef.current.get(selectedKey)
    if (!group) return
    const box = new THREE.Box3().setFromObject(group)
    if (box.isEmpty()) return
    recordHistory()
    bakeExactMatrix(group)
    group.position.z -= box.min.z
    writeBackGroupTransform(group)
    syncSelectedTransform(group)
    regenerateActivePlateThumbnail()
  }, [selectedKey, recordHistory, bakeExactMatrix, writeBackGroupTransform, syncSelectedTransform, regenerateActivePlateThumbnail])


  /**
   * Apply a mutation to the currently selected group, then write the result back
   * into state, refresh the gizmo, the manual panel, and the plate thumbnail.
   */
  const mutateSelectedGroup = useCallback(
    (mutate: (group: THREE.Group) => void) => {
      const key = selectedKeyRef.current
      if (!key) return
      const group = groupByKeyRef.current.get(key)
      if (!group) return
      recordHistory()
      bakeExactMatrix(group)
      mutate(group)
      restObjectOnBed(group)
      writeBackGroupTransform(group)
      syncSelectedTransform(group)
      regenerateActivePlateThumbnail()
    },
    [recordHistory, bakeExactMatrix, writeBackGroupTransform, syncSelectedTransform, regenerateActivePlateThumbnail]
  )

  /** Auto-orient: rest the selected object on its largest hull face (most stable base). */
  const handleAutoOrient = useCallback(() => {
    if (!selectedKey) return
    const group = groupByKeyRef.current.get(selectedKey)
    if (!group) return
    const normal = largestHullFaceNormal(group)
    if (!normal) return
    mutateSelectedGroup((target) => {
      rotorOf(target).quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(normal, DOWN_VECTOR))
    })
  }, [selectedKey, mutateSelectedGroup])

  /** Nudge every selected instance together on the bed (multi-select aware). */
  const nudgeSelection = useCallback((dx: number, dy: number) => {
    const keys = allSelectedKeysRef.current()
    if (keys.length === 0) return
    recordHistory()
    for (const key of keys) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      bakeExactMatrix(group)
      group.position.x += dx
      group.position.y += dy
      writeBackGroupTransform(group)
    }
    const primary = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
    if (primary) syncSelectedTransform(primary)
    regenerateActivePlateThumbnail()
  }, [recordHistory, bakeExactMatrix, writeBackGroupTransform, syncSelectedTransform, regenerateActivePlateThumbnail])

  const applyManualPosition = useCallback((axis: 'x' | 'y' | 'z', value: number) => {
    if (!Number.isFinite(value)) return
    mutateSelectedGroup((group) => { group.position[axis] = value })
  }, [mutateSelectedGroup])

  const applyManualRotation = useCallback((axis: 'x' | 'y' | 'z', degrees: number) => {
    if (!Number.isFinite(degrees)) return
    mutateSelectedGroup((group) => { rotorOf(group).rotation[axis] = THREE.MathUtils.degToRad(degrees) })
  }, [mutateSelectedGroup])

  const applyManualScale = useCallback((axis: 'x' | 'y' | 'z', percent: number) => {
    if (!Number.isFinite(percent) || percent <= 0) return
    const factor = percent / 100
    mutateSelectedGroup((group) => {
      if (uniformScale) {
        group.scale.set(factor, factor, factor)
      } else {
        group.scale[axis] = factor
      }
    })
  }, [mutateSelectedGroup, uniformScale])

  // ---- Keyboard transforms ---------------------------------------------------
  // Arrow keys nudge X/Y on the bed (Shift = coarse, Ctrl/Cmd = fine); [ and ]
  // rotate about Z; Delete/Backspace removes the selection. Text inputs are
  // exempt so typing in the manual fields is never hijacked.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        return
      }

      // Undo/redo work regardless of selection (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y).
      if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
        if (event.shiftKey) {
          redoRef.current()
        } else {
          undoRef.current()
        }
        event.preventDefault()
        return
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || event.key === 'Y')) {
        redoRef.current()
        event.preventDefault()
        return
      }

      const key = selectedKeyRef.current
      if (!key) return

      const step = event.shiftKey ? KEY_MOVE_STEP_LARGE : (event.ctrlKey || event.metaKey) ? KEY_MOVE_STEP_FINE : KEY_MOVE_STEP
      switch (event.key) {
        case 'ArrowLeft':
          nudgeSelection(-step, 0); break
        case 'ArrowRight':
          nudgeSelection(step, 0); break
        case 'ArrowUp':
          nudgeSelection(0, step); break
        case 'ArrowDown':
          nudgeSelection(0, -step); break
        case '[':
          mutateSelectedGroup((group) => { rotorOf(group).rotation.z += KEY_ROTATE_STEP }); break
        case ']':
          mutateSelectedGroup((group) => { rotorOf(group).rotation.z -= KEY_ROTATE_STEP }); break
        case 'Delete':
        case 'Backspace':
          handleDelete(key); break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mutateSelectedGroup, handleDelete, nudgeSelection, undoRef, redoRef])

  const handleAddPlate = useCallback(() => {
    // Compute the new (contiguous) index from current state, NOT inside the setState updater —
    // React runs the updater later, so reading a var it mutates would select the wrong plate.
    const newIndex = (stateRef.current?.plates.length ?? 0) + 1
    updatePlates((plates) => {
      const template = plates[plates.length - 1]
      const bed = template ? { ...template.bed } : { minX: -128, maxX: 128, minY: -128, maxY: 128, excludeAreas: [] }
      const plateType = template?.plateType ?? null
      return reindexPlates([
        ...plates,
        { index: plates.length + 1, name: null, plateType, bed, instances: [], primeTower: null }
      ])
    })
    setActivePlateIndex(newIndex)
    setSelectedKey(null)
  }, [updatePlates])

  const handleRemovePlate = useCallback((index: number) => {
    updatePlates((plates) => {
      if (plates.length <= 1) return plates
      return reindexPlates(plates.filter((plate) => plate.index !== index))
    })
    setSelectedKey(null)
    setActivePlateIndex((current) => {
      const remaining = (stateRef.current?.plates.length ?? 1) - 1
      if (current > remaining) return Math.max(remaining, 1)
      if (current >= index) return Math.max(current - 1, 1)
      return current
    })
  }, [updatePlates])

  const handleRenamePlate = useCallback(async (index: number) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === index)
    const name = await promptText({
      title: `Rename plate ${index}`,
      label: 'Plate name',
      placeholder: `Plate ${index}`,
      initialValue: plate?.name ?? '',
      confirmLabel: 'Rename'
    })
    if (name === null) return
    const trimmed = name.trim()
    updatePlates((plates) => plates.map((entry) => entry.index === index ? { ...entry, name: trimmed || null } : entry))
  }, [promptText, updatePlates])

  const handleReorderPlate = useCallback((fromIndex: number, toIndex: number) => {
    updatePlates((plates) => {
      const from = plates.findIndex((plate) => plate.index === fromIndex)
      const to = plates.findIndex((plate) => plate.index === toIndex)
      if (from < 0 || to < 0 || from === to) return plates
      const reordered = [...plates]
      const [moved] = reordered.splice(from, 1)
      if (!moved) return plates
      reordered.splice(to, 0, moved)
      return reindexPlates(reordered)
    })
    // Keep viewing the plate that was dragged (it now sits at the drop position).
    setActivePlateIndex(toIndex)
  }, [updatePlates])

  // Bake the controller's desired filament list (Bambu-style add/remove of materials)
  // into every SceneEdit the editor emits, so both save and slice carry the new set.
  const buildSceneEditOut = useCallback((current: EditorState, options?: { thumbnails?: Array<{ plateIndex: number; png: string }> }): SceneEdit => {
    const base = buildSceneEdit(current)
    const withFilaments = sliceConfig?.desiredFilaments ? { ...base, filaments: sliceConfig.desiredFilaments } : base
    // Attach freshly-captured plate previews (when provided) so the saved 3MF / sliced output's
    // thumbnail reflects the edited layout — the slicer CLI and the 3MF rewriter both reuse the
    // embedded PNG rather than regenerating it. Callers capture via captureAllPlateThumbnails().
    const thumbnails = options?.thumbnails
    return thumbnails && thumbnails.length > 0 ? { ...withFilaments, plateThumbnails: thumbnails } : withFilaments
  }, [sliceConfig])

  const {
    saving,
    saveAsOpen,
    setSaveAsOpen,
    handleApply,
    handleCloseRequest,
    handleSaveVersion,
    handleSaveAs
  } = useEditorSave({
    stateRef,
    sliceConfigRef,
    dirtyRef,
    markSaved,
    buildSceneEditOut,
    captureAllPlateThumbnails,
    seededProcessOverrideObjectIdsRef,
    baseFileId,
    baseVersionId,
    saveAsBridgeId,
    onApply,
    onSaved,
    onClose,
    confirm
  })

  // ---- Render ----------------------------------------------------------------
  const loading = !hasNoBaseFile && (
    platesQuery.isLoading || initialSceneQuery.isLoading || (!state && plateIndices.length > 0)
  )
  // Disable scene-manipulation controls until the plate has finished (re)building — acting on a
  // half-loaded scene (e.g. auto-arrange before the models are in) is undefined.
  const controlsBusy = loading || viewportBuilding || !sceneReady
  // The in-viewport loading overlay shows while models build AND during the brief pre-build window
  // after the viewport mounts but before the scene/canvas is ready — otherwise the first open shows
  // an empty bed with no sign of loading until the models suddenly appear. Pre-build is treated as
  // incremental (the plate starts empty), so it gets the top bar + centred message rather than the
  // same-plate dimming rebuild.
  const showBuildOverlay = viewportBuilding || !sceneReady
  const buildOverlayIncremental = buildIncremental || !sceneReady
  const loadError = platesQuery.error instanceof Error
    ? platesQuery.error.message
    : initialSceneQuery.error instanceof Error
      ? initialSceneQuery.error.message
      : restScenesQuery.error instanceof Error
        ? restScenesQuery.error.message
        : null

  return (
    <>
    <Modal
      open
      onClose={(_event, reason) => {
        // Escape while the right-click menu is open (or the synthetic Escape we dispatch to
        // dismiss other Joy menus on right-click) should only close that menu, not the editor.
        if (reason === 'escapeKeyDown' && (contextMenuOpenRef.current || suppressEditorEscapeRef.current)) return
        void handleCloseRequest()
      }}
    >
      <ModalDialog
        variant="outlined"
        layout="center"
        // A large centred dialog with equal margins on all four sides.
        sx={{
          width: '92vw',
          height: '92dvh',
          maxWidth: '92vw',
          maxHeight: '92dvh',
          p: { xs: 1.5, sm: 2 },
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          gap: 0
        }}
      >
        <ModalClose onClick={handleCloseRequest} sx={{ top: 12, right: 12 }} />
        <Typography level="h4" sx={{ mb: 1 }}>{isNewProject ? 'New Project' : 'Edit Project'}</Typography>

        {loadError ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState
              icon={<OpenWithRoundedIcon />}
              title="Unable to load this project"
              description={loadError}
            />
          </Box>
        ) : !state || !activePlate ? (
          // Only the genuine first load (no plates/scene yet) shows the full overlay. Once the
          // editor has content, plate switches and background refetches keep the viewport mounted
          // and lean on the in-viewport "Loading models…" overlay — flipping the whole content out
          // here would unmount the WebGL canvas and reinitialize the entire scene (a visible
          // "reload" of the dialog on every plate switch).
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Stack spacing={1} alignItems="center">
              <CircularProgress size="sm" />
              <Typography level="body-sm" textColor="text.tertiary">Loading plates…</Typography>
            </Stack>
          </Box>
        ) : (
          (() => {
            const plateStrip = (
              <PlateThumbnailStrip
                plates={state.plates}
                activeIndex={activePlateIndex}
                thumbnails={plateThumbnails}
                embeddedThumbnailUrl={embeddedPlateThumbnailUrl}
                onSelect={(index) => { setSelectedKey(null); setActivePlateIndex(index) }}
                onAddPlate={handleAddPlate}
                onRemovePlate={handleRemovePlate}
                onRenamePlate={handleRenamePlate}
                onReorderPlate={handleReorderPlate}
              />
            )
            const viewport = (
              <Sheet
                variant="soft"
                sx={{
                  gridArea: 'viewport',
                  flex: 1,
                  position: 'relative',
                  overflow: 'hidden',
                  borderRadius: 'md',
                  bgcolor: '#0d1322',
                  minHeight: { xs: 240, md: 0 }
                }}
              >
                {/*
                  Pin the WebGL canvas to `touch-action: none` so the browser never hijacks a
                  one-finger drag as a page scroll. TransformControls (active while an object is
                  selected) sets the canvas's inline `touch-action` to "none" on pointerdown but
                  resets it to "" (auto) on pointerup, and has no pointercancel handler — so a
                  scroll-hijacked touch leaves it "none", the next touch starts "none" (works), its
                  clean pointerup resets to "" again, and the touch after that gets scroll-hijacked
                  (pointercancel) — interrupting every other drag/rotate on mobile. A CSS rule wins
                  whenever the inline value is cleared, keeping the canvas non-scrolling every time.
                */}
                <Box ref={setViewerContainer} sx={{ position: 'absolute', inset: 0, touchAction: 'none', '& canvas': { touchAction: 'none' } }} />
                {showBuildOverlay && buildOverlayIncremental && (
                  // Incremental / first load: a progress bar pinned to the top edge PLUS a centred
                  // spinner + count over a light scrim. The centre carries the "still loading"
                  // message clearly (a bare top bar was too easy to miss), while the light dim still
                  // lets each model show as it lands. The bar/count are part-based, so even a single
                  // multi-solid assembly shows real progress.
                  <>
                    <LinearProgress
                      determinate={!!buildProgress && buildProgress.total > 1}
                      value={buildProgress && buildProgress.total > 1 ? Math.round((buildProgress.done / buildProgress.total) * 100) : 0}
                      thickness={4}
                      sx={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        zIndex: 3,
                        pointerEvents: 'none',
                        '--LinearProgress-radius': '0px'
                      }}
                    />
                    <Box
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        zIndex: 2,
                        pointerEvents: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 1.25,
                        bgcolor: 'rgba(13, 19, 34, 0.4)'
                      }}
                    >
                      <CircularProgress
                        size="md"
                        determinate={!!buildProgress && buildProgress.total > 1}
                        value={buildProgress && buildProgress.total > 1 ? Math.round((buildProgress.done / buildProgress.total) * 100) : 0}
                      />
                      <Typography level="body-sm" textColor="common.white">
                        {buildProgress && buildProgress.total > 1
                          ? `Loading models… ${buildProgress.done} of ${buildProgress.total}`
                          : 'Loading models…'}
                      </Typography>
                    </Box>
                  </>
                )}
                {showBuildOverlay && !buildOverlayIncremental && (
                  // Atomic rebuild: the previous plate is still visible, so dim it more to signal
                  // work while the replacement is assembled off-screen.
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 2,
                      pointerEvents: 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 1.25,
                      bgcolor: 'rgba(13, 19, 34, 0.55)'
                    }}
                  >
                    {buildProgress && buildProgress.total > 1 ? (
                      <>
                        <CircularProgress size="md" determinate value={Math.round((buildProgress.done / buildProgress.total) * 100)} />
                        <Typography level="body-sm" textColor="common.white">
                          Loading models… ({buildProgress.done}/{buildProgress.total})
                        </Typography>
                      </>
                    ) : (
                      <>
                        <CircularProgress size="md" />
                        <Typography level="body-sm" textColor="common.white">Loading models…</Typography>
                      </>
                    )}
                  </Box>
                )}
                {importing && (
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 2,
                      pointerEvents: 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 1.25,
                      bgcolor: 'rgba(13, 19, 34, 0.55)'
                    }}
                  >
                    <CircularProgress size="md" />
                    <Typography level="body-sm" textColor="common.white">Importing model…</Typography>
                  </Box>
                )}
                <Box
                  sx={{
                    position: 'absolute',
                    top: 8,
                    left: 8,
                    right: 8,
                    zIndex: (theme) => theme.zIndex.tooltip,
                    display: 'flex',
                    gap: 1,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'center',
                    // Don't block clicks/drags on the 3D scene showing through the
                    // full-width centering strip; the controls re-enable themselves.
                    pointerEvents: 'none',
                    '& > *': { pointerEvents: 'auto' }
                  }}
                >
                  <GizmoToolbar
                    mode={gizmoMode}
                    disabled={!selectedKey || controlsBusy}
                    busy={controlsBusy}
                    arrangeDisabled={controlsBusy || (activePlate?.instances.length ?? 0) === 0}
                    onChange={setGizmoMode}
                    onDropToBed={handleDropToBed}
                    onAutoOrient={handleAutoOrient}
                    onArrangeAll={handleArrangeAll}
                  />
                  <ButtonGroup size="sm" variant="outlined" aria-label="Undo and redo">
                    <Tooltip title="Undo (Ctrl/Cmd+Z)">
                      <IconButton onClick={undo} disabled={!canUndo || controlsBusy} aria-label="Undo">
                        <UndoRoundedIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Redo (Ctrl/Cmd+Shift+Z)">
                      <IconButton onClick={redo} disabled={!canRedo || controlsBusy} aria-label="Redo">
                        <RedoRoundedIcon />
                      </IconButton>
                    </Tooltip>
                  </ButtonGroup>
                  <KeyboardHelpButton />
                </Box>
                {gizmoMode === 'cut' && selectedKey && cutRange && (
                  <CutToolPanel
                    cutAxis={cutAxis}
                    setCutAxis={setCutAxis}
                    cutOffset={cutOffset}
                    setCutOffset={setCutOffset}
                    cutRange={cutRange}
                    clampedCutOffset={clampedCutOffset}
                    cutKeepLower={cutKeepLower}
                    setCutKeepLower={setCutKeepLower}
                    cutKeepUpper={cutKeepUpper}
                    setCutKeepUpper={setCutKeepUpper}
                    cutting={cutting}
                    onCut={handlePerformCut}
                    onCancel={() => setGizmoMode('translate')}
                  />
                )}
                {gizmoMode === 'measure' && (
                  <MeasurePanel
                    measureDelta={measureDelta}
                    pointCount={measurePoints.length}
                    onClear={() => setMeasurePoints([])}
                    onDone={() => setGizmoMode('translate')}
                  />
                )}
                {activePaintChannel !== null && selectedKey && (
                  <PaintToolPanel
                    paint={paint}
                    paintTargetIsObject={paintTargetIsObject}
                    filamentOptions={filamentOptions}
                    onDone={() => setGizmoMode('translate')}
                  />
                )}
                {gizmoMode === 'brimEars' && selectedKey && (
                  <BrimEarsPanel
                    paintTargetIsObject={paintTargetIsObject}
                    brimEarDiameter={brimEarDiameter}
                    setBrimEarDiameter={setBrimEarDiameter}
                    onClear={() => editSelectedBrimEars({ kind: 'clear' })}
                    onDone={() => setGizmoMode('translate')}
                  />
                )}
                {selectedAddedPart && selectedKey && (gizmoMode === 'translate' || gizmoMode === 'rotate' || gizmoMode === 'scale') && (
                  <Sheet
                    variant="soft"
                    sx={{
                      position: 'absolute', top: TOOL_PANEL_TOP, left: 8, zIndex: (theme) => theme.zIndex.tooltip,
                      p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
                      width: 'min(280px, calc(100% - 16px))',
                      display: 'flex', flexDirection: 'column', gap: 0.75
                    }}
                  >
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <Box sx={{ width: 12, height: 12, borderRadius: '3px', flexShrink: 0, bgcolor: `#${ADDED_PART_SPECS[selectedAddedPart.subtype].color.toString(16).padStart(6, '0')}` }} />
                      <Typography level="title-sm" sx={{ flex: 1 }}>{ADDED_PART_SPECS[selectedAddedPart.subtype].label}</Typography>
                      <Select
                        size="sm"
                        variant="plain"
                        value={selectedAddedPart.subtype}
                        onChange={(_event, subtype) => { if (subtype) handleChangeAddedPartType(selectedAddedPart.key, subtype) }}
                        slotProps={{ button: { 'aria-label': 'Change part type' } }}
                      >
                        {ADDED_PART_SUBTYPES.map((subtype) => (
                          <Option key={subtype} value={subtype}>{ADDED_PART_SPECS[subtype].label}</Option>
                        ))}
                      </Select>
                    </Stack>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {ADDED_PART_SPECS[selectedAddedPart.subtype].hint} Move, rotate, or scale it with
                      the gizmo; click the model body to go back to the whole object.
                    </Typography>
                    <Stack direction="row" spacing={0.75} justifyContent="space-between">
                      <Button size="sm" variant="plain" color="danger" onClick={handleRemoveAddedPart}>
                        Remove part
                      </Button>
                      <Stack direction="row" spacing={0.75}>
                        {selectedAddedPart.subtype === 'modifier_part' && perObject && (
                          <Button size="sm" variant="soft" onClick={() => setEditingPartKey(selectedAddedPart.key)}>
                            Settings{Object.keys(selectedAddedPart.settings ?? {}).length > 0 ? ` (${Object.keys(selectedAddedPart.settings ?? {}).length})` : ''}
                          </Button>
                        )}
                        <Button size="sm" onClick={() => setSelectedAddedPartKey(null)}>Done</Button>
                      </Stack>
                    </Stack>
                  </Sheet>
                )}
                {rotationReadout !== null && (
                  <Chip
                    variant="solid"
                    color="primary"
                    size="sm"
                    sx={{ position: 'absolute', top: 8, right: 8, zIndex: (theme) => theme.zIndex.tooltip }}
                  >
                    {`${Math.round(rotationReadout)}°`}
                  </Chip>
                )}
                <Box
                  sx={{
                    position: 'absolute',
                    left: { xs: -18, sm: 0 },
                    bottom: { xs: -18, sm: 0 },
                    zIndex: (theme) => theme.zIndex.tooltip
                  }}
                >
                  <Box
                    ref={setViewCubeContainer}
                    aria-label="Editor orientation cube"
                    sx={{ width: VIEW_CUBE_SIZE, height: VIEW_CUBE_SIZE, '& canvas': { display: 'block' } }}
                  />
                </Box>
                {viewerError && (
                  <Alert
                    color="warning"
                    variant="soft"
                    sx={{ position: 'absolute', bottom: 8, left: 8, right: 8, zIndex: 1 }}
                    endDecorator={
                      <Button
                        size="sm"
                        variant="outlined"
                        color="warning"
                        onClick={() => { setViewerError(null); setRebuildToken((token) => token + 1) }}
                      >
                        Retry
                      </Button>
                    }
                  >
                    {viewerError}
                  </Alert>
                )}
                {placementWarningsVisible && (
                  <Sheet
                    variant="soft"
                    color="danger"
                    sx={{
                      position: 'absolute', right: 8, bottom: 8, zIndex: 2,
                      maxWidth: 'min(300px, calc(100% - 16px))', p: 1, borderRadius: 'sm',
                      boxShadow: 'sm', display: 'flex', flexDirection: 'column', gap: 0.25
                    }}
                  >
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <WarningRoundedIcon fontSize="small" />
                      <Typography level="body-xs" fontWeight="lg" sx={{ color: 'inherit', flex: 1 }}>
                        {placementWarnings.length} {placementWarnings.length === 1 ? 'issue' : 'issues'}
                      </Typography>
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="danger"
                        onClick={() => setDismissedWarningsSig(placementWarningsSig)}
                        aria-label="Dismiss placement issues"
                        sx={{ '--IconButton-size': '20px', minWidth: 20, minHeight: 20 }}
                      >
                        <CloseRoundedIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                    {placementWarnings.slice(0, 3).map((warning) => (
                      <Link
                        key={warning.key}
                        component="button"
                        type="button"
                        level="body-xs"
                        textColor="inherit"
                        sx={{ display: 'block', textAlign: 'left' }}
                        onClick={() => setSelectedKey(warning.key)}
                      >
                        {warning.name}: {warning.issues.join(', ')}
                      </Link>
                    ))}
                    {placementWarnings.length > 3 && (
                      <Typography level="body-xs" sx={{ color: 'inherit', opacity: 0.8 }}>
                        +{placementWarnings.length - 3} more
                      </Typography>
                    )}
                  </Sheet>
                )}
              </Sheet>
            )
            const objectsContent = (
              <>
                {/* On mobile this header sits in the bottom-sheet next to the drawer's
                    close (X); reserve room on the right so the Add button clears it. */}
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ pr: { xs: 4.5, sm: 0 } }}>
                  <Typography level="title-sm">Models on plate {activePlateIndex}</Typography>
                  <AddModelMenu
                    importing={importing}
                    disabled={sliceConfig != null && !hasMaterials}
                    disabledReason="Add a material before adding objects."
                    onAddFromLibrary={() => { setReplaceTargetKey(null); setLibraryPickerOpen(true) }}
                    onImportFile={() => { setReplaceTargetKey(null); fileInputRef.current?.click() }}
                    onAddPrimitive={(kind) => void handleAddPrimitive(kind)}
                  />
                </Stack>
                {selectedTransform && (
                  <TransformPanel
                    transform={selectedTransform}
                    uniformScale={uniformScale}
                    onToggleUniformScale={setUniformScale}
                    onPosition={applyManualPosition}
                    onRotation={applyManualRotation}
                    onScale={applyManualScale}
                  />
                )}
                <Sheet variant="outlined" sx={{ flex: 1, minHeight: 120, borderRadius: 'sm', overflow: 'auto' }}>
                  {activePlate.instances.length === 0 ? (
                    <Box sx={{ p: 1.5 }}>
                      <Typography level="body-sm" textColor="text.tertiary">
                        No models on this plate. Use “Add model”.
                      </Typography>
                    </Box>
                  ) : (
                    <ModelList
                      instances={activePlate.instances}
                      selectedKey={selectedKey}
                      extraSelectedKeys={extraSelectedKeys}
                      partSelection={partSelection}
                      onSelect={handleSelect}
                      onSelectPart={handleSelectPart}
                      onObjectContextMenu={handleObjectRowContextMenu}
                      onPartContextMenu={handlePartRowContextMenu}
                      onRename={handleRenameObject}
                      onDuplicate={handleDuplicate}
                      onDelete={handleDelete}
                      filamentColors={filamentColors}
                      filamentOptions={filamentOptions}
                      onReassignFilament={filamentOptions.length > 0 ? reassignFilament : undefined}
                      resolveFilamentId={resolveColorFilamentId}
                      onTogglePrintable={handleTogglePrintable}
                      onChangePartType={(objectId, componentObjectId, subtype) =>
                        handleChangePartTypes([{ objectId, componentObjectId }], subtype)}
                      perObject={perObject ? {
                        // Baked objects from the slice index PLUS each not-yet-saved import's
                        // synthetic object id, so per-object process is editable before any save.
                        sliceObjectIds: new Set<number>([
                          ...(sliceConfig?.plateObjects ?? []).map((object) => object.id),
                          ...activePlate.instances.flatMap((instance) =>
                            instance.source.kind === 'import' && instance.source.replacedObjectId != null
                              ? [instance.source.replacedObjectId]
                              : [])
                        ]),
                        overrideCountFor: (objectId) => Object.keys(perObject.value[String(objectId)] ?? {}).length,
                        onEditObject: (objectId, name) => setEditingObject({ ids: [objectId], name }),
                        onEditPart: (objectId, componentObjectId, name) => setEditingPart({ objectId, componentObjectIds: [componentObjectId], name }),
                        partOverrideCountFor: (objectId, componentObjectId) =>
                          Object.keys(stateRef.current?.partProcessOverrides?.[supportPaintKey(objectId, componentObjectId)] ?? {}).length
                      } : undefined}
                    />
                  )}
                </Sheet>
                {filamentOptions.length > 1 && activePlate && (
                  <Stack spacing={0.75} sx={{ mt: 1 }}>
                    <Typography level="title-sm">Filament changes</Typography>
                    {effectiveFilamentChanges(activePlate).length === 0 && (
                      <Typography level="body-xs" textColor="text.tertiary">
                        Swap to another material at a print height — the whole plate changes colour
                        from that layer up.
                      </Typography>
                    )}
                    {effectiveFilamentChanges(activePlate).map((change, index) => (
                      <Stack key={index} direction="row" spacing={0.75} alignItems="center">
                        <Input
                          size="sm"
                          type="number"
                          value={change.z}
                          endDecorator="mm"
                          slotProps={{ input: { min: 0.2, step: 0.2, 'aria-label': 'Change height' } }}
                          onChange={(event) => {
                            const next = Number.parseFloat(event.target.value)
                            if (!Number.isFinite(next) || next <= 0) return
                            setActivePlateFilamentChanges(effectiveFilamentChanges(activePlate).map((entry, i) => (
                              i === index ? { ...entry, z: next } : entry
                            )))
                          }}
                          sx={{ width: 110, flexShrink: 0 }}
                        />
                        <Select<number>
                          size="sm"
                          value={change.filamentId}
                          onChange={(_event, value) => {
                            if (value == null) return
                            setActivePlateFilamentChanges(effectiveFilamentChanges(activePlate).map((entry, i) => (
                              i === index ? { ...entry, filamentId: value } : entry
                            )))
                          }}
                          renderValue={(selected) => {
                            const option = filamentOptions.find((entry) => entry.id === selected?.value)
                            return option ? <FilamentOptionContent option={option} /> : null
                          }}
                          sx={{ flex: 1, minWidth: 0 }}
                        >
                          {filamentOptions.map((option) => (
                            <Option key={option.id} value={option.id}>
                              <FilamentOptionContent option={option} />
                            </Option>
                          ))}
                        </Select>
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          aria-label="Remove filament change"
                          onClick={() => {
                            setActivePlateFilamentChanges(effectiveFilamentChanges(activePlate).filter((_, i) => i !== index))
                          }}
                        >
                          <CloseRoundedIcon />
                        </IconButton>
                      </Stack>
                    ))}
                    <Button
                      size="sm"
                      variant="soft"
                      startDecorator={<AddRoundedIcon />}
                      onClick={() => {
                        const current = effectiveFilamentChanges(activePlate)
                        const lastZ = current[current.length - 1]?.z ?? 0
                        const lastFilament = current[current.length - 1]?.filamentId
                        const nextOption = filamentOptions.find((option) => option.id !== (lastFilament ?? filamentOptions[0]?.id))
                        setActivePlateFilamentChanges([
                          ...current,
                          { z: Math.round((lastZ + 1) * 10) / 10, filamentId: nextOption?.id ?? filamentOptions[0]?.id ?? 1 }
                        ])
                      }}
                      sx={{ alignSelf: 'flex-start' }}
                    >
                      Add filament change
                    </Button>
                  </Stack>
                )}
                {activePlate && (
                  <PlatePausesSection
                    pauses={effectivePauses(activePlate)}
                    onChange={setActivePlatePauses}
                  />
                )}
              </>
            )
            const settingsPanel = sliceConfigForPanel
              ? <SliceSettingsPanel controller={sliceConfigForPanel} mode="editor" activePlateIndex={activePlateIndex} />
              : null

            if (isMobile) {
              return (
                <>
                  <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {sliceConfig && (
                      <Tabs
                        value={mobileView}
                        onChange={(_event, value) => setMobileView(value === 'settings' ? 'settings' : 'view')}
                        sx={{ bgcolor: 'transparent', flexShrink: 0 }}
                      >
                        <TabList>
                          <Tab value="view" sx={{ flex: 1 }}>3D view</Tab>
                          <Tab value="settings" sx={{ flex: 1 }}>Settings</Tab>
                        </TabList>
                      </Tabs>
                    )}
                    {/* The 3D view stays mounted (canvas preserved) but hides while editing settings. */}
                    <Box sx={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 1, display: (sliceConfig && mobileView === 'settings') ? 'none' : 'flex' }}>
                      {plateStrip}
                      {viewport}
                    </Box>
                    {sliceConfig && mobileView === 'settings' && (
                      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                        <Stack spacing={1.25}>{settingsPanel}</Stack>
                      </Box>
                    )}
                    <Button
                      variant="outlined"
                      color="neutral"
                      startDecorator={<ViewListRoundedIcon />}
                      onClick={() => setObjectsSheetOpen(true)}
                      sx={{ flexShrink: 0 }}
                    >
                      Objects ({activePlate.instances.length})
                    </Button>
                  </Box>
                  <Drawer
                    anchor="bottom"
                    open={objectsSheetOpen}
                    onClose={() => setObjectsSheetOpen(false)}
                    slotProps={{ content: { sx: { height: '72dvh', borderTopLeftRadius: 'lg', borderTopRightRadius: 'lg' } } }}
                  >
                    <ModalClose />
                    <Box sx={{ p: 1.5, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {objectsContent}
                    </Box>
                  </Drawer>
                </>
              )
            }

            return (
              <Box
                sx={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  display: 'grid',
                  gap: 1,
                  gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 388px' },
                  gridTemplateRows: { xs: 'auto minmax(0, 1fr) auto', sm: 'auto minmax(0, 1fr)' },
                  gridTemplateAreas: {
                    xs: '"plates" "viewport" "panel"',
                    sm: '"plates panel" "viewport panel"'
                  }
                }}
              >
                <Box sx={{ gridArea: 'plates', minWidth: 0 }}>{plateStrip}</Box>
                {viewport}
                <Box sx={{ gridArea: 'panel', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  {sliceConfig ? (
                    <Sheet
                      variant="outlined"
                      sx={{ flex: 1, minHeight: 0, borderRadius: 'sm', overflow: 'hidden', display: 'flex', flexDirection: 'column', bgcolor: 'background.level1' }}
                    >
                      <Tabs
                        value={sidebarTab}
                        onChange={(_event, value) => setSidebarTab(value === 'settings' ? 'settings' : 'objects')}
                        sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', bgcolor: 'transparent' }}
                      >
                        <TabList
                          disableUnderline
                          sx={{ flexShrink: 0, borderBottom: '1px solid', borderColor: 'divider', borderRadius: 0, bgcolor: 'background.surface' }}
                        >
                          <Tab value="settings" sx={{ flex: 1 }}>Settings</Tab>
                          <Tab value="objects" sx={{ flex: 1 }}>Objects</Tab>
                        </TabList>
                        <TabPanel value="settings" keepMounted sx={{ p: 1.25, flex: 1, minHeight: 0, overflow: 'auto' }}>
                          <Stack spacing={1.25}>{settingsPanel}</Stack>
                        </TabPanel>
                        <TabPanel value="objects" keepMounted sx={{ p: 1.25, flex: 1, minHeight: 0, gap: 1, flexDirection: 'column', '&:not([hidden])': { display: 'flex' } }}>
                          {objectsContent}
                        </TabPanel>
                      </Tabs>
                    </Sheet>
                  ) : (
                    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1, overflow: 'auto' }}>
                      {objectsContent}
                    </Box>
                  )}
                </Box>
              </Box>
            )
          })()
        )}

        <DialogActions sx={{ pt: 1 }}>
          <Button type="button" variant="plain" onClick={handleCloseRequest} disabled={saving}>Close</Button>
          {/* Save and Slice stay separate split-buttons on every width (matching desktop). */}
          {/* Save/Slice gate on loaded state only — not the 3D viewport's ready/build state, which
              can be false while a settings tab is shown and would wrongly disable slicing. */}
          {/* Save is the primary action and sits rightmost (solid); Slice/Apply pair to its left. */}
          {onSlice ? (
            <SliceSplitButton
              slicing={slicing}
              disabled={!state || !canSlice || slicing || saving}
              disabledReason={!state ? 'Preparing the model…' : (slicing || saving) ? undefined : sliceDisabledReason}
              activePlateIndex={activePlateIndex}
              onSliceAll={() => { const current = stateRef.current; if (!current) return; void (async () => { const thumbnails = await captureAllPlateThumbnails(current); onSlice({ plate: 0, sceneEdit: buildSceneEditOut(current, { thumbnails }) }) })() }}
              onSlicePlate={() => { const current = stateRef.current; if (!current) return; void (async () => { const thumbnails = await captureAllPlateThumbnails(current); onSlice({ plate: activePlateIndex, sceneEdit: buildSceneEditOut(current, { thumbnails }) }) })() }}
            />
          ) : onApply ? (
            <Button type="button" variant="soft" color="primary" disabled={!state || saving} onClick={handleApply}>Use this layout</Button>
          ) : null}
          <SaveSplitButton
            saving={saving}
            disabled={!state || (sliceConfig != null && !hasMaterials)}
            dirty={hasUnsavedChanges}
            canSaveVersion={baseFileId !== null && !isNewProject}
            onSaveVersion={handleSaveVersion}
            onSaveAs={() => setSaveAsOpen(true)}
          />
        </DialogActions>

        {/* Hidden picker for "Import file…" — STL required; STEP server-tessellated. */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".stl,.step,.stp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            const replaceKey = replaceTargetKey
            setReplaceTargetKey(null)
            if (replaceKey) void handleReplaceFromFile(replaceKey, file)
            else void handleImportFile(file)
          }}
        />
        {contextMenu?.kind === 'object' && (
          <EditorContextMenu
            contextMenu={contextMenu}
            listboxRef={contextMenuListboxRef}
            onClose={() => setContextMenu(null)}
            selectionCount={selectedKey === contextMenu.key || extraSelectedKeys.includes(contextMenu.key) ? extraSelectedKeys.length + 1 : 1}
            onDuplicate={handleDuplicate}
            onSplitToObjects={(key) => { void handleSplitToObjects(key) }}
            canAssemble={extraSelectedKeys.length > 0 && (selectedKey === contextMenu.key || extraSelectedKeys.includes(contextMenu.key))}
            assembleCount={extraSelectedKeys.length + 1}
            onAssemble={() => { void handleAssembleSelection() }}
            onReplaceFromLibrary={(key) => { setReplaceTargetKey(key); setLibraryPickerOpen(true) }}
            onReplaceFromFile={(key) => { setReplaceTargetKey(key); fileInputRef.current?.click() }}
            isObject={activePlate?.instances.find((entry) => entry.key === contextMenu.key)?.source.kind === 'object'}
            onAddPartVolume={(key, subtype) => { void handleAddPartVolume(key, subtype) }}
            filamentOptions={filamentOptions}
            onChangeMaterial={(filamentId) => reassignSelectionFilament(contextMenu.key, filamentId)}
            onSetPrintable={(printable) => handleSetPrintableSelection(selectionFor(contextMenu.key), printable)}
            onEditObjectSettings={perObject ? () => openObjectSettingsFor(contextMenu.key) : undefined}
            onCenterOnPlate={() => {
              const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
              if (plate) {
                const cx = (plate.bed.minX + plate.bed.maxX) / 2
                const cy = (plate.bed.minY + plate.bed.maxY) / 2
                mutateSelectedGroup((group) => { group.position.x = cx; group.position.y = cy })
              }
            }}
            onDropToBed={handleDropToBed}
            onResetRotation={() => mutateSelectedGroup((group) => { rotorOf(group).rotation.set(0, 0, 0) })}
            onResetScale={() => mutateSelectedGroup((group) => { group.scale.set(1, 1, 1) })}
            onMirror={(axis) => mutateSelectedGroup((group) => { group.scale[axis] *= -1 })}
            otherPlates={(state?.plates ?? []).filter((plate) => plate.index !== activePlateIndex)}
            onMoveToPlate={handleMoveToPlate}
            onDelete={handleDelete}
          />
        )}
        {contextMenu?.kind === 'parts' && (
          <EditorPartContextMenu
            contextMenu={contextMenu}
            count={contextMenu.componentObjectIds.length}
            listboxRef={contextMenuListboxRef}
            onClose={() => setContextMenu(null)}
            onChangeType={(subtype) => handleChangePartTypes(
              contextMenu.componentObjectIds.map((componentObjectId) => ({ objectId: contextMenu.objectId, componentObjectId })),
              subtype
            )}
            filamentOptions={filamentOptions}
            onChangeMaterial={(filamentId) => reassignFilament(
              contextMenu.componentObjectIds.map((componentObjectId) => ({ objectId: contextMenu.objectId, componentObjectId })),
              filamentId
            )}
            onEditSettings={perObject ? openPartSettingsForSelection : undefined}
          />
        )}
      </ModalDialog>
    </Modal>

    {libraryPickerOpen && (
      <LibraryFilePickerDialog
        title={replaceTargetKey ? 'Replace from library' : 'Add from library'}
        description={replaceTargetKey
          ? 'Choose an STL, STEP, or 3MF file to swap in for the selected object — its position and settings are kept.'
          : 'Choose an STL, STEP, or 3MF file to add to this project.'}
        initialBridgeId={bridgeId}
        acceptFile={isImportableLibraryFile}
        emptyState={
          <EmptyState
            icon={<InventoryRoundedIcon />}
            title="No importable files here"
            description="Open a subfolder, or upload an STL, STEP, or 3MF file to the library first."
          />
        }
        onPick={(file) => {
          const replaceKey = replaceTargetKey
          if (replaceKey) void handleReplaceFromLibrary(replaceKey, file.id)
          else void handleImportFromLibrary(file.id)
        }}
        onClose={() => { setLibraryPickerOpen(false); setReplaceTargetKey(null) }}
      />
    )}

    {saveAsOpen && (
      <LibraryDestinationDialog
        title="Save as new file"
        description="Choose where to save the new file, then confirm the file name. Picking an existing file saves over it."
        showFiles
        fileNameField={{ label: 'File name', initialValue: saveAsSuggestedName, extension: '.3mf' }}
        initialFolderId={saveAsInitialFolderId}
        folders={editorFoldersQuery.data?.folders ?? []}
        bridgeId={saveAsBridgeId}
        bridgeName={null}
        showRoot
        dialogWidth={720}
        submitting={saving}
        error={null}
        confirmActionLabel={({ outputFolderId, rootDestinationLabel }) => outputFolderId ? 'Save here' : `Save to ${rootDestinationLabel}`}
        onClose={() => setSaveAsOpen(false)}
        onSubmit={({ outputFileName, outputFolderId }) => { if (outputFileName) handleSaveAs(outputFileName, outputFolderId) }}
      />
    )}

    {editingPartKey && perObject && (() => {
      // Per-volume overrides for a modifier part: same restricted catalog as the
      // per-object dialog, baselined on the inherited global + object overrides; the
      // result is stored on the part and baked into its model_settings `<part>` block.
      const part = (() => {
        for (const parts of Object.values(stateRef.current?.addedParts ?? {})) {
          const found = parts.find((entry) => entry.key === editingPartKey)
          if (found) return found
        }
        return null
      })()
      const parentObjectId = (() => {
        for (const [objectId, parts] of Object.entries(stateRef.current?.addedParts ?? {})) {
          if (parts.some((entry) => entry.key === editingPartKey)) return objectId
        }
        return null
      })()
      if (!part) return null
      const objectOverrides = parentObjectId ? perObject.value[parentObjectId] ?? {} : {}
      return (
        <ProcessSettingsDialog
          open
          applyScope="project"
          onClose={() => setEditingPartKey(null)}
          slicerTargetId={perObject.slicerTargetId}
          processProfileId={perObject.processProfileId}
          processProfileName={part.name}
          sourceFileId={perObject.sourceFileId}
          initialOverrides={part.settings ?? {}}
          visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}
          allowedKeys={PER_OBJECT_PROCESS_KEYS}
          baseOverlay={{ ...perObject.globalOverrides, ...objectOverrides }}
          titlePrefix="Modifier settings"
          onApply={(overrides) => {
            recordHistoryRef.current?.()
            const serialized: Record<string, string> = {}
            for (const [key, value] of Object.entries(overrides)) {
              serialized[key] = Array.isArray(value) ? value.join(',') : value
            }
            if (Object.keys(serialized).length === 0) delete part.settings
            else part.settings = serialized
            setEditingPartKey(null)
          }}
        />
      )
    })()}
    {editingObject && perObject && (
      <ProcessSettingsDialog
        open
        applyScope="project"
        onClose={() => setEditingObject(null)}
        slicerTargetId={perObject.slicerTargetId}
        processProfileId={perObject.processProfileId}
        processProfileName={editingObject.name}
        sourceFileId={perObject.sourceFileId}
        initialOverrides={editingObjectOverrides}
        visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}
        allowedKeys={PER_OBJECT_PROCESS_KEYS}
        baseOverlay={perObject.globalOverrides}
        titlePrefix="Object settings"
        onApply={(overrides) => {
          // Snapshot for undo (overrides live in the borrowed slice config, captured by the
          // materials history); recording also flags the project dirty so Save lights up / close warns.
          recordMaterialsHistory()
          const next = { ...perObject.value }
          // Bulk apply (context menu on a multi-selection) REPLACES every selected
          // object's override set with the dialog result, like BambuStudio's
          // multi-object per-object settings.
          for (const id of editingObject.ids) {
            if (Object.keys(overrides).length === 0) delete next[String(id)]
            else next[String(id)] = overrides
          }
          perObject.onChange(next)
          setEditingObject(null)
        }}
      />
    )}
    {editingPart && perObject && (() => {
      // Per-PART process overrides: same restricted catalog as the per-object dialog, baselined on
      // the inherited global + object overrides; the result is stored per part and baked into that
      // part's model_settings block (separate from the object's overall overrides). With several
      // parts selected (bulk), the dialog seeds from the FIRST part and applies to all of them.
      const partKeys = editingPart.componentObjectIds.map((componentObjectId) =>
        supportPaintKey(editingPart.objectId, componentObjectId))
      const objectOverrides = perObject.value[String(editingPart.objectId)] ?? {}
      return (
        <ProcessSettingsDialog
          open
          applyScope="project"
          onClose={() => setEditingPart(null)}
          slicerTargetId={perObject.slicerTargetId}
          processProfileId={perObject.processProfileId}
          processProfileName={editingPart.name}
          sourceFileId={perObject.sourceFileId}
          initialOverrides={(partKeys[0] != null ? stateRef.current?.partProcessOverrides?.[partKeys[0]] : undefined) ?? EMPTY_OBJECT_OVERRIDES}
          visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}
          allowedKeys={PER_OBJECT_PROCESS_KEYS}
          baseOverlay={{ ...perObject.globalOverrides, ...objectOverrides }}
          titlePrefix="Part settings"
          onApply={(overrides) => {
            recordHistory()
            const serialized: Record<string, string> = {}
            for (const [key, value] of Object.entries(overrides)) serialized[key] = Array.isArray(value) ? value.join(';') : value
            setState((current) => {
              if (!current) return current
              const map = { ...(current.partProcessOverrides ?? {}) }
              for (const partKey of partKeys) {
                if (Object.keys(serialized).length === 0) delete map[partKey]
                else map[partKey] = serialized
              }
              return { ...current, partProcessOverrides: map }
            })
            setEditingPart(null)
          }}
        />
      )
    })()}
    </>
  )
}

/** Small swatch showing a part/object's filament number, tinted with its colour. */
export type FilamentOption = { id: number; color: string | null; label: string | null; colorName: string | null }

/**
 * Re-render the editor ONLY when its own data changes — never on a parent re-render driven by live
 * printer-status WS pushes. The host (LibraryView/SliceFileModal) re-renders ~once a second while a
 * printer is connected (status updates); it rebuilds the borrowed `sliceConfig` and the editor
 * callbacks by identity each time, which — without this gate — re-rendered the whole editor and
 * interrupted camera orbit / object drags every second. Once the editor is open it doesn't care about
 * printer status; the only host-driven thing that legitimately changes is the loaded-materials list,
 * which lives in `sliceConfig` and is caught by the content compare below.
 *
 * Callback identity (onApply/onClose/onSlice/onEditObjectSettings/onSaved) is intentionally ignored:
 * they're rebuilt every parent render, but the editor invokes them only on real user interactions,
 * which always follow a data change (so a fresh closure has already been delivered). Internal editor
 * state changes still re-render normally — React.memo only gates parent-prop-driven re-renders.
 */
const EDITOR_DATA_PROP_KEYS = [
  'baseFileId', 'isNewProject', 'baseVersionId', 'currentEdit', 'initialPlateIndex', 'targetPrinterModel',
  'folderId', 'bridgeId', 'canSlice', 'sliceDisabledReason', 'slicing', 'objectOverrideCount',
  'hasPlateObjects', 'canEditSettings'
] as const
function editorViewPropsEqual(prev: EditorViewProps, next: EditorViewProps): boolean {
  for (const key of EDITOR_DATA_PROP_KEYS) {
    if (!Object.is(prev[key], next[key])) return false
  }
  // The borrowed slice controller is a fresh object every parent render; compare it by DATA content
  // (JSON drops its functions/setters) so material/colour/selection edits DO re-render, but a pure
  // status tick (identical data, new identity) does not. A serialize failure falls back to re-render.
  try {
    return JSON.stringify(prev.sliceConfig) === JSON.stringify(next.sliceConfig)
  } catch {
    return false
  }
}

export default memo(EditorView, editorViewPropsEqual)
