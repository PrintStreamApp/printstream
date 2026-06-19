/**
 * Interactive 3D plate editor (Bambu Studio "prepare" stage, basic).
 *
 * Loads every plate of a 3MF project, lets the user move/rotate/scale, add,
 * duplicate, and delete model instances across multiple plates, then hands back a
 * `SceneEdit` (the locked shared contract) on apply. Heavy: lazy-loaded by the
 * `SlicingEditorAction` slot button via `React.lazy`.
 *
 * Transform convention: each instance group's matrix is seeded by decomposing the
 * scene's plate-local 12-element transform (position/quaternion/scale, Euler XYZ).
 * On apply we read each group's position/rotation(Euler XYZ)/scale straight into
 * the `SceneEdit` instance — the backend recomposes M = T * R(eulerXYZ) * S. Values
 * stay plate-local (plate origin is never baked in).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  buttonClasses,
  ButtonGroup,
  Checkbox,
  Chip,
  CircularProgress,
  DialogActions,
  Drawer,
  Dropdown,
  IconButton,
  iconButtonClasses,
  Input,
  Link,
  List,
  ListDivider,
  ListItem,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Slider,
  Stack,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  Typography
} from '@mui/joy'
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import DriveFileRenameOutlineRoundedIcon from '@mui/icons-material/DriveFileRenameOutlineRounded'
import OpenWithRoundedIcon from '@mui/icons-material/OpenWith'
import ThreeSixtyRoundedIcon from '@mui/icons-material/ThreeSixtyRounded'
import AspectRatioRoundedIcon from '@mui/icons-material/AspectRatioRounded'
import VerticalAlignBottomRoundedIcon from '@mui/icons-material/VerticalAlignBottomRounded'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded'
import MergeTypeRoundedIcon from '@mui/icons-material/MergeTypeRounded'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import LayersRoundedIcon from '@mui/icons-material/LayersRounded'
import SaveRoundedIcon from '@mui/icons-material/SaveRounded'
import ViewListRoundedIcon from '@mui/icons-material/ViewListRounded'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import RedoRoundedIcon from '@mui/icons-material/RedoRounded'
import FlipRoundedIcon from '@mui/icons-material/FlipRounded'
import CenterFocusStrongRoundedIcon from '@mui/icons-material/CenterFocusStrongRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import LockRoundedIcon from '@mui/icons-material/LockRounded'
import LockOpenRoundedIcon from '@mui/icons-material/LockOpenRounded'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded'
import DriveFileMoveRoundedIcon from '@mui/icons-material/DriveFileMoveRounded'
import UnfoldLessRoundedIcon from '@mui/icons-material/UnfoldLessRounded'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'
import AdjustRoundedIcon from '@mui/icons-material/AdjustRounded'
import BrushRoundedIcon from '@mui/icons-material/BrushRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import FormatPaintRoundedIcon from '@mui/icons-material/FormatPaintRounded'
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import TouchAppRoundedIcon from '@mui/icons-material/TouchAppRounded'
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as THREE from 'three'
import { ConvexGeometry, OrbitControls, TransformControls } from 'three-stdlib'
import type {
  LibraryFile,
  LibraryFolder,
  LibraryThreeMfPrimeTower,
  LibraryThreeMfScene,
  ProcessSettingOverrides,
  SaveArrangedThreeMf,
  SceneEdit,
  SceneEditAddedPartSubtype,
  StagedImport,
  ThreeMfIndex
} from '@printstream/shared'
import { PER_OBJECT_PROCESS_KEYS } from '@printstream/shared'
import ProcessSettingsDialog from '../../components/ProcessSettingsDialog'
import { apiFetch } from '../../lib/apiClient'
import { resolveProjectFilamentColorName } from '../../lib/filamentColor'
import { buildApiUrl } from '../../lib/apiUrl'
import { toast } from '../../lib/toast'
import { invalidateLibraryQueries } from '../../lib/libraryQueryInvalidation'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { EmptyState } from '../../components/EmptyState'
import { LibraryFilePickerDialog } from '../../components/LibraryFilePickerDialog'
import { LibraryDestinationDialog } from '../../components/LibraryDestinationDialog'
import { splitLibraryFileNameForRename } from '../../lib/libraryDisplay'
import { useMobileViewport } from '../../components/useMobileViewport'
import { SliceSettingsPanel, type SliceMaterialsSnapshot, type SliceSettingsController } from '../../pages/LibraryView'
import {
  createPreviewPlateSurface,
  createThreeMfMatrix,
  createThreeMfPartObject,
  disposeObject3D,
  getGeometryTrianglePaint,
  isModifierVolumeSubtype,
  parseStlGeometry,
  parseThreeMfModelEntry,
  type SupportPaintCodes,
  type TrianglePaintChannel
} from './lib/threeMfScene'
import { arrangePlateItems, FOOTPRINT_CELL_MM, footprintCellKey } from './lib/arrange'
import { PRIMITIVE_LABELS, primitivePartSoup, primitiveTriangleSoup, type PrimitiveKind } from './lib/primitives'
import {
  applyBucketFill,
  applyHeightRangePaint,
  applySingleTrianglePaint,
  applySmartFill,
  applySupportPaintBrush,
  buildTrianglePaintOverlay,
  decodeWholeTriangleColorState,
  getTriangleScanData,
  SEAM_PAINT_COLORS,
  SEAM_PAINT_OVERLAY_NAME,
  SUPPORT_PAINT_COLORS,
  SUPPORT_PAINT_OVERLAY_NAME,
  type PaintPalette,
  type SupportPaintBrushMode
} from './lib/supportPaint'
import {
  EDITOR_HOME_VIEW_DIRECTION as EDITOR_HOME_VIEW,
  VIEW_CUBE_SIZE,
  VIEW_PRESET_CONFIG,
  createViewCube,
  type ViewPreset
} from './lib/viewCube'
import { createPlateThumbnailRenderer, type PlateThumbnailRenderer } from './lib/plateThumbnail'
import { estimateWipeTowerFootprint } from './lib/primeTower'
import {
  buildSceneEdit,
  cloneEditorState,
  duplicateInstance,
  fillPlateFromScene,
  findFreePlatePosition,
  instanceFromStagedImport,
  replaceInstanceGeometry,
  reindexPlates,
  effectiveAddedParts,
  effectiveBrimEars,
  effectiveFilamentChanges,
  nextInstanceKey,
  seedEditorState,
  seedEmptyEditorState,
  supportPaintKey,
  type EditorAddedPart,
  type EditorBrimEar,
  type EditorFilamentChange,
  type EditorInstance,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'
import {
  fetchImportMesh,
  stageImportFromFile,
  stageImportFromLibrary
} from './lib/editorImports'
import { fetchModelText } from './lib/modelFetch'
import {
  collectWorldTriangles,
  cutTriangleSoup,
  rebaseTriangleSoup,
  splitTriangleSoup,
  triangleSoupToBinaryStl,
  type CutAxis
} from './lib/meshCut'

type GizmoMode = 'translate' | 'rotate' | 'scale' | 'layFace' | 'cut' | 'paintSupports' | 'paintSeam' | 'paintColor' | 'brimEars' | 'measure'

/** Screen-space radius (px) within which a measure click snaps to a mesh corner. */
const MEASURE_SNAP_PX = 14

/**
 * Top offset for the tool panels (cut/paint/measure/…) that hang below the
 * viewport toolbar: the toolbar is an icon-only row on phones but taller
 * icon-above-caption buttons on desktop.
 */
const TOOL_PANEL_TOP = { xs: 52, sm: 56 } as const

/** Scene-object name for the brim-ear disc markers (children of an instance's rotor). */
const BRIM_EAR_MARKER_NAME = 'brimEarMarker'
const BRIM_EAR_MARKER_COLOR = 0xeec25a

/** Viewport meshes for added part volumes (negative parts, modifiers, blockers). */
const ADDED_PART_MESH_NAME = 'addedPartVolume'
const ADDED_PART_SPECS: Record<SceneEditAddedPartSubtype, { label: string; color: number; hint: string }> = {
  negative_part: { label: 'Negative part', color: 0x8a8f98, hint: 'Its shape is cut out of the model when slicing.' },
  modifier_part: { label: 'Modifier', color: 0x2fae6a, hint: 'Apply per-object process overrides inside its volume.' },
  support_blocker: { label: 'Support blocker', color: 0xd24a4a, hint: 'Supports are never generated inside its volume.' },
  support_enforcer: { label: 'Support enforcer', color: 0x3a62e0, hint: 'Supports are always generated inside its volume.' }
}
const ADDED_PART_SUBTYPES = Object.keys(ADDED_PART_SPECS) as SceneEditAddedPartSubtype[]

/**
 * Per-channel wiring for the two triangle-paint brushes. Both share the brush, panel,
 * undo, and overlay machinery; they differ only in which EditorState map they edit,
 * which `geometry.userData` key seeds them, and how the overlay renders. The seam
 * overlay's stronger polygon offset draws it above support paint on doubly-painted
 * triangles.
 */
const PAINT_CHANNEL_SPECS: Record<TrianglePaintChannel, {
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

function paintChannelForGizmoMode(mode: GizmoMode): TrianglePaintChannel | null {
  return mode === 'paintSupports' ? 'supports' : mode === 'paintSeam' ? 'seam' : mode === 'paintColor' ? 'color' : null
}

/**
 * Paint tools, mirroring Bambu Studio's per-gizmo tool rows: circle/sphere brushes
 * everywhere, smart fill on supports + colour, and the single-triangle,
 * same-colour bucket-fill, and height-range tools on colour only.
 */
type PaintToolType = 'circle' | 'sphere' | 'fill' | 'bucket' | 'triangle' | 'height'

const PAINT_TOOLS_BY_CHANNEL: Record<TrianglePaintChannel, PaintToolType[]> = {
  supports: ['circle', 'sphere', 'fill'],
  seam: ['circle', 'sphere'],
  color: ['circle', 'sphere', 'triangle', 'fill', 'bucket', 'height']
}

const PAINT_TOOL_LABELS: Record<PaintToolType, string> = {
  circle: 'Circle',
  sphere: 'Sphere',
  fill: 'Fill',
  bucket: 'Bucket',
  triangle: 'Tri',
  height: 'Height'
}

/** The channel's tool for a selection, falling back to the circle brush. */
function effectivePaintTool(channel: TrianglePaintChannel, tool: PaintToolType): PaintToolType {
  return PAINT_TOOLS_BY_CHANNEL[channel].includes(tool) ? tool : 'circle'
}

/** Bed-relative names for the two halves either side of each cut-plane axis. */
const CUT_AXIS_SIDES: Record<CutAxis, { lower: string; upper: string }> = {
  x: { lower: 'left', upper: 'right' },
  y: { lower: 'front', upper: 'back' },
  z: { lower: 'lower', upper: 'upper' }
}

/** One undo/redo step: either a scene snapshot or a material-edit snapshot (not both). */
type EditorHistoryEntry = { state: EditorState | null; materials: SliceMaterialsSnapshot | null }

const DOWN_VECTOR = new THREE.Vector3(0, 0, -1)

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
 * Cache of decoded 3MF geometry keyed by `entryPath`. Values are PROMISES so
 * concurrent loads of the same entry (parallel part fetches, prefetch + build)
 * dedupe to one request/parse; failed/aborted loads evict themselves.
 */
type GeometryCache = Map<string, Promise<Map<number, THREE.BufferGeometry>>>
/** Cache of decoded imported STL geometry keyed by `importId` (promise, as above). */
type ImportGeometryCache = Map<string, Promise<THREE.BufferGeometry>>

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

const ISO_UP = new THREE.Vector3(0, 0, 1)

/**
 * Editor default camera direction (offset from the bed centre to the camera): mostly
 * top-down but tilted toward the front, similar to Bambu Studio's prepare view.
 */
// Shared with the read-only G-code preview so both open at the same angle (see viewCube.ts).
const EDITOR_HOME_VIEW_DIRECTION = new THREE.Vector3(EDITOR_HOME_VIEW.x, EDITOR_HOME_VIEW.y, EDITOR_HOME_VIEW.z).normalize()

/** Keyboard move steps (mm) for the bed plane. */
const KEY_MOVE_STEP = 1
const KEY_MOVE_STEP_LARGE = 10
const KEY_MOVE_STEP_FINE = 0.1
/** Keyboard rotate step (radians) about Z. */
const KEY_ROTATE_STEP = THREE.MathUtils.degToRad(15)
/** Rotation snap increments (radians). Coarse while a modifier is held. */
const ROTATE_SNAP_COARSE = THREE.MathUtils.degToRad(45)
const ROTATE_SNAP_FINE = THREE.MathUtils.degToRad(15)

/** Max retained undo steps. */
const HISTORY_LIMIT = 100

/** Stable empty per-object overrides so the override editor doesn't re-fetch each render. */
const EMPTY_OBJECT_OVERRIDES: ProcessSettingOverrides = {}

/**
 * Resolve once the browser has had a chance to paint. Awaited before a synchronous,
 * main-thread-blocking rebuild (e.g. switching plates) so a just-shown loading overlay
 * renders first — otherwise the await-chain that follows starves the paint and the work
 * looks like a silent UI freeze. Falls back to a short timer if rAF is paused (backgrounded
 * tab) so the rebuild never stalls.
 */
function nextPaint(): Promise<void> {
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
function nextIdle(): Promise<void> {
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
function createPrimeTowerObject(
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
function rotorOf(group: THREE.Object3D): THREE.Object3D {
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
function syncBrimEarMarkerMatrices(group: THREE.Object3D): void {
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
function printableMeshBox(object: THREE.Object3D, precise = true): THREE.Box3 {
  object.updateMatrixWorld(true)
  const box = new THREE.Box3()
  object.traverse((child) => {
    // `precise: true` walks actual vertices. Required for rotated meshes: the cheap path
    // transforms the mesh's LOCAL AABB, whose corners rotate BELOW the real geometry, so
    // the box dipped under the mesh and rested the object floating (the "handle" bug).
    // Callers needing exact bounds (resting on the bed) keep the default; the live selection
    // box passes precise=false while dragging, where a slightly loose box is fine and the
    // per-vertex walk would stutter high-poly drags. Modifier/support volumes are excluded —
    // they're aids, not printed geometry, so they must not affect resting or the selection box.
    if ((child as THREE.Mesh).isMesh && !child.userData.isModifier) box.expandByObject(child, precise)
  })
  return box
}

/** Drop an object so its lowest printable point rests on the bed (z = 0); nothing floats. */
function restObjectOnBed(object: THREE.Object3D): void {
  const box = printableMeshBox(object)
  if (!box.isEmpty()) object.position.z -= box.min.z
}

/** Do two boxes overlap in the XY (bed) plane, beyond a small tolerance? */
function xyBoxesOverlap(a: THREE.Box3, b: THREE.Box3, tol = 0.2): boolean {
  return a.min.x < b.max.x - tol && a.max.x > b.min.x + tol
    && a.min.y < b.max.y - tol && a.max.y > b.min.y + tol
}

// Collision grid (2mm cells) shared with the auto-arrange packer in lib/arrange.ts.

/** Is point p inside triangle abc (inclusive)? */
function pointInTriangle(
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
function addTriangleCells(
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

function computeFootprintCells(group: THREE.Object3D): Set<number> {
  group.updateWorldMatrix(true, true)
  const cells = new Set<number>()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.isFaceHull || mesh.userData.isPrimeTower || mesh.userData.isModifier) return
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
function rasterizePolygonCells(polygon: Array<{ x: number; y: number }>): Set<number> {
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

/** Which nozzle (1 = left, 2 = right) an exclude zone's label requires, or null. */
function zoneRequiredNozzle(label: string | null): number | null {
  if (!label) return null
  if (/left/i.test(label)) return 1
  if (/right/i.test(label)) return 2
  return null
}

/**
 * Do two footprint cell sets overlap by a meaningful area? Requires several shared
 * cells (not just one boundary cell) so objects that merely touch — or whose edges
 * round into the same 2 mm cell — aren't flagged as colliding.
 */
function footprintCellsOverlap(a: Set<number>, b: Set<number>, minSharedCells = 4): boolean {
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
function groupTransformSignature(group: THREE.Object3D): string {
  const r = (n: number) => Math.round(n * 100) / 100
  const { position: p, quaternion: q, scale: s } = group
  return `${r(p.x)},${r(p.y)},${r(p.z)}|${r(q.x)},${r(q.y)},${r(q.z)},${r(q.w)}|${r(s.x)},${r(s.y)},${r(s.z)}`
}

/**
 * Full world-affecting transform of an instance group: the outer group's position+scale
 * (it carries no rotation) plus its rotor child's rotation. Full float precision so the
 * selection box stays pixel-accurate during a drag, while letting the animation loop skip
 * the expensive precise-bounds recompute on frames where nothing moved (idle selection or
 * a camera-only orbit) — the per-frame vertex walk was the main avoidable editor cost.
 */
function selectionBoxSignature(group: THREE.Object3D): string {
  const { position: p, scale: s } = group
  const rq = rotorOf(group).quaternion
  return `${p.x},${p.y},${p.z}|${s.x},${s.y},${s.z}|${rq.x},${rq.y},${rq.z},${rq.w}`
}

/** Whether two plate beds (bounds + unprintable zones) are identical. */
function bedsEqual(a: EditorPlate['bed'], b: EditorPlate['bed']): boolean {
  return a.minX === b.minX && a.maxX === b.maxX && a.minY === b.minY && a.maxY === b.maxY
    && JSON.stringify(a.excludeAreas) === JSON.stringify(b.excludeAreas)
}

/**
 * Does an axis-aligned XY footprint overlap any unprintable exclude zone? Tested against each
 * zone's bounding box (zones are corner/edge rectangles), which is conservative for any
 * non-rectangular zone — safe, since it only keeps the tower further clear of the excluded area.
 */
function footprintHitsExcludeZones(
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

interface PlacementWarning {
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
function computePlacementWarnings(
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
const FILAMENT_CHANGE_MAX_BANDS = 8

/** Shared uniform set driving the filament-change band shader on every part material. */
interface FilamentChangeBandUniforms {
  uFcCount: { value: number }
  uFcHeights: { value: number[] }
  uFcColors: { value: THREE.Color[] }
}

/**
 * Inject layer-based filament-change banding into a part's MeshStandardMaterial: above
 * each change height (world Z, ascending) the fragment colour switches to that change's
 * material colour, so the 3D model shows the swap exactly where it will print. Uniforms
 * are shared across all part materials, so panel edits update every mesh per-frame
 * without recompiling shaders.
 */
function applyFilamentChangeBands(material: THREE.Material, uniforms: FilamentChangeBandUniforms): void {
  const standard = material as THREE.MeshStandardMaterial
  if (standard.userData.hasFilamentChangeBands) return
  standard.userData.hasFilamentChangeBands = true
  standard.onBeforeCompile = (shader) => {
    shader.uniforms.uFcCount = uniforms.uFcCount
    shader.uniforms.uFcHeights = uniforms.uFcHeights
    shader.uniforms.uFcColors = uniforms.uFcColors
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFcWorldZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFcWorldZ = (modelMatrix * vec4(position, 1.0)).z;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying float vFcWorldZ;',
        'uniform int uFcCount;',
        `uniform float uFcHeights[${FILAMENT_CHANGE_MAX_BANDS}];`,
        `uniform vec3 uFcColors[${FILAMENT_CHANGE_MAX_BANDS}];`
      ].join('\n'))
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        `for (int i = 0; i < ${FILAMENT_CHANGE_MAX_BANDS}; i++) {`,
        '  if (i < uFcCount && vFcWorldZ >= uFcHeights[i]) {',
        '    diffuseColor.rgb = uFcColors[i];',
        '  }',
        '}'
      ].join('\n'))
  }
  standard.needsUpdate = true
}

function setObjectPrintedStyle(object: THREE.Object3D, printed: boolean): void {
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
function buildHullGeometry(group: THREE.Object3D): THREE.BufferGeometry | null {
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

function buildFaceHullOverlay(group: THREE.Object3D): THREE.Mesh | null {
  const geometry = buildHullGeometry(group)
  if (!geometry) return null
  const overlay = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
  )
  overlay.userData.isFaceHull = true
  overlay.renderOrder = 6
  return overlay
}

/**
 * The world-space normal of the group's largest convex-hull "face" (coplanar hull
 * triangles clustered by normal, biggest summed world area wins). Resting the object
 * on this face is the auto-orient heuristic: the largest flat face is the most
 * stable, support-free base. Returns null when no hull can be built.
 */
function largestHullFaceNormal(group: THREE.Object3D): THREE.Vector3 | null {
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
interface SelectedTransform {
  position: { x: number; y: number; z: number }
  /** Rotation in degrees (display units). */
  rotationDeg: { x: number; y: number; z: number }
  /** Scale in percent (display units). */
  scalePct: { x: number; y: number; z: number }
}

export default function EditorView({
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
  const queryClient = useQueryClient()
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
  // BambuStudio parity: a project must have a material, and a material in use by an object
  // can't be removed. `usedFilamentIds` is the live set of materials any object/part references
  // (across every plate); `hasMaterials` whether the project has any material at all. The set is
  // derived through a stable string key so it only changes identity when the materials actually
  // in use change — not on every drag — so it can gate the memoized settings-panel controller.
  const usedFilamentKey = useMemo(() => {
    const ids = new Set<number>()
    for (const plate of state?.plates ?? []) {
      for (const instance of plate.instances) {
        if (instance.filamentId != null) ids.add(instance.filamentId)
        for (const part of instance.parts) if (part.filamentId != null) ids.add(part.filamentId)
      }
      // Layer-based filament changes reference materials too.
      for (const change of effectiveFilamentChanges(plate)) ids.add(change.filamentId)
    }
    // Colour-painted triangles reference a material via their whole-triangle paint code.
    for (const channel of [state?.colorPaint]) {
      for (const codes of Object.values(channel ?? {})) {
        for (const code of Object.values(codes)) {
          const filamentId = decodeWholeTriangleColorState(code)
          if (filamentId != null) ids.add(filamentId)
        }
      }
    }
    return [...ids].sort((left, right) => left - right).join(',')
  }, [state])
  const usedFilamentIds = useMemo(
    () => new Set(usedFilamentKey ? usedFilamentKey.split(',').map(Number) : []),
    [usedFilamentKey]
  )
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
  // Support-paint brush: enforce/block/erase + radius (mm). Read via refs inside the
  // viewport's pointer handlers so strokes never re-bind the scene effect.
  const [paintBrushMode, setPaintBrushMode] = useState<SupportPaintBrushMode>('enforcer')
  const [paintBrushRadius, setPaintBrushRadius] = useState(3)
  const paintBrushModeRef = useRef(paintBrushMode)
  paintBrushModeRef.current = paintBrushMode
  const paintBrushRadiusRef = useRef(paintBrushRadius)
  paintBrushRadiusRef.current = paintBrushRadius
  // Paint tool (Bambu's tool row): circle/sphere brush, smart fill, single triangle,
  // height range. The selection is shared across channels; channels that lack the
  // selected tool fall back to the circle brush (see effectivePaintTool).
  const [paintTool, setPaintTool] = useState<PaintToolType>('circle')
  const paintToolRef = useRef(paintTool)
  paintToolRef.current = paintTool
  // Smart fill: max angle (deg) between neighbouring face normals to flood across.
  const [paintSmartAngle, setPaintSmartAngle] = useState(30)
  const paintSmartAngleRef = useRef(paintSmartAngle)
  paintSmartAngleRef.current = paintSmartAngle
  // Height range: band height (mm) painted upward from the clicked point.
  const [paintHeightRange, setPaintHeightRange] = useState(1)
  const paintHeightRangeRef = useRef(paintHeightRange)
  paintHeightRangeRef.current = paintHeightRange
  // Edge detection (colour brushes): strokes stop at edges sharper than the smart
  // fill angle instead of wrapping around them.
  const [paintEdgeDetection, setPaintEdgeDetection] = useState(false)
  const paintEdgeDetectionRef = useRef(paintEdgeDetection)
  paintEdgeDetectionRef.current = paintEdgeDetection
  // On overhangs only (support painting): strokes/fills affect only faces steeper
  // than the threshold (Bambu's highlight-by-angle gate).
  const [paintOnOverhangs, setPaintOnOverhangs] = useState(false)
  const paintOnOverhangsRef = useRef(paintOnOverhangs)
  paintOnOverhangsRef.current = paintOnOverhangs
  const [paintOverhangAngle, setPaintOverhangAngle] = useState(40)
  const paintOverhangAngleRef = useRef(paintOverhangAngle)
  paintOverhangAngleRef.current = paintOverhangAngle
  // Colour brush: which 1-based project filament new strokes paint with.
  const [paintColorFilamentId, setPaintColorFilamentId] = useState<number | null>(null)
  const paintColorFilamentIdRef = useRef(paintColorFilamentId)
  paintColorFilamentIdRef.current = paintColorFilamentId
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
  const [placementWarnings, setPlacementWarnings] = useState<PlacementWarning[]>([])
  const placementWarningsSetterRef = useRef(setPlacementWarnings)
  // Dismissing the warnings panel hides the CURRENT set of issues (keyed by the same
  // JSON signature the validator dedupes on); any change to the set shows it again.
  const [dismissedWarningsSig, setDismissedWarningsSig] = useState<string | null>(null)
  const placementWarningsSig = useMemo(() => JSON.stringify(placementWarnings), [placementWarnings])
  const placementWarningsVisible = placementWarnings.length > 0 && placementWarningsSig !== dismissedWarningsSig
  const lastWarningSigRef = useRef('')
  // Cached XY footprint cell-sets per instance, keyed by transform signature so
  // collision checks only re-rasterize objects that actually moved.
  const footprintCacheRef = useRef<Map<string, { sig: string; cells: Set<number> }>>(new Map())
  const [importing, setImporting] = useState(false)
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
  // When set, the next picked library file / uploaded local file replaces this instance's
  // geometry in place (Replace flow) instead of adding a new model to the plate.
  const [replaceTargetKey, setReplaceTargetKey] = useState<string | null>(null)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
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
  const [editingObject, setEditingObject] = useState<{ id: number; name: string } | null>(null)
  // A normal part of a multi-part object whose per-part process overrides are being edited.
  const [editingPart, setEditingPart] = useState<{ objectId: number; componentObjectId: number; name: string } | null>(null)
  // Modifier part whose per-volume process overrides are being edited (dialog open).
  const [editingPartKey, setEditingPartKey] = useState<string | null>(null)
  const editingObjectOverrides = useMemo(
    () => (editingObject && perObject ? perObject.value[String(editingObject.id)] ?? EMPTY_OBJECT_OVERRIDES : EMPTY_OBJECT_OVERRIDES),
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
  const [saving, setSaving] = useState(false)
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

  // The editable state mutates outside React (gizmo drags write into Three.js
  // groups); a ref keeps the latest pointers available to the render loop and to
  // the Apply handler without re-binding the whole scene on every change.
  const stateRef = useRef<EditorState | null>(null)
  stateRef.current = state

  // ---- Undo/redo history -----------------------------------------------------
  // Snapshots are deep clones because transform edits mutate state in place. A
  // bumped rebuildToken forces the plate to re-render after a restore even when the
  // instance set is unchanged (e.g. undoing a move). Each entry records ONE aspect:
  // a scene edit (`state`) or a material add/remove (`materials`, which lives in the
  // slice controller), so undo reverts exactly the last action of either kind.
  const historyRef = useRef<{ past: EditorHistoryEntry[]; future: EditorHistoryEntry[] }>({ past: [], future: [] })
  // True once the user makes an undoable edit; cleared on save. Drives the close warning.
  const dirtyRef = useRef(false)
  // Reactive mirror of dirtyRef so the Save button can stay greyed until there are
  // unsaved edits (a ref alone does not trigger a re-render).
  const [dirty, setDirty] = useState(false)
  const markDirty = useCallback(() => {
    dirtyRef.current = true
    setDirty(true)
  }, [])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [rebuildToken, setRebuildToken] = useState(0)

  const refreshHistoryFlags = useCallback(() => {
    setCanUndo(historyRef.current.past.length > 0)
    setCanRedo(historyRef.current.future.length > 0)
  }, [])

  // Warn on page refresh / navigation away while there are unsaved edits (the in-app
  // close already warns via handleCloseRequest; this covers the browser-level exit).
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Material edits live in the slice controller; refs keep undo/redo reading the latest
  // snapshot/restore without re-creating those callbacks on every controller render.
  const materialsSnapshotRef = useRef(sliceConfig?.materialsSnapshot)
  materialsSnapshotRef.current = sliceConfig?.materialsSnapshot
  const restoreMaterialsRef = useRef(sliceConfig?.restoreMaterials)
  restoreMaterialsRef.current = sliceConfig?.restoreMaterials
  // Latest controller, so the save handlers read the current machine selection (retarget
  // target / slicer version) without a stale closure or being re-created every render.
  const sliceConfigRef = useRef(sliceConfig)
  sliceConfigRef.current = sliceConfig
  // The "Choose material" picker Modal is rendered by the host slice dialog (which stays mounted
  // behind the editor), so a pick there calls the controller's raw `handleMaterialOptionChange` and
  // bypasses the markDirty-wrapped copy below. Register `markDirty` as the controller's material-edit
  // listener so those picks still light the Save button.
  useEffect(() => {
    const ref = sliceConfig?.materialEditListenerRef
    if (!ref) return
    ref.current = markDirty
    return () => { ref.current = null }
  }, [sliceConfig, markDirty])
  // A pending cross-model retarget (selected machine differs from the project's source) is
  // itself unsaved work, so it enables Save. Derived, not a marked flag: once saved, the
  // project's source model matches the target and `retargetTarget` clears on its own — the
  // button greys again with no post-save re-lighting.
  const hasUnsavedChanges = dirty || sliceConfig?.retargetTarget != null

  /** Snapshot the current scene before a scene mutation begins. */
  const recordHistory = useCallback(() => {
    const current = stateRef.current
    if (!current) return
    markDirty()
    historyRef.current.past.push({ state: cloneEditorState(current), materials: null })
    if (historyRef.current.past.length > HISTORY_LIMIT) historyRef.current.past.shift()
    historyRef.current.future = []
    refreshHistoryFlags()
  }, [markDirty, refreshHistoryFlags])
  const recordHistoryRef = useRef(recordHistory)
  recordHistoryRef.current = recordHistory

  /** Snapshot the current material set before a material add/remove begins. */
  const recordMaterialsHistory = useCallback(() => {
    const snapshot = materialsSnapshotRef.current
    if (!snapshot) return
    markDirty()
    historyRef.current.past.push({ state: null, materials: snapshot })
    if (historyRef.current.past.length > HISTORY_LIMIT) historyRef.current.past.shift()
    historyRef.current.future = []
    refreshHistoryFlags()
  }, [markDirty, refreshHistoryFlags])

  const restoreHistoryState = useCallback((target: EditorState) => {
    const restored = cloneEditorState(target)
    setSelectedKey((current) => (current && restored.plates.some((plate) => plate.instances.some((instance) => instance.key === current)) ? current : null))
    setActivePlateIndex((index) => (restored.plates.some((plate) => plate.index === index) ? index : (restored.plates[0]?.index ?? 1)))
    setState(restored)
    setRebuildToken((token) => token + 1)
  }, [])

  // Apply one history entry, returning the inverse entry to push onto the other stack.
  const applyHistoryEntry = useCallback((entry: EditorHistoryEntry): EditorHistoryEntry => {
    const inverse: EditorHistoryEntry = { state: null, materials: null }
    if (entry.state) {
      const current = stateRef.current
      inverse.state = current ? cloneEditorState(current) : null
      restoreHistoryState(entry.state)
    }
    if (entry.materials) {
      inverse.materials = materialsSnapshotRef.current ?? null
      restoreMaterialsRef.current?.(entry.materials)
    }
    return inverse
  }, [restoreHistoryState])

  const undo = useCallback(() => {
    const entry = historyRef.current.past.pop()
    if (!entry) return
    historyRef.current.future.push(applyHistoryEntry(entry))
    refreshHistoryFlags()
  }, [applyHistoryEntry, refreshHistoryFlags])

  const redo = useCallback(() => {
    const entry = historyRef.current.future.pop()
    if (!entry) return
    historyRef.current.past.push(applyHistoryEntry(entry))
    refreshHistoryFlags()
  }, [applyHistoryEntry, refreshHistoryFlags])
  const undoRef = useRef(undo)
  undoRef.current = undo
  const redoRef = useRef(redo)
  redoRef.current = redo
  const recordMaterialsHistoryRef = useRef(recordMaterialsHistory)
  recordMaterialsHistoryRef.current = recordMaterialsHistory

  // The settings panel calls the controller's material add/remove directly; wrap them so
  // each records an undo checkpoint first (routing material edits through the same
  // undo/redo as scene edits — Ctrl+Z / the toolbar buttons).
  const sliceConfigForPanel = useMemo<SliceSettingsController | undefined>(() => {
    if (!sliceConfig) return undefined
    return {
      ...sliceConfig,
      onAddFilament: () => { recordMaterialsHistory(); sliceConfig.onAddFilament() },
      // BambuStudio parity: a material assigned to any object can't be removed — reassign first.
      filamentInUse: (projectFilamentId: number) => usedFilamentIds.has(projectFilamentId),
      onRemoveFilament: (projectFilamentId: number) => {
        if (usedFilamentIds.has(projectFilamentId)) {
          toast.error('This material is used by one or more objects. Reassign them to another material before removing it.')
          return
        }
        recordMaterialsHistory()
        sliceConfig.onRemoveFilament(projectFilamentId)
      },
      // Material profile/colour/nozzle edits feed `desiredFilaments` into the saved 3MF, so
      // they count as unsaved changes (they don't snapshot for undo like add/remove — the
      // controller owns that — they only need to flip the dirty flag for the Save button).
      handleMaterialOptionChange: (projectFilamentId, option) => { markDirty(); sliceConfig.handleMaterialOptionChange(projectFilamentId, option) },
      setFilamentColors: (value) => { markDirty(); sliceConfig.setFilamentColors(value) },
      setFilamentToolheadIds: (value) => { markDirty(); sliceConfig.setFilamentToolheadIds(value) }
    }
  }, [sliceConfig, recordMaterialsHistory, markDirty, usedFilamentIds])

  const platesQuery = useQuery({
    queryKey: ['library-editor-plates', baseFileId, baseVersionId ?? 'current'],
    enabled: !hasNoBaseFile,
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBase}/plates`, { signal }),
    staleTime: 60_000
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
      await Promise.all(
        restPlateIndices.map(async (plateIndex) => {
          scenes.set(plateIndex, await fetchPlateScene(plateIndex, signal))
        })
      )
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
  /** Replace the whole selection with one key (plain click semantics). */
  const selectExclusive = useCallback((key: string | null) => {
    setSelectedKey(key)
    setExtraSelectedKeys((current) => (current.length > 0 ? [] : current))
  }, [])
  const selectExclusiveRef = useRef(selectExclusive)
  selectExclusiveRef.current = selectExclusive
  /** Ctrl/Cmd-click semantics: toggle a key in/out of the selection. */
  const toggleAdditiveSelection = useCallback((key: string) => {
    const primary = selectedKeyRef.current
    const extras = extraSelectedKeysRef.current
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

  // Right-click context menu (anchored at the cursor on the instance under it).
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; key: string } | null>(null)
  const openContextMenuRef = useRef<(menu: { x: number; y: number; key: string } | null) => void>(() => {})
  openContextMenuRef.current = (menu) => {
    if (menu) setSelectedKey(menu.key)
    setContextMenu(menu)
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
    if (existing) return existing
    const promise = (async () => {
      // Stall-guarded read: a wedged transport that commits a response then hangs mid-body
      // must fail loudly (so the viewport shows an error/retry) rather than freeze the build.
      const xmlText = await fetchModelText(
        buildApiUrl(`${resourceBase}/scene-entry?path=${encodeURIComponent(entryPath)}`),
        { credentials: 'include' }
      )
      return parseThreeMfModelEntry(xmlText)
    })()
    cache.set(entryPath, promise)
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
    if (existing) return existing
    const promise = (async () => {
      const buffer = await fetchImportMesh(importId, partIndex)
      return parseStlGeometry(buffer)
    })()
    cache.set(cacheKey, promise)
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
      const meshFilamentId = resolveColorFilamentId(instance.filamentId)
      const meshColor = (meshFilamentId != null && filamentColors?.[meshFilamentId]) || instance.color
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
            const partFilamentId = resolveColorFilamentId(part.filamentId)
            const partColor = (partFilamentId != null && filamentColors?.[partFilamentId]) || part.color || meshColor
            const partGroup = createThreeMfPartObject(geometry, { color: partColor, clearanceTransform: placement })
            const partMesh = partGroup.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true)
            if (partMesh) applyFilamentChangeBands(partMesh.material as THREE.Material, filamentChangeUniformsRef.current)
            rotor.add(partGroup)
          }
        } else {
          // Single mesh from the staged binary STL, no per-part transform.
          const geometry = await fetchImportGeometry(importId)
          const importGroup = createThreeMfPartObject(geometry, { color: meshColor, clearanceTransform: placement })
          const importMesh = importGroup.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true)
          if (importMesh) applyFilamentChangeBands(importMesh.material as THREE.Material, filamentChangeUniformsRef.current)
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
          const partFilamentId = resolveColorFilamentId(part.filamentId)
          const partColor = (partFilamentId != null && filamentColors?.[partFilamentId]) || part.color || meshColor
          const partGroup = createThreeMfPartObject(geometry, {
            color: partColor,
            transform: partTransform,
            clearanceTransform: placement.clone().multiply(partTransform),
            subtype: part.subtype
          })
          // Printed parts (not blocker/enforcer/modifier volumes) are paintable with the
          // support/seam brushes; tag the mesh and show any existing paint as overlays.
          // Bambu marks ordinary parts subtype="normal_part", so test via the predicate.
          if (!isModifierVolumeSubtype(part.subtype)) {
            const paintableMesh = partGroup.children.find(
              (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true
            )
            if (paintableMesh) {
              applyFilamentChangeBands(paintableMesh.material as THREE.Material, filamentChangeUniformsRef.current)
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
    [colorPaintStateColor, fetchGeometry, fetchImportGeometry, filamentColors, resolveColorFilamentId]
  )

  // ---- Triangle painting (support + seam brushes) -------------------------------

  // The active paint channel, derived from the tool mode; read via ref in handlers.
  const activePaintChannel = paintChannelForGizmoMode(gizmoMode)
  const activePaintChannelRef = useRef(activePaintChannel)
  activePaintChannelRef.current = activePaintChannel
  // The tool actually in effect for the active channel (channels without the selected
  // tool fall back to the circle brush; the shared selection is kept for when the user
  // returns to a channel that has it).
  const activePaintTool = activePaintChannel ? effectivePaintTool(activePaintChannel, paintTool) : paintTool

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

  /** Effective paint for a tagged mesh: this session's override, else the source mesh's. */
  const effectivePaintCodes = useCallback((mesh: THREE.Mesh, channel: TrianglePaintChannel): SupportPaintCodes | null => {
    const partRef = mesh.userData.supportPaintPart as { objectId: number; componentObjectId: number } | undefined
    if (!partRef) return null
    const override = stateRef.current?.[PAINT_CHANNEL_SPECS[channel].stateKey]?.[supportPaintKey(partRef.objectId, partRef.componentObjectId)]
    if (override) return Object.keys(override).length > 0 ? override : null
    return getGeometryTrianglePaint(mesh.geometry as THREE.BufferGeometry, channel)
  }, [])

  /** Replace a tagged mesh's painted-triangle overlay for one channel. */
  const setMeshPaintOverlay = useCallback((mesh: THREE.Mesh, channel: TrianglePaintChannel, codes: SupportPaintCodes | null) => {
    const spec = PAINT_CHANNEL_SPECS[channel]
    for (const child of mesh.children.filter((entry) => entry.name === spec.overlayName)) {
      mesh.remove(child)
      disposeObject3D(child)
    }
    if (!codes || Object.keys(codes).length === 0) return
    const overlay = buildTrianglePaintOverlay(mesh.geometry as THREE.BufferGeometry, codes, {
      palette: spec.palette,
      name: spec.overlayName,
      offsetFactor: spec.offsetFactor,
      ...(channel === 'color' ? { colorForState: colorPaintStateColor } : {})
    })
    if (overlay) mesh.add(overlay)
  }, [colorPaintStateColor])

  /** Rebuild both channels' paint overlays for one instance group (or every group). */
  const refreshPaintOverlays = useCallback((root?: THREE.Object3D) => {
    const targets = root ? [root] : [...groupByKeyRef.current.values()]
    for (const target of targets) {
      const meshes: THREE.Mesh[] = []
      target.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh && mesh.userData.supportPaintPart) meshes.push(mesh)
      })
      for (const mesh of meshes) {
        for (const channel of ['supports', 'seam', 'color'] as const) {
          setMeshPaintOverlay(mesh, channel, effectivePaintCodes(mesh, channel))
        }
      }
    }
  }, [effectivePaintCodes, setMeshPaintOverlay])
  const refreshPaintOverlaysRef = useRef(refreshPaintOverlays)
  refreshPaintOverlaysRef.current = refreshPaintOverlays

  /**
   * Apply one dab of the ACTIVE channel's selected tool at a world-space hit on a
   * tagged mesh. Mutates the session's paint map in place (history is recorded once
   * per stroke by the pointer handler, matching the gizmo write-back idiom) and
   * refreshes only the touched meshes' overlays. `faceIndex` is the hit triangle
   * (the brush growth/fill seed); `phase` distinguishes the initial click from drag
   * continuation (the height band is placed by the click only).
   */
  const applyPaintStroke = useCallback((
    mesh: THREE.Mesh,
    worldPoint: THREE.Vector3,
    worldDirection: THREE.Vector3,
    faceIndex: number | null,
    phase: 'down' | 'move'
  ) => {
    const state = stateRef.current
    const channel = activePaintChannelRef.current
    if (!state || !channel) return
    const tool = effectivePaintTool(channel, paintToolRef.current)
    if (tool === 'height' && phase !== 'down') return

    const mode = paintBrushModeRef.current
    let paintState: number
    if (mode === 'eraser') paintState = 0
    else if (channel === 'color') {
      const filamentId = paintColorFilamentIdRef.current
      if (filamentId == null || filamentId < 1 || filamentId > 15) return
      paintState = filamentId
    } else paintState = mode === 'enforcer' ? 1 : 2

    const paintMesh = (target: THREE.Mesh, targetFaceIndex: number | null): void => {
      const partRef = target.userData.supportPaintPart as { objectId: number; componentObjectId: number } | undefined
      if (!partRef) return
      const geometry = target.geometry as THREE.BufferGeometry
      const scan = getTriangleScanData(geometry)
      if (!scan) return
      const stateKey = PAINT_CHANNEL_SPECS[channel].stateKey
      const key = supportPaintKey(partRef.objectId, partRef.componentObjectId)
      let channelPaint = state[stateKey]
      if (!channelPaint) {
        channelPaint = {}
        state[stateKey] = channelPaint
      }
      let codes = channelPaint[key]
      if (!codes) {
        // First stroke on this part: seed from the source mesh's existing paint so
        // erasing/overpainting starts from what the file already had.
        codes = { ...(getGeometryTrianglePaint(geometry, channel) ?? {}) }
        channelPaint[key] = codes
      }
      target.updateWorldMatrix(true, false)
      const inverse = new THREE.Matrix4().copy(target.matrixWorld).invert()
      const localPoint = worldPoint.clone().applyMatrix4(inverse)
      const localDirection = worldDirection.clone().transformDirection(inverse).normalize()
      // Brush radius is in world mm; approximate the local radius with the mesh's
      // average world axis scale (per-axis scale would need an ellipsoid test).
      const scaleX = new THREE.Vector3().setFromMatrixColumn(target.matrixWorld, 0).length()
      const scaleY = new THREE.Vector3().setFromMatrixColumn(target.matrixWorld, 1).length()
      const scaleZ = new THREE.Vector3().setFromMatrixColumn(target.matrixWorld, 2).length()
      const averageScale = (scaleX + scaleY + scaleZ) / 3 || 1
      // "On overhangs only" (support painting): faces steeper than the threshold,
      // judged on WORLD normals (Bambu's highlight_by_angle gate).
      let triangleAllowed: ((index: number) => boolean) | undefined
      if (channel === 'supports' && paintOnOverhangsRef.current) {
        const e = new THREE.Matrix3().getNormalMatrix(target.matrixWorld).elements
        const limit = -Math.cos((paintOverhangAngleRef.current * Math.PI) / 180)
        triangleAllowed = (i) => {
          const nx = scan.normals[i * 3]!
          const ny = scan.normals[i * 3 + 1]!
          const nz = scan.normals[i * 3 + 2]!
          const wx = e[0]! * nx + e[3]! * ny + e[6]! * nz
          const wy = e[1]! * nx + e[4]! * ny + e[7]! * nz
          const wz = e[2]! * nx + e[5]! * ny + e[8]! * nz
          const length = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1
          return wz / length < limit
        }
      }
      let changed = false
      if (tool === 'fill') {
        if (targetFaceIndex == null) return
        changed = applySmartFill({
          codes,
          scan,
          seedTriangle: targetFaceIndex,
          angleDeg: paintSmartAngleRef.current,
          state: paintState,
          ...(triangleAllowed ? { triangleAllowed } : {})
        })
      } else if (tool === 'bucket') {
        if (targetFaceIndex == null) return
        changed = applyBucketFill({ codes, scan, seedTriangle: targetFaceIndex, state: paintState })
      } else if (tool === 'triangle') {
        if (targetFaceIndex == null) return
        changed = applySingleTrianglePaint({ codes, seedTriangle: targetFaceIndex, state: paintState })
      } else if (tool === 'height') {
        changed = applyHeightRangePaint({
          codes,
          scan,
          zBottom: worldPoint.z,
          zTop: worldPoint.z + paintHeightRangeRef.current,
          state: paintState,
          localToWorld: target.matrixWorld,
          averageScale
        })
      } else {
        changed = applySupportPaintBrush({
          codes,
          scan,
          point: localPoint,
          direction: localDirection,
          radius: paintBrushRadiusRef.current / averageScale,
          mode,
          shape: tool,
          ...(paintState > 0 ? { state: paintState } : {}),
          ...(targetFaceIndex != null ? { seedTriangle: targetFaceIndex } : {}),
          ...(triangleAllowed ? { triangleAllowed } : {}),
          ...(channel === 'color' && paintEdgeDetectionRef.current
            ? { propagationAngleDeg: paintSmartAngleRef.current }
            : {})
        })
      }
      if (changed) setMeshPaintOverlay(target, channel, Object.keys(codes).length > 0 ? codes : null)
    }

    if (tool === 'height') {
      // The band wraps the whole object: paint every printed part of the selected
      // instance, not just the part under the pointer (Bambu applies it per object).
      const group = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
      const meshes: THREE.Mesh[] = []
      ;(group ?? mesh).traverse((node) => {
        const candidate = node as THREE.Mesh
        if (candidate.isMesh && candidate.userData.supportPaintPart) meshes.push(candidate)
      })
      for (const target of meshes.length > 0 ? meshes : [mesh]) paintMesh(target, null)
      return
    }
    paintMesh(mesh, faceIndex)
  }, [setMeshPaintOverlay])
  const applyPaintStrokeRef = useRef(applyPaintStroke)
  applyPaintStrokeRef.current = applyPaintStroke

  /** Remove the ACTIVE channel's paint from the selected object's printed parts. */
  const clearSelectedPaint = useCallback(() => {
    const state = stateRef.current
    const channel = activePaintChannelRef.current
    const instance = activePlateRef.current?.instances.find((entry) => entry.key === selectedKeyRef.current)
    if (!state || !channel || !instance || instance.source.kind !== 'object') return
    recordHistoryRef.current?.()
    const stateKey = PAINT_CHANNEL_SPECS[channel].stateKey
    const channelPaint = state[stateKey] ?? (state[stateKey] = {})
    for (const part of instance.parts) {
      if (isModifierVolumeSubtype(part.subtype)) continue
      // An empty map means "no paint" — emitted so existing source paint is stripped.
      channelPaint[supportPaintKey(instance.objectId, part.componentObjectId)] = {}
    }
    const group = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
    if (group) refreshPaintOverlays(group)
    regenerateActiveThumbnailRef.current?.()
  }, [refreshPaintOverlays])

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
  }, [refreshBrimEarMarkers])
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
  }, [state, filamentColors])

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
    renderer.setPixelRatio(window.devicePixelRatio || 1)
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)

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
        selectionBoxValue.copy(printableMeshBox(group))
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
    const throttledPanelSync = (group: THREE.Object3D) => {
      panelSyncTick += 1
      if (panelSyncTick % PANEL_SYNC_EVERY === 0) syncSelectedTransformRef.current?.(group)
    }

    /** The part mesh the gizmo is attached to, when transforming an added part volume. */
    const attachedPartMesh = (): THREE.Object3D | null => {
      const target = (transform as unknown as { object?: THREE.Object3D }).object
      return target && typeof target.userData.addedPartKey === 'string' ? target : null
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
        if (group) gizmoCoDrag.push({ group, dx: group.position.x - primary.position.x, dy: group.position.y - primary.position.y })
      }
    }

    const onDraggingChanged = (event: TransformControlsEvent) => {
      orbit.enabled = !event.value
      const dragging = Boolean(event.value)
      gizmoDragging = dragging
      interactionActiveRef.current = dragging
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
          writeBackAddedPartRef.current?.(partMesh)
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
        writeBackAddedPartRef.current?.(partMesh)
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
    // Other selected groups co-dragged with the grabbed one (multi-select moves), each
    // with its own bed-plane offset so relative spacing is preserved.
    let bodyDragExtras: Array<{ group: THREE.Group; offsetX: number; offsetY: number }> = []
    // A motionless click on a multi-selection member collapses the selection to it on
    // release; any real drag keeps the multi-selection.
    let collapseClickCandidate: { key: string; x: number; y: number } | null = null
    /** Capture co-drag offsets for every selected group except the grabbed one. */
    const beginSelectionCoDrag = (grabbedKey: string) => {
      bodyDragExtras = allSelectedKeysRef.current()
        .filter((entry) => entry !== grabbedKey)
        .map((entry) => groupByKeyRef.current.get(entry))
        .filter((entry): entry is THREE.Group => Boolean(entry))
        .map((entry) => ({ group: entry, offsetX: entry.position.x - dragPoint.x, offsetY: entry.position.y - dragPoint.y }))
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
        return
      }
      const earMode = gizmoModeRef.current === 'brimEars'
      const mode = paintBrushModeRef.current
      const channel = activePaintChannelRef.current
      // Fill/triangle/height pick faces rather than sweep a radius: no brush ball.
      if (!earMode && channel) {
        const tool = effectivePaintTool(channel, paintToolRef.current)
        if (tool !== 'circle' && tool !== 'sphere') {
          brushCursor.visible = false
          return
        }
      }
      const palette = PAINT_CHANNEL_SPECS[channel ?? 'supports'].palette
      const colorModeHex = channel === 'color'
        ? new THREE.Color(filamentColorsRef.current?.[paintColorFilamentIdRef.current ?? -1] ?? '#9aa4ad').getHex()
        : null
      ;(brushCursor.material as THREE.MeshBasicMaterial).color.setHex(
        earMode
          ? BRIM_EAR_MARKER_COLOR
          : mode === 'eraser'
            ? 0xe8edf4
            : channel === 'color' && colorModeHex != null
              ? colorModeHex
              : mode === 'blocker' ? palette.blocker : palette.enforcer
      )
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
          recordHistoryRef.current?.()
          panelSyncTick = 0
          dragOffset.set(group.position.x - dragPoint.x, group.position.y - dragPoint.y, 0)
          bodyDragGroup = group
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
          recordHistoryRef.current?.()
          panelSyncTick = 0
          dragOffset.set(group.position.x - dragPoint.x, group.position.y - dragPoint.y, 0)
          bodyDragGroup = group
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
          setSelectedAddedPartKey(partKey)
          return
        }
        if (selectedAddedPartKeyRef.current) setSelectedAddedPartKey(null)
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
          const worldNormal = faceHit.face.normal.clone().transformDirection(faceHit.object.matrixWorld).normalize()
          rotorOf(group).quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(worldNormal, DOWN_VECTOR))
          restObjectOnBed(group)
          writeBackGroupTransform(group)
          syncSelectedTransformRef.current?.(group)
          regenerateActiveThumbnailRef.current?.()
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
          recordHistoryRef.current?.()
          panelSyncTick = 0
          dragOffset.set(group.position.x - dragPoint.x, group.position.y - dragPoint.y, 0)
          bodyDragGroup = group
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
      } else if (brushCursor.visible) {
        brushCursor.visible = false
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
    const animate = () => {
      orbit.update()
      // Any active drag (gizmo, object body, or purge tower). Drives both the cheaper
      // selection-box bounds below and the deferred placement-warning recompute further down.
      const interacting = gizmoDragging || bodyDragGroup !== null || towerDragObject !== null
      const dragJustEnded = wasInteracting && !interacting
      wasInteracting = interacting
      // Track the selected object's mesh bounds (Box3Helper fits itself to the box value in its
      // own updateMatrixWorld during render). The PRECISE walk (per-vertex) is the priciest
      // per-frame work for high-poly models, so: only recompute when the object actually moved
      // (idle selections / camera orbits skip it), and while dragging use the cheap transformed-
      // AABB path so high-poly drags stay smooth — then restore the precise box on the drop frame.
      if (selectionBox && selectionTarget) {
        const sig = selectionBoxSignature(selectionTarget)
        if (sig !== selectionBoxSig || dragJustEnded) {
          selectionBoxSig = sig
          selectionBoxValue.copy(printableMeshBox(selectionTarget, !interacting))
        }
      }
      // Keep ear markers flat on the bed through rotations/scales (their matrices bake
      // the world transform, so they must re-bake whenever the instance moves). Only
      // the few groups that actually carry markers pay anything here.
      for (const group of groupByKeyRef.current.values()) syncBrimEarMarkerMatrices(group)
      syncExtraSelectionBoxes()
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
      if (!interacting && (dragJustEnded || validationFrame % 15 === 0)) {
        const plate = activePlateRef.current
        let warnings: PlacementWarning[] = []
        if (plate) {
          const footprints = new Map<string, Set<number>>()
          for (const instance of plate.instances) {
            const group = groupByKeyRef.current.get(instance.key)
            if (!group || !isInstancePrintedRef.current(instance)) continue
            const sig = groupTransformSignature(group)
            const cached = footprintCacheRef.current.get(instance.key)
            const cells = cached && cached.sig === sig ? cached.cells : computeFootprintCells(group)
            footprintCacheRef.current.set(instance.key, { sig, cells })
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
      frame = requestAnimationFrame(animate)
    }
    animate()

    const onResize = () => {
      const w = Math.max(container.clientWidth, 1)
      const h = Math.max(container.clientHeight, 1)
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
      disposeObject3D(plateRoot)
      scene.remove(plateRoot)
      scene.remove(transform as unknown as THREE.Object3D)
      renderer.dispose()
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
  }, [viewerContainer, viewCubeContainer])

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

    // Build the new plate's contents in a DETACHED staging group, then swap it onto the live
    // plateRoot atomically once complete. Keeping the visible plate intact until the
    // replacement is ready lets us yield between objects — so the progress overlay actually
    // animates and the UI stays responsive — without the half-built flicker that clearing
    // plateRoot up front caused when a rebuild was superseded mid-flight (slice-config/filament
    // settling on open, a rapid plate switch). A superseded build just discards its staged
    // group; the visible plate is never touched.
    void (async () => {
      const staging = new THREE.Group()
      const bedSurface = createPreviewPlateSurface({ width: bedWidth, depth: bedDepth, centerX: bedCenterX, centerY: bedCenterY, excludeAreas: activePlate.bed.excludeAreas })
      // Tagged so the thumbnail renderer hides it (Bambu-style model-only thumbnails).
      bedSurface.userData.isBedSurface = true
      staging.add(bedSurface)
      const stagedGroups = new Map<string, THREE.Group>()
      let stagedTower: THREE.Object3D | null = null

      // Paint once before the (potentially heavy) geometry work so the loading overlay shows
      // immediately rather than after the first object's synchronous build.
      await nextPaint()
      if (cancelled) { disposeObject3D(staging); return }

      // Warm the geometry caches for EVERYTHING on the plate up front: the instance loop below
      // stays sequential (deterministic scene order, per-object bed rest), but all entry/import
      // downloads now run concurrently instead of one round-trip at a time — the dominant cost
      // for bridge-owned files with many parts.
      for (const instance of activePlate.instances) {
        if (instance.source.kind === 'import') {
          const importId = instance.source.importId
          if (instance.parts.length > 1) {
            instance.parts.forEach((_part, index) => fetchImportGeometry(importId, index).catch(() => {}))
          } else {
            fetchImportGeometry(importId).catch(() => {})
          }
        } else {
          for (const part of instance.parts) fetchGeometry(part.entryPath).catch(() => {})
        }
      }
      const instances = activePlate.instances
      // Drive the overlay's "Loading models… (done/total)" readout. Start at 0 so the count is
      // visible immediately while geometry warms; each built instance bumps it.
      setBuildProgress(instances.length > 0 ? { done: 0, total: instances.length } : null)
      let lastPaintAt = performance.now()
      for (let instanceIndex = 0; instanceIndex < instances.length; instanceIndex += 1) {
        const instance = instances[instanceIndex]!
        try {
          const group = await buildInstanceGroup(instance)
          if (cancelled) {
            if (group) disposeObject3D(group)
            disposeObject3D(staging)
            return
          }
          setBuildProgress({ done: instanceIndex + 1, total: instances.length })
          if (group) {
            // Rest every object on the bed as it's built and persist the corrected z into
            // state (in place, like writeBack — no re-render). Objects must sit on the bed for
            // slicing, and this guarantees nothing is ever displayed floating/sunk — so a later
            // move/scale never "snaps" it to the bed (the long-standing jump bug).
            restObjectOnBed(group)
            instance.position.z = group.position.z
            setObjectPrintedStyle(group, isInstancePrintedRef.current(instance))
            staging.add(group)
            stagedGroups.set(instance.key, group)
          }
        } catch (error) {
          if (cancelled || abort.signal.aborted) { disposeObject3D(staging); return }
          setViewerError(error instanceof Error ? error.message : 'Unable to load model geometry.')
        }
        // Yield so the progress overlay paints and input stays responsive while a multi-object
        // plate builds. Throttled to ~frame cadence so a quick plate isn't slowed by needless
        // waits; the staged group is off-screen, so this never reveals a half-built scene.
        if (instanceIndex < instances.length - 1 && performance.now() - lastPaintAt > 24) {
          await nextPaint()
          if (cancelled) { disposeObject3D(staging); return }
          lastPaintAt = performance.now()
        }
      }
      if (cancelled) { disposeObject3D(staging); return }
      // Now that the plate's models are present, size the prime tower to the print height (its
      // depth depends on height) and place it on the bed — but only when the plate actually
      // prints more than one filament, since that's the only time a purge/prime tower is
      // generated. Use the plate's authoritative filament list (a single object can be
      // multi-filament via its parts, so counting distinct per-instance filaments under-counts).
      if (activePlate.primeTower && activePlateFilamentCountRef.current >= 2) {
        const bounds = new THREE.Box3()
        let printHeight = 0
        for (const group of stagedGroups.values()) {
          bounds.setFromObject(group)
          if (!bounds.isEmpty()) printHeight = Math.max(printHeight, bounds.max.z)
        }
        stagedTower = createPrimeTowerObject(activePlate.primeTower, activePlateFilamentCountRef.current, printHeight || 30)
        staging.add(stagedTower)
      }

      // ---- Atomic swap: replace the visible plate with the freshly built one in one frame. ----
      transformRef.current?.detach()
      disposeObject3D(plateRoot)
      plateRoot.clear()
      while (staging.children.length > 0) plateRoot.add(staging.children[0]!)
      groupByKeyRef.current.clear()
      for (const [key, group] of stagedGroups) groupByKeyRef.current.set(key, group)
      primeTowerObjRef.current = stagedTower
      // Re-attach the gizmo to the selected instance if it is on this plate.
      reattachGizmo()
      // All of this plate's models are now in the scene.
      setBuildProgress(null)
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
      hull.geometry.dispose()
      ;(hull.material as THREE.Material).dispose()
      if (faceHullRef.current === hull) faceHullRef.current = null
    }
  }, [gizmoMode, selectedKey, rebuildToken])

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

  /** Build a non-active plate's contents offscreen and snapshot it. */
  const regeneratePlateThumbnail = useCallback(
    async (plate: EditorPlate, signal: AbortSignal) => {
      const group = new THREE.Group()
      try {
        for (const instance of plate.instances) {
          // Background work: take an idle slot before each (synchronous, potentially
          // heavy) geometry build, and keep deferring while the user is orbiting or
          // dragging the gizmo so the visible plate's interactions stay smooth.
          do {
            await nextIdle()
          } while (!signal.aborted && interactionActiveRef.current)
          if (signal.aborted) {
            disposeObject3D(group)
            return
          }
          const built = await buildInstanceGroup(instance)
          if (signal.aborted) {
            if (built) disposeObject3D(built)
            disposeObject3D(group)
            return
          }
          if (built) group.add(built)
        }
        // Model-only group (no bed surface) → a clean, Bambu-style thumbnail.
        const url = getThumbnailRenderer().render(group, plate.bed)
        if (!signal.aborted) {
          setPlateThumbnails((current) => ({ ...current, [plate.index]: url }))
        }
      } catch {
        // Best-effort; ignore.
      } finally {
        disposeObject3D(group)
      }
    },
    [buildInstanceGroup, getThumbnailRenderer]
  )

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
        const group = new THREE.Group()
        try {
          for (const instance of plate.instances) {
            const built = await buildInstanceGroup(instance)
            if (built) group.add(built)
          }
          const url = renderer.render(group, plate.bed)
          setPlateThumbnails((existing) => ({ ...existing, [plate.index]: url }))
          const png = url.replace(/^data:image\/png;base64,/, '')
          if (plate.index > 0 && png.length > 0) out.push({ plateIndex: plate.index, png })
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

  // Regenerate thumbnails for every non-active plate whenever the plate set or any
  // plate's instances change. The active plate is snapshotted by the plate-rebuild
  // effect. Runs on plate-set changes only — never per animation frame, and
  // deliberately NOT on plate switches: rebuilding every other plate's geometry just
  // because the selection moved froze the UI for a beat, and the outgoing plate's
  // thumbnail is already current from its live snapshot. The active index is read
  // through a ref so this effect doesn't refire when it changes.
  const activePlateIndexRef = useRef(activePlateIndex)
  activePlateIndexRef.current = activePlateIndex
  const platesSignature = useMemo(
    () => state?.plates.map((plate) => `${plate.index}:${plate.instances.map((i) => i.key).join('.')}`).join('|') ?? '',
    [state]
  )
  useEffect(() => {
    // Held back while the visible plate is still building so its geometry fetches are
    // never contended by thumbnails of plates the user can't see; the effect refires
    // when the build settles (viewportBuilding flips) and the abort cancels stale runs.
    if (!state || viewportBuilding) return
    const abort = new AbortController()
    void (async () => {
      for (const plate of state.plates) {
        if (plate.index === activePlateIndexRef.current) continue
        // Skip plates whose scene hasn't streamed in yet — rendering their (empty) seed would
        // produce a blank thumbnail and hide the loading spinner. They regenerate once filled
        // (which changes platesSignature and refires this effect).
        if (pendingScenePlatesRef.current.has(plate.index)) continue
        if (abort.signal.aborted) return
        await regeneratePlateThumbnail(plate, abort.signal)
      }
    })()
    return () => abort.abort()
    // `scenesByPlate` is a dep so the effect refires when a plate's scene streams in (the merge
    // effect, which runs first, clears it from pendingScenePlatesRef) — including empty plates,
    // whose instance signature doesn't change but which must still drop their loading spinner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platesSignature, viewportBuilding, regeneratePlateThumbnail, scenesByPlate])

  // ---- State mutations -------------------------------------------------------
  // Shared band-shader uniforms: every part material reads these, so editing the
  // panel recolours the whole plate immediately.
  const filamentChangeUniformsRef = useRef<FilamentChangeBandUniforms>({
    uFcCount: { value: 0 },
    uFcHeights: { value: new Array(FILAMENT_CHANGE_MAX_BANDS).fill(0) },
    uFcColors: { value: Array.from({ length: FILAMENT_CHANGE_MAX_BANDS }, () => new THREE.Color('#9aa4ad')) }
  })
  useEffect(() => {
    const uniforms = filamentChangeUniformsRef.current
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
  }, [activePlate, state, filamentColors, resolveColorFilamentId])

  // Default the colour brush to the second material (painting with the first is a
  // no-op visually) once options are known or when the chosen one disappears.
  useEffect(() => {
    if (paintColorFilamentId != null && filamentOptions.some((option) => option.id === paintColorFilamentId)) return
    setPaintColorFilamentId(filamentOptions[1]?.id ?? filamentOptions[0]?.id ?? null)
  }, [filamentOptions, paintColorFilamentId])

  /** Replace the active plate's layer-based filament changes (history-recorded). */
  const setActivePlateFilamentChanges = useCallback((changes: EditorFilamentChange[]) => {
    updatePlates((plates) => plates.map((plate) => (
      plate.index === activePlateIndex ? { ...plate, filamentChangesOverride: changes } : plate
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

  const handleSelect = useCallback((key: string, additive = false) => {
    if (additive) {
      toggleAdditiveSelection(key)
      return
    }
    if (selectedKeyRef.current === key) selectExclusive(null)
    else selectExclusive(key)
  }, [toggleAdditiveSelection, selectExclusive])

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
  }, [activePlateIndex, refreshAddedPartMeshes])

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
  }, [refreshAddedPartMeshes])

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

  /** Move an instance from the active plate to another plate, placed at a free spot. */
  const handleMoveToPlate = useCallback((key: string, targetIndex: number) => {
    updatePlates((plates) => {
      const source = plates.find((plate) => plate.index === activePlateIndex)
      const instance = source?.instances.find((entry) => entry.key === key)
      const target = plates.find((plate) => plate.index === targetIndex)
      if (!instance || !target) return plates
      const spot = findFreePlatePosition(target)
      const moved: EditorInstance = { ...instance, position: instance.position.clone() }
      moved.position.x = spot.x
      moved.position.y = spot.y
      return plates.map((plate) => {
        if (plate.index === activePlateIndex) return { ...plate, instances: plate.instances.filter((entry) => entry.key !== key) }
        if (plate.index === targetIndex) return { ...plate, instances: [...plate.instances, moved] }
        return plate
      })
    })
    setSelectedKey((current) => (current === key ? null : current))
  }, [activePlateIndex, updatePlates])

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
  }, [mutateSelectedGroup, handleDelete, nudgeSelection])

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

  const handleApply = useCallback(() => {
    const current = stateRef.current
    if (!current || !onApply) return
    void (async () => {
      const thumbnails = await captureAllPlateThumbnails(current)
      onApply(buildSceneEditOut(current, { thumbnails }))
    })()
  }, [onApply, buildSceneEditOut, captureAllPlateThumbnails])

  // Persist the arrangement as a 3MF. Staged imports are already on the server,
  // so the SceneEdit's importId references are all the backend needs to bake them.
  const runSave = useCallback(
    async (payload: SaveArrangedThreeMf, successMessage: string): Promise<{ id: string; name: string } | null> => {
      // BambuStudio parity: a project must have a material before it can be saved.
      if ((sliceConfigRef.current?.projectFilaments?.length ?? 0) === 0) {
        toast.error('Add a material to the project before saving.')
        return null
      }
      setSaving(true)
      try {
        const { file } = await apiFetch<{ file: { id: string; name: string } }>('/api/editor/save', {
          method: 'POST',
          body: payload
        })
        await invalidateLibraryQueries(queryClient)
        dirtyRef.current = false
        setDirty(false)
        toast.success(successMessage)
        onSaved?.(file)
        // Keep the editor open after saving so the user can keep arranging/printing.
        return file
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to save the project.')
        return null
      } finally {
        setSaving(false)
      }
    },
    [onSaved, queryClient]
  )

  // Closing the editor warns first if there are unsaved edits (drags, imports, etc.).
  const handleCloseRequest = useCallback(async () => {
    if (dirtyRef.current) {
      const discard = await confirm({
        title: 'Discard unsaved changes?',
        description: 'This project has changes that have not been saved. Closing now will lose them.',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        color: 'danger'
      })
      if (!discard) return
    }
    onClose()
  }, [confirm, onClose])

  // Per-object PROCESS overrides authored in the editor (keyed by baked object id or a fresh
  // import's synthetic id). Sent with every save so they persist into the saved 3MF rather than
  // only applying to a one-off slice. Prunes overrides for objects that no longer exist, and emits
  // an empty `{}` for a re-hydrated object whose overrides were CLEARED so the save strips the now
  // stale baked overrides (rather than leaving them to resurrect on the next reopen).
  const collectObjectProcessOverrides = useCallback((): Record<string, Record<string, string | string[]>> | undefined => {
    const value = sliceConfigRef.current?.perObjectSettings?.value
    if (!value) return undefined
    // Object identities currently placed: a real objectId, or an import's synthetic id.
    const placed = new Set<number>()
    for (const plate of stateRef.current?.plates ?? []) {
      for (const instance of plate.instances) {
        if (instance.source.kind === 'object') placed.add(instance.objectId)
        else if (instance.source.replacedObjectId != null) placed.add(instance.source.replacedObjectId)
      }
    }
    const out: Record<string, Record<string, string | string[]>> = {}
    for (const [key, overrides] of Object.entries(value)) {
      if (placed.has(Number(key)) && Object.keys(overrides).length > 0) out[key] = overrides
    }
    for (const id of seededProcessOverrideObjectIdsRef.current) {
      const key = String(id)
      if (placed.has(id) && !out[key]) out[key] = {} // re-hydrated then cleared → strip on save
    }
    return Object.keys(out).length > 0 ? out : undefined
  }, [])

  const handleSaveVersion = useCallback(() => {
    const current = stateRef.current
    if (!current || baseFileId === null) return
    void (async () => {
      const thumbnails = await captureAllPlateThumbnails(current)
      const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
      await runSave(
        {
          baseFileId, baseVersionId, mode: 'newVersion', sceneEdit: buildSceneEditOut(current, { thumbnails }),
          objectProcessOverrides: collectObjectProcessOverrides(),
          retarget,
          slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined
        },
        retarget ? `Saved a new version for ${retarget.printerModel}` : 'Saved a new version'
      )
    })()
  }, [baseFileId, runSave, buildSceneEditOut, captureAllPlateThumbnails, collectObjectProcessOverrides])

  const handleSaveAs = useCallback((name: string, destinationFolderId: string | null) => {
    const current = stateRef.current
    if (!current) return
    setSaveAsOpen(false)
    void (async () => {
      const thumbnails = await captureAllPlateThumbnails(current)
      const retarget = sliceConfigRef.current?.retargetTarget ?? undefined
      await runSave(
        {
          baseFileId, baseVersionId, mode: 'saveAs', name, folderId: destinationFolderId, bridgeId: saveAsBridgeId,
          sceneEdit: buildSceneEditOut(current, { thumbnails }),
          objectProcessOverrides: collectObjectProcessOverrides(),
          retarget,
          slicerTargetId: retarget ? sliceConfigRef.current?.selectedSlicerTargetId : undefined
        },
        `Saved “${name}”`
      )
    })()
  }, [baseFileId, saveAsBridgeId, runSave, buildSceneEditOut, captureAllPlateThumbnails, collectObjectProcessOverrides])

  // ---- Render ----------------------------------------------------------------
  const loading = !hasNoBaseFile && (
    platesQuery.isLoading || initialSceneQuery.isLoading || (!state && plateIndices.length > 0)
  )
  // Disable scene-manipulation controls until the plate has finished (re)building — acting on a
  // half-loaded scene (e.g. auto-arrange before the models are in) is undefined.
  const controlsBusy = loading || viewportBuilding || !sceneReady
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
                {viewportBuilding && (
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
                        <CircularProgress
                          size="md"
                          determinate
                          value={Math.round((buildProgress.done / buildProgress.total) * 100)}
                        />
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
                  <Sheet
                    variant="soft"
                    sx={{
                      position: 'absolute', top: TOOL_PANEL_TOP, left: 8, zIndex: (theme) => theme.zIndex.tooltip,
                      p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
                      width: 'min(260px, calc(100% - 16px))',
                      display: 'flex', flexDirection: 'column', gap: 0.75
                    }}
                  >
                    <Typography level="title-sm">Cut plane</Typography>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <ButtonGroup size="sm" variant="soft" aria-label="Cut plane axis">
                        {(['x', 'y', 'z'] as const).map((axis) => (
                          <Button
                            key={axis}
                            variant={cutAxis === axis ? 'solid' : 'soft'}
                            color={cutAxis === axis ? 'primary' : 'neutral'}
                            onClick={() => setCutAxis(axis)}
                          >
                            {axis.toUpperCase()}
                          </Button>
                        ))}
                      </ButtonGroup>
                      <Input
                        size="sm"
                        type="number"
                        value={Math.round(cutOffset * 100) / 100}
                        onChange={(event) => {
                          const next = Number.parseFloat(event.target.value)
                          if (Number.isFinite(next)) setCutOffset(next)
                        }}
                        endDecorator="mm"
                        slotProps={{ input: { step: 0.1, min: Math.round(cutRange.min * 10) / 10, max: Math.round(cutRange.max * 10) / 10, 'aria-label': 'Cut plane position' } }}
                        sx={{ flex: 1, minWidth: 0 }}
                      />
                    </Stack>
                    <Slider
                      size="sm"
                      min={Math.round(cutRange.min * 10) / 10}
                      max={Math.round(cutRange.max * 10) / 10}
                      step={0.1}
                      value={clampedCutOffset}
                      onChange={(_event, value) => setCutOffset(value as number)}
                      aria-label="Cut plane position"
                    />
                    <Stack direction="row" spacing={1.5}>
                      <Checkbox
                        size="sm"
                        label={`Keep ${CUT_AXIS_SIDES[cutAxis].lower}`}
                        checked={cutKeepLower}
                        onChange={(event) => setCutKeepLower(event.target.checked)}
                      />
                      <Checkbox
                        size="sm"
                        label={`Keep ${CUT_AXIS_SIDES[cutAxis].upper}`}
                        checked={cutKeepUpper}
                        onChange={(event) => setCutKeepUpper(event.target.checked)}
                      />
                    </Stack>
                    <Stack direction="row" spacing={0.75} justifyContent="flex-end">
                      <Button size="sm" variant="plain" color="neutral" disabled={cutting} onClick={() => setGizmoMode('translate')}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        startDecorator={<ContentCutRoundedIcon />}
                        loading={cutting}
                        disabled={!cutKeepLower && !cutKeepUpper}
                        onClick={handlePerformCut}
                      >
                        Cut
                      </Button>
                    </Stack>
                  </Sheet>
                )}
                {gizmoMode === 'measure' && (
                  <Sheet
                    variant="soft"
                    sx={{
                      position: 'absolute', top: TOOL_PANEL_TOP, left: 8, zIndex: (theme) => theme.zIndex.tooltip,
                      p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
                      width: 'min(240px, calc(100% - 16px))',
                      display: 'flex', flexDirection: 'column', gap: 0.75
                    }}
                  >
                    <Typography level="title-sm">Measure</Typography>
                    {measureDelta ? (
                      <Stack spacing={0.25}>
                        <Stack direction="row" justifyContent="space-between">
                          <Typography level="body-sm" textColor="text.tertiary">Distance</Typography>
                          <Typography level="body-sm" fontWeight="lg">{measureDelta.distance.toFixed(2)} mm</Typography>
                        </Stack>
                        {([['X', measureDelta.dx], ['Y', measureDelta.dy], ['Z', measureDelta.dz]] as const).map(([axis, value]) => (
                          <Stack key={axis} direction="row" justifyContent="space-between">
                            <Typography level="body-xs" textColor="text.tertiary">Δ{axis}</Typography>
                            <Typography level="body-xs">{Math.abs(value).toFixed(2)} mm</Typography>
                          </Stack>
                        ))}
                      </Stack>
                    ) : (
                      <Typography level="body-xs" textColor="text.tertiary">
                        {measurePoints.length === 0
                          ? 'Click two points on models or the bed. Clicks snap to nearby corners; drag to orbit.'
                          : 'Click a second point to measure.'}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={0.75} justifyContent="flex-end">
                      <Button
                        size="sm"
                        variant="plain"
                        color="neutral"
                        disabled={measurePoints.length === 0}
                        onClick={() => setMeasurePoints([])}
                      >
                        Clear
                      </Button>
                      <Button size="sm" variant="soft" color="neutral" onClick={() => setGizmoMode('translate')}>
                        Done
                      </Button>
                    </Stack>
                  </Sheet>
                )}
                {activePaintChannel !== null && selectedKey && (
                  <Sheet
                    variant="soft"
                    sx={{
                      position: 'absolute', top: TOOL_PANEL_TOP, left: 8, zIndex: (theme) => theme.zIndex.tooltip,
                      p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
                      width: 'min(280px, calc(100% - 16px))',
                      display: 'flex', flexDirection: 'column', gap: 0.75
                    }}
                  >
                    <Typography level="title-sm">
                      {activePaintChannel === 'seam' ? 'Paint seam' : activePaintChannel === 'color' ? 'Paint color' : 'Paint supports'}
                    </Typography>
                    {!paintTargetIsObject ? (
                      <Typography level="body-xs" textColor="text.tertiary">
                        Painting isn't available for imported models yet.
                      </Typography>
                    ) : (
                      <>
                        <ButtonGroup size="sm" variant="soft" aria-label="Paint brush mode" buttonFlex={1} sx={{ width: '100%' }}>
                          {activePaintChannel !== 'color' ? (
                            <Button
                              variant={paintBrushMode === 'enforcer' ? 'solid' : 'soft'}
                              color={paintBrushMode === 'enforcer' ? 'primary' : 'neutral'}
                              onClick={() => setPaintBrushMode('enforcer')}
                            >
                              Enforce
                            </Button>
                          ) : (
                            <Button
                              variant={paintBrushMode !== 'eraser' ? 'solid' : 'soft'}
                              color={paintBrushMode !== 'eraser' ? 'primary' : 'neutral'}
                              onClick={() => setPaintBrushMode('enforcer')}
                            >
                              Paint
                            </Button>
                          )}
                          {activePaintChannel !== 'color' && (
                            <Button
                              variant={paintBrushMode === 'blocker' ? 'solid' : 'soft'}
                              color={paintBrushMode === 'blocker' ? 'danger' : 'neutral'}
                              onClick={() => setPaintBrushMode('blocker')}
                            >
                              Block
                            </Button>
                          )}
                          <Button
                            variant={paintBrushMode === 'eraser' ? 'solid' : 'soft'}
                            color={paintBrushMode === 'eraser' ? 'primary' : 'neutral'}
                            onClick={() => setPaintBrushMode('eraser')}
                          >
                            Erase
                          </Button>
                        </ButtonGroup>
                        {PAINT_TOOLS_BY_CHANNEL[activePaintChannel].length > 1 && (
                          <ButtonGroup size="sm" variant="soft" aria-label="Paint tool" buttonFlex={1} sx={{ width: '100%' }}>
                            {PAINT_TOOLS_BY_CHANNEL[activePaintChannel].map((tool) => (
                              <Button
                                key={tool}
                                variant={activePaintTool === tool ? 'solid' : 'soft'}
                                color={activePaintTool === tool ? 'primary' : 'neutral'}
                                onClick={() => setPaintTool(tool)}
                                sx={{ px: 0.5, fontSize: 'xs' }}
                              >
                                {PAINT_TOOL_LABELS[tool]}
                              </Button>
                            ))}
                          </ButtonGroup>
                        )}
                        {activePaintChannel === 'color' && (
                          <Select<number>
                            size="sm"
                            value={paintColorFilamentId ?? filamentOptions[0]?.id ?? null}
                            onChange={(_event, value) => { if (value != null) setPaintColorFilamentId(value) }}
                            aria-label="Paint material"
                            renderValue={(selected) => {
                              const option = filamentOptions.find((entry) => entry.id === selected?.value)
                              return option ? <FilamentOptionContent option={option} /> : null
                            }}
                          >
                            {filamentOptions.map((option) => (
                              <Option key={option.id} value={option.id}>
                                <FilamentOptionContent option={option} />
                              </Option>
                            ))}
                          </Select>
                        )}
                        {(activePaintTool === 'circle' || activePaintTool === 'sphere') && (
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Brush</Typography>
                            <Slider
                              size="sm"
                              min={0.5}
                              max={10}
                              step={0.5}
                              value={paintBrushRadius}
                              onChange={(_event, value) => setPaintBrushRadius(value as number)}
                              aria-label="Brush size"
                              sx={{ flex: 1, minWidth: 0 }}
                            />
                            <Chip size="sm" variant="soft" color="neutral">{paintBrushRadius} mm</Chip>
                          </Stack>
                        )}
                        {activePaintTool === 'fill' && (
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Angle</Typography>
                            <Slider
                              size="sm"
                              min={1}
                              max={90}
                              step={1}
                              value={paintSmartAngle}
                              onChange={(_event, value) => setPaintSmartAngle(value as number)}
                              aria-label="Smart fill angle"
                              sx={{ flex: 1, minWidth: 0 }}
                            />
                            <Chip size="sm" variant="soft" color="neutral">{paintSmartAngle}&deg;</Chip>
                          </Stack>
                        )}
                        {activePaintTool === 'height' && (
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Height</Typography>
                            <Slider
                              size="sm"
                              min={0.2}
                              max={10}
                              step={0.2}
                              value={paintHeightRange}
                              onChange={(_event, value) => setPaintHeightRange(value as number)}
                              aria-label="Height range"
                              sx={{ flex: 1, minWidth: 0 }}
                            />
                            <Chip size="sm" variant="soft" color="neutral">{paintHeightRange} mm</Chip>
                          </Stack>
                        )}
                        {activePaintChannel === 'color' && (activePaintTool === 'circle' || activePaintTool === 'sphere') && (
                          <Checkbox
                            size="sm"
                            label="Edge detection"
                            checked={paintEdgeDetection}
                            onChange={(event) => setPaintEdgeDetection(event.target.checked)}
                          />
                        )}
                        {activePaintChannel === 'supports' && (
                          <Checkbox
                            size="sm"
                            label="On overhangs only"
                            checked={paintOnOverhangs}
                            onChange={(event) => setPaintOnOverhangs(event.target.checked)}
                          />
                        )}
                        {activePaintChannel === 'supports' && paintOnOverhangs && (
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Overhang</Typography>
                            <Slider
                              size="sm"
                              min={1}
                              max={90}
                              step={1}
                              value={paintOverhangAngle}
                              onChange={(_event, value) => setPaintOverhangAngle(value as number)}
                              aria-label="Overhang angle"
                              sx={{ flex: 1, minWidth: 0 }}
                            />
                            <Chip size="sm" variant="soft" color="neutral">{paintOverhangAngle}&deg;</Chip>
                          </Stack>
                        )}
                        <Typography level="body-xs" textColor="text.tertiary">
                          {activePaintTool === 'fill'
                            ? 'Click a face to fill connected faces, stopping at edges sharper than the angle.'
                            : activePaintTool === 'bucket'
                              ? 'Click to repaint the connected area that shares the clicked color.'
                              : activePaintTool === 'triangle'
                                ? 'Click or drag to paint individual triangles.'
                                : activePaintTool === 'height'
                                  ? 'Click the model to paint a horizontal band upward from the clicked height.'
                                  : activePaintChannel === 'seam'
                                    ? 'Drag on the model: green forces the seam here, orange keeps it away.'
                                    : activePaintChannel === 'color'
                                      ? 'Drag on the model to paint it with the selected material.'
                                      : 'Drag on the model: blue areas force supports, red areas block them.'}
                        </Typography>
                        <Stack direction="row" spacing={0.75} justifyContent="space-between">
                          <Button size="sm" variant="plain" color="danger" onClick={clearSelectedPaint}>
                            Clear all
                          </Button>
                          <Button size="sm" onClick={() => setGizmoMode('translate')}>Done</Button>
                        </Stack>
                      </>
                    )}
                  </Sheet>
                )}
                {gizmoMode === 'brimEars' && selectedKey && (
                  <Sheet
                    variant="soft"
                    sx={{
                      position: 'absolute', top: TOOL_PANEL_TOP, left: 8, zIndex: (theme) => theme.zIndex.tooltip,
                      p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
                      width: 'min(280px, calc(100% - 16px))',
                      display: 'flex', flexDirection: 'column', gap: 0.75
                    }}
                  >
                    <Typography level="title-sm">Brim ears</Typography>
                    {!paintTargetIsObject ? (
                      <Typography level="body-xs" textColor="text.tertiary">
                        Brim ears aren't available for imported models yet.
                      </Typography>
                    ) : (
                      <>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>Ear size</Typography>
                          <Slider
                            size="sm"
                            min={2}
                            max={20}
                            step={0.5}
                            value={brimEarDiameter}
                            onChange={(_event, value) => setBrimEarDiameter(value as number)}
                            aria-label="Brim ear diameter"
                            sx={{ flex: 1, minWidth: 0 }}
                          />
                          <Chip size="sm" variant="soft" color="neutral">{brimEarDiameter} mm</Chip>
                        </Stack>
                        <Typography level="body-xs" textColor="text.tertiary">
                          Click the model near the bed to add an ear; click an ear to remove it.
                          Ears print only when the process Brim type is set to "Brim ears".
                        </Typography>
                        <Stack direction="row" spacing={0.75} justifyContent="space-between">
                          <Button size="sm" variant="plain" color="danger" onClick={() => editSelectedBrimEars({ kind: 'clear' })}>
                            Clear all
                          </Button>
                          <Button size="sm" onClick={() => setGizmoMode('translate')}>Done</Button>
                        </Stack>
                      </>
                    )}
                  </Sheet>
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
                      <Typography level="title-sm">{ADDED_PART_SPECS[selectedAddedPart.subtype].label}</Typography>
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
                      onSelect={handleSelect}
                      onRename={handleRenameObject}
                      onDuplicate={handleDuplicate}
                      onDelete={handleDelete}
                      filamentColors={filamentColors}
                      filamentOptions={filamentOptions}
                      onReassignFilament={filamentOptions.length > 0 ? reassignFilament : undefined}
                      resolveFilamentId={resolveColorFilamentId}
                      onTogglePrintable={handleTogglePrintable}
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
                        onEditObject: (objectId, name) => setEditingObject({ id: objectId, name }),
                        onEditPart: (objectId, componentObjectId, name) => setEditingPart({ objectId, componentObjectId, name }),
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
        {contextMenu && (
          <Menu
            open
            ref={contextMenuListboxRef}
            onClose={() => setContextMenu(null)}
            anchorEl={{ getBoundingClientRect: () => new DOMRect(contextMenu.x, contextMenu.y, 0, 0) }}
            placement="bottom-start"
            sx={{
              zIndex: (theme) => theme.zIndex.tooltip,
              // In a vertical menu Joy's ListItemDecorator only reserves height, not width, so
              // icons of differing glyph widths leave the labels ragged. Pin a fixed icon column
              // and a uniform icon size so every label starts at the same x.
              [`& .${listItemDecoratorClasses.root}`]: { minInlineSize: '1.75rem' },
              '& svg': { fontSize: '1.25rem' }
            }}
          >
            <MenuItem onClick={() => { handleDuplicate(contextMenu.key); setContextMenu(null) }}>
              <ListItemDecorator><ContentCopyRoundedIcon /></ListItemDecorator>
              Duplicate
            </MenuItem>
            <MenuItem onClick={() => { void handleSplitToObjects(contextMenu.key); setContextMenu(null) }}>
              <ListItemDecorator><CallSplitRoundedIcon /></ListItemDecorator>
              Split to objects
            </MenuItem>
            {extraSelectedKeys.length > 0 && (selectedKey === contextMenu.key || extraSelectedKeys.includes(contextMenu.key)) && (
              <MenuItem onClick={() => { void handleAssembleSelection(); setContextMenu(null) }}>
                <ListItemDecorator><MergeTypeRoundedIcon /></ListItemDecorator>
                Assemble {extraSelectedKeys.length + 1} objects
              </MenuItem>
            )}
            <ListDivider />
            <MenuItem onClick={() => { const key = contextMenu.key; setContextMenu(null); setReplaceTargetKey(key); setLibraryPickerOpen(true) }}>
              <ListItemDecorator><SwapHorizRoundedIcon /></ListItemDecorator>
              Replace from library…
            </MenuItem>
            <MenuItem onClick={() => { const key = contextMenu.key; setContextMenu(null); setReplaceTargetKey(key); fileInputRef.current?.click() }}>
              <ListItemDecorator><SwapHorizRoundedIcon /></ListItemDecorator>
              Replace from file…
            </MenuItem>
            {activePlate?.instances.find((entry) => entry.key === contextMenu.key)?.source.kind === 'object' && (
              <>
                <ListDivider />
                {ADDED_PART_SUBTYPES.map((subtype) => (
                  <MenuItem key={subtype} onClick={() => { void handleAddPartVolume(contextMenu.key, subtype); setContextMenu(null) }}>
                    <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
                    Add {ADDED_PART_SPECS[subtype].label.toLowerCase()}
                  </MenuItem>
                ))}
              </>
            )}
            <MenuItem onClick={() => {
              const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
              if (plate) {
                const cx = (plate.bed.minX + plate.bed.maxX) / 2
                const cy = (plate.bed.minY + plate.bed.maxY) / 2
                mutateSelectedGroup((group) => { group.position.x = cx; group.position.y = cy })
              }
              setContextMenu(null)
            }}>
              <ListItemDecorator><CenterFocusStrongRoundedIcon /></ListItemDecorator>
              Center on plate
            </MenuItem>
            <MenuItem onClick={() => { handleDropToBed(); setContextMenu(null) }}>
              <ListItemDecorator><VerticalAlignBottomRoundedIcon /></ListItemDecorator>
              Drop to bed
            </MenuItem>
            <MenuItem onClick={() => { mutateSelectedGroup((group) => { rotorOf(group).rotation.set(0, 0, 0) }); setContextMenu(null) }}>
              <ListItemDecorator><ThreeSixtyRoundedIcon /></ListItemDecorator>
              Reset rotation
            </MenuItem>
            <MenuItem onClick={() => { mutateSelectedGroup((group) => { group.scale.set(1, 1, 1) }); setContextMenu(null) }}>
              <ListItemDecorator><AspectRatioRoundedIcon /></ListItemDecorator>
              Reset scale
            </MenuItem>
            <ListDivider />
            {(['x', 'y', 'z'] as const).map((axis) => (
              <MenuItem
                key={`mirror-${axis}`}
                onClick={() => { mutateSelectedGroup((group) => { group.scale[axis] *= -1 }); setContextMenu(null) }}
              >
                <ListItemDecorator><FlipRoundedIcon /></ListItemDecorator>
                Mirror {axis.toUpperCase()}
              </MenuItem>
            ))}
            {(state?.plates.length ?? 0) > 1 && (
              <>
                <ListDivider />
                {(state?.plates ?? [])
                  .filter((plate) => plate.index !== activePlateIndex)
                  .map((plate) => (
                    <MenuItem key={`move-${plate.index}`} onClick={() => { handleMoveToPlate(contextMenu.key, plate.index); setContextMenu(null) }}>
                      <ListItemDecorator><DriveFileMoveRoundedIcon /></ListItemDecorator>
                      Move to plate {plate.index}
                    </MenuItem>
                  ))}
              </>
            )}
            <ListDivider />
            <MenuItem color="danger" onClick={() => { handleDelete(contextMenu.key); setContextMenu(null) }}>
              <ListItemDecorator><DeleteRoundedIcon /></ListItemDecorator>
              Delete
            </MenuItem>
          </Menu>
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
          // materials history) and flag the project dirty so Save lights up / close warns.
          recordMaterialsHistory()
          const next = { ...perObject.value }
          if (Object.keys(overrides).length === 0) delete next[String(editingObject.id)]
          else next[String(editingObject.id)] = overrides
          perObject.onChange(next)
          markDirty()
          setEditingObject(null)
        }}
      />
    )}
    {editingPart && perObject && (() => {
      // Per-PART process overrides: same restricted catalog as the per-object dialog, baselined on
      // the inherited global + object overrides; the result is stored per part and baked into that
      // part's model_settings block (separate from the object's overall overrides).
      const partKey = supportPaintKey(editingPart.objectId, editingPart.componentObjectId)
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
          initialOverrides={stateRef.current?.partProcessOverrides?.[partKey] ?? EMPTY_OBJECT_OVERRIDES}
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
              if (Object.keys(serialized).length === 0) delete map[partKey]
              else map[partKey] = serialized
              return { ...current, partProcessOverrides: map }
            })
            markDirty()
            setEditingPart(null)
          }}
        />
      )
    })()}
    </>
  )
}

/**
 * Plate selector strip: a live thumbnail per plate (rendered offscreen from the
 * edited layout), with add-plate and per-plate delete. The selected plate is
 * highlighted.
 */
function PlateThumbnailStrip({
  plates,
  activeIndex,
  thumbnails,
  onSelect,
  onAddPlate,
  onRemovePlate,
  onRenamePlate,
  onReorderPlate
}: {
  plates: EditorPlate[]
  activeIndex: number
  thumbnails: Record<number, string>
  onSelect: (index: number) => void
  onAddPlate: () => void
  onRemovePlate: (index: number) => void
  onRenamePlate: (index: number) => void
  onReorderPlate: (fromIndex: number, toIndex: number) => void
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  // Tile currently hovered during a reorder drag, for the drop-target highlight.
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  // Collapsed mode trades the thumbnails for name-only chips so the 3D viewport gets the
  // vertical space back; the preference sticks across sessions.
  const [collapsed, setCollapsed] = useLocalStorageState(
    'bambu.editor.plateStripCollapsed',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  return (
    <Sheet variant="outlined" sx={{ p: 0.75, borderRadius: 'sm', bgcolor: 'background.level1', width: '100%', minWidth: 0 }}>
    <Stack direction="row" spacing={0.75} sx={{ overflowX: 'auto', alignItems: 'stretch' }}>
      {plates.map((plate) => {
        const active = plate.index === activeIndex
        const thumbnail = thumbnails[plate.index]
        // No thumbnail yet means the plate is still loading — either its scene is streaming in
        // (the visible plate loads first; the rest arrive behind it, #28) or its preview is
        // still being rendered in the background. Either way, show a spinner, not an empty tile.
        const loading = !thumbnail
        const label = plate.name?.trim() || `Plate ${plate.index}`
        return (
          <Sheet
            key={plate.index}
            // A div (not a <button>) because the tile contains the options MenuButton, and a
            // button nested in a button is invalid DOM. role/tabIndex/keydown keep it operable.
            component="div"
            role="button"
            tabIndex={0}
            variant={active ? 'solid' : 'outlined'}
            color={active ? 'primary' : 'neutral'}
            onClick={() => onSelect(plate.index)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(plate.index) }
            }}
            draggable
            onDragStart={(event) => { setDragIndex(plate.index); event.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
            onDragOver={(event) => {
              if (dragIndex === null || dragIndex === plate.index) return
              event.preventDefault()
              setDragOverIndex(plate.index)
            }}
            onDragLeave={() => setDragOverIndex((current) => (current === plate.index ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              if (dragIndex !== null && dragIndex !== plate.index) onReorderPlate(dragIndex, plate.index)
              setDragIndex(null)
              setDragOverIndex(null)
            }}
            aria-label={`Select ${label}`}
            aria-current={active}
            sx={{
              // Expanded: fixed-width tile sized to the (square) thumbnail; the label must not
              // stretch it, so cap the width and let the label truncate within it. Collapsed:
              // a name-only chip with the options menu inline.
              flex: collapsed ? '0 0 auto' : '0 0 92px',
              width: collapsed ? 'auto' : 92,
              minWidth: collapsed ? 0 : 92,
              maxWidth: collapsed ? 160 : 92,
              p: 0.5,
              border: active ? undefined : '1px solid',
              borderColor: active ? undefined : 'neutral.outlinedBorder',
              appearance: 'none',
              borderRadius: 'sm',
              cursor: 'pointer',
              position: 'relative',
              display: 'flex',
              flexDirection: collapsed ? 'row' : 'column',
              alignItems: collapsed ? 'center' : undefined,
              gap: collapsed ? 0.5 : 0.25,
              // Reorder-drag feedback: dim the tile being dragged and ring the tile
              // the plate will land on.
              ...(dragIndex === plate.index ? { opacity: 0.45 } : {}),
              ...(dragIndex !== null && dragIndex !== plate.index && dragOverIndex === plate.index
                ? { boxShadow: 'inset 0 0 0 2px var(--joy-palette-primary-400)' }
                : {})
            }}
          >
            {!collapsed && (
              <Box
                sx={{
                  aspectRatio: '1 / 1',
                  width: '100%',
                  borderRadius: 'xs',
                  overflow: 'hidden',
                  bgcolor: '#0d1322',
                  display: 'grid',
                  placeItems: 'center'
                }}
              >
                {thumbnail ? (
                  <Box
                    component="img"
                    src={thumbnail}
                    alt=""
                    // The tile owns the reorder drag; a draggable <img> would start a
                    // native image drag instead whenever the grab lands on the thumb.
                    draggable={false}
                    sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <CircularProgress size="sm" />
                )}
              </Box>
            )}
            {collapsed && loading && <CircularProgress size="sm" sx={{ flexShrink: 0, '--CircularProgress-size': '16px' }} />}
            <Tooltip title={label} variant="soft" size="sm">
              <Typography
                level="body-xs"
                noWrap
                textColor={active ? 'primary.50' : undefined}
                sx={{ textAlign: collapsed ? 'left' : 'center', width: '100%', minWidth: 0, maxWidth: '100%', px: collapsed ? 0.25 : 0 }}
              >
                {label}
              </Typography>
            </Tooltip>
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', onClick: (event: React.MouseEvent) => event.stopPropagation(), 'aria-label': `Plate ${plate.index} options` } }}
                sx={collapsed
                  ? { flexShrink: 0, minHeight: 22, minWidth: 22, '--IconButton-size': '22px' }
                  : { position: 'absolute', top: 2, right: 2, minHeight: 22, minWidth: 22, '--IconButton-size': '22px' }}
              >
                <MoreVertRoundedIcon fontSize="small" />
              </MenuButton>
              <Menu placement="bottom-end" sx={{ zIndex: (theme) => theme.zIndex.tooltip, minWidth: 160 }} onClick={(event) => event.stopPropagation()}>
                {/* Lay out icon + label directly with a fixed gap so every row aligns
                    (ListItemDecorator sizes differently on the danger/selected row). */}
                <MenuItem onClick={(event) => { event.stopPropagation(); onRenamePlate(plate.index) }} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <DriveFileRenameOutlineRoundedIcon fontSize="small" />
                  Rename
                </MenuItem>
                {plates.length > 1 && (
                  <MenuItem color="danger" onClick={(event) => { event.stopPropagation(); onRemovePlate(plate.index) }} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <DeleteRoundedIcon fontSize="small" />
                    Delete plate
                  </MenuItem>
                )}
              </Menu>
            </Dropdown>
          </Sheet>
        )
      })}
      <Tooltip title="Add plate">
        <IconButton
          size={collapsed ? 'sm' : 'lg'}
          variant="outlined"
          color="neutral"
          onClick={onAddPlate}
          aria-label="Add plate"
          sx={{ flex: '0 0 auto', alignSelf: 'stretch' }}
        >
          <AddRoundedIcon />
        </IconButton>
      </Tooltip>
      <Tooltip title={collapsed ? 'Show plate previews' : 'Hide plate previews'}>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Show plate previews' : 'Hide plate previews'}
          sx={{ flex: '0 0 auto', alignSelf: 'center', ml: 'auto !important' }}
        >
          {collapsed ? <UnfoldMoreRoundedIcon fontSize="small" /> : <UnfoldLessRoundedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Stack>
    </Sheet>
  )
}

/** Build a small Bambu-style rotation snap-guide ring with spokes at 45-deg steps. */
function createRotationSnapGuides(): THREE.Group {
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
function createMeasureLabelSprite(text: string): THREE.Sprite | null {
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

/** Material number + swatch + label + colour name for filament pickers (options AND value). */
function FilamentOptionContent({ option }: { option: FilamentOption }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0, minWidth: '1.1em', textAlign: 'right' }}>
        {option.id}
      </Typography>
      <Box sx={{ width: 12, height: 12, borderRadius: '3px', flexShrink: 0, bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
      <Typography level="body-sm" noWrap>{option.label}</Typography>
      {option.colorName || option.color ? (
        <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flexShrink: 1, minWidth: 0 }}>
          {option.colorName ?? option.color}
        </Typography>
      ) : null}
    </Box>
  )
}

/** One entry in the viewport toolbar: a modal tool (active highlights) or a one-shot action. */
interface ToolbarEntry {
  key: string
  /** Full name, shown in the tooltip and aria-label. */
  label: string
  /** Compact caption under the icon; defaults to `label`. */
  short?: string
  icon: JSX.Element
  active?: boolean
  disabled: boolean
  onClick: () => void
}

/**
 * A toolbar button: icon-only on phones, icon above a small caption on desktop
 * (keeps each button narrow so the whole row fits typical editor widths — Joy
 * has no vertical-content button variant, hence the column-flex override).
 *
 * ButtonGroup rounds its corners by cloning DIRECT children with
 * `data-first-child`/`data-last-child` and styling `& > [data-*-child]` — those
 * attributes land on this component, so they must be forwarded to the real
 * button (still a direct DOM child: Tooltip renders no wrapper element).
 */
function ToolbarButton({ entry, isMobile, ...groupAttrs }: {
  entry: ToolbarEntry
  isMobile: boolean
  'data-first-child'?: string
  'data-last-child'?: string
}) {
  const variant = entry.active ? ('solid' as const) : ('soft' as const)
  const color = entry.active ? ('primary' as const) : ('neutral' as const)
  return (
    <Tooltip title={entry.label}>
      {isMobile ? (
        <IconButton {...groupAttrs} variant={variant} color={color} disabled={entry.disabled} onClick={entry.onClick} aria-label={entry.label}>
          {entry.icon}
        </IconButton>
      ) : (
        <Button
          {...groupAttrs}
          variant={variant}
          color={color}
          disabled={entry.disabled}
          onClick={entry.onClick}
          aria-label={entry.label}
          sx={{
            flexDirection: 'column',
            gap: 0.25,
            minWidth: 0,
            px: 1,
            py: 0.5,
            '--Icon-fontSize': '1.125rem'
          }}
        >
          {entry.icon}
          <Box component="span" sx={{ fontSize: '0.625rem', lineHeight: 1.1, whiteSpace: 'nowrap' }}>
            {entry.short ?? entry.label}
          </Box>
        </Button>
      )}
    </Tooltip>
  )
}

function GizmoToolbar({
  mode,
  disabled,
  busy,
  arrangeDisabled,
  onChange,
  onDropToBed,
  onAutoOrient,
  onArrangeAll
}: {
  mode: GizmoMode
  disabled: boolean
  /** Disables even selection-independent tools (measure) while the viewport is busy. */
  busy: boolean
  /** Auto-arrange is plate-scoped: enabled whenever the plate has models, selection or not. */
  arrangeDisabled: boolean
  onChange: (mode: GizmoMode) => void
  onDropToBed: () => void
  onAutoOrient: () => void
  onArrangeAll: () => void
}) {
  const isMobile = useMobileViewport()
  // Selection tools: everything here needs a selected object — the modal editing
  // tools (the active one highlights) plus the one-shot Drop/Orient actions.
  const tools: ToolbarEntry[] = [
    ...([
      { value: 'translate', label: 'Move', icon: <OpenWithRoundedIcon /> },
      { value: 'rotate', label: 'Rotate', icon: <ThreeSixtyRoundedIcon /> },
      { value: 'scale', label: 'Scale', icon: <AspectRatioRoundedIcon /> },
      // Tap-a-face icon: the tool rests the CLICKED face on the bed. The plane-
      // through-a-shape icon (Flip) reads as slicing, so it marks the Cut tool.
      { value: 'layFace', label: 'Place on face', short: 'Lay flat', icon: <TouchAppRoundedIcon /> },
      { value: 'cut', label: 'Cut', icon: <FlipRoundedIcon /> },
      { value: 'paintSupports', label: 'Paint supports', short: 'Supports', icon: <BrushRoundedIcon /> },
      { value: 'paintSeam', label: 'Paint seam', short: 'Seam', icon: <FormatPaintRoundedIcon /> },
      { value: 'paintColor', label: 'Paint color', short: 'Color', icon: <PaletteRoundedIcon /> },
      { value: 'brimEars', label: 'Brim ears', icon: <AdjustRoundedIcon /> }
    ] as Array<{ value: GizmoMode; label: string; short?: string; icon: JSX.Element }>).map((tool) => ({
      key: tool.value,
      label: tool.label,
      short: tool.short,
      icon: tool.icon,
      active: mode === tool.value,
      disabled,
      onClick: () => onChange(tool.value)
    })),
    { key: 'drop', label: 'Drop to bed', short: 'Drop', icon: <VerticalAlignBottomRoundedIcon />, disabled, onClick: onDropToBed },
    { key: 'orient', label: 'Auto-orient (rest on the largest flat face)', short: 'Orient', icon: <AutoFixHighRoundedIcon />, disabled, onClick: onAutoOrient }
  ]
  // Utilities that work without a selection: plate-wide arrange and measure
  // (still a mode — it highlights while active — but it never edits the scene).
  const utilities: ToolbarEntry[] = [
    { key: 'arrange', label: 'Auto-arrange all models on this plate', short: 'Arrange', icon: <GridViewRoundedIcon />, disabled: arrangeDisabled, onClick: onArrangeAll },
    { key: 'measure', label: 'Measure', icon: <StraightenRoundedIcon />, active: mode === 'measure', disabled: busy, onClick: () => onChange('measure') }
  ]
  // The two groups are returned as siblings (no wrapper) so the toolbar's
  // flex-wrap container can break them onto separate rows on phones instead of
  // pushing the second group out of view. The slightly smaller phone buttons
  // let the 11-button tools group fit a 360px viewport on one row.
  const groupSx = {
    '--ButtonGroup-radius': 'var(--joy-radius-sm)',
    // Joy fades each button's divider to the near-invisible disabled border color
    // whenever that button is disabled; with the whole tools group disabled (no
    // object selected) that erased every divider. Pin the divider to the normal
    // outlined border regardless of disabled state so the toolbar always reads as
    // a connected row. `&&` outranks Joy's own `:disabled` separator rule.
    [`&& .${buttonClasses.root}:disabled, && .${iconButtonClasses.root}:disabled`]: {
      '--ButtonGroup-separatorColor': 'var(--joy-palette-neutral-outlinedBorder)'
    },
    ...(isMobile ? { '--IconButton-size': '30px' } : null)
  }
  return (
    <>
      <ButtonGroup size="sm" variant="soft" sx={groupSx}>
        {tools.map((entry) => <ToolbarButton key={entry.key} entry={entry} isMobile={isMobile} />)}
      </ButtonGroup>
      <ButtonGroup size="sm" variant="soft" sx={groupSx}>
        {utilities.map((entry) => <ToolbarButton key={entry.key} entry={entry} isMobile={isMobile} />)}
      </ButtonGroup>
    </>
  )
}

/** A small "?" affordance documenting the editor keyboard shortcuts. */
/** A single keyboard-key chip, styled like markdown `code`/`<kbd>`. */
function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="kbd"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: 0.5,
        minWidth: '1.4em',
        justifyContent: 'center',
        borderRadius: 'xs',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
        borderBottomWidth: 2,
        bgcolor: 'background.level1',
        fontFamily: 'code',
        fontSize: '0.7rem',
        lineHeight: 1.7,
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </Box>
  )
}

function KeyboardHelpButton() {
  const shortcuts: Array<{ keys: string[]; description: string }> = [
    { keys: ['↑', '↓', '←', '→'], description: 'Move on bed' },
    { keys: ['Shift', '↑↓←→'], description: 'Move farther' },
    { keys: ['Ctrl/Cmd', '↑↓←→'], description: 'Fine move' },
    { keys: ['[', ']'], description: 'Rotate about Z' },
    { keys: ['Del'], description: 'Remove' },
    { keys: ['Shift'], description: 'Snap 45° while rotating' }
  ]
  // Click-driven popup (not a hover Tooltip) so it also opens on touch devices.
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{ root: { size: 'sm', variant: 'soft', color: 'neutral', 'aria-label': 'Keyboard shortcuts' } }}
      >
        <HelpOutlineRoundedIcon />
      </MenuButton>
      <Menu placement="bottom-start" sx={{ zIndex: (theme) => theme.zIndex.tooltip, p: 1.25, maxWidth: 280 }}>
        <Typography level="title-sm" sx={{ mb: 0.75 }}>Keyboard shortcuts</Typography>
        <Stack spacing={0.5}>
          {shortcuts.map((shortcut) => (
            <Stack key={shortcut.description} direction="row" spacing={0.75} alignItems="center">
              <Stack direction="row" spacing={0.25} sx={{ flexShrink: 0 }}>
                {shortcut.keys.map((key, index) => (
                  <KeyCap key={`${shortcut.description}-${index}`}>{key}</KeyCap>
                ))}
              </Stack>
              <Typography level="body-xs">{shortcut.description}</Typography>
            </Stack>
          ))}
        </Stack>
      </Menu>
    </Dropdown>
  )
}

/**
 * Bambu-style manual transform panel for the selected object: position (mm),
 * rotation (deg), and per-axis scale (%) with a uniform-lock toggle. Editing a
 * field updates the live object + gizmo; values reflect the current gizmo state.
 */
function TransformPanel({
  transform,
  uniformScale,
  onToggleUniformScale,
  onPosition,
  onRotation,
  onScale
}: {
  transform: SelectedTransform
  uniformScale: boolean
  onToggleUniformScale: (value: boolean) => void
  onPosition: (axis: 'x' | 'y' | 'z', value: number) => void
  onRotation: (axis: 'x' | 'y' | 'z', value: number) => void
  onScale: (axis: 'x' | 'y' | 'z', value: number) => void
}) {
  return (
    <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm', display: 'flex', flexDirection: 'column', gap: 1 }}>
      <AxisRow label="Position (mm)" values={transform.position} step={1} onChange={onPosition} />
      <AxisRow label="Rotation (°)" values={transform.rotationDeg} step={1} onChange={onRotation} />
      <Stack spacing={0.5}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography level="body-xs" textColor="text.tertiary">Scale (%)</Typography>
          <Tooltip title={uniformScale ? 'Uniform scale (locked)' : 'Independent axes'}>
            <IconButton
              size="sm"
              variant={uniformScale ? 'solid' : 'outlined'}
              color={uniformScale ? 'primary' : 'neutral'}
              onClick={() => onToggleUniformScale(!uniformScale)}
              aria-label="Toggle uniform scale"
              aria-pressed={uniformScale}
            >
              {uniformScale ? <LockRoundedIcon fontSize="small" /> : <LockOpenRoundedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Stack>
        <AxisInputs values={transform.scalePct} step={1} onChange={onScale} />
      </Stack>
    </Sheet>
  )
}

function AxisRow({
  label,
  values,
  step,
  onChange
}: {
  label: string
  values: { x: number; y: number; z: number }
  step: number
  onChange: (axis: 'x' | 'y' | 'z', value: number) => void
}) {
  return (
    <Stack spacing={0.5}>
      <Typography level="body-xs" textColor="text.tertiary">{label}</Typography>
      <AxisInputs values={values} step={step} onChange={onChange} />
    </Stack>
  )
}

function AxisInputs({
  values,
  step,
  onChange
}: {
  values: { x: number; y: number; z: number }
  step: number
  onChange: (axis: 'x' | 'y' | 'z', value: number) => void
}) {
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z']
  return (
    <Stack direction="row" spacing={0.5}>
      {axes.map((axis) => (
        <NumberField
          key={axis}
          axis={axis}
          value={values[axis]}
          step={step}
          onCommit={(value) => onChange(axis, value)}
        />
      ))}
    </Stack>
  )
}

/**
 * A controlled numeric field that shows the live value but commits the user's edit
 * on change/blur. Keeps a local string while focused so dragging the gizmo does
 * not overwrite mid-edit, then snaps back to the live value on blur.
 */
function NumberField({
  axis,
  value,
  step,
  onCommit
}: {
  axis: 'x' | 'y' | 'z'
  value: number
  step: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? roundForDisplay(value)
  return (
    <Input
      size="sm"
      type="number"
      slotProps={{ input: { step, 'aria-label': `${axis.toUpperCase()} axis` } }}
      value={display}
      onFocus={() => setDraft(roundForDisplay(value))}
      onChange={(event) => {
        setDraft(event.target.value)
        const parsed = Number.parseFloat(event.target.value)
        if (Number.isFinite(parsed)) onCommit(parsed)
      }}
      onBlur={() => setDraft(null)}
      startDecorator={<Typography level="body-xs" textColor="text.tertiary">{axis.toUpperCase()}</Typography>}
      sx={{ minWidth: 0, flex: 1, '--Input-decoratorChildHeight': '1rem' }}
    />
  )
}

function roundForDisplay(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

/**
 * "Add" split button: the default click opens the library file picker (the common
 * case); the dropdown offers uploading a local file or cloning an in-project object.
 * Mirrors the Print split button on the printer cards — a `ButtonGroup` with a main
 * `Button` plus an `IconButton` driving an anchored `Menu`.
 */
function AddModelMenu({
  importing,
  disabled = false,
  disabledReason,
  onAddFromLibrary,
  onImportFile,
  onAddPrimitive
}: {
  importing: boolean
  /** Blocks adding objects (e.g. BambuStudio parity: a project needs a material first). */
  disabled?: boolean
  disabledReason?: string
  onAddFromLibrary: () => void
  onImportFile: () => void
  onAddPrimitive: (kind: PrimitiveKind) => void
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const blocked = importing || disabled
  return (
    <>
      {/* Soft variant so the caret matches the main button (outlined fills the
          Button but leaves the IconButton transparent in this theme). */}
      <Tooltip title={disabled && disabledReason ? disabledReason : ''} variant="soft">
      <ButtonGroup ref={anchorRef} size="sm" variant="soft" color="neutral" aria-label="add model">
        <Button
          onClick={onAddFromLibrary}
          disabled={blocked}
          startDecorator={importing ? <CircularProgress size="sm" /> : <AddRoundedIcon />}
        >
          Add
        </Button>
        <IconButton
          disabled={blocked}
          aria-controls={menuOpen ? 'add-model-menu' : undefined}
          aria-expanded={menuOpen ? 'true' : undefined}
          aria-haspopup="menu"
          aria-label="More add options"
          onClick={() => setMenuOpen((value) => !value)}
        >
          <ArrowDropDownIcon />
        </IconButton>
      </ButtonGroup>
      </Tooltip>
      <Menu
        id="add-model-menu"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorEl={anchorRef.current}
        placement="bottom-end"
        // The editor is a Modal (zIndex 1300); the menu popper defaults to the
        // lower `popup` layer, so lift it above the dialog or it renders behind it.
        // In a vertical menu Joy's ListItemDecorator only reserves height, not width,
        // so icons of differing glyph widths leave the labels ragged. Pin a fixed icon
        // column and a uniform icon size so every label starts at the same x.
        sx={{
          minWidth: 220,
          zIndex: (theme) => theme.zIndex.tooltip,
          [`& .${listItemDecoratorClasses.root}`]: { minInlineSize: '1.75rem' },
          '& svg': { fontSize: '1.25rem' }
        }}
      >
        <MenuItem onClick={() => { setMenuOpen(false); onAddFromLibrary() }}>
          <ListItemDecorator><InventoryRoundedIcon /></ListItemDecorator>
          From library…
        </MenuItem>
        <MenuItem onClick={() => { setMenuOpen(false); onImportFile() }}>
          <ListItemDecorator><UploadFileRoundedIcon /></ListItemDecorator>
          Upload local file…
        </MenuItem>
        <ListDivider />
        {(Object.keys(PRIMITIVE_LABELS) as PrimitiveKind[]).map((kind) => (
          <MenuItem key={kind} onClick={() => { setMenuOpen(false); onAddPrimitive(kind) }}>
            <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
            Add {PRIMITIVE_LABELS[kind].toLowerCase()}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}

/** Split "Save" button: primary action saves, the caret opens Save-as. Mirrors AddModelMenu. */
function SaveSplitButton({
  saving,
  disabled,
  dirty,
  canSaveVersion,
  onSaveVersion,
  onSaveAs
}: {
  saving: boolean
  disabled: boolean
  /** Whether there are unsaved edits. Greys the primary "Save" (version) action when false. */
  dirty: boolean
  canSaveVersion: boolean
  onSaveVersion: () => void
  onSaveAs: () => void
}) {
  // Dropdown drives open/close (incl. click-away + Escape, which a bare anchored Menu
  // lacks); ButtonGroup keeps the split radii and the MenuButton renders as an
  // IconButton so it inherits the group's variant (no transparent/disconnected caret).
  // Solid primary: Save is the footer's primary action (Slice sits soft to its left).
  // "Save (version)" overwrites the open file, so it greys out until there are unsaved
  // edits (matching Bambu Studio's Ctrl+S). "Save as new…" always stays available — both
  // as the new-project path (no version to save) and as a safety valve if a change ever
  // slips past dirty tracking. The caret stays enabled so Save-as is always reachable.
  const saveVersionDisabled = disabled || saving || !dirty
  return (
    <Dropdown>
      <ButtonGroup variant="solid" color="primary" aria-label="save">
        <Button
          loading={saving}
          disabled={canSaveVersion ? saveVersionDisabled : disabled || saving}
          startDecorator={<SaveRoundedIcon />}
          onClick={() => (canSaveVersion ? onSaveVersion() : onSaveAs())}
        >Save</Button>
        <MenuButton slots={{ root: IconButton }} disabled={disabled || saving} aria-label="More save options">
          <ArrowDropDownIcon />
        </MenuButton>
      </ButtonGroup>
      <Menu placement="bottom-end" sx={{ minWidth: 200, zIndex: (theme) => theme.zIndex.tooltip }}>
        {canSaveVersion && <MenuItem disabled={saveVersionDisabled} onClick={onSaveVersion}>Save</MenuItem>}
        <MenuItem onClick={onSaveAs}>Save as new…</MenuItem>
      </Menu>
    </Dropdown>
  )
}

/** Split "Slice" button: primary slices the active plate, the caret offers all plates. */
function SliceSplitButton({
  slicing,
  disabled,
  disabledReason,
  activePlateIndex,
  onSliceAll,
  onSlicePlate
}: {
  slicing: boolean
  disabled: boolean
  disabledReason?: string
  activePlateIndex: number
  onSliceAll: () => void
  onSlicePlate: () => void
}) {
  // Phones are tight on footer width; "Slice plate" wraps to two lines there.
  const isMobile = useMobileViewport()
  const group = (
    <Dropdown>
      {/* Soft: Save (solid, rightmost) is the footer's primary action. */}
      <ButtonGroup variant="soft" color="primary" disabled={disabled} aria-label="slice">
        <Button startDecorator={<LayersRoundedIcon />} loading={slicing} onClick={onSlicePlate}>
          {isMobile ? 'Slice' : 'Slice plate'}
        </Button>
        <MenuButton slots={{ root: IconButton }} aria-label="More slice options">
          <ArrowDropDownIcon />
        </MenuButton>
      </ButtonGroup>
      <Menu placement="top-end" sx={{ minWidth: 200, zIndex: (theme) => theme.zIndex.tooltip }}>
        <MenuItem onClick={onSlicePlate}>Slice plate {activePlateIndex}</MenuItem>
        <MenuItem onClick={onSliceAll}>Slice all plates</MenuItem>
      </Menu>
    </Dropdown>
  )
  // A disabled native button swallows hover events, so wrap the group in an element that still
  // receives them; this lets the tooltip explain *why* the Slice button is unavailable.
  if (disabled && disabledReason) {
    return (
      <Tooltip title={disabledReason} variant="soft" sx={{ maxWidth: 280 }}>
        <Box sx={{ display: 'inline-flex' }}>{group}</Box>
      </Tooltip>
    )
  }
  return group
}

/** STL, STEP, and 3MF library files can be imported as parts (STEP is tessellated server-side). */
function isImportableLibraryFile(file: LibraryFile): boolean {
  if (file.kind === 'stl' || file.kind === 'step' || file.kind === '3mf') return true
  // Fallback for STEP files uploaded before they became a first-class kind (kind === 'other').
  const lower = file.name.toLowerCase()
  return file.kind === 'other' && (lower.endsWith('.step') || lower.endsWith('.stp'))
}

/** Prompt for a name and save the arrangement as a new library file. */
/**
 * The Objects sidebar list. Each row selects/duplicates/deletes the model. When
 * `perObject` is supplied (slice settings present), the row also carries the
 * per-object controls that used to live in a separate dialog: a print on/off
 * toggle and an override editor (with a badge for the override count).
 */
/** Readable text color (black/white) for a filament swatch background. */
function filamentTextColor(hex: string | null): string {
  const m = hex ? /^#?([0-9a-f]{6})$/i.exec(hex.trim()) : null
  if (!m) return '#fff'
  const n = parseInt(m[1] ?? '0', 16)
  const luminance = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return luminance > 150 ? '#11181f' : '#fff'
}

/** Small swatch showing a part/object's filament number, tinted with its colour. */
type FilamentOption = { id: number; color: string | null; label: string | null; colorName: string | null }

/**
 * Small swatch showing a part/object's filament number, tinted with its colour.
 * When `onReassign` + `options` are supplied it becomes a button that opens a
 * filament picker so the user can reassign the material.
 */
function FilamentBadge({
  filamentId,
  color,
  options,
  onReassign,
  title
}: {
  filamentId: number | null
  color: string | null
  options?: FilamentOption[]
  onReassign?: (filamentId: number) => void
  title?: string
}) {
  const interactive = Boolean(onReassign && options && options.length > 0)
  if (filamentId == null && !interactive) return null
  const swatch = (
    <Box
      sx={{
        flexShrink: 0,
        width: 20,
        height: 20,
        borderRadius: '4px',
        bgcolor: color || 'neutral.softBg',
        border: '1px solid rgba(255,255,255,0.18)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <Typography level="body-xs" sx={{ fontWeight: 700, lineHeight: 1, color: filamentTextColor(color) }}>
        {filamentId ?? '+'}
      </Typography>
    </Box>
  )
  if (!interactive) {
    return <Tooltip title={title ?? `Material ${filamentId}`}>{swatch}</Tooltip>
  }
  return (
    <Dropdown>
      <Tooltip title={title ?? 'Change material'}>
        <MenuButton
          variant="plain"
          color="neutral"
          aria-label={title ?? 'Change material'}
          sx={{ p: 0, minHeight: 0, minWidth: 0, border: 'none', background: 'none', '&:hover': { background: 'none' }, flexShrink: 0 }}
        >
          {swatch}
        </MenuButton>
      </Tooltip>
      <Menu placement="bottom-end" sx={{ zIndex: (theme) => theme.zIndex.tooltip, minWidth: 180 }}>
        {options!.map((option) => (
          <MenuItem
            key={option.id}
            selected={option.id === filamentId}
            onClick={() => onReassign!(option.id)}
            // Lay out the swatch + label directly with a fixed gap so every row aligns
            // (ListItemDecorator sized differently on the selected row).
            sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
          >
            <Box sx={{ flexShrink: 0, width: 16, height: 16, borderRadius: '3px', bgcolor: option.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
            <span>Material {option.id}{option.label ? ` — ${option.label}` : ''}{option.colorName ? ` (${option.colorName})` : ''}</span>
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  )
}

function ModelList({
  instances,
  selectedKey,
  extraSelectedKeys,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
  filamentColors,
  filamentOptions,
  onReassignFilament,
  resolveFilamentId,
  onTogglePrintable,
  perObject
}: {
  instances: EditorInstance[]
  selectedKey: string | null
  /** Additional multi-selected instance keys (Ctrl/Cmd-click). */
  extraSelectedKeys?: ReadonlyArray<string>
  onSelect: (key: string, additive?: boolean) => void
  onRename: (key: string) => void
  onDuplicate: (key: string) => void
  onDelete: (key: string) => void
  filamentColors?: Record<number, string>
  filamentOptions?: FilamentOption[]
  onReassignFilament?: (targets: Array<{ objectId: number; componentObjectId: number }>, filamentId: number) => void
  /** Map a (possibly-removed) material id to the one shown (removed -> material 1). */
  resolveFilamentId?: (id: number | null) => number | null
  /** Toggle an instance's Bambu "Printable" flag (per-instance, editor-owned). */
  onTogglePrintable: (key: string) => void
  /** Slice-config per-object process overrides (keyed by Bambu objectId). Null without a profile. */
  perObject?: {
    sliceObjectIds: Set<number>
    overrideCountFor: (objectId: number) => number
    onEditObject: (objectId: number, name: string) => void
    /** Open per-PART process settings for one part of an object (separate from the object's). */
    onEditPart?: (objectId: number, componentObjectId: number, name: string) => void
    partOverrideCountFor?: (objectId: number, componentObjectId: number) => number
  }
}) {
  const resolveId = resolveFilamentId ?? ((id: number | null) => id)
  const liveColor = (filamentId: number | null, fallback: string | null): string | null =>
    (filamentId != null && filamentColors?.[filamentId]) || fallback || null
  return (
    <List size="sm" sx={{ '--ListItem-minHeight': '2.5rem' }}>
      {instances.map((instance) => {
        // The object identity used for per-object settings AND per-part filament reassignment:
        // an in-project object's Bambu id, or an import's stable identity (synthetic for a fresh
        // import, the replaced object's id for "Replace with…") — so a not-yet-saved import's
        // parts are reassignable and its process is editable without a save first.
        const perObjectId = instance.source.kind === 'object'
          ? instance.objectId
          : (instance.source.replacedObjectId ?? null)
        const sliceObject = perObjectId != null && perObject?.sliceObjectIds.has(perObjectId) ? perObjectId : null
        // Printability is an editor-owned per-instance flag (BambuStudio's "Printable"),
        // so the toggle shows for every object on the plate — including just-moved ones —
        // independent of the slice dialog's per-plate object selection.
        const printing = instance.printable
        const overrideCount = sliceObject != null ? perObject!.overrideCountFor(sliceObject) : 0
        // Objects can hold multiple parts, each on its own filament — list them nested.
        const showParts = instance.parts.length > 1
        return (
          <Fragment key={instance.key}>
            <ListItem sx={{ borderRadius: 'sm', bgcolor: instance.key === selectedKey ? 'neutral.softBg' : extraSelectedKeys?.includes(instance.key) ? 'neutral.plainActiveBg' : undefined }}>
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
                <Tooltip title={printing ? 'Printable — toggle to skip' : 'Skipped — toggle to print'} variant="soft">
                  <Switch
                    size="sm"
                    checked={printing}
                    onChange={() => onTogglePrintable(instance.key)}
                    slotProps={{ input: { 'aria-label': `Print ${instance.name}` } }}
                    sx={{ flexShrink: 0 }}
                  />
                </Tooltip>
                <Typography
                  level="body-sm"
                  noWrap
                  onClick={(event) => onSelect(instance.key, event.ctrlKey || event.metaKey)}
                  sx={{ flex: 1, minWidth: 0, cursor: 'pointer', opacity: printing ? 1 : 0.5 }}
                >
                  {instance.name}
                </Typography>
                {perObjectId != null && onReassignFilament && instance.parts.length > 0 ? (
                  <FilamentBadge
                    filamentId={showParts ? null : resolveId(instance.filamentId)}
                    color={showParts ? null : liveColor(resolveId(instance.filamentId), instance.color)}
                    options={filamentOptions}
                    title={showParts ? "Set all parts' material" : 'Change material'}
                    onReassign={(fid) => onReassignFilament(instance.parts.map((p) => ({ objectId: perObjectId, componentObjectId: p.componentObjectId })), fid)}
                  />
                ) : (!showParts && <FilamentBadge filamentId={resolveId(instance.filamentId)} color={liveColor(resolveId(instance.filamentId), instance.color)} />)}
                {perObject && sliceObject != null && (
                  <Tooltip title="Per-object settings">
                    <IconButton
                      size="sm"
                      variant={overrideCount > 0 ? 'soft' : 'plain'}
                      color={overrideCount > 0 ? 'primary' : 'neutral'}
                      onClick={() => perObject.onEditObject(sliceObject, instance.name)}
                      aria-label={`Per-object settings for ${instance.name}`}
                    >
                      <TuneRoundedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="Rename">
                  <IconButton size="sm" variant="plain" color="neutral" onClick={() => onRename(instance.key)} aria-label="Rename object">
                    <DriveFileRenameOutlineRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Duplicate">
                  <IconButton size="sm" variant="plain" color="neutral" onClick={() => onDuplicate(instance.key)} aria-label="Duplicate model">
                    <ContentCopyRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete">
                  <IconButton size="sm" variant="plain" color="danger" onClick={() => onDelete(instance.key)} aria-label="Delete model">
                    <DeleteRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </ListItem>
            {showParts && instance.parts.map((part, index) => (
              <ListItem key={`${instance.key}:${index}`} sx={{ pl: 3 }}>
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%', minWidth: 0, opacity: printing ? 0.85 : 0.4 }}>
                  <Typography level="body-xs" noWrap sx={{ flex: 1, minWidth: 0 }}>
                    {part.name ?? `Part ${index + 1}`}
                  </Typography>
                  <FilamentBadge
                    filamentId={resolveId(part.filamentId)}
                    color={liveColor(resolveId(part.filamentId), part.color)}
                    options={filamentOptions}
                    onReassign={onReassignFilament && perObjectId != null ? (fid) => onReassignFilament([{ objectId: perObjectId, componentObjectId: part.componentObjectId }], fid) : undefined}
                  />
                  {perObject?.onEditPart && sliceObject != null && (() => {
                    const partOverrides = perObject!.partOverrideCountFor?.(sliceObject, part.componentObjectId) ?? 0
                    return (
                      <Tooltip title="Per-part settings">
                        <IconButton
                          size="sm"
                          variant={partOverrides > 0 ? 'soft' : 'plain'}
                          color={partOverrides > 0 ? 'primary' : 'neutral'}
                          onClick={() => perObject!.onEditPart!(sliceObject, part.componentObjectId, part.name ?? `Part ${index + 1}`)}
                          aria-label={`Per-part settings for ${part.name ?? `Part ${index + 1}`}`}
                        >
                          <TuneRoundedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )
                  })()}
                </Stack>
              </ListItem>
            ))}
          </Fragment>
        )
      })}
    </List>
  )
}
