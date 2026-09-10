/**
 * Interactive 3D plate editor (Bambu Studio "prepare" stage).
 *
 * Loads every plate of a 3MF project and lets the user arrange instances across
 * plates (move/rotate/scale, add/duplicate/delete, auto-arrange/orient), edit
 * materials and per-object overrides, paint supports/seams/colour, plane-cut and
 * split objects, add part volumes, place brim ears, schedule per-layer filament
 * changes, and measure, then hands back a `SceneEdit` (the locked shared
 * contract) on apply. Heavy: lazy-loaded by the `SlicingEditorAction` slot button
 * via `React.lazy`.
 *
 * Transform convention: each instance group's matrix is seeded by decomposing the
 * scene's plate-local 12-element transform (position/quaternion/scale, Euler XYZ).
 * On apply we read each group's position/rotation(Euler XYZ)/scale straight into
 * the `SceneEdit` instance: the backend recomposes M = T * R(eulerXYZ) * S. Values
 * stay plate-local (plate origin is never baked in).
 */
import { type ComponentProps, type ReactNode, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  CircularProgress,
  DialogActions,
  IconButton,
  Link,
  ModalClose,
  ModalDialog,
  Sheet,
  Stack,
  Tab,
  TabList,
  Tabs,
  Tooltip,
  Typography
} from '@mui/joy'
import OpenWithRoundedIcon from '@mui/icons-material/OpenWith'
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import RedoRoundedIcon from '@mui/icons-material/RedoRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import TableRowsRoundedIcon from '@mui/icons-material/TableRowsRounded'
import ViewSidebarRoundedIcon from '@mui/icons-material/ViewSidebarRounded'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as THREE from 'three'
import { OrbitControls, TransformControls } from 'three-stdlib'
import type {
  LibraryFile,
  LibraryFolder,
  LibraryThreeMfScene,
  ProcessSettingOverrides,
  SceneEdit,
  SceneEditFlushVolumes,
  SceneEditPartSubtype,
  StagedImport
} from '@printstream/shared'
import {
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  PER_OBJECT_PROCESS_KEYS,
  canonicalThreeMfPartSubtype,
  extractErrorMessage,
  isNonRenderableThreeMfPartSubtype,
  threeMfPartSubtypeCarriesFilament,
  FILAMENT_SETTING_KEYS,
  isFilamentIdentitySettingKey,
  readProjectFlushContext,
  type ThreeMfSettingsRepairReason,
  MAX_SVG_SOURCE_BYTES
} from '@printstream/shared'
import { MODEL_UNIT_MILLIMETRES, buildVanillaThreeMfEntries, type ConvertibleModelUnit,
  adaptiveLayerHeightProfile,
  flatLayerHeightProfile,
  paintLayerHeightProfile,
  smoothLayerHeightProfile,
  TEXT_INFO_DEFAULTS,
  TEXT_INFO_DEFAULT_SURFACE_TYPE,
  defaultTextInfo,
  studioShapeFixTransform,
  studioShapeScale,
  type BambuStudioShape,
  type SvgPartRecord,
  type TextInfo
} from '@printstream/shared/three-mf'
import {
  alignOffsets,
  distributeOffsets,
  minimumMembersFor,
  type AlignDistributeOperation,
  type AlignMember
} from './lib/alignDistribute'
import { useFlushCalibration, useFlushDatasets } from './lib/flushDatasets'
import { zipArchiveEntries } from './lib/zipArchiveClient'
import { afterNextPaint } from '../../lib/afterNextPaint'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { downloadBlob } from '../../lib/downloadBlob'
import { enqueueLibraryUploads } from '../../lib/libraryUploadQueue'
import { toast } from '../../lib/toast'
import { machineSwitchWarnings } from '../../lib/machineSwitchWarnings'
import { applyBulkOverridesToMember } from '../../lib/processBulkOverrides'
import { BackAwareModal as Modal, isBackGestureClose } from '../../components/BackAwareModal'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { DialogFileTitle } from '../../components/DialogFileTitle'
import { EmptyState } from '../../components/EmptyState'
import { HorizontalOverflowScroller } from '../../components/HorizontalOverflowScroller'
import { RepairProjectSettingsAlert } from '../../components/library/RepairProjectSettingsAlert'
import { ProjectVersionWarningAlert } from '../../components/library/ProjectVersionWarningAlert'
import { LibraryFilePickerDialog } from '../../components/LibraryFilePickerDialog'
import { LibraryDestinationDialog } from '../../components/LibraryDestinationDialog'
import { formatLibraryFileName, splitLibraryFileNameForRename } from '../../lib/libraryDisplay'
import { useMobileViewport } from '../../components/useMobileViewport'
import { createBedModelObject, loadBedModelGeometry } from './lib/bedModel'
import { bedSurfaceSignature } from './lib/bedSurfaceSignature'
import { EditorSettingsDialog } from '../../components/library/EditorSettingsDialog'
import { SliceSettingsPanel, type SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import type { FilamentConfigResolver } from '../../components/library/FilamentSettingsDialog'
import { applyRepairedFilamentConfigs, attachResolvedFilamentConfigs, rekeyByBakedSlot, type RepairedFilamentPreset } from './lib/filamentConfigAuthoring'
import { StickySectionHeader, StickySectionScope } from '../../components/library/StickySectionHeader'
import {
  createPreviewPlateSurface,
  createThreeMfMatrix,
  createThreeMfPartObject,
  disposeObject3D,
  getGeometryTrianglePaint,
  threeMfTransformFromMatrix
} from './lib/threeMfScene'
import { arrangePlateItems, planFillBedCopies } from './lib/arrange'
import { computePlateObstacles } from './lib/plateObstacles'
import { removeLayerHeightVisuals, syncLayerHeightVisuals } from './lib/layerHeightOverlay'
import { TextToolPanel } from './TextToolPanel'
import { DEFAULT_TEXT, textToolValuesEqual, type TextToolValue } from './lib/textToolValue'
import { buildSurfaceTextSoup, buildTextSoup, glyphAdvances } from './lib/textGeometry'
import {
  arcOffsetNearest, loopLength, loopNearest, nearestFrame, reverseLoop, seatGlyphs, sliceSegments,
  suggestUp
} from './lib/textSurfaceProjection'
import {
  BUNDLED_FAMILIES,
  BUNDLED_FONTS,
  bundledFace,
  loadBundledFont,
  loadUserFont,
  parsedFont,
  type TextFontFace
} from './lib/textFonts'
import { clampPrimeTowerIntoReach } from './lib/primeTowerReach'
import { PRIMITIVE_LABELS, primitiveTriangleSoup, type PrimitiveKind } from './lib/primitives'
import {
  addedPartDropPosition,
  addedPartLabel,
  soupSize,
  stageAddedPartGeometry,
  type AddedPartSource
} from './lib/addedParts'
import {
  buildTrianglePaintOverlay,
  collectColorPaintFilamentIds
} from './lib/supportPaint'
import {
  VIEW_CUBE_EDGE_INSET,
  VIEW_CUBE_HINT,
  VIEW_CUBE_SIZE,
  type ViewPreset
} from './lib/viewCube'
import { createPlateThumbnailRenderer, type PlateThumbnailRenderer } from './lib/plateThumbnail'
import {
  buildSceneEdit,
  buildSessionFilamentIdRemap,
  rebaseEditorStateFilamentIds,
  rebaseSceneEditFilamentIds,
  deriveObjectFilamentId,
  duplicateInstance,
  fillPlateFromScene,
  findFreePlatePosition,
  placeInstanceAt,
  instanceFromStagedImport,
  replaceInstanceGeometry,
  carriedPartSubtypes,
  withRemovedParts,
  canRemoveParts,
  reindexPlates,
  mintPlateId,
  normalizePlateObjectOrder,
  moveObjectBefore,
  movePartBefore,
  movePlate,
  addedPartHostId,
  assignInstanceFilament,
  dropAddedPartsForReplacedHost,
  instanceLinkageKey,
  makeInstanceIndependent,
  BODY_PART_INDEX,
  addedPartPaintKey,
  bodyPaintHostId,
  bodyPartSubtype,
  effectiveAddedParts,
  effectivePartFilamentId,
  instanceVolumeRows,
  INHERITED_PLATE_SETTINGS,
  effectiveHeightRanges,
  effectiveLayerHeightProfile,
  type EditorHeightRange,
  effectiveBrimEars,
  effectiveFilamentChanges,
  effectivePauses,
  nextInstanceKey,
  seedEditorState,
  seedEmptyEditorState,
  seededActivePlateIndex,
  stagedFootprint,
  partSlotKey,
  supportPaintKey,
  type EditorAddedPart,
  type EditorCutGroup,
  type EditorBrimEar,
  type EditorFilamentChange,
  type EditorPause,
  type EditorInstance,
  type EditorPlate,
  type EditorState,
  type PlateFootprintRect,
  isObjectMarkedForRepair,
  resolveSvgArchiveEntry,
  planSvgReextrude,
  svgArtworkParts,
  locateObjectForReveal
} from './lib/editorModel'
import { helperVolumeSpec } from './lib/helperVolumes'
import { defaultPlateName, plateDisplayName, resolvePlateRename } from './lib/plateName'
import { LazyDialogBoundary } from '../../components/LazyDialogBoundary'
import { FullScreenDialogButton } from '../../components/DialogPresentationToggles'
import { dialogPresentationProps } from '../../lib/dialogPresentation'
import { useDialogPresentationState } from '../../hooks/useDialogPresentationState'
import { useShowBedModel } from './lib/useShowBedModel'
import { useEffectiveSidebarSide } from '../../lib/editorViewportSettings'
import { useSidebarResize } from './lib/useSidebarResize'
import { buildEditorGridLayout, choosePlateStripOrientation, EDITOR_GRID_GAP_PX } from './lib/editorChromeLayout'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { useMirroredRef } from '../../hooks/useMirroredRef'
import {
  createApiImportStore
} from './lib/editorImports'
import { importFileAccept, type EditorImportStore } from './lib/editorImportStore'
import { createArchiveProjectSource, type EditorProjectSource } from './lib/editorProjectSource'
import { createApiSaveTarget, type EditorSaveTarget } from './lib/editorSaveTarget'
import { parseStlGeometryAsync, parseThreeMfModelEntryAsync } from './lib/meshParseClient'
import {
  capSoupForHalf,
  collectWorldTriangles,
  cutHalfForSide,
  cutTriangleSoup,
  cutTriangleSoupWithGroove,
  drillBoresIntoHalf,
  grooveDefaultsForSize,
  grooveSizeLimitsForSize,
  helperVolumeCutSides,
  orientCutHalfSoup,
  rebaseTriangleSoup,
  shiftTriangleSoup,
  splitTriangleSoup,
  triangleSoupToBinaryStl,
  triangleSoupXYCenter,
  triangleSoupsEqual,
  GROOVE_CUT_DEFAULTS,
  type CutAxis,
  type CutHalfOrientation,
  type CutMode,
  type GrooveCut
} from './lib/meshCut'
import { isClosedSoup } from './lib/meshBooleanCore'
import {
  CONNECTOR_DEFAULTS,
  connectorBoresForSide,
  connectorProblemSummary,
  connectorSoup,
  connectorVolumes,
  findConnectorProblems,
  isPointInsideSoup,
  type ConnectorSettings,
  type CutConnector,
  connectorSizeLimitsForSize
} from './lib/cutConnectors'
import {
  buildObjectStl,
  buildObjectsStl,
  buildSelectedPartsStl,
  exportBaseName,
  groupHasExcludedVolumes,
  partsExportName,
  stlExportBaseName,
  stlExportFileName
} from './lib/objectExport'
import { buildGenericThreeMf, genericThreeMfExportFileName } from './lib/genericThreeMfExport'
import {
  ADDED_PART_MESH_NAME,
  isAddedPartMesh,
  TEXT_HIGHLIGHT_COLORS,
  type TextInteraction,
  partGroupRef,
  plateDeltaToPartLocal,
  applyLayerBandOverlays,
  bedsEqual,
  BRIM_EAR_MARKER_COLOR,
  BRIM_EAR_MARKER_NAME,
  buildFaceHullOverlay,
  computeFootprintCells,
  createMeasureLabelSprite,
  MEASURE_HOVER_COLOR,
  MEASURE_ARROWHEAD_PX,
  MEASURE_CENTRE_MARKER_NAME,
  MEASURE_POINT_COLORS,
  SCREEN_SPACE_PX_KEY,
  createMeasureFeatureHighlight,
  SCREEN_SPACE_OVERLAY_KEY,
  createPrimeTowerObject,
  removePrimeTowers,
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
  paintOverlayVisible,
  TRIANGLE_PAINT_CHANNELS,
  allowsSelectionPicking,
  isSelectionOnlyGizmoMode,
  RESTING_GIZMO_MODE,
  isViewportAidMesh,
  isTransformGizmoMode,
  printableMeshBox,
  rasterizePolygonCells,
  restObjectOnBed,
  scaleGroupAboutPoint,
  ROTATE_SNAP_COARSE,
  ROTATE_SNAP_FINE,
  rotorOf,
  setObjectPrintedStyle,
  editorEscapeAction,
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
import { useEditorKeyboardShortcuts } from './useEditorKeyboardShortcuts'
import {
  AddObjectMenu,
  GizmoToolbar,
  isImportableLibraryFile,
  KeyboardHelpButton,
  ObjectList,
  type ObjectListPerObject,
  PlateThumbnailStrip,
  SaveMenuButton,
  SliceMenuButton,
  RAIL_HOVER_LABEL_SX,
  LiveTransformPanel
} from './editorPanels'
import { PlateFilamentChangesSection, PlatePausesSection } from '../../components/library/PlateGcodeSections'
import { editorMaterialsFromSliceConfig, type EditorMaterials } from './lib/editorMaterials'
import { BrimEarsPanel } from './BrimEarsPanel'
import { CutToolPanel } from './CutToolPanel'
import { HeightRangesDialog } from './HeightRangesDialog'
import { PlateSettingsDialog, type PlateSettingsDraft } from './PlateSettingsDialog'
import { LayerHeightPanel } from './LayerHeightPanel'
import { SvgToolPanel, type SvgToolValue } from './SvgToolPanel'
import { buildSvgPieceSoups, detectSvgBackgroundPiece, parseSvgShapes, svgHeightMm, svgObjectFrameShift, type ParsedSvg } from './lib/svgGeometry'
import { EditorContextMenu } from './EditorContextMenu'
import { EditorPartContextMenu } from './EditorPartContextMenu'
import { isInsideContextMenu, type ContextMenuAnchor } from './contextMenuChrome'
import { EDITOR_CHROME_Z_INDEX, TOOL_PANEL_Z_INDEX, VIEWPORT_AID_Z_INDEX } from './editorLayers'
import { selectionPivot } from './lib/multiSelectionTransform'
import {
  hasEditorSelection,
  prunePartSelection,
  partRowMenuSelection,
  rangePartSelection,
  rangeSlice,
  samePartMember,
  samePartRef,
  selectionHasMember,
  togglePartInSelection,
  type PartMember,
  type PartRef,
  type PartSelection
} from './lib/selectionModel'
import { MeasurePanel } from './MeasurePanel'
import { MeshBooleanPanel } from './MeshBooleanPanel'
import { useEditorMeshBoolean } from './useEditorMeshBoolean'
import { PaintToolPanel } from './PaintToolPanel'
import { useEditorHistory } from './useEditorHistory'
import { useEditorPaint } from './useEditorPaint'
import { useEditorSave } from './useEditorSave'
import type { EditorContentBasePin } from './lib/contentBasePin'
import { getMeasurement,
  canSetXyzDistance
} from './lib/measureBetween'
import { isCircleCentrePick, sameMeasureFeature } from './lib/measureFeatures'
import { useEditorScene, type MeasurePick } from './useEditorScene'

/**
 * The 1-based filament ids referenced as support material by a process-override map
 * (`support_filament` / `support_interface_filament`). `'0'` / non-positive means "use the
 * default", i.e. no specific material, those are ignored. Used to count support materials as
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
// editor chunk; it loads only when a settings dialog is first opened. A LOCAL `LazyDialogBoundary`
// means that first open suspends just the dialog, not the whole editor (which sits under an
// ancestor boundary via the slot's lazy load) -- and that a chunk that never arrives leaves the
// editor standing instead of unmounting the app. Matches LibraryView's treatment of the same
// component.
import type { ProcessConfigResolver } from '../../components/ProcessSettingsDialog'
import { ProgressBar } from '../../components/ProgressBar'
import { ProgressSpinner } from '../../components/ProgressSpinner'
const ProcessSettingsDialogImpl = lazy(() => import('../../components/ProcessSettingsDialog'))
// Same treatment: it pulls in the whole grid and is opened rarely, so it must not ride the
// editor's own chunk.
const ParameterTableDialogImpl = lazy(() => import('./ParameterTableDialog'))

/** BambuStudio's own ceiling for "Number of copies" (`wxGetNumberFromUser(..., 1, 0, 1000, this)`). */
const MAX_CLONE_COPIES = 1000

/**
 * Nudge a piece's centre so its footprint sits inside the bed on one axis. A piece WIDER than the
 * bed is centred rather than jammed against an edge, so the placement warning it raises points at
 * the real problem (it does not fit) instead of at an arbitrary corner.
 */
function clampOntoBed(center: number, halfExtent: number, min: number, max: number): number {
  if (halfExtent * 2 > max - min) return (min + max) / 2
  return Math.min(Math.max(center, min + halfExtent), max - halfExtent)
}

/**
 * Re-open a saved text part in the panel, from the `<text_info>` it carries.
 *
 * The font FAMILY is the one field that can fail to resolve: a file may name a font this install
 * does not bundle and the user never loaded. Falling back to the current family keeps the text
 * editable rather than refusing to open it, at the cost of re-rendering it in a different face --
 * which the user can see and change, unlike a dialog that will not open.
 */
function textToolValueFromInfo(
  info: TextInfo,
  subtype: SceneEditPartSubtype,
  fallback: TextToolValue
): TextToolValue {
  const known = BUNDLED_FONTS.some((face) => face.family === info.fontName)
  return {
    text: info.text,
    family: known ? info.fontName : fallback.family,
    bold: info.bold,
    italic: info.italic,
    fontSize: info.fontSize,
    thickness: info.thickness,
    textGap: info.textGap,
    rotateAngle: info.rotateAngle,
    embeddedDepth: info.embeddedDepth,
    // `surfaceChar` is not offered (see the tool's development notes), but a file -- ours from before it was
    // withdrawn, or one Studio wrote -- can name it. Coerced to the mode it now behaves as, so the
    // picker shows what the text will actually do rather than blanking on a value it has no option
    // for. The record itself keeps whatever it said; only the panel is coerced.
    surfaceMode: info.surfaceType === 'surfaceChar' ? 'surface' : info.surfaceType,
    operation: subtype
  }
}

/**
 * World-space triangles of specific meshes.
 *
 * Unlike `collectWorldTriangles`, which walks a whole group, this takes exactly the meshes the
 * caller vetted -- which for text means the host without the text's own part, since a Join part is
 * printed geometry and every group walk keeps it.
 */
function worldTrianglesOf(meshes: readonly THREE.Mesh[]): Float32Array {
  const chunks: Float32Array[] = []
  let total = 0
  const vertex = new THREE.Vector3()
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position')
    if (!position) continue
    mesh.updateWorldMatrix(true, false)
    const out = new Float32Array(position.count * 3)
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld)
      out[i * 3] = vertex.x
      out[i * 3 + 1] = vertex.y
      out[i * 3 + 2] = vertex.z
    }
    chunks.push(out)
    total += out.length
  }
  const soup = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) { soup.set(chunk, offset); offset += chunk.length }
  return soup
}

/** Dot product of a projection-module vector against a three.js one. */
function dotVec(a: { x: number; y: number; z: number }, b: THREE.Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * The surface nearest a free point in space, with the normal it faces there.
 *
 * Used to re-seat DRAGGED text: the gizmo yields a position, and the placement needs the surface
 * under it. Six axis rays rather than a true closest-point query, because the answer only has to be
 * good enough to pick a face and its normal, and this needs no acceleration structure to stay
 * responsive during a drag.
 *
 * Rays are cast from OUTSIDE the model inward, not outward from the anchor: a point that has drifted
 * off the model sees nothing along an outward ray, and a point inside a wall sees the wall's back.
 * Casting inward finds the near face from either side, which is what makes text keep its grip while
 * the pointer wanders off the geometry and back on.
 */
function nearestSurfaceAt(anchor: THREE.Vector3, targets: readonly THREE.Mesh[], box: THREE.Box3):
{ point: THREE.Vector3; normal: THREE.Vector3 } | null {
  if (targets.length === 0 || box.isEmpty()) return null
  const reach = box.getSize(new THREE.Vector3()).length()
  if (reach <= 0) return null
  const directions = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
  ]
  let best: { hit: THREE.Intersection; distance: number } | null = null
  const raycaster = new THREE.Raycaster()
  for (const direction of directions) {
    raycaster.set(anchor.clone().addScaledVector(direction, -reach), direction)
    raycaster.far = reach * 2
    for (const hit of raycaster.intersectObjects(targets as THREE.Mesh[], false)) {
      const distance = hit.point.distanceTo(anchor)
      if (!best || distance < best.distance) best = { hit, distance }
    }
  }
  if (!best?.hit.face) return null
  return {
    point: best.hit.point.clone(),
    normal: best.hit.face.normal.clone().transformDirection(best.hit.object.matrixWorld).normalize()
  }
}

/**
 * What a height range may override beyond its own layer height.
 *
 * The per-object set minus `layer_height`, which the ranges dialog edits inline because every band
 * MUST carry one (BambuStudio reads it without a `has()` check and null-derefs otherwise), and
 * minus the flush-into trio, which is a whole-object wipe decision rather than a per-band one.
 * BambuStudio allows all ~93 `PrintRegionConfig` keys here; we deliberately keep the same curated
 * subset the per-object gear uses, so one model does not have two different ideas of what is
 * overridable.
 */
const HEIGHT_RANGE_TUNABLE_KEYS = PER_OBJECT_PROCESS_KEYS.filter(
  (key) => key !== 'layer_height' && !key.startsWith('flush_into_')
)

/**
 * Clearance kept between objects by both plate packers (Auto-arrange and Fill bed with copies).
 * One constant so filling a plate cannot pack tighter than arranging it would, which would make
 * the two operations disagree about whether the same layout fits.
 */
const PLATE_PACKING_GAP_MM = 6

/** Shell cap for both split actions: past this the result is debris, not parts. */
const MAX_SPLIT_SHELLS = 50
function ProcessSettingsDialog(props: ComponentProps<typeof ProcessSettingsDialogImpl>) {
  return (
    <LazyDialogBoundary label="settings" onClose={props.onClose}>
      <ProcessSettingsDialogImpl {...props} />
    </LazyDialogBoundary>
  )
}

function ParameterTableDialog(props: ComponentProps<typeof ParameterTableDialogImpl>) {
  // The default (standard) shell, NOT `maximized`: the dialog has no `base`, so it opens at the
  // standard presentation unless this device's stored preference says otherwise. A maximized
  // fallback painted a near-full-screen shell that snapped down to a 1200px dialog when the chunk
  // landed -- the exact resize a matching fallback exists to avoid.
  return (
    <LazyDialogBoundary label="the parameter table" onClose={props.onClose}>
      <ParameterTableDialogImpl {...props} />
    </LazyDialogBoundary>
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
  /**
   * Endpoint the modelled 3D bed mesh is fetched from. Defaults to the workspace route; the public 3MF
   * editor passes the anonymous catalogue route so the plate model loads with no workspace.
   */
  bedModelPath?: string
  /**
   * Where to fetch BambuStudio's measured flush tables. Defaults to the workspace route; the
   * public editor passes the anonymous one. Same shape as {@link bedModelPath}, and for the same
   * reason: the data is engine-owned and identical either way, only the surface differs.
   */
  flushDataPath?: string
  /** Sibling of {@link flushDataPath} for the engine self-check; same workspace/public split. */
  flushCalibrationPath?: string
  /**
   * How the per-object/part process dialogs resolve a preset's base config. Defaults to the workspace
   * route (inside `ProcessSettingsDialog`); the public editor passes an anonymous resolver. Must be
   * a stable reference. The GLOBAL process dialog is rendered by the host, which passes this itself.
   */
  resolveProcessConfig?: ProcessConfigResolver
  /**
   * Resolves a filament preset's config, so a save can author the material's own physics into the
   * project instead of only its name (see `lib/filamentConfigAuthoring.ts`). Host-supplied and
   * un-defaulted like `resolveProcessConfig`: the workspace host passes the workspace route's resolver,
   * the public editor its in-tab one. Without it a save keeps the previous drop behaviour.
   */
  resolveFilamentConfig?: FilamentConfigResolver
  /**
   * Repairable defects in the OPEN project, for a host whose project is not a library file.
   *
   * The library host needs nothing here, it reads them off the file DTO. A host that opened the
   * project from disk has no DTO, and the reasons are a pure function of the parsed settings
   * (`collectSettingsRepairReasons`), so it passes them in rather than the notice being
   * workspace-only. Without this the public editor showed no warning at all on a file it could
   * describe perfectly well.
   */
  repairReasons?: readonly ThreeMfSettingsRepairReason[]
  /**
   * The subset of {@link repairReasons} whose repair would decline, for the same host. Derived from
   * the same parse (`unrepairableSettingsRepairReasons`); without it the public editor would offer
   * a Repair button for a defect it cannot fix, which is what issue #101 was about.
   */
  unrepairableRepairReasons?: readonly ThreeMfSettingsRepairReason[]
  /**
   * The host's slicing-preset manager, opened by the sidebar's "Manage" action.
   *
   * Deliberately un-defaulted: the workspace manager is a workspace surface, and quietly defaulting to
   * it is exactly what made the public editor open a dialog whose every request 403s. A host with
   * no manager passes nothing and the button does not render at all.
   */
  presetManager?: (props: { open: boolean; onClose: () => void }) => ReactNode
  /**
   * Status for a host-provided preset source (the Bambu Cloud sync chip), forwarded to
   * `SliceSettingsPanel`. Only the workspace host passes one: the public editor has no
   * workspace or plugin graph. See the prop's doc there.
   */
  presetSourceStatus?: ReactNode
  /**
   * Slice-time apply (only present when launched from the slice dialog).
   *
   * `contentBase` travels WITH the edit for the same reason it does on {@link onSlice}: the host
   * holds this edit until the user submits a slice from the slim dialog, and by then the session
   * may have saved, moving the file's head off the bytes the edit describes.
   */
  onApply?: (edit: SceneEdit, contentBase: EditorContentBasePin | null, stagedFileId: string | null) => void
  /** Library folder + bridge to save new files into (from the host context). */
  folderId?: string | null
  bridgeId?: string | null
  /** Called after a successful save with the resulting library file. */
  onSaved?: (file: { id: string; name: string }) => void
  /** Called after a Save As (new file) so the host re-opens the editor on it. */
  onSavedAs?: (file: { id: string; name: string }) => void
  onClose: () => void
  /**
   * Full slice-settings controller (printer/process/filament/plate-type/nozzle)
   * shared with the slim slicing dialog. When present, the editor renders the
   * shared `SliceSettingsPanel` in its sidebar and can slice/print directly.
   */
  sliceConfig?: SliceSettingsController
  /**
   * The project's materials. Optional: with a slice controller present the editor derives them
   * from it, which is what the library host relies on. A host without one (the public editor)
   * passes them explicitly: see `lib/editorMaterials.ts`.
   */
  materials?: EditorMaterials
  /**
   * Where staged geometry lives: uploads to the api by default, or the caller's own store when
   * there is no server to stage on. See `lib/editorImportStore.ts`.
   */
  importStore?: EditorImportStore
  /**
   * Where the project is READ from: the api by default, or an archive the caller opened locally.
   * See `lib/editorProjectSource.ts`.
   */
  projectSource?: EditorProjectSource
  /**
   * Where a save GOES, a library version by default, or the user's own file. See
   * `lib/editorSaveTarget.ts`.
   */
  saveTarget?: EditorSaveTarget
  /**
   * Where the editor is being hosted. `dialog` (default) is the modal the library opens OVER a page,
   * so it sits maximized with a gutter and the page behind still reads as present. `page` is a host
   * where the editor IS the page, there is nothing behind it, so it takes the screen outright and
   * the user's own full-screen toggle has nothing left to hide.
   */
  hosting?: 'dialog' | 'page'
  /** Whether the slice's printer/process/filament settings are complete. */
  canSlice?: boolean
  /** When the Slice button is disabled, a short reason shown as its tooltip. */
  sliceDisabledReason?: string
  /** A slice job is in flight (drives the Slice button's loading state). */
  slicing?: boolean
  /**
   * Slice a single 1-based plate without persisting a project; the host opens a results dialog that
   * can save/print.
   *
   * `contentBase` is the session's pinned base (`contentBasePin.ts`) and the host MUST forward it:
   * the `sceneEdit` is a diff against those bytes, so a slice that resolved the file's CURRENT
   * content would re-apply an edit an earlier save already baked in. See `EditorSave.contentBase`.
   */
  onSlice?: (opts: {
    plate: number
    sceneEdit: SceneEdit
    contentBase: EditorContentBasePin | null
    /**
     * A hidden staged row holding the baked result of `sceneEdit`, to slice in the project's place.
     *
     * Null when this host cannot stage. The `sceneEdit` still travels, because the dialog reads it
     * to know it is looking at an editor slice, but it is the STAGED bytes that get sliced.
     */
    stagedFileId: string | null
  }) => void
}

/**
 * A 12-number component transform as the position/rotation/scale an added part carries.
 *
 * The WHOLE matrix, not just its translation. Taking only the translation looked safe on the
 * assumption that an SVG piece is authored axis-aligned, which is true of the pieces OUR tool makes
 * and false of everything that happens to them afterwards: a volume the user rotated, or one
 * embossed and turned in BambuStudio, snapped back to axis-aligned on a width change.
 */
function decomposeThreeMfTransform(transform: number[]): {
  position: THREE.Vector3
  rotation: THREE.Euler
  scale: THREE.Vector3
} {
  const matrix = new THREE.Matrix4().fromArray([
    transform[0] ?? 1, transform[1] ?? 0, transform[2] ?? 0, 0,
    transform[3] ?? 0, transform[4] ?? 1, transform[5] ?? 0, 0,
    transform[6] ?? 0, transform[7] ?? 0, transform[8] ?? 1, 0,
    transform[9] ?? 0, transform[10] ?? 0, transform[11] ?? 0, 1
  ])
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  matrix.decompose(position, quaternion, scale)
  return { position, rotation: new THREE.Euler().setFromQuaternion(quaternion), scale }
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

/** How a plate edit touches the live 3D scene: see {@link EditorView}'s `updatePlates`. */
type PlateEditKind = 'structure' | 'transform' | 'material' | 'visibility' | 'inert'

/** Stable empty per-object overrides so the override editor doesn't re-fetch each render. */
const EMPTY_OBJECT_OVERRIDES: ProcessSettingOverrides = {}

/**
 * Shared empty list for the repair reasons.
 *
 * A `?? []` fallback mints a new array on every render, and the no-defect case is the common one,
 * so the reasons -- and everything memoised on them, up to the settings panel's whole controller
 * object -- would have been unstable exactly when there was nothing to report.
 */
const NO_REPAIR_REASONS: readonly ThreeMfSettingsRepairReason[] = []

/**
 * Trailing delay before a filament-swatch edit is mirrored into the plate-strip thumbnail. The
 * colour picker commits on every drag tick and a snapshot is a full offscreen render plus a
 * synchronous `toDataURL` readback, so only the settled colour is worth rendering.
 */
const THUMBNAIL_RECOLOUR_DEBOUNCE_MS = 250

/**
 * What the next picked model file is for. The library picker and the hidden file input are shared
 * by three flows (add a model to the plate, replace a model's geometry, add a part inside a model),
 * so the pending request decides where the staged import lands. Absent = add to the plate.
 */
/**
 * Above this many drawn shapes an SVG comes in as ONE part.
 *
 * Splitting is for logos, where a handful of shapes each want their own material; an illustration
 * with hundreds of paths would bury the object list and make the editor unusable rather than more
 * controllable.
 */
const SVG_MAX_PARTS = 24

/** Concatenate triangle soups that already share a coordinate frame. */
/**
 * Every part of an object as selection members, both kinds, in the order the sidebar lists them:
 * the parts baked into the project's 3MF, then the volumes added this session.
 *
 * The ORDER is load-bearing. A shift-range slices this list, so listing the volumes anywhere other
 * than where the rows actually appear would select a different set than the one dragged across.
 */
function ownerPartMembers(instance: EditorInstance, state: EditorState | null): PartMember[] {
  const added = effectiveAddedParts(state, instance)
  return [
    ...(instanceVolumeRows(instance, added.length).showBodyRow ? [{ kind: 'body' } as PartMember] : []),
    ...instance.parts.map((part): PartMember => ({ kind: 'baked', partIndex: part.partIndex })),
    ...added.map((part): PartMember => ({ kind: 'added', key: part.key }))
  ]
}

function mergeSoups(soups: Float32Array[]): Float32Array {
  if (soups.length === 1) return soups[0]!
  const merged = new Float32Array(soups.reduce((total, soup) => total + soup.length, 0))
  let at = 0
  for (const soup of soups) {
    merged.set(soup, at)
    at += soup.length
  }
  return merged
}

type ModelSourceRequest =
  | { kind: 'replace'; key: string }
  | { kind: 'addPart'; key: string; subtype: SceneEditPartSubtype }

/** Library-picker copy per {@link ModelSourceRequest} kind ('import' = no pending request). */
const LIBRARY_PICKER_COPY: Record<'import' | ModelSourceRequest['kind'], { title: string; description: string }> = {
  import: {
    title: 'Add from library',
    description: 'Choose an STL, STEP, or 3MF file to add to this project.'
  },
  replace: {
    title: 'Replace from library',
    description: 'Choose an STL, STEP, or 3MF file to swap in for the selected object, its position and settings are kept.'
  },
  addPart: {
    title: 'Add part from library',
    description: 'Choose an STL, STEP, or 3MF file to add as a part inside the selected object.'
  }
}

function EditorView({
  baseFileId,
  isNewProject: isNewProjectScaffold = false,
  baseVersionId = null,
  initialPlateIndex,
  targetPrinterModel,
  bedModelPath,
  flushDataPath,
  flushCalibrationPath,
  resolveProcessConfig,
  resolveFilamentConfig,
  repairReasons,
  unrepairableRepairReasons,
  presetManager,
  presetSourceStatus,
  onApply,
  folderId = null,
  bridgeId = null,
  onSaved,
  onSavedAs,
  onClose,
  sliceConfig,
  materials: materialsProp,
  importStore: importStoreProp,
  projectSource: projectSourceProp,
  saveTarget,
  hosting = 'dialog',
  canSlice = false,
  sliceDisabledReason,
  slicing: slicingProp = false,
  onSlice
}: EditorViewProps) {
  // `hasNoBaseFile` gates DATA loading (a fileless project seeds empty, skipping the scene
  // queries). A scaffold-backed new project DOES have a base file (it carries the bed/settings),
  // so it still loads, only the SAVE/heading behaviour treats it as new.
  // Gates DATA loading. A locally-opened project has no library file id but DOES have a project to
  // read, so a supplied source counts as having one, otherwise the editor would seed empty and
  // ignore the file the user just picked.
  const hasNoBaseFile = baseFileId === null && projectSourceProp == null
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
  /**
   * Which plate's settings dialog is open, by its session-stable `plateId`, or null for none.
   *
   * NOT the live index, per this plugin's rule that `index` is a POSITION: undo is armed while the
   * dialog is open (a Joy Select button is not a typing target, so the shortcut hook does not skip
   * it), so a Ctrl+Z that adds, removes or reorders a plate would otherwise leave Apply writing the
   * draft onto whichever plate slid into that number.
   */
  const [plateSettingsId, setPlateSettingsId] = useState<number | null>(null)
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
  // Materials come through the EditorMaterials seam, not off the slice controller directly, so a
  // host that has no slice dialog (the public editor, which opens a file from disk) can supply them
  // from the project's own filament list. See `lib/editorMaterials.ts`.
  // Keyed on the CONTENT this reads, not on `sliceConfig`'s identity. The controller is built as a
  // fresh literal on every render of the host dialog, so an identity dep re-derives `materials` on
  // every one of those renders -- a new object and a new colour map each time, which is an unstable
  // prop straight into the memoised `ObjectList` and defeats it exactly when the host is busiest.
  // The live object is still read inside the body; only the signature decides when to recompute.
  const materialsSignature = JSON.stringify([
    sliceConfig?.projectFilaments ?? null,
    sliceConfig?.filamentColors ?? null,
    sliceConfig?.filamentMaterialOptionIds ?? null,
    sliceConfig?.materialOptions ?? null
  ])
  const materials = useMemo(
    () => materialsProp ?? editorMaterialsFromSliceConfig(sliceConfig),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [materialsProp, materialsSignature]
  )
  // The api store is stateless and shared; a host-supplied one owns its own lifetime (the caller
  // disposes it), so this must not create or dispose anything itself.
  const importStore = useMemo(() => importStoreProp ?? createApiImportStore(), [importStoreProp])
  // Both are read off the store rather than a public-host flag, so the rule stays "what this store
  // supports" and cannot drift from the store that has to honour it. Today the hosts differ only in
  // the library (a server-less one has none); the formats they stage are the same.
  const canImportFromLibrary = importStore.supportsLibrarySource
  const importAccept = useMemo(() => importFileAccept(importStore), [importStore])
  // A save target that is not library-backed writes to the user's own file. There is no library
  // folder to choose and no "version" concept, so Save means "write it back" and Save-as means
  // "ask the OS where", never the library destination dialog.
  // Memoized on `resourceBase`: the source owns one downloaded archive, so an identity that
  // changed each render would re-download the project and re-key every query that depends on it.
  const projectSource = useMemo(
    () => projectSourceProp ?? createArchiveProjectSource(resourceBase),
    [projectSourceProp, resourceBase]
  )
  // Read through a ref by the callbacks that must not re-create themselves when the source's
  // identity changes (the SVG reopen, which reads an archive entry on demand).
  const projectSourceRef = useRef(projectSource)
  projectSourceRef.current = projectSource
  // Only names the upload session: an addressed new version keeps the row's OWN name, precisely
  // because this session's copy of it may be stale.
  const projectNameRef = useRef('project.3mf')
  /**
   * The workspace save target, built here rather than defaulted inside `useEditorSave`, because it
   * needs what only this component holds: the archive this session OPENED, which every bake authors
   * from, and the import store the `SceneEdit` refers to.
   *
   * Read through the refs so one target survives a re-render. The archive accessor is deliberately
   * not an async open: a bake must author from the bytes this session has been reading all along,
   * and re-fetching would author from whatever the file holds now, which after an earlier save is
   * this session's own output.
   */
  const workspaceSaveTarget = useMemo(
    () => createApiSaveTarget({
      archive: () => projectSourceRef.current.archive(),
      importStore,
      projectName: () => projectNameRef.current
    }),
    [importStore]
  )
  const effectiveSaveTarget = saveTarget ?? workspaceSaveTarget
  const savesToLocalFile = !effectiveSaveTarget.isLibraryBacked
  // Only dispose a source this component created; a host that supplies one owns its lifetime
  // (same rule as `importStore`). Without this the archive and its plate-thumbnail object URLs
  // would outlive every editor open.
  useEffect(() => {
    if (projectSourceProp) return
    return () => projectSource.dispose?.()
  }, [projectSource, projectSourceProp])

  // Drop this session's cached view of the file when the editor closes.
  //
  // These caches are answered from an archive downloaded ONCE per session, so anything cached
  // after a save describes the pre-save bytes. Leaving it behind is what let a reopen (same page,
  // within staleTime) seed from the previous session's stale scene. Removing rather than
  // invalidating is the point: a later session must READ the file, not inherit a view of it.
  useEffect(() => () => {
    queryClient.removeQueries({ queryKey: ['library-editor-plates', baseFileId] })
    queryClient.removeQueries({ queryKey: ['library-editor-scene-initial', baseFileId] })
    queryClient.removeQueries({ queryKey: ['library-editor-scenes-rest', baseFileId] })
    // The file's own DTO goes too. Nothing invalidates this key (`library-files` does not prefix-match
    // `library-file`), so at a 60s staleTime a reopen inside that window inherits the PRE-save row,
    // including `currentVersionNumber`, which seeds the concurrent-save baseline. That made an
    // ordinary save-close-reopen-save loop accuse the user of overwriting their own previous save.
    queryClient.removeQueries({ queryKey: ['library-file', baseFileId] })
  }, [queryClient, baseFileId])
  // `filamentColors` only changes identity when a colour actually changes, so it's
  // safe as an effect dependency; the ref lets stable callbacks read it live.
  const filamentColors = materials.colorById
  const filamentColorsRef = useRef(filamentColors)
  filamentColorsRef.current = filamentColors
  // Ref-backed so paint-overlay callbacks can resolve live colours without rebinding.
  const resolveColorFilamentIdRef = useRef<(id: number | null) => number | null>(() => null)
  // Live recolour after a material is removed: a part referencing a now-gone material
  // shows material 1's colour (the backend reassigns it to material 1 at save/slice).
  const projectFilamentIds = useMemo(() => new Set(materials.options.map((option) => option.id)), [materials])
  const fallbackFilamentId = materials.options[0]?.id ?? null
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

  /**
   * Attach this session's (or the source mesh's) paint overlays to a freshly built part mesh.
   *
   * Shared by the in-project, IMPORT and session-added render paths so every printed mesh shows
   * paint the same way: they are painted through the same state map and emitted at bake time, and
   * the only thing that differs is which KEY names the mesh, which is why the caller supplies it
   * rather than the three identities being pulled apart in here.
   */
  const seedPaintOverlays = useCallback((mesh: THREE.Mesh, paintKey: string, instanceKey: string) => {
    for (const channel of TRIANGLE_PAINT_CHANNELS) {
      const spec = PAINT_CHANNEL_SPECS[channel]
      const sessionCodes = stateRef.current?.[spec.stateKey]?.[paintKey]
      const codes = sessionCodes ?? getGeometryTrianglePaint(mesh.geometry, channel)
      if (!codes || Object.keys(codes).length === 0) continue
      const overlay = buildTrianglePaintOverlay(mesh.geometry, codes, {
        palette: spec.palette,
        name: spec.overlayName,
        offsetFactor: spec.offsetFactor,
        ...(channel === 'color' ? { colorForState: colorPaintStateColor } : {})
      })
      if (!overlay) continue
      // Seeded with the SAME rule the per-frame sync applies. Without this the overlay inherited
      // three's default `visible = true` and every rebuild flashed the painted channels over the
      // model, because the sync only re-runs when the tool, selection or drag state changes and a
      // rebuild changes none of them.
      overlay.visible = paintOverlayVisible(channel, activePaintChannelRef.current, instanceKey === selectedKeyRef.current)
      mesh.add(overlay)
    }
    // The two refs are declared LATER in this component (they come out of the paint hook), so they
    // cannot be listed here even though the body reads them. That is sound: a ref's identity never
    // changes, and this body only runs during an async plate build, long after both exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorPaintStateColor])

  const filamentOptions = materials.options
  const platesQuery = useQuery({
    queryKey: ['library-editor-plates', baseFileId, baseVersionId ?? 'current'],
    enabled: !hasNoBaseFile,
    queryFn: ({ signal }) => projectSource.loadIndex(signal),
    staleTime: 60_000
  })

  // The presets the project carries inside itself. `staleTime: Infinity` because they come from the
  // archive this session already holds and nothing outside the session can change them: the file
  // on disk is not re-read until the next open (see `in-memory-after-open`).
  const embeddedPresetsQuery = useQuery({
    queryKey: ['library-editor-embedded-presets', baseFileId, baseVersionId ?? 'current'],
    enabled: !hasNoBaseFile && typeof projectSource.loadEmbeddedPresets === 'function',
    queryFn: () => projectSource.loadEmbeddedPresets?.() ?? Promise.resolve([]),
    staleTime: Infinity
  })

  // The project's own settings, for the purge volumes the flushing dialog edits. Same
  // `staleTime: Infinity` reasoning as the embedded presets above: it comes from the archive this
  // session already holds, and the file is not re-read until the next open.
  const projectSettingsQuery = useQuery({
    queryKey: ['library-editor-project-settings', baseFileId, baseVersionId ?? 'current'],
    enabled: !hasNoBaseFile && typeof projectSource.loadProjectSettings === 'function',
    queryFn: () => projectSource.loadProjectSettings?.() ?? Promise.resolve(null),
    staleTime: Infinity
  })

  // BambuStudio parity: a project must have a material, and a material in use can't be removed.
  // `usedFilamentIds` is the live set of materials referenced by any object/part, layer filament
  // change, colour paint, OR support setting (across every plate); `hasMaterials` whether the
  // project has any material at all. Support materials count even though no geometry references
  // them directly: the baked `support_filament`/`support_interface_filament` (from the loaded
  // index) plus any live session override of those settings. We track the OBJECT side and the
  // SUPPORT side separately so the remove-blocked copy can be accurate: `supportOnlyFilamentIds`
  // is the materials used ONLY for supports (no object/part/layer/paint reference), which earn the
  // "used for supports" wording rather than "used by an object". Both are derived through a stable
  // string key so they only change identity when the materials actually in use change, not on
  // every drag, so they can gate the memoized settings-panel controller.
  const bakedSupportFilamentIds = platesQuery.data?.supportFilamentIds
  const sessionSupportOverrides = sliceConfig?.perObjectSettings
  // Paint mutates `EditorState` IN PLACE (a clone per pointer-move would be brutal), so the state
  // object's identity does not change when a stroke lands, and the usage memo below is keyed on
  // it. This revision is bumped once per committed stroke (and by clear-paint) so the used-material
  // set re-derives: without it a painted material stayed "unused" (removable, and no prime tower)
  // until some unrelated edit happened to replace the state object.
  const [paintRevision, setPaintRevision] = useState(0)
  const paintCommittedRef = useRef<(() => void) | null>(null)
  paintCommittedRef.current = () => setPaintRevision((revision) => revision + 1)
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
    // Colour-painted triangles reference materials through their paint codes. Walk the whole split
    // TREE, not just whole-triangle codes: a brush dab splits triangles, so a partially painted
    // model's second filament would otherwise read as unused: removable, and no prime tower.
    for (const channel of [state?.colorPaint]) {
      for (const codes of Object.values(channel ?? {})) {
        for (const code of Object.values(codes)) collectColorPaintFilamentIds(code, objectIds)
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
    // PROMOTE a support reference to genuine usage when the baked index attributes it to a plate.
    // The index only does that for an object carrying its OWN `enable_support` opt-in (see
    // `parseModelSettingsObjectFilamentIds`), which is the case the project-wide toggle hides: a
    // process with support DISABLED but a support-interface material set, plus per-object overrides
    // turning support on, really does print in that material, so it must not read as "referenced
    // only by a setting" and be freely removable. A support material no plate attributes stays
    // support-only (removable, BambuStudio drops the setting to Default). Deliberately conservative:
    // the attribution comes from the baked file, so turning those overrides off in-session keeps the
    // material blocked until reopen rather than risking a silent print change.
    const bakedPlateFilamentIds = new Set<number>()
    for (const plate of platesQuery.data?.plates ?? []) {
      for (const filament of plate.filaments) bakedPlateFilamentIds.add(filament.id)
    }
    for (const id of supportIds) {
      if (bakedPlateFilamentIds.has(id)) objectIds.add(id)
    }
    const sortJoin = (ids: Set<number>) => [...ids].sort((left, right) => left - right).join(',')
    return `${sortJoin(objectIds)}|${sortJoin(supportIds)}`
    // `paintRevision` is an INVALIDATION KEY, not a value this body reads: paint mutates the state
    // object in place, so its identity cannot signal a stroke (see the revision's declaration).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, paintRevision, bakedSupportFilamentIds, sessionSupportOverrides, platesQuery.data])
  const { usedFilamentIds, supportOnlyFilamentIds } = useMemo(() => {
    const [objectStr = '', supportStr = ''] = usageKey.split('|')
    const objectIds = new Set(objectStr ? objectStr.split(',').map(Number) : [])
    const supportIds = new Set(supportStr ? supportStr.split(',').map(Number) : [])
    return {
      usedFilamentIds: new Set<number>([...objectIds, ...supportIds]),
      supportOnlyFilamentIds: new Set<number>([...supportIds].filter((id) => !objectIds.has(id)))
    }
  }, [usageKey])
  const hasMaterials = materials.options.length > 0

  // Flips true once the Three.js scene/plate root exist, so the plate-build effect
  // re-runs and renders the initial plate even though `activePlateIndex` is stable
  // (the canvas only mounts after data loads, so the scene is created after the
  // first build attempt would otherwise have bailed).
  const [sceneReady, setSceneReady] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>(RESTING_GIZMO_MODE)
  // 3D build plate (BambuStudio's modelled bed): shared with the read-only previews, so the
  // preference and its default live in the hook. Printers with no bundled bed mesh fall back to
  // the plain grid on their own.
  const showBedModel = useShowBedModel()
  // Which side the settings/objects panel sits on (desktop only: the narrow layout stacks it
  // below the viewport regardless). Read-only here: the workspace default and this device's
  // override are both edited in the editor settings dialog.
  const sidebarSide = useEffectiveSidebarSide()
  const [bedModelGeometry, setBedModelGeometry] = useState<THREE.BufferGeometry | null>(null)
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false)
  // The preset manager is its own dialog, supplied by the host and reached from the sidebar's
  // "Manage" action; the gear opens editor settings. Deliberately no path from one to the other:
  // see EditorSettingsDialog.
  const [slicingPresetsOpen, setSlicingPresetsOpen] = useState(false)
  const openSlicingPresets = useCallback(() => setSlicingPresetsOpen(true), [])
  // Cut tool: plane axis + offset (world mm), the selected object's range along that axis,
  // sides to keep, and the staging-in-flight flag for the Cut button. The offset is kept raw
  // while typing; consumers clamp it to the range.
  const [cutAxis, setCutAxis] = useState<CutAxis>('z')
  const [cutOffset, setCutOffset] = useState(0)
  const [cutRange, setCutRange] = useState<{ min: number; max: number } | null>(null)
  const [cutKeepUpper, setCutKeepUpper] = useState(true)
  const [cutKeepLower, setCutKeepLower] = useState(true)
  // Per-half orientation after the cut (BambuStudio's Keep orientation / Place on cut / Flip).
  // Both default to `keep`, which is what the tool did before the choice existed. Studio instead
  // defaults its upper half to Place on cut; matching that would silently change what an existing
  // cut produces, so it stays an explicit choice rather than a new default.
  const [cutOrientUpper, setCutOrientUpper] = useState<CutHalfOrientation>('keep')
  const [cutOrientLower, setCutOrientLower] = useState<CutHalfOrientation>('keep')
  const [cutting, setCutting] = useState(false)
  const clampedCutOffset = cutRange ? Math.min(Math.max(cutOffset, cutRange.min), cutRange.max) : cutOffset
  // Dovetail (BambuStudio's tongue-and-groove) cut. The angles and tolerances are PREFERENCES and
  // persist across objects, while depth and width are sized from whatever model the tool opens on
  // (see the seeding effect) -- 4mm deep is a sturdy key in a 100mm box and an amputation in a 6mm
  // one, which is why Studio derives them from the bounding box too.
  const [cutMode, setCutMode] = useState<CutMode>('plane')
  const [groove, setGroove] = useState<GrooveCut>(() => ({ depth: 4, width: 16, ...GROOVE_CUT_DEFAULTS }))
  const [cutObjectSize, setCutObjectSize] = useState<{ x: number; y: number; z: number } | null>(null)
  /** Which object the groove's depth/width were last sized for, so an AXIS change does not resize them. */
  const grooveSizedForRef = useRef<string | null>(null)
  const grooveSizeLimits = useMemo(
    () => grooveSizeLimitsForSize(cutObjectSize ?? { x: 0, y: 0, z: 0 }),
    [cutObjectSize]
  )
  // A connector is a peg through the cut face, not a channel across the part, so it has its own
  // range. It also tolerates a null size, which the groove range cannot: before the cut-plane
  // effect measures the object, `{x:0,y:0,z:0}` collapsed the groove range to `{min:1,max:1}` and
  // clamped the connector defaults the moment anyone touched the field.
  const connectorSizeLimits = useMemo(() => connectorSizeLimitsForSize(cutObjectSize ?? null), [cutObjectSize])
  /**
   * Cut connectors, and whether a click on the cut plane places one.
   *
   * The settings are shared by every connector rather than held per connector, which is a
   * deliberate divergence from Studio: it edits whichever connectors are SELECTED, showing blank
   * fields where a multi-selection disagrees. Uniform settings need no selection model, no
   * mixed-value rendering, and match what a joint actually wants -- matching pegs. Placement stays
   * per connector, which is the part that has to vary.
   */
  const [cutConnectors, setCutConnectors] = useState<CutConnector[]>([])
  const [cutConnectorMode, setCutConnectorMode] = useState(false)
  /** Which half stays visible while placing. Both faces are the same surface, seen from either side. */
  const [cutConnectorFace, setCutConnectorFace] = useState<'lower' | 'upper'>('lower')
  const [connectorSettings, setConnectorSettings] = useState<ConnectorSettings>({ ...CONNECTOR_DEFAULTS })
  /**
   * Whether clicking the cut face places connectors RIGHT NOW.
   *
   * Derived rather than stored, on the same rule as {@link activeConnectors} below: connectors are a
   * PLANE-cut affordance, and the panel hides the whole section -- the "Done placing" toggle
   * included -- in Dovetail. Read as raw state, switching mode mid-placement left the cross-section
   * clipping half the model away with the ghost still tracking the pointer and no reachable control
   * to turn either off. Switching back to Plane resumes placing, which is what the still-lit button
   * in the panel promises.
   */
  const placingConnectors = cutConnectorMode && cutMode === 'plane'
  const cutConnectorModeRef = useRef(false)
  cutConnectorModeRef.current = placingConnectors && gizmoMode === 'cut'
  const cutConnectorTargetsRef = useRef<{
    plane: THREE.Object3D | null
    /** The visible cut face. Hitting it is proof the point is on the cross-section. */
    section: THREE.Object3D | null
    markers: THREE.Object3D[]
  }>({ plane: null, section: null, markers: [] })
  /**
   * The selected object's world triangles while the cut tool is open, which the connector rules are
   * checked against. STATE rather than a ref even though it is large: it is captured once per tool
   * open or axis change, both of which already re-render, and holding it as state is what lets the
   * validity memo and the click handler say plainly what they depend on.
   */
  const [cutSoup, setCutSoup] = useState<Float32Array | null>(null)
  /**
   * Connectors apply to a PLANE cut only, mirroring Studio's `apply_connectors_in_model`, which
   * returns early for tongue-and-groove. The panel hides the whole section in Dovetail mode, so
   * anything still placed must stop counting there too -- otherwise the halves silently gain pegs
   * against an interface that is not a flat plane, and an invalid one left the Cut button disabled
   * with no visible cause and no reachable control to clear it.
   */
  const activeConnectors = useMemo(
    () => (cutMode === 'plane' ? cutConnectors : []),
    [cutMode, cutConnectors]
  )
  /**
   * Containment answers, cached across recomputes. Keyed on the connector's POSITION rather than its
   * id, and dropped whenever the geometry changes, so a cached answer can only ever describe the
   * exact point and mesh it was measured on -- a stale "inside" would let an invalid connector cut.
   */
  const insideCacheRef = useRef(new Map<string, boolean>())
  useEffect(() => { insideCacheRef.current.clear() }, [cutSoup])
  const activeProblems = useMemo(() => {
    if (!cutSoup) return new Map()
    const cache = insideCacheRef.current
    return findConnectorProblems(activeConnectors, cutSoup, (connector) => {
      const key = `${connector.x},${connector.y},${connector.z}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const inside = isPointInsideSoup(cutSoup, connector)
      cache.set(key, inside)
      return inside
    })
  }, [activeConnectors, cutSoup])
  // Measure tool: up to two picked points (world mm). Clicks snap to nearby mesh
  // corners (MEASURE_SNAP_PX); a third click starts a new measurement. The scene
  // overlay and the readout panel both derive from these points.
  const [measurePoints, setMeasurePoints] = useState<MeasurePick[]>([])
  const addMeasurePointRef = useRef<((pick: MeasurePick) => void) | null>(null)
  // Read by the Delete shortcut, which is a stable callback and cannot close over the live array.
  const measurePointsRef = useRef<MeasurePick[]>([])
  measurePointsRef.current = measurePoints
  /**
   * The centre marker of each selected circle, handed to the scene so a ray can reach it.
   *
   * The screen-space rule in `lib/circleScreenZone.ts` covers a POINTER, which arrives over a hole
   * having crossed its rim. A tap does not: it has no hover path, so nothing tells the pick which
   * circle it is inside. Raycasting the drawn marker needs no history and is what makes the centre
   * selectable on touch at all.
   */
  const measureCentreTargetsRef = useRef<Array<{ object: THREE.Object3D; slot: number }>>([])
  /**
   * Take one pick into the two selection slots, BambuStudio's `detect_current_item` rules
   * (`GLGizmoMeasure.cpp:281`).
   *
   * The important one is that a third click OVERWRITES the second slot rather than starting over,
   * which is what lets a datum be pinned and the second pick swept around it -- "how far is
   * everything from this hole" is one click per answer instead of two. Ours restarted from empty,
   * so the datum had to be re-picked every time.
   *
   * Clicking a feature that is already selected is a DESELECT, and which slot it sits in decides
   * what that means: the second simply goes, while the first is replaced by the second (Studio's
   * `reset_feature1` shuffle) so the survivor becomes the new datum rather than leaving a hole in
   * slot one that nothing could fill.
   */
  addMeasurePointRef.current = (pick) => {
    setMeasurePoints((prev) => {
      const matches = (existing: MeasurePick) => sameMeasureFeature(existing.feature, pick.feature)
      const [firstPick, secondPick] = prev
      if (!firstPick) return [pick]
      if (!secondPick) return matches(firstPick) ? [] : [firstPick, pick]
      if (matches(secondPick)) return [firstPick]
      if (matches(firstPick)) return [secondPick]
      return [firstPick, pick]
    })
  }
  // Leaving the tool or switching plates discards the measurement.
  useEffect(() => {
    if (gizmoMode !== 'measure') setMeasurePoints([])
  }, [gizmoMode])

  // Fetch the printer's 3D plate mesh only while the option is on. A printer with no bundled
  // bed simply resolves null and the grid stays: see lib/bedModel.ts.
  //
  // Each cached geometry is released when it is replaced: switching printer model refetches, and
  // without this every switch leaked a bed geometry (CPU arrays plus its GPU upload). Disposing
  // the CACHED original is safe because the rendered beds are clones of it, so a live plate is
  // never pulled out from under the scene.
  useEffect(() => {
    const replaceGeometry = (next: THREE.BufferGeometry | null) => {
      setBedModelGeometry((previous) => {
        if (previous && previous !== next) previous.dispose()
        return next
      })
    }
    if (!showBedModel || !targetPrinterModel) {
      replaceGeometry(null)
      return undefined
    }
    const controller = new AbortController()
    void loadBedModelGeometry({
      printerModel: targetPrinterModel,
      slicerTargetId: sliceConfig?.selectedSlicerTargetId ?? null,
      basePath: bedModelPath,
      signal: controller.signal
    }).then((geometry) => {
      // A switch that lands after this fetch resolved must not strand the geometry it produced.
      if (controller.signal.aborted) geometry?.dispose()
      else replaceGeometry(geometry)
    })
    return () => controller.abort()
  }, [showBedModel, targetPrinterModel, sliceConfig?.selectedSlicerTargetId, bedModelPath])
  useEffect(() => {
    setMeasurePoints([])
  }, [activePlateIndex])
  /**
   * What the two picked features measure.
   *
   * A CIRCLE measures from its RIM, and its centre is a selection of its own -- point at the ring and
   * you measure the ring, click the dot at the middle and you measure the middle. DIVERGENCE from
   * Studio, which hard-codes `deal_circle_result` true for every measurement its GUI takes
   * (`GLGizmoMeasure.cpp:2589`) so that a circle always collapses to its centre.
   *
   * Studio's rule makes its own centre control useless, which is how this surfaced: against an edge
   * both settings answered with the centre distance, so a toggle labelled "Center of circle" changed
   * nothing, and the rim distance -- the wall thickness between a hole and an edge, the thing
   * actually being asked -- could not be reached at all. Ours means what the labels say.
   *
   * Hole-to-hole centre spacing is still one click away: select each centre dot rather than each rim.
   */
  const measureResult = useMemo(() => {
    const [a, b] = measurePoints
    if (!a || !b) return null
    return getMeasurement(a.feature, b.feature)
  }, [measurePoints])
  // Brim-ear tool: diameter (mm) of newly placed ears.
  const [brimEarDiameter, setBrimEarDiameter] = useState(8)
  const brimEarDiameterRef = useRef(brimEarDiameter)
  brimEarDiameterRef.current = brimEarDiameter
  // The single part currently holding the transform gizmo, of EITHER kind: a part baked into the
  // project's 3MF (addressed by its ORDINAL within the object) or a volume added this session
  // (addressed by its own key). The move/rotate/scale gizmo attaches to that part's mesh instead
  // of the object while set.
  //
  // ONE state rather than the two this used to be. Everything that asks "is a part selected" wants
  // the union, and while the added kind had a state of its own every clearing site had to remember
  // it separately -- which several did not, so Ctrl+A and a range-click could leave a volume
  // highlighted with nothing else selected (see `hasEditorSelection`).
  //
  // A baked member is never keyed by `componentObjectId`: that is the MESH the part references, and
  // one mesh may back several parts of the same object, so it does not identify a part. Placement
  // edits are geometry-level: they apply to every instance of the object and are emitted as
  // SceneEdit.partTransforms.
  const [gizmoPart, setGizmoPart] = useState<PartRef | null>(null)
  const gizmoPartRef = useRef(gizmoPart)
  gizmoPartRef.current = gizmoPart
  /**
   * Whether a PART of either kind is selected, for the keyboard shortcuts.
   *
   * They cannot ask `selectedKeyRef`, because the bulk part path nulls the object key on purpose, so
   * Delete over a visible multi-part selection reached the handler with nothing to act on and
   * silently did nothing. Assigned below the part-selection state, which is declared later.
   */
  const partSelectedRef = useRef(false)
  /**
   * The gizmo'd part as a session-added volume key, or null when it is a baked part.
   *
   * A narrow VIEW, not a second state. A few features are genuinely about one kind -- re-editing a
   * text volume, routing a drag write-back to the right seam -- and reading the union there would
   * claim a generality they do not have. Anything that merely asks "is some part selected" must use
   * `gizmoPart` itself.
   */
  const selectedAddedPartKey = gizmoPart?.member.kind === 'added' ? gizmoPart.member.key : null
  /**
   * The selected BAKED part, on the same narrow-view rule as {@link selectedAddedPartKey}.
   *
   * Its one consumer is re-editing a part a PREVIOUS session authored: a text or SVG part becomes a
   * baked `<component>` the moment the project is saved, so without this the tools could only ever
   * reopen what the current session made, which is what limited them to a session for so long.
   */
  // Memoised on its PRIMITIVES, not built inline: this feeds a `useCallback` dependency array, and a
  // fresh object literal every render would change that callback's identity every render, which is
  // what silently defeats the memo on `ObjectList` (the most expensive thing the editor renders).
  const selectedBakedPartObjectId = gizmoPart?.member.kind === 'baked' ? gizmoPart.objectId : null
  const selectedBakedPartIndex = gizmoPart?.member.kind === 'baked' ? gizmoPart.member.partIndex : null
  const selectedBakedPart = useMemo(
    () => (selectedBakedPartObjectId != null && selectedBakedPartIndex != null
      ? { objectId: selectedBakedPartObjectId, partIndex: selectedBakedPartIndex }
      : null),
    [selectedBakedPartObjectId, selectedBakedPartIndex]
  )
  /**
   * What the placement panel calls itself.
   *
   * The BODY has no placement "within the object" -- the instance's placement IS where its geometry
   * sits, and these inputs write straight through to the object -- so it keeps the object's own
   * unlabelled panel rather than claiming an object-local frame it does not have.
   */
  const placementPanelHeading = gizmoPart && gizmoPart.member.kind !== 'body'
    ? 'Part placement (within the object)'
    : undefined
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
  /**
   * Instance keys whose geometry is actually IN the 3D scene. The object list is driven off this
   * while a build runs so the sidebar never lists models the viewport hasn't shown yet (a plate of
   * heavy assemblies used to populate the list instantly and then trickle into the view). Filled as
   * each model lands (incremental builds) and set to the finished set on the atomic swap.
   */
  const [renderedInstanceKeys, setRenderedInstanceKeys] = useState<ReadonlySet<string>>(new Set())
  const [placementWarnings, setPlacementWarnings] = useState<PlacementWarning[]>([])
  const placementWarningsSetterRef = useRef(setPlacementWarnings)
  // Dismissing the warnings panel hides the CURRENT set of issues (keyed by the same
  // JSON signature the validator dedupes on); any change to the set shows it again.
  const [dismissedWarningsSig, setDismissedWarningsSig] = useState<string | null>(null)
  const placementWarningsSig = useMemo(() => JSON.stringify(placementWarnings), [placementWarnings])
  const placementWarningsVisible = placementWarnings.length > 0 && placementWarningsSig !== dismissedWarningsSig
  const lastWarningSigRef = useRef('')
  // MACHINE-SWITCH WARNINGS. BambuStudio reports these too (it never silently moves a user's
  // objects, and it clamps an out-of-range layer height without comment): the gap was only WHEN:
  // an off-bed object used to surface as the CLI's "no object fully inside the print volume"
  // (exit 206) after a slice attempt, long after the switch that caused it. Fires once per model
  // change, and only after the warnings have settled for the NEW bed (the placement validator runs
  // off the rebuilt scene, so checking immediately would read the previous bed's verdict).
  const previousTargetModelRef = useRef<string | undefined>(undefined)
  const pendingSwitchModelRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousTargetModelRef.current
    previousTargetModelRef.current = targetPrinterModel
    // The FIRST resolve is the project's own machine, not a switch.
    if (previous === undefined || targetPrinterModel === undefined || previous === targetPrinterModel) return
    pendingSwitchModelRef.current = targetPrinterModel
  }, [targetPrinterModel])
  useEffect(() => {
    const model = pendingSwitchModelRef.current
    if (model == null || !sceneReady || viewportBuilding) return
    pendingSwitchModelRef.current = null
    const warnings = machineSwitchWarnings({
      printerModel: model,
      offBedObjectCount: placementWarnings.filter((warning) => warning.offBed).length,
      layerHeight: sliceConfig?.selectedProcessProfile?.layerHeight ?? null,
      machineProfile: sliceConfig?.selectedMachineProfile ?? null
    })
    for (const warning of warnings) toast.warn(warning.message)
  }, [placementWarnings, sceneReady, viewportBuilding, sliceConfig?.selectedProcessProfile?.layerHeight, sliceConfig?.selectedMachineProfile])
  // Forces an immediate placement-warning recompute, bypassing the rAF poll's per-frame gate.
  // The poll (in useEditorScene) only refreshes warnings ~4x/sec and is skipped while a drag
  // flag is set; the plate-build effect calls this right after a rebuild so undo/redo/delete/
  // duplicate reflect in the warning panel instantly instead of lagging (or, if a drag flag is
  // ever left stuck, never catching up). Assigned by useEditorScene.
  const recomputeWarningsRef = useRef<() => void>(() => undefined)
  // Cached XY footprint cell-sets per instance, keyed by transform signature so
  // collision checks only re-rasterize objects that actually moved.
  const footprintCacheRef = useRef<Map<string, { shapeSig: string; cells: Set<number>; baseX: number; baseY: number }>>(new Map())
  const [importing, setImporting] = useState(false)
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
  // What the next picked library file / uploaded local file is FOR. The library picker and the
  // hidden file input are shared by three flows, so the pending request, not a boolean each,
  // decides where the staged import lands. Null means "add it to the plate as a new model".
  const [modelRequest, setModelRequest] = useState<ModelSourceRequest | null>(null)
  const svgInputRef = useRef<HTMLInputElement | null>(null)
  // Pending export-to-library request (destination dialog open). 'object'/'merged'/'parts'
  // save one named STL; 'separate' saves one STL per selected object (no name field,
  // each file is named after its object). Downloads never set this; they run immediately.
  const [exportRequest, setExportRequest] = useState<
    | { kind: 'object'; key: string }
    | { kind: 'project'; key: string }
    | { kind: 'merged'; keys: ReadonlyArray<string> }
    | { kind: 'separate'; keys: ReadonlyArray<string> }
    // A vanilla 3MF for other slicers. ONE kind for any number of objects, unlike STL's
    // merged/separate pair: the format holds several named solids in a single file, so the
    // distinction those two exist to offer does not arise here.
    | { kind: 'generic3mf'; keys: ReadonlyArray<string> }
    // One kind for parts of either address space: a mixed set world-bakes through the same
    // traversal and exports as a single STL.
    | { kind: 'parts'; ownerId: number; members: ReadonlyArray<PartMember> }
    | null
  >(null)
  // Per-object process overrides now live inline in the sidebar object list (no
  // separate dialog/button); the active object's override editor is a sub-dialog.
  const perObject = sliceConfig?.perObjectSettings ?? null
  // Which instances actually print (BambuStudio's per-object "Printable" toggle). This is
  // an editor-owned per-instance flag carried through moves/duplicates and baked into the
  // SceneEdit, so it stays correct across plate changes: unlike the slice dialog's per-plate
  // object selection, which is keyed off the static baked index.
  const isInstancePrinted = useCallback((instance: EditorInstance) => instance.printable, [])
  const isInstancePrintedRef = useRef(isInstancePrinted)
  isInstancePrintedRef.current = isInstancePrinted
  // Object(s) whose per-object process overrides are being edited. Multiple ids = the bulk
  // context-menu action: the dialog seeds from every member ("Mixed" where they disagree) and
  // merges edits back onto each one (see lib/processBulkOverrides.ts).
  const [parameterTableOpen, setParameterTableOpen] = useState(false)
  const [editingObject, setEditingObject] = useState<{ ids: ReadonlyArray<number>; name: string } | null>(null)
  // Normal part(s) of one multi-part object whose per-part process overrides are being
  // edited. Multiple ids = the part-selection bulk action (same mixed-value bulk semantics).
  const [editingPart, setEditingPart] = useState<{ objectId: number; members: ReadonlyArray<PartMember>; name: string } | null>(null)
  /**
   * Layer height a NEW height range starts at: the project's own, else Bambu's 0.2 default. A band
   * must always name one, so this is a seed rather than an inherited blank.
   */
  const defaultLayerHeightMm = useMemo(() => {
    const raw = perObject?.globalOverrides?.layer_height
    const value = Number.parseFloat(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '')
    return Number.isFinite(value) && value > 0 ? value : 0.2
  }, [perObject])
  /**
   * The machine's first-layer height. Every layer-height profile must START with exactly this or
   * BambuStudio discards the whole curve and silently reverts the object to uniform layers
   * (`PrintObject.cpp:3341` compares it with `!=`), so it is threaded into every generator.
   */
  const firstLayerHeightMm = useMemo(() => {
    const raw = perObject?.globalOverrides?.initial_layer_print_height
    const value = Number.parseFloat(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '')
    return Number.isFinite(value) && value > 0 ? value : defaultLayerHeightMm
  }, [perObject, defaultLayerHeightMm])
  /** The object whose height ranges are open, and (when set) the band whose settings are open. */
  const [editingHeightRanges, setEditingHeightRanges] = useState<{ key: string; objectId: number; name: string } | null>(null)
  const [editingHeightRangeIndex, setEditingHeightRangeIndex] = useState<number | null>(null)
  /** The object whose variable layer height is open. */
  const [editingLayerHeight, setEditingLayerHeight] = useState<{ key: string; objectId: number; name: string } | null>(null)
  /** Text tool form state, and the part being edited when reopening existing text. */
  const [textTool, setTextTool] = useState<TextToolValue>({
    text: DEFAULT_TEXT, family: BUNDLED_FAMILIES[0] ?? 'DejaVu Sans', bold: false, italic: false,
    fontSize: TEXT_INFO_DEFAULTS.fontSize, thickness: TEXT_INFO_DEFAULTS.thickness,
    textGap: TEXT_INFO_DEFAULTS.textGap, rotateAngle: TEXT_INFO_DEFAULTS.rotateAngle,
    embeddedDepth: TEXT_INFO_DEFAULTS.embeddedDepth,
    surfaceMode: TEXT_INFO_DEFAULT_SURFACE_TYPE, operation: 'normal_part'
  })
  const [textUserFaces, setTextUserFaces] = useState<TextFontFace[]>([])
  const [editingTextPartKey, setEditingTextPartKey] = useState<string | null>(null)
  const editingTextPartKeyRef = useRef<string | null>(null)
  editingTextPartKeyRef.current = editingTextPartKey
  /** Where the thickness bar's brush is pointing, in OBJECT space, so the viewport can mark it. */
  const [layerHeightBrush, setLayerHeightBrush] = useState<{ z: number; bandWidth: number } | null>(null)
  // One override map per selected object, in selection order: the bulk dialog seeds from ALL of
  // them (disagreements render as "Mixed") rather than only the first member's map.
  const editingObjectMemberOverrides = useMemo(
    () => (editingObject && perObject
      ? editingObject.ids.map((id) => perObject.value[String(id)] ?? EMPTY_OBJECT_OVERRIDES)
      : null),
    [editingObject, perObject]
  )
  const { sidebarWidth, resizeHandleProps } = useSidebarResize(sidebarSide)
  const isMobile = useMobileViewport()
  // Sidebar visibility is a sticky per-device preference, like the plate strip's own collapse.
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState<boolean>(
    'bambu.editor.sidebarCollapsed',
    false,
    (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
    String
  )
  // The editor is maximized by nature, it has no smaller footprint to shrink to, so only the
  // full-screen toggle is offered, and a page host locks the whole thing to full screen. The shared
  // modes own the geometry and the rule that this toggle is never persisted (it hides Save).
  const { presentation, fullScreen, setFullScreen } = useDialogPresentationState({
    maximizedStorageKey: null,
    base: 'maximized',
    locked: hosting === 'page' ? 'fullscreen' : undefined
  })
  // A page host has nothing behind the editor, so its chrome stays: only the user's own toggle hides it.
  const showEditorChrome = !fullScreen
  const showSidebar = showEditorChrome && !sidebarCollapsed
  // The plate strip runs along whichever axis leaves the 3D area best proportioned, which depends on
  // the space actually available, so the body is measured rather than guessed from breakpoints.
  const [bodyNode, setBodyNode] = useState<HTMLDivElement | null>(null)
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!bodyNode) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect
      if (!box) return
      // Only a change that could flip the orientation is worth a re-render; the observer fires on
      // every drag frame of the sidebar resize.
      setBodySize((current) => (
        Math.abs(current.width - box.width) < 1 && Math.abs(current.height - box.height) < 1
          ? current
          : { width: box.width, height: box.height }
      ))
    })
    observer.observe(bodyNode)
    return () => observer.disconnect()
  }, [bodyNode])
  const plateStripOrientation = choosePlateStripOrientation({
    bodyWidth: bodySize.width,
    bodyHeight: bodySize.height,
    sidebarWidth: showSidebar ? sidebarWidth : 0,
    gap: EDITOR_GRID_GAP_PX
  })
  // On phones the 3D view and the sidebar can't sit side by side, so the user toggles between
  // them. The sidebar tab holds the SAME content as the desktop panel, settings, the object
  // list, the per-plate G-code rows, rather than splintering the object list into a surface of
  // its own, which hid it behind a second gesture and let the two layouts drift apart.
  const [mobileView, setMobileView] = useState<'view' | 'settings'>('view')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Live transform of the selected instance (mm / degrees / percent) for the
  // manual-input panel. Mirrors the gizmo and updates as the user drags.
  const [selectedTransform, setSelectedTransform] = useState<SelectedTransform | null>(null)
  // Per-axis uniform scale lock for the manual scale inputs.
  const [uniformScale, setUniformScale] = useState(true)
  // Rotation readout shown while the rotate gizmo or body-rotate is dragging.
  const [rotationReadout, setRotationReadout] = useState<number | null>(null)
  // Per-plate thumbnail data URLs, keyed by the plate's session identity (`plateId`, NEVER the
  // live index: reorders/removes renumber indices and an index-keyed cache leaves each image
  // parked on the position it was captured at while the plates move out from under it).
  const [plateThumbnails, setPlateThumbnails] = useState<Record<number, string>>({})
  /**
   * Plates (by `plateId`) whose thumbnail can no longer be trusted after a material was recoloured,
   * BOTH sources. The embedded PNG was baked by an earlier save, and a live thumbnail is just a
   * cached image of a plate that is not currently built, so neither follows a colour change. Only
   * the ACTIVE plate is genuinely repainted (the recolour traversal walks the groups in the live
   * scene, which are its).
   *
   * The strip stops showing a stale plate immediately, one advertising the wrong colour is worse
   * than one that admits it is loading, and a background pass re-renders them one at a time.
   */
  const [staleEmbeddedPlates, setStaleEmbeddedPlates] = useState<ReadonlySet<number>>(() => new Set())
  // Live (client-rendered) thumbnails, only set for plates the user has opened/edited. Read via
  // a ref at save time to know which plates to re-render.
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
  // Incremental-sync tokens: a scene edit that changes only transforms or only part materials must
  // NOT tear down and rebuild every part's geometry (murder on a hundred-part object). Instead of
  // bumping `rebuildToken`, such edits bump one of these and a light effect updates the live groups
  // in place: positions for `transform`, mesh colours for `material`. See `updatePlates`.
  const [transformSyncToken, setTransformSyncToken] = useState(0)
  const [materialSyncToken, setMaterialSyncToken] = useState(0)
  /** Saved filament ids a renumber is waiting on before it recolours; see handleFilamentsRenumbered. */
  const pendingRenumberIdsRef = useRef<number[] | null>(null)
  // Bumped to rebuild ONLY the place-on-face hull (not the whole plate) after a lay-flat re-orients
  // the part: the hull bakes the rotor's rotation in group-local space, so it must be rebuilt to
  // follow the new orientation instead of lingering stale.
  const [faceHullToken, setFaceHullToken] = useState(0)
  const rebuildFaceHullRef = useRef<() => void>(() => undefined)
  rebuildFaceHullRef.current = () => setFaceHullToken((token) => token + 1)
  // Latest controller, so the save handlers read the current machine selection (retarget
  // target / slicer version) without a stale closure or being re-created every render.
  const sliceConfigRef = useRef(sliceConfig)
  sliceConfigRef.current = sliceConfig
  // Declared here rather than beside `openSlicingPresets` because it reads the controller ref.
  const closeSlicingPresets = useCallback(() => {
    setSlicingPresetsOpen(false)
    // The editor renders from a catalogue snapshot taken at open, so a preset added or removed in
    // the manager would otherwise not reach it. This is the deliberate carve-out: a change the user
    // made THERE applies back, while ambient refetches stay excluded.
    sliceConfigRef.current?.refreshSlicingPresets?.()
  }, [])

  // ---- Undo/redo history -----------------------------------------------------
  // Undo/redo stacks plus unsaved-edit ("dirty") tracking, and the material add/remove
  // wrapper, live in useEditorHistory; the component just feeds it the state refs/setters.
  const {
    dirtyRef,
    markSaved,
    rebaseFilamentSources: rebaseHistoryFilamentSources,
    hasUnsavedChanges,
    canUndo,
    canRedo,
    undo,
    redo,
    undoRef,
    redoRef,
    recordHistory,
    recordHistoryRef,
    recordSliceConfigHistory,
    sliceConfigForPanel
  } = useEditorHistory({
    stateRef,
    setState,
    setSelectedKey,
    setActivePlateIndex,
    setRebuildToken,
    sliceConfig,
    usedFilamentIds,
    supportOnlyFilamentIds,
    // A scaffold has no machine of its own, so its SEEDED target is unsaved work from the start
    // (no baseline is captured until the first save): see the retarget-signature block.
    editorBorn: isNewProject
  })
  // Read through a ref so the save handler stays stable (it is built far below, and the history
  // action is re-created per render), the same shape as recordHistoryRef/undoRef.
  const rebaseHistoryFilamentSourcesRef = useRef(rebaseHistoryFilamentSources)
  rebaseHistoryFilamentSourcesRef.current = rebaseHistoryFilamentSources

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
  // Kept current for the upload session's name; see the ref's own note for why it is cosmetic.
  projectNameRef.current = baseFileQuery.data?.file.name ?? 'project.3mf'
  // Non-null only while the OPENED project is the one flagged as needing repair, an editor
  // opened on a new-project scaffold or an archived version has no repairable stored file.
  const needsSettingsRepairFileId = baseFileId !== null
    && !isNewProject
    && baseVersionId == null
    && baseFileQuery.data?.file.needsSettingsRepair === true
    ? baseFileId
    : null
  // The defects to warn about, from whichever source this host has: the library DTO, the OPENED
  // VERSION's own parse for an archived open, or the host's own parse. Kept separate from the file
  // id above because a host can have reasons and NO file (the public editor): conflating the two
  // is what made the notice workspace-only. An archived version reads its OWN parsed index, never
  // the library DTO: the DTO describes the file's head, which may already be repaired, that
  // mismatch is how defective old versions opened with no warning at all while the head was clean.
  const openedArchivedVersion = baseFileId !== null && !isNewProject && baseVersionId != null
  const rawSettingsRepairReasons: readonly ThreeMfSettingsRepairReason[] =
    (needsSettingsRepairFileId
      ? baseFileQuery.data?.file.settingsRepairReasons
      : openedArchivedVersion
        ? platesQuery.data?.settingsRepairReasons
        : repairReasons) ?? NO_REPAIR_REASONS
  // A repair the user ran THIS SESSION drops its reasons immediately, before any save: the session
  // is authoritative once the project is open, and leaving a warning up after the action that fixes
  // it reads as the action having failed. Both come back on undo for free, because the pins they
  // read live in the undo-cloned editor state.
  // Resolved from the SAME source as the reasons above, or the two disagree about one file: the
  // DTO describes the head while an archived version reads its own parsed index.
  const unrepairableRepairReasonsResolved: readonly ThreeMfSettingsRepairReason[] =
    (needsSettingsRepairFileId
      ? baseFileQuery.data?.file.unrepairableSettingsRepairReasons
      : openedArchivedVersion
        ? platesQuery.data?.unrepairableSettingsRepairReasons
        : unrepairableRepairReasons) ?? NO_REPAIR_REASONS
  // Memoised because it is a DEPENDENCY, not just a value: `handleRepairInEditor` closes over it,
  // and that handler rides the settings panel's controller object. Rebuilt inline every render it
  // made the whole panel's props unstable, so the panel could never be skipped.
  const settingsRepairReasons = useMemo(
    () => rawSettingsRepairReasons.filter((reason) => (reason === 'filamentPhysics'
      ? !state?.repairedFilamentConfigs
      : !state?.settingsRepairStaged)),
    [rawSettingsRepairReasons, state?.repairedFilamentConfigs, state?.settingsRepairStaged]
  )
  const editorFoldersQuery = useQuery({
    queryKey: ['library-folders', saveAsBridgeId ?? 'none'],
    enabled: saveAsBridgeId !== null,
    queryFn: ({ signal }) => apiFetch<{ folders: LibraryFolder[] }>(`/api/library/folders?bridgeId=${encodeURIComponent(saveAsBridgeId!)}`, { signal }),
    staleTime: 60_000
  })
  // Library permissions gate the object export-as-STL targets, mirroring LibraryView:
  // downloading to the PC needs library.download, exporting into the library needs
  // library.upload (both open when auth is disabled). The server enforces the upload
  // permission regardless; this only decides which menu items appear.
  const authBootstrapQuery = useAuthBootstrapQuery()
  const editorAuthEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const editorPermissions = authBootstrapQuery.data?.permissions
  // Downloading to your OWN machine is not a library operation: on a host with no library there is
  // no permission to hold, and gating it on one hid Export-as-STL and Download-3MF entirely for an
  // anonymous user editing their own file. Exporting INTO a library still needs the grant, and has
  // no meaning without one, so it stays off.
  const canExportDownload = savesToLocalFile || !editorAuthEnabled || (editorPermissions ?? []).includes(LIBRARY_DOWNLOAD_PERMISSION)
  const canExportToLibrary = !savesToLocalFile && (!editorAuthEnabled || (editorPermissions ?? []).includes(LIBRARY_UPLOAD_PERMISSION))

  const plateIndices = useMemo(
    () => (platesQuery.data?.plates ?? []).map((plate) => plate.index),
    [platesQuery.data]
  )

  // SOURCE plate indices whose 3MF carries an embedded PNG thumbnail. The plate strip shows that
  // cheap image for plates the user hasn't opened, so a large multi-plate project no longer
  // has to fetch + render every plate's geometry up front just to fill the selector.
  const platesWithEmbeddedThumbnail = useMemo(
    () => new Set((platesQuery.data?.plates ?? []).filter((plate) => plate.hasThumbnail).map((plate) => plate.index)),
    [platesQuery.data]
  )
  // Resolved through the plate's SOURCE index, the archive's numbering, never its live index:
  // after a reorder the plate at position 1 must keep fetching the PNG of the source plate it
  // came from, and a session-added plate (no source) has no embedded image at any position.
  const embeddedPlateThumbnailUrl = useCallback(
    (plate: EditorPlate): string | null => (
      plate.sourcePlateIndex !== null
      && platesWithEmbeddedThumbnail.has(plate.sourcePlateIndex)
      && !staleEmbeddedPlates.has(plate.plateId)
        ? projectSource.plateThumbnailUrl(plate.sourcePlateIndex)
        : null
    ),
    [platesWithEmbeddedThumbnail, projectSource, staleEmbeddedPlates]
  )

  // The plate the editor will open on: the host's pre-selected plate when it exists,
  // otherwise the first plate. Its scene loads FIRST so the user is never kept waiting on
  // plates they can't see; the rest stream in behind it (#28).
  //
  // Frozen after the first resolution: this only governs which plate loads first on open. The
  // editor mirrors the active plate back to the host's plate-number (for slicing), which feeds
  // back in as `initialPlateIndex`: if `preferredPlateIndex` followed that, every plate switch
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

  const fetchPlateScene = useCallback(
    (plateIndex: number, signal?: AbortSignal) => projectSource.loadScene(plateIndex, targetPrinterModel ?? null, signal),
    [projectSource, targetPrinterModel]
  )

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
      // requests on open, each forcing a full server-side root-model parse, an N-wide spike right
      // when the editor is mounting. A small worker pool turns that burst into a throttled trickle
      // (each plate's parse is cheap and now server-cached, so re-selecting one is free).
      const REST_SCENE_CONCURRENCY = 3
      const queue = [...restPlateIndices]
      const worker = async () => {
        for (;;) {
          const plateIndex = queue.shift()
          if (plateIndex === undefined) return
          const scene = await fetchPlateScene(plateIndex, signal)
          // Null means the plate carries no scene metadata (a geometry-only export). It simply
          // contributes no instances rather than failing the batch.
          if (scene) scenes.set(plateIndex, scene)
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
    // Keyed by plateId (scenes fetch by SOURCE index, but the set must follow the plate through
    // any reorder/remove that happens before its scene lands).
    pendingScenePlatesRef.current = new Set(
      seeded.plates
        .filter((plate) => plate.sourcePlateIndex !== null && !scenesByPlate.has(plate.sourcePlateIndex))
        .map((plate) => plate.plateId)
    )
    // `preferredPlateIndex` is a SOURCE index; the seeded plates are positional. Assigning it
    // directly deadlocked on archives whose plate list doesn't start at 1: see the helper's doc.
    setActivePlateIndex(seededActivePlateIndex(seeded.plates, preferredPlateIndex))
    setState(seeded)
  }, [hasNoBaseFile, platesQuery.data, initialSceneSettled, scenesByPlate, preferredPlateIndex])

  // Apply arriving scenes to the live state in ONE pass: fill plates that were seeded
  // before their scene loaded (only still-empty plates, so a user edit on a seemingly
  // empty plate is never clobbered; not an undoable edit), and keep every plate's bed +
  // unprintable zones in sync with the selected target printer (the scene queries refetch
  // when `targetPrinterModel` changes, it's in their keys). These MUST stay one effect:
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
    // late-loaded plates ended up empty: the per-part re-hydrate effect overwrote the
    // plate fill). Composing over `prev` makes the writes additive.
    // All three maps key on `plateId`: scenes are fetched by SOURCE index and the updater below
    // composes over a `prev` whose LIVE indices may have moved since this snapshot (a reorder
    // setState in the same flush), so neither index can address "the same plate" reliably.
    const filledPlates = new Map<number, EditorPlate>()
    const nextBeds = new Map<number, EditorPlate['bed']>()
    // Per-plate {dx,dy} to shift already-placed instances when the bed's ORIGIN moves under them:
    // see below. Absent for plates whose bed didn't move that way.
    const recenter = new Map<number, { dx: number; dy: number }>()
    // Session-added plates have no scene of their own but share the project's one printer bed,
    // so they borrow any loaded scene's bed, otherwise a printer switch would leave them on the
    // bed they copied from their template plate at add time.
    const anyScene = scenesByPlate.values().next().value as LibraryThreeMfScene | undefined
    for (const plate of snapshot.plates) {
      const ownScene = plate.sourcePlateIndex !== null ? scenesByPlate.get(plate.sourcePlateIndex) : undefined
      const scene = ownScene ?? (plate.sourcePlateIndex === null ? anyScene : undefined)
      if (!scene) continue
      if (ownScene && pendingScenePlatesRef.current.has(plate.plateId)) {
        pendingScenePlatesRef.current.delete(plate.plateId)
        if (plate.instances.length === 0) {
          filledPlates.set(plate.plateId, fillPlateFromScene(plate, ownScene))
          continue
        }
      }
      const nextBed = {
        minX: scene.bed.minX, maxX: scene.bed.maxX, minY: scene.bed.minY, maxY: scene.bed.maxY,
        maxZ: scene.bed.maxZ,
        excludeAreas: scene.bed.excludeAreas
      }
      if (!bedsEqual(plate.bed, nextBed)) {
        nextBeds.set(plate.plateId, nextBed)
        // Objects placed before the real printer bed resolved were positioned against the
        // origin-centred FALLBACK bed (min < 0, centre at 0,0). When the real, 0-based bed
        // (min >= 0) arrives, an object left at its fallback coordinates sits near the machine's
        // front-left corner, partly off the plate, and the slice fails with BambuStudio's
        // CLI_NO_SUITABLE_OBJECTS (exit 206). Shift each placed instance by the bed-centre delta so
        // it keeps the same position RELATIVE TO THE PLATE instead of stranding at the old origin.
        // Only for this fallback -> real transition (not real -> real printer switches, which
        // preserve exact placement, BambuStudio-style).
        const wasFallback = plate.bed.minX < 0 && plate.bed.minY < 0
        const isRealBed = nextBed.minX >= 0 && nextBed.minY >= 0
        if (wasFallback && isRealBed && plate.instances.length > 0) {
          const dx = (nextBed.minX + nextBed.maxX) / 2 - (plate.bed.minX + plate.bed.maxX) / 2
          const dy = (nextBed.minY + nextBed.maxY) / 2 - (plate.bed.minY + plate.bed.maxY) / 2
          if (dx !== 0 || dy !== 0) recenter.set(plate.plateId, { dx, dy })
        }
      }
    }
    if (filledPlates.size === 0 && nextBeds.size === 0) return
    setState((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        plates: prev.plates.map((plate) => {
          const filled = filledPlates.get(plate.plateId)
          // Keep `prev`'s live index: the fill was built from the snapshot, and a reorder may
          // have landed in between.
          if (filled) return { ...filled, index: plate.index }
          const bed = nextBeds.get(plate.plateId)
          if (!bed) return plate
          const shift = recenter.get(plate.plateId)
          if (!shift) return { ...plate, bed }
          return {
            ...plate,
            bed,
            instances: plate.instances.map((instance) => ({
              ...instance,
              position: instance.position.clone().add(new THREE.Vector3(shift.dx, shift.dy, 0))
            }))
          }
        })
      }
    })
    // A bed change (printer-model switch) or late plate fill rebuilds the plate. Ideally a
    // bed-only change would replace just the bed surface and keep the models, but the 3D build
    // plate model (`bedModelGeometry`) is a dependency of the build effect and reloads on a
    // printer switch, so the build effect re-runs regardless: decoupling the bed surface from
    // the model build is a separate change. See docs/slicer-architecture.md. Re-running is not
    // the same as rebuilding the BED, though -- the incremental path reuses whatever bed it finds
    // unless `bedSurfaceSignature` says otherwise, which is what makes that rule load-bearing.
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
  // rather than the borrowed slice controller). One-shot per `objectId:partIndex`;
  // never clobber a session edit; seeds without marking the project dirty.
  const seededPartProcessKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const current = stateRef.current
    if (scenesByPlate.size === 0 || !current) return
    const additions: Record<string, Record<string, string>> = {}
    for (const scene of scenesByPlate.values()) {
      for (const instance of scene.instances) {
        for (const [partIndex, part] of instance.parts.entries()) {
          if (!part.processOverrides || Object.keys(part.processOverrides).length === 0) continue
          const key = partSlotKey(instance.objectId, partIndex)
          if (seededPartProcessKeysRef.current.has(key)) continue
          seededPartProcessKeysRef.current.add(key)
          if (current.partProcessOverrides?.[key]) continue
          additions[key] = { ...part.processOverrides }
        }
      }
    }
    if (Object.keys(additions).length === 0) return
    // Functional updater so this composes with the plate-fill effect that also runs on
    // this `scenesByPlate` change, a `{ ...stateRef.current }` spread here would clobber
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
  /**
   * Instances to LIST in the sidebar: only the models the viewport has actually rendered
   * ({@link renderedInstanceKeys}), so the list and the 3D view always agree.
   *
   * Filtered UNCONDITIONALLY, not just while `viewportBuilding`, because the plate's instances are
   * seeded a beat BEFORE the build effect starts, so a "show everything when not building" guard
   * listed them all, blanked on build start, then refilled (a visible flash on open). The set can't
   * go stale: `activeInstanceKeys` is a dependency of the build effect, so any instance-set change
   * re-runs a build that finalises this to exactly what it rendered.
   */
  const listedInstances = useMemo(
    () => (activePlate?.instances ?? []).filter((instance) => renderedInstanceKeys.has(instance.key)),
    [activePlate, renderedInstanceKeys]
  )
  // The support brush only paints in-project parts (imports/cut halves are baked as
  // fresh meshes whose client/server triangle order isn't contractually aligned yet).
  const paintTargetIsObject = useMemo(() => {
    if (!selectedKey) return false
    const instance = activePlate?.instances.find((entry) => entry.key === selectedKey)
    // Any model with an editor identity, INCLUDING a not-yet-saved import: its paint emits as
    // `importPaint` against the staged mesh's triangle order, which is the same order the viewport
    // rendered. See the plugin guide's no-save-first rule.
    return instance != null && addedPartHostId(instance) != null
  }, [activePlate, selectedKey])
  // Read through refs so the async scene-build isn't re-fired by identity churn. The height
  // helper is declared further down (it needs the paint/plate readers), so the build reads it
  // through this ref rather than closing over a value that changes every render.
  /**
   * Publish the top chrome strip's real height as `--editor-chrome-height`, which the floating tool
   * panels anchor beneath (`TOOL_PANEL_ANCHOR`).
   *
   * Measured rather than assumed because the strip WRAPS: on a phone it carries the whole tool rail,
   * so its height moves with the button count and the viewport width. It was a hardcoded one-row 52,
   * and the moment the tools group needed a second row every panel opened underneath it.
   */
  const [chromeStripElement, setChromeStripElement] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!chromeStripElement) return
    // The variable goes on the positioned ancestor the panels resolve against, so one write serves
    // every panel without threading a measurement through their props.
    const host = chromeStripElement.parentElement
    if (!host) return
    const publish = () => {
      host.style.setProperty('--editor-chrome-height', `${Math.ceil(chromeStripElement.getBoundingClientRect().height)}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(chromeStripElement)
    return () => {
      observer.disconnect()
      host.style.removeProperty('--editor-chrome-height')
    }
  }, [chromeStripElement])

  const computePrimeTowerHeightRef = useRef<(groups: Map<string, THREE.Group>, plateIndex: number) => number>(() => 0)
  const towerRequiredRef = useRef(false)
  const projectFilamentCountRef = useRef(0)
  // filamentId -> runtime nozzleId (1 = left, 0 = right) for the active plate, so per-object
  // nozzle reach can be checked against the labeled nozzle-only zones. Values come straight from
  // the parsed index, so they are runtime ids: `zoneRequiredNozzle` answers in the same space.
  const filamentNozzleRef = useRef<Map<number, number>>(new Map())
  {
    const map = new Map<number, number>()
    // The baked index speaks SOURCE plate numbers, so resolve through the active plate's own
    // source identity: the live index drifts from it after a reorder, and never matched at all
    // on archives whose plate list doesn't start at 1. A session-added plate has no baked entry
    // and gets an empty map: the index knows nothing about it.
    const activeSourceIndex = activePlate?.sourcePlateIndex ?? null
    const indexPlate = activeSourceIndex !== null
      ? platesQuery.data?.plates.find((plate) => plate.index === activeSourceIndex)
      : undefined
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
  // The multi-selection pivot proxy the gizmo attaches to when several objects are selected
  // (created/owned by useEditorScene; seated at the selection's centre by reattachGizmo).
  const multiPivotRef = useRef<THREE.Object3D | null>(null)
  const plateRootRef = useRef<THREE.Group | null>(null)
  const geometryCacheRef = useRef<GeometryCache>(new Map())
  const importGeometryCacheRef = useRef<ImportGeometryCache>(new Map())
  // Bound after `worldFootprintCenterFor` is declared (it reads the live scene groups, set up further
  // down). A ref, like `setGroupBrimEarMarkersRef`, so the replace path can ask where an instance
  // actually SITS without a circular declaration.
  const worldFootprintCenterForRef = useRef<((key: string) => { x: number; y: number } | null) | null>(null)
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
  // object selection above: selecting either kind clears the other (never mixed), and
  // parts only multi-select within one object (rules in lib/selectionModel.ts). Geometry-
  // level (objectId+componentObjectId), so it means "this part on every copy".
  const [partSelection, setPartSelection] = useState<PartSelection | null>(null)
  const partSelectionRef = useRef(partSelection)
  partSelectionRef.current = partSelection
  partSelectedRef.current = partSelection != null || gizmoPart != null
  // Shift-range anchors: the last plainly/Ctrl-clicked object row and part row.
  const objectAnchorKeyRef = useRef<string | null>(null)
  const partAnchorRef = useRef<PartRef | null>(null)
  /** Replace the whole selection with one key (plain click semantics). */
  const selectExclusive = useCallback((key: string | null) => {
    setSelectedKey(key)
    setExtraSelectedKeys((current) => (current.length > 0 ? [] : current))
    setPartSelection((current) => (current ? null : current))
    // Clears the gizmo'd part whichever KIND it is. While a session-added volume had a state of its
    // own this call left it set, so every caller had to clear it by hand and several forgot.
    setGizmoPart((current) => (current ? null : current))
    if (key) objectAnchorKeyRef.current = key
  }, [])
  const selectExclusiveRef = useRef(selectExclusive)
  selectExclusiveRef.current = selectExclusive
  /** Ctrl/Cmd-click semantics: toggle a key in/out of the selection. */
  const toggleAdditiveSelection = useCallback((key: string) => {
    const primary = selectedKeyRef.current
    const extras = extraSelectedKeysRef.current
    setPartSelection((current) => (current ? null : current))
    setGizmoPart((current) => (current ? null : current))
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
  // Part selection follows the project: drop parts whose owning object (on any plate:
  // part identity is geometry-level) or the parts themselves vanished (delete/undo/replace).
  useEffect(() => {
    setPartSelection((current) => {
      if (!current) return current
      const owner = state?.plates.flatMap((plate) => plate.instances).find((instance) => {
        const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
        return ownerId === current.objectId
      })
      return prunePartSelection(current, owner ? ownerPartMembers(owner, state ?? null) : null)
    })
    setGizmoPart((current) => {
      if (!current) return current
      // Resolved through `addedPartHostId`, the same owner identity the bulk prune above uses. The
      // baked half of this used to require an in-project object, so it never pruned a part of an
      // unsaved import -- and there was no prune at all for a session-added volume, which could
      // outlive its own deletion and leave the gizmo attached to geometry no longer on the plate.
      const stillExists = state?.plates.some((plate) => plate.instances.some((instance) =>
        addedPartHostId(instance) === current.objectId
        && selectionHasMember(ownerPartMembers(instance, state ?? null), current.member)))
      return stillExists ? current : null
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
  // no partial-then-reload flicker: e.g. when slice-config/filament data settles after open).
  const prevBuiltPlateIndexRef = useRef<number | null>(null)
  // Commits a dragged prime-tower position back into state (rebound below).
  const movePrimeTowerRef = useRef<((x: number, y: number) => void) | null>(null)

  // Right-click context menu, anchored at the cursor: on an object (viewport or object
  // row) or on the selected part(s) of one object (part rows in the list).
  const [contextMenu, setContextMenu] = useState<
    | (ContextMenuAnchor & (
      | { kind: 'object'; key: string }
      | { kind: 'parts'; objectId: number; members: ReadonlyArray<PartMember> }
      // A session-added volume addresses itself by its own key rather than a baked ordinal, but it
      // offers the SAME actions, so it reuses the parts menu and its click-away wiring.
    ))
    | null
  >(null)
  const openContextMenuRef = useRef<(menu: (ContextMenuAnchor & { key: string }) | null) => void>(() => {})
  openContextMenuRef.current = (menu) => {
    if (!menu) {
      setContextMenu(null)
      return
    }
    // Right-clicking a member keeps the multi-selection (the menu offers bulk actions);
    // any other object becomes the sole selection first (BambuStudio behaviour).
    if (!allSelectedKeysRef.current().includes(menu.key)) selectExclusiveRef.current(menu.key)
    setContextMenu({ x: menu.x, y: menu.y, align: menu.align, kind: 'object', key: menu.key })
  }
  // The context menu is a bare anchored Menu (no Dropdown), so it lacks Joy's built-in
  // click-away/Escape handling: wire it up below. `contextMenuListboxRef` is the menu's
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
    // The menu's OWN scrolling is not an outside interaction. It is capped at the viewport height
    // and scrolls itself (`CONTEXT_MENU_SX`), and the long single-object menu regularly needs it, so
    // a guard that ignores where the event came from dismisses the menu the moment someone reaches
    // for the item they opened it to press. `contains` covers the listbox itself, which IS the
    // scrolling element.
    const insideMenu = (target: EventTarget | null) => isInsideContextMenu(contextMenuListboxRef.current, target)
    const onPointerDown = (event: PointerEvent) => {
      if (insideMenu(event.target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    // Capture pointerdown so an outside click closes the menu before it reaches other handlers;
    // a re-right-click closes it here too (then `onContextMenu` reopens it at the new spot).
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    // A scroll of anything ELSE leaves the menu behind: it is anchored to a rect captured when it
    // opened, so it ends up beside a DIFFERENT row while still acting on the original one. Touch
    // scrolling starts with a pointerdown and was already covered; a wheel is not, and a wheel over
    // the object list is the ordinary way to reach a row whose kebab you just opened. Capture, since
    // scroll does not bubble.
    const onScroll = (event: Event) => {
      if (insideMenu(event.target)) return
      close()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [contextMenu])
  // Offscreen renderer used to snapshot plate thumbnails.
  const thumbnailRendererRef = useRef<PlateThumbnailRenderer | null>(null)
  // Latest panel-sync + rotation-readout callbacks for non-React handlers.
  const syncSelectedTransformRef = useRef<((object: THREE.Object3D) => void) | null>(null)
  const setRotationReadoutRef = useRef<((angleDeg: number | null) => void) | null>(null)
  // Setter published by the isolated LiveTransformPanel so drag-frequency readout updates bypass
  // EditorView's render (and the many-part sidebar). Null while no transform readout is mounted.
  const transformReadoutSetterRef = useRef<((value: SelectedTransform | null) => void) | null>(null)
  setRotationReadoutRef.current = setRotationReadout
  const regenerateActiveThumbnailRef = useRef<(() => void) | null>(null)

  // NOTE: cache-owned fetches deliberately take no AbortSignal. The promise is shared
  // across builds (prefetch + sequential assembly, superseding rebuilds), so tying it
  // to one build's signal let that build's teardown abort a fetch a NEWER build was
  // awaiting: the model never appeared and the AbortError surfaced as an error toast.
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
      const bytes = await projectSource.loadEntry(entryPath)
      // Parse + process off the main thread (worker pool) so a huge object (50MB+ of mesh XML)
      // doesn't freeze the editor while it builds: falls back to a main-thread parse on worker error.
      return parseThreeMfModelEntryAsync(bytes)
    })()
    cache.set(entryPath, promise)
    evictGeometryCache(cache, GEOMETRY_CACHE_MAX_ENTRIES, (map) => { for (const geometry of map.values()) geometry.dispose() })
    // A failed load must not poison the cache for the next attempt.
    promise.catch(() => {
      if (cache.get(entryPath) === promise) cache.delete(entryPath)
    })
    return promise
  }, [projectSource])

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
      const buffer = await importStore.fetchMesh(importId, partIndex)
      // Parse off the main thread (worker pool); falls back to a main-thread parse on worker error.
      return parseStlGeometryAsync(new Uint8Array(buffer))
    })()
    cache.set(cacheKey, promise)
    evictGeometryCache(cache, GEOMETRY_CACHE_MAX_ENTRIES, (geometry) => geometry.dispose())
    promise.catch(() => {
      if (cache.get(cacheKey) === promise) cache.delete(cacheKey)
    })
    return promise
  }, [importStore])

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
      // w.r.t. colour edits, a swatch change recolours in place (see the recolor effect) instead of
      // re-running this whole builder and rebuilding the plate. Each coloured mesh is tagged with its
      // resolved filament id + a static fallback so that effect can recompute its live colour.
      const meshColor = (meshFilamentId != null && filamentColorsRef.current?.[meshFilamentId]) || instance.color
      // Full geometry->world transform (the placement applied to the group below) so the
      // shared part builder computes bed clearance, and thus picks the same material and
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
        const importHostId = addedPartHostId(instance)
        // Chosen on the import's ORIGINAL solid count (survivors + the ones deleted this session),
        // not on how many are left: the single-mesh branch below fetches the import's MERGED mesh,
        // so an import whittled down to one solid would put the deleted geometry back on screen.
        // The bake makes the same call on the same reasoning (`bake-documents.ts`).
        const removedSolidCount = importHostId != null
          ? stateRef.current?.removedParts?.[importHostId]?.length ?? 0
          : 0
        if (instance.parts.length + removedSolidCount > 1) {
          // Multi-solid import (STEP assembly): each solid is fetched by its OWN staged index and
          // added at its own coordinates (the per-part STL is already in assembly space), coloured
          // by its own filament so a multi-material assembly renders correctly.
          //
          // `part.partIndex`, never the array position: a deleted solid leaves the survivors with
          // their original indexes, so position `i` and solid `i` stop agreeing the moment one is
          // removed, and every later solid would render its neighbour's mesh.
          const partGeometries = await Promise.all(
            instance.parts.map(async (part) => ({ part, geometry: await fetchImportGeometry(importId, part.partIndex) }))
          )
          for (const { part, geometry } of partGeometries) {
            // A solid with no explicit material prints in the object's, so colour it that way
            // (see effectivePartFilamentId) instead of falling through to the first material.
            const partFilamentId = resolveColorFilamentIdRef.current(effectivePartFilamentId(part, instance.filamentId))
            const partColor = (partFilamentId != null && filamentColorsRef.current?.[partFilamentId]) || part.color || meshColor
            // subtype: an import solid retyped via "Change type" (e.g. to a modifier volume)
            // renders translucent like a baked part of that type.
            const partGroup = createThreeMfPartObject(geometry, { color: partColor, clearanceTransform: placement, subtype: part.subtype })
            // Part identity for per-part export. Deliberately NOT `partRef`: that key drives the
            // baked-part gizmo/selection write-back, whose transforms bake by REAL 3MF object id,
            // an import's synthetic identity must stay out of that path.
            partGroup.userData.importPartRef = { componentObjectId: part.componentObjectId, partIndex: part.partIndex }
            if (!isNonRenderableThreeMfPartSubtype(part.subtype)) {
              const partMesh = partGroup.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true)
              if (partMesh) {
                applyLayerBandOverlays(partMesh.material as THREE.Material, layerBandUniformsRef.current)
                partMesh.userData.recolor = { filamentId: partFilamentId, fallbackColor: part.color || instance.color }
                // Paintable: an import's solids paint like any part. The key is the import's
                // synthetic identity + its SOLID INDEX, which `collectImportPaint` maps back to
                // (importId, partIndex), the same indexing the bake writes paint at.
                const paintHostId = addedPartHostId(instance)
                if (paintHostId != null) {
                  partMesh.userData.supportPaintPart = {
                    objectId: paintHostId,
                    componentObjectId: part.componentObjectId
                  }
                  seedPaintOverlays(partMesh, supportPaintKey(paintHostId, part.componentObjectId), instance.key)
                }
              }
            }
            rotor.add(partGroup)
          }
        } else if (!instance.bodyRemoved) {
          // A DELETED body contributes no mesh at all: the object's added volumes are its whole
          // geometry, which is exactly what the save writes. Not building it is also what gives
          // every geometry reader the right answer for free -- bounds, footprint, thumbnail, export
          // and the boolean all walk this group, so there is nothing for them to exclude.
          //
          // Single mesh from the staged binary STL, no per-part transform.
          const geometry = await fetchImportGeometry(importId)
          // The BODY's own subtype, which a user can change before any save (it rides
          // `partTypeChanges` at `BODY_PART_INDEX`, the ordinal the bake promotes it into). Passed
          // here so retyping it to a helper renders translucent and tags `isHelperVolume`
          // immediately, rather than looking like an ordinary part until the file is reopened.
          const bodySubtype = bodyPartSubtype(stateRef.current, instance)
          const importGroup = createThreeMfPartObject(geometry, {
            color: meshColor,
            clearanceTransform: placement,
            subtype: bodySubtype === 'normal_part' ? null : bodySubtype
          })
          const importMesh = importGroup.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true)
          if (importMesh) {
            applyLayerBandOverlays(importMesh.material as THREE.Material, layerBandUniformsRef.current)
            importMesh.userData.recolor = { filamentId: meshFilamentId, fallbackColor: instance.color }
            // Paintable, exactly like a multi-solid import's parts. A single-solid import has an
            // EMPTY `parts` array, so its one mesh is solid 0: the index `collectImportPaint`
            // emits and the bake reads back. Without this tag the brush finds no target and paint
            // silently does nothing (an added cube in a new project is the common case).
            //
            // Gated on the subtype for the same reason the other three mesh-build sites are: see
            // `bodyPaintHostId`, which owns that rule.
            const paintHostId = bodyPaintHostId(stateRef.current, instance)
            if (paintHostId != null) {
              importMesh.userData.supportPaintPart = { objectId: paintHostId, componentObjectId: 0 }
              seedPaintOverlays(importMesh, supportPaintKey(paintHostId, 0), instance.key)
            }
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
          // own filament so multi-material objects render correctly, falling back to the
          // object's for a part that names none (see effectivePartFilamentId).
          const partFilamentId = resolveColorFilamentIdRef.current(effectivePartFilamentId(part, instance.filamentId))
          const partColor = (partFilamentId != null && filamentColorsRef.current?.[partFilamentId]) || part.color || meshColor
          const partGroup = createThreeMfPartObject(geometry, {
            color: partColor,
            clearanceTransform: placement.clone().multiply(partTransform),
            subtype: part.subtype
          })
          // The part matrix lives on the GROUP (children stay part-local) so the part
          // gizmo renders where the part actually sits, attached to an identity group
          // it appeared at the object's origin, over the main part. Write-backs stay
          // layout-agnostic: they read group.matrix x child matrix.
          partGroup.applyMatrix4(partTransform)
          // Part identity for the part-selection highlight (owner comes from the
          // enclosing instance group's key; see syncPartSelectionBoxes).
          partGroup.userData.partRef = { componentObjectId: part.componentObjectId, partIndex: part.partIndex }
          // Printed parts (not blocker/enforcer/modifier volumes) are paintable with the
          // support/seam brushes; tag the mesh and show any existing paint as overlays.
          // Bambu marks ordinary parts subtype="normal_part", so test via the predicate.
          if (!isNonRenderableThreeMfPartSubtype(part.subtype)) {
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
              seedPaintOverlays(paintableMesh, supportPaintKey(instance.objectId, part.componentObjectId), instance.key)
            }
          }
          rotor.add(partGroup)
          placedParts += 1
        }
        // "Has this object anything to draw?" counts its SESSION-ADDED volumes too, which are
        // attached below. Counting only the baked parts is the part-is-a-part rule broken at the
        // root: an object whose geometry is entirely added -- every part booleaned into a new one,
        // or a body built from primitives -- was disposed here and vanished from the viewport and
        // the sidebar, while its state said it was still on the plate. Note this asks whether there
        // is GEOMETRY, not whether there is printed geometry; `canRemoveParts` owns the second
        // question, and an object left holding only a helper volume must still be visible to be
        // fixed rather than silently disappear.
        if (placedParts === 0 && effectiveAddedParts(stateRef.current, instance).length === 0) {
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
      // Both are keyed by the model's editor identity, so an unsaved import carries them too;
      // `effectiveBrimEars` simply returns nothing for a model that has none.
      setGroupBrimEarMarkersRef.current?.(group, effectiveBrimEars(stateRef.current, instance))
      setGroupAddedPartMeshesRef.current?.(group, instance)
      return group
    },
    // resolveColorFilamentId is read via its ref (not a dep) so a late filament/slice-config
    // settle on open doesn't recreate this builder and trigger a redundant second plate rebuild,
    // colours are applied/refreshed by the dedicated recolor effect, not by rebuilding geometry.
    // seedPaintOverlays is stable (its only dep, colorPaintStateColor, has empty deps), so
    // listing it cannot retrigger a plate rebuild, it now owns the colour-paint tint lookup the
    // builder used to reference directly.
    [seedPaintOverlays, fetchGeometry, fetchImportGeometry]
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
    regenerateActiveThumbnailRef,
    paintCommittedRef
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
    applyPaintStrokeRef,
    previewPaintRegionRef
  } = paint

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
      // A normal part IS printed geometry: it renders opaque in its own filament colour and must
      // count toward bed-rest, the selection box, footprints, thumbnails, and STL export. Only the
      // helper volumes are the translucent aids that all of those deliberately skip.
      const helper = helperVolumeSpec(part.subtype)
      const partFilamentId = resolveColorFilamentIdRef.current(part.filamentId ?? instance.filamentId)
      const liveColor = (partFilamentId != null && filamentColorsRef.current?.[partFilamentId]) || instance.color
      const mesh = new THREE.Mesh(
        geometry,
        helper
          ? new THREE.MeshStandardMaterial({
            color: helper.color,
            transparent: true,
            opacity: 0.45,
            roughness: 0.5,
            metalness: 0,
            depthWrite: false
          })
          : new THREE.MeshStandardMaterial({ color: liveColor ?? '#D3DDE7', roughness: 0.55, metalness: 0 })
      )
      mesh.name = ADDED_PART_MESH_NAME
      mesh.position.copy(part.position)
      mesh.rotation.copy(part.rotation)
      mesh.scale.copy(part.scale)
      mesh.userData.addedPartKey = part.key
      if (helper) {
        // Aids, not printed geometry: excluded from bed-rest, selection box, footprints.
        mesh.userData.isHelperVolume = true
        mesh.renderOrder = 3
      } else {
        // Follows live swatch edits like every other printed mesh. No part ref: the recolour
        // effect finds none and falls back to the instance's filament, which is the right answer
        // for a part that inherited it, and `refreshAddedPartMeshes` rebuilds on an explicit
        // per-part reassignment anyway.
        mesh.userData.recolor = { filamentId: partFilamentId, fallbackColor: instance.color ?? undefined }
        // A normal added volume IS printed geometry, so it takes the plate's layer-change colour
        // bands and pause stripes like the body and the baked parts do (the three other mesh-build
        // sites all call this). Without it a filament change at height H recoloured everything on
        // the plate except the volume, which reports the print as doing something it will not.
        applyLayerBandOverlays(mesh.material as THREE.Material, layerBandUniformsRef.current)
        // PAINTABLE, like every other printed mesh. This one tag is what the brush needs: the hit
        // test builds its raycast set from it, so an untagged volume was not even a candidate and
        // the brush painted straight THROUGH it onto the body behind (brim ears landed there too).
        // Keyed by the volume's own mesh import, which is what its `importPaint` entry names.
        mesh.userData.supportPaintPart = { addedPartImportId: part.importId }
        seedPaintOverlays(mesh, addedPartPaintKey(part.importId), instance.key)
      }
      rotor.add(mesh)
    }
  }, [seedPaintOverlays])
  const setGroupAddedPartMeshesRef = useRef(setGroupAddedPartMeshes)
  setGroupAddedPartMeshesRef.current = setGroupAddedPartMeshes

  /**
   * Re-derive every built group's added-part meshes from the current editor state. Covers
   * import-backed instances too: `effectiveAddedParts` returns nothing for a model that has no
   * parts, and an unsaved import can host them (see {@link addedPartHostId}).
   */
  /**
   * Bumped whenever anything about the session's added parts changes.
   *
   * The ONE signal that `state.addedParts` moved. It has two consumers and they need it for
   * different reasons, so it must be bumped by EVERY mutation rather than by the ones a given
   * consumer happens to care about:
   *
   * - the gizmo attaches to a specific mesh object and a rebuild disposes it. The Text tool rewrites
   *   its part on every keystroke, so without a signal the gizmo kept an object that was no longer
   *   in the scene; three.js then logged "The attached 3D object must be a part of the scene graph"
   *   once a frame and drew the gizmo at the world origin, which read as a gizmo off the plate that
   *   dragged the wrong way.
   * - the sidebar reads added parts through a memoised `addedPartsFor`, whose identity is keyed on
   *   this. `addedParts` is mutated IN PLACE on a ref, so no prop changes when a volume is added,
   *   retyped, recoloured or removed -- this version is the only thing that can tell the memoised
   *   `ObjectList` to look again.
   *
   * Do not narrow it to "the meshes were rebuilt", which is what it used to say: a caller that
   * mutates `addedParts` and skips it leaves a stale sidebar, and nothing throws.
   */
  const [addedPartMeshVersion, setAddedPartMeshVersion] = useState(0)

  const refreshAddedPartMeshes = useCallback(() => {
    for (const [key, group] of groupByKeyRef.current) {
      const instance = activePlateRef.current?.instances.find((entry) => entry.key === key)
      if (!instance) continue
      setGroupAddedPartMeshes(group, instance)
    }
    // The meshes the gizmo may be holding have just been replaced; see the version's own comment.
    setAddedPartMeshVersion((version) => version + 1)
  }, [setGroupAddedPartMeshes])
  const refreshAddedPartMeshesRef = useRef(refreshAddedPartMeshes)
  refreshAddedPartMeshesRef.current = refreshAddedPartMeshes

  /**
   * Re-seat surface text onto whatever it has just been dragged over. Assigned further down, once
   * the text placement it needs exists; a ref because the drag write-back above is defined first.
   */
  const reseatDraggedTextRef = useRef<((mesh: THREE.Object3D) => void) | null>(null)
  /** Pointer-driven text placement; assigned once the placement it needs exists. */
  const placeTextAtRef = useRef<
    (worldPoint: THREE.Vector3, worldNormal: THREE.Vector3, phase: 'start' | 'move') => void
  >(() => {})
  /**
   * Where the text sat relative to the point the user grabbed, in world space.
   *
   * BambuStudio's `SurfaceDrag::mouse_offset`. Without it a drag can only put the text's CENTRE at
   * the cursor, so it jumps the moment you press -- you grab a letter and the whole run leaps to
   * centre itself under the pointer. Held in world space rather than screen space because the drag
   * already works there: the hit point is on the surface, so the offset rides the surface with it.
   */
  const textGrabOffsetRef = useRef<THREE.Vector3 | null>(null)
  /**
   * The face the text was last POINTED at, for the life of the editing session.
   *
   * The pointer is the only thing that knows which surface the user meant, so every later rebuild
   * -- the debounced settle after a drag, and every keystroke in the panel -- has to reuse it.
   * Without this the settle re-ran the old inference 300ms after each drag and quietly replaced the
   * correct placement with a guessed one, which is the geometry that then got staged and saved.
   */
  const editingTextSurfaceRef = useRef<{ point: THREE.Vector3; normal: THREE.Vector3 } | null>(null)
  /**
   * The exact panel value written by adopting an existing text, so its own load can be ignored.
   *
   * Adopting sets the panel from the saved record, which the live-rebuild effect sees as an edit and
   * would answer by re-placing the text -- with no pointed face yet, so through the nearest-face
   * inference. Merely OPENING text to retype it would move it.
   *
   * Stored as the VALUE, not a "skip the next one" flag. A blanket flag swallowed the user's first
   * real change after reopening: selecting text, opening the tool and then switching Placement did
   * nothing at all, because the flag armed by the load consumed the mode change instead.
   */
  const textApplyLoadedRef = useRef<TextToolValue | null>(null)
  /** Last render's selection, so the text tool can tell a DESELECT from "nothing was selected". */
  const previousSelectedKeyRef = useRef<string | null>(null)
  /**
   * The text session's two pinned identities: the standalone text OBJECT it created (so later edits
   * replace it instead of adding another), and its HOST.
   *
   * Both are mirrored because both are needed on either side of a render: the debounced rebuild and
   * the pointer drag read the refs between renders, while the panel's memo decides from the state
   * which controls apply. `useMirroredRef` owns keeping the halves in step -- writing `.current`
   * here by hand is what lets them drift.
   */
  const editingTextObjectKeyRef = useRef<string | null>(null)
  const [editingTextObjectKey, setEditingTextObject] = useMirroredRef(editingTextObjectKeyRef, null)
  const editingTextHostKeyRef = useRef<string | null>(null)
  const [editingTextHostKey, setEditingTextHost] = useMirroredRef(editingTextHostKeyRef, null)
  /** How the text is being interacted with; drives its highlight. Written by the scene's hit tests. */
  const [textInteraction, setTextInteraction] = useState<TextInteraction>('idle')
  const setTextInteractionRef = useRef(setTextInteraction)
  setTextInteractionRef.current = setTextInteraction
  /** The text part's mesh, so the scene can hit-test IT rather than the whole model. */
  const textMeshRef = useRef<THREE.Mesh | null>(null)
  /**
   * The most recent placement asked for while one was still building.
   *
   * COALESCED, not dropped. A rebuild takes longer than a pointer-move, so dropping requests while
   * busy discarded every frame of a continuous drag and only the one after the pointer STOPPED ever
   * landed -- the text appeared to move only when you let go. Keeping just the latest is right
   * rather than queueing them: intermediate positions of a drag are worthless once passed.
   */
  const pendingTextPlacementRef = useRef<{ point: THREE.Vector3; normal: THREE.Vector3 } | null>(null)
  const reseatSettleRef = useRef<number | undefined>(undefined)
  /**
   * The SVG tool's form and the artwork it has read.
   *
   * The parsed artwork is state rather than a ref because the panel renders off it (the height
   * readout, whether Add is enabled). It is cleared when the tool closes, so reopening starts from a
   * fresh file rather than silently re-adding the last one.
   */
  const [svgTool, setSvgTool] = useState<SvgToolValue>({ widthMm: 40, thickness: 2, operation: 'normal_part', includeBackground: false })
  /**
   * The artwork the SVG tool is re-editing: which archive entry it came from and which object it is
   * on. Set when the tool is opened on a part that carries a record, cleared on a fresh import.
   */
  const reeditSvgRef = useRef<
    { entryPath: string; hostId: number; fileName: string; loadedMarkup: string } | null
  >(null)
  /** How many parts a commit will replace, mirrored into state so the panel can say so. */
  const [reeditSvgCount, setReeditSvgCount] = useState(0)
  /**
   * The BAKED part the open tool is re-editing, and which its first apply must therefore replace.
   *
   * A baked part's geometry lives in the base file's object XML, so it cannot be rewritten the way
   * a session volume's soup can: the edit is expressed as a removal plus a new added part, exactly
   * as the mesh boolean expresses consuming a baked operand. Held until the first APPLY rather than
   * acted on at open, so opening the tool on saved artwork to read its settings, and closing again,
   * leaves the project untouched.
   */
  const reeditBakedPartRef = useRef<{ hostId: number; partIndex: number; transform: number[] } | null>(null)
  const [svgArtwork, setSvgArtwork] = useState<ParsedSvg | null>(null)
  const [svgFileName, setSvgFileName] = useState<string | null>(null)
  /** The chosen file's raw bytes, held so the save can store them in the archive. */
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  /**
   * Entry names the opened archive holds, cached so naming a new one can avoid ORPHANS as well as
   * entries some record still points at. Refreshed whenever artwork is loaded rather than read at
   * commit time, because the commit is synchronous and this is not.
   */
  const archiveEntriesRef = useRef<readonly string[]>([])
  const [svgEmptyReason, setSvgEmptyReason] = useState<string | null>(null)
  const applyTextPartRef = useRef<(() => Promise<void>) | null>(null)

  /** Persist a gizmo-dragged ADDED part mesh's transform into the editor state. */
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
        // Text in a surface mode is not merely MOVED by a drag, it is rebuilt around where it now
        // sits, so it re-wraps as the pointer carries it across a curve. Fired from here because
        // this is the one place a drag lands for an added part, whatever moved it.
        reseatDraggedTextRef.current?.(mesh)
        return
      }
    }
  }, [])

  /**
   * Persist a gizmo-dragged BAKED part group's placement. The group carries the drag
   * delta (its children carry the baked matrix), so the part's new object-local matrix
   * is delta x baked. The placement is geometry-level: it is written to
   * `state.partTransforms` (for the SceneEdit) and every instance's `part.transform`
   * (for rebuilds/thumbnails), and mirrored live onto the other instances' part groups.
   */
  const writeBackBakedPart = useCallback((partGroup: THREE.Object3D) => {
    // Genuinely baked-only: a session-added volume is written back by `writeBackAddedPart`, which
    // the drag dispatcher picks off the mesh's own tag. So this narrows the gizmo'd part to its
    // baked kind rather than asking the union a question it cannot answer.
    const gizmo = gizmoPartRef.current
    const selected = gizmo?.member.kind === 'baked'
      ? { objectId: gizmo.objectId, partIndex: gizmo.member.partIndex }
      : null
    const state = stateRef.current
    const ref = partGroupRef(partGroup)
    if (!selected || !state || !ref || ref.partIndex !== selected.partIndex) return
    const mesh = partGroup.children.find((child) => (child as THREE.Mesh).isMesh === true)
    if (!mesh) return
    partGroup.updateMatrix()
    mesh.updateMatrix()
    const effective = new THREE.Matrix4().multiplyMatrices(partGroup.matrix, mesh.matrix)
    const matrix = threeMfTransformFromMatrix(effective)
    if (!state.partTransforms) state.partTransforms = {}
    state.partTransforms[partSlotKey(selected.objectId, selected.partIndex)] = matrix
    // Match by the identity the part row keys on, the part's ORDINAL within its object, so a
    // multi-solid import's solids update every copy too. Addressing by `componentObjectId` moved
    // every volume that shared the dragged one's MESH: four modifier cubes cut from one cube mesh
    // all collapsed onto whichever one was dragged.
    const ownsSelectedPart = (instance: EditorInstance): boolean =>
      (instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId) === selected.objectId
    for (const plate of state.plates) {
      for (const instance of plate.instances) {
        if (!ownsSelectedPart(instance)) continue
        const part = instance.parts.find((entry) => entry.partIndex === selected.partIndex)
        if (part) part.transform = [...matrix]
      }
    }
    // Mirror the drag delta onto the other instances' matching part groups (their child
    // matrices equal the dragged one's, so the same delta lands on the same placement). Within the
    // dragged part's OWN instance exactly one node matches, itself, and it is skipped.
    for (const instance of activePlateRef.current?.instances ?? []) {
      if (!ownsSelectedPart(instance)) continue
      const group = groupByKeyRef.current.get(instance.key)
      if (!group) continue
      group.traverse((node) => {
        if (node === partGroup) return
        const nodeRef = partGroupRef(node)
        if (nodeRef && nodeRef.partIndex === selected.partIndex) {
          node.position.copy(partGroup.position)
          node.quaternion.copy(partGroup.quaternion)
          node.scale.copy(partGroup.scale)
        }
      })
    }
  }, [])

  /** Gizmo write-back dispatch: session-added parts by key, baked parts by partRef. */
  const writeBackPartMesh = useCallback((mesh: THREE.Object3D) => {
    if (typeof mesh.userData.addedPartKey === 'string') writeBackAddedPart(mesh)
    else if (partGroupRef(mesh)) writeBackBakedPart(mesh)
  }, [writeBackAddedPart, writeBackBakedPart])
  const writeBackPartMeshRef = useRef(writeBackPartMesh)
  writeBackPartMeshRef.current = writeBackPartMesh

  // ---- Brim ears -----------------------------------------------------------------

  /**
   * Add or remove a connector from a click on the cut plane.
   *
   * A placement outside the cross-section is REFUSED at the click rather than accepted and flagged,
   * which is what Studio does (`unproject_on_cut_plane` simply returns false). The difference from
   * Studio is that we say why: it drops the click silently, which reads as a dead tool.
   */
  const editCutConnectors = useCallback((edit:
    | { kind: 'add'; worldPoint: THREE.Vector3 }
    | { kind: 'remove'; id: string }
  ) => {
    if (edit.kind === 'remove') {
      setCutConnectors((current) => current.filter((entry) => entry.id !== edit.id))
      return
    }
    if (cutSoup && !isPointInsideSoup(cutSoup, edit.worldPoint)) {
      toast.error('Place connectors inside the cut face.')
      return
    }
    setCutConnectors((current) => [...current, {
      ...connectorSettings,
      id: nextInstanceKey(),
      x: edit.worldPoint.x,
      y: edit.worldPoint.y,
      z: edit.worldPoint.z
    }])
  }, [connectorSettings, cutSoup])
  /**
   * Settings are SHARED, so changing one rewrites every connector already placed as well as the ones
   * to come. Snapshotting them at placement instead made the controls silently apply to future
   * connectors only, which contradicts what the panel says and leaves a joint with mismatched pegs
   * from a control the user believes is global. The markers redraw from the same values, so the
   * preview keeps meaning what it claims to.
   */
  const applyConnectorSettings = useCallback((next: ConnectorSettings) => {
    setConnectorSettings(next)
    setCutConnectors((current) => current.map((connector) => ({ ...connector, ...next })))
  }, [])
  /**
   * The cut PLANE starts fresh; the rest of the setup persists.
   *
   * That split is BambuStudio's, and it is narrower than it looks. Opening the gizmo runs
   * `reset_cut_plane()` (plane centre onto the bounding box, rotation to identity) and clears
   * connector editing (`on_set_state`, `:563`); changing the selection runs `reset_rotation()` plus
   * `update_bb()` (`data_changed`, `:552`). Neither touches `m_cut_mode`, `m_keep_upper`,
   * `m_keep_lower`, `m_place_on_cut_*` or `m_rotate_*` -- those are plain members that only the
   * panel's own "Reset all" button restores. So leaving the tool to check a dimension and coming
   * back keeps the setup, and so does moving to another model.
   *
   * The AXIS is our analogue of that identity rotation, which is why it resets on both triggers
   * rather than on the object alone. The offset resets with it, in the cut-plane effect below, which
   * re-centres on the object's bounding box whenever either changes. Connectors are cleared here for
   * a reason of their own: each holds an ABSOLUTE world point on the model it was placed on, so
   * carrying them to another object puts pegs in mid air. The connector's type/style/shape/size does
   * persist, being a preference about hardware rather than about a model.
   */
  useEffect(() => {
    if (gizmoMode !== 'cut' || !selectedKey) return
    setCutAxis('z')
    setCutConnectors([])
    setCutConnectorMode(false)
    setCutConnectorFace('lower')
  }, [gizmoMode, selectedKey])

  /**
   * A ghost of the connector under the pointer, moved directly rather than through React because it
   * updates at pointer rate. Built alongside the cut face and cleared with it.
   */
  const connectorGhostRef = useRef<THREE.Mesh | null>(null)
  const hoverCutConnector = useCallback((worldPoint: THREE.Vector3 | null) => {
    const ghost = connectorGhostRef.current
    if (!ghost) return
    if (!worldPoint) {
      ghost.visible = false
      return
    }
    ghost.position.copy(worldPoint)
    ghost.visible = true
  }, [])
  const hoverCutConnectorRef = useRef(hoverCutConnector)
  hoverCutConnectorRef.current = hoverCutConnector

  const clearCutConnectors = useCallback(() => setCutConnectors([]), [])
  // A connector stores an absolute world point, so it goes stale the moment the plane it was placed
  // on moves. Nothing in `findConnectorProblems` references the plane, so a stale one raises no
  // warning and cuts a peg that never reaches the join. Dragging the position re-seats them onto the
  // new plane; changing the AXIS discards them, because their in-plane coordinates describe a
  // surface that no longer exists and there is nothing honest to map them onto.
  useEffect(() => {
    setCutConnectors((current) => (current.length === 0 ? current : []))
  }, [cutAxis])
  useEffect(() => {
    setCutConnectors((current) => {
      if (current.length === 0) return current
      const seated = current.map((connector) => ({ ...connector, [cutAxis]: clampedCutOffset }))
      return seated.every((c, i) => c[cutAxis] === current[i]![cutAxis]) ? current : seated
    })
  }, [clampedCutOffset, cutAxis])
  const editCutConnectorsRef = useRef(editCutConnectors)
  editCutConnectorsRef.current = editCutConnectors

  /**
   * While connectors are being placed, show the CUT FACE: clip the near half of the selected object
   * away and draw the real cross-section in its place.
   *
   * Without this the tool is unusable rather than merely awkward. The cut plane preview is a
   * translucent quad passing through a solid model, so the section it describes is hidden INSIDE the
   * geometry -- a user aiming at it is guessing, and the only way to get a face worth clicking was
   * to perform the cut first, which defeats the point. BambuStudio clips the object at the plane
   * (`ObjectClipper`) for exactly this reason, and this is that.
   *
   * The cap is also what a connector click hits, so a click is EXACT: anything landing on it is
   * inside the cross-section by construction, rather than being projected onto an unbounded plane
   * and validated afterwards.
   *
   * The CUT itself is held across connector edits. It is a full cut of the whole object and depends
   * only on the plane, while the effect below re-runs on every connector placed and every drag of a
   * size slider -- so recomputing it there re-cut a dense model on each React commit and made the
   * sliders unusable. Only the drill and the ghost belong on that path.
   */
  const cutPreviewHalf = useMemo(
    () => (cutSoup && gizmoMode === 'cut' && placingConnectors
      ? cutHalfForSide(cutSoup, cutAxis, clampedCutOffset, cutConnectorFace)
      : null),
    [cutSoup, gizmoMode, placingConnectors, cutAxis, clampedCutOffset, cutConnectorFace]
  )
  useEffect(() => {
    const scene = sceneRef.current
    const group = selectedKey ? groupByKeyRef.current.get(selectedKey) : null
    if (!scene || !group || !cutPreviewHalf) return undefined

    const targets = cutConnectorTargetsRef.current
    // The face as the cut will leave it: the visible half, with its bores already taken out. Showing
    // an undrilled face instead means the preview disagrees with the result, which is the whole
    // reason to show a face at all. Same derivation the cut itself runs, so the two cannot drift.
    const previewBores = connectorBoresForSide(cutConnectors, cutAxis, cutConnectorFace)
      .map((bore) => bore.soup)
    const cap = capSoupForHalf(cutPreviewHalf, cutAxis, clampedCutOffset, cutConnectorFace, previewBores)
    // Clip away the half the user is NOT looking at, so the eye and the pointer both reach the face.
    // Showing the lower half keeps material below the plane (normal -axis); showing the upper flips
    // it. The cross-section itself is the same surface either way -- only the side it is seen from
    // changes -- so nothing about placement depends on which is chosen.
    const towards = cutConnectorFace === 'lower' ? -1 : 1
    const normal = new THREE.Vector3(
      cutAxis === 'x' ? towards : 0,
      cutAxis === 'y' ? towards : 0,
      cutAxis === 'z' ? towards : 0
    )
    const clip = new THREE.Plane(normal, -towards * clampedCutOffset)
    const restore: Array<{ material: THREE.Material; planes: THREE.Plane[] | null }> = []
    group.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        restore.push({ material, planes: material.clippingPlanes })
        material.clippingPlanes = [clip]
        material.needsUpdate = true
      }
    })

    // The plane preview and this face occupy the SAME plane, which is what made the face shimmer:
    // two coplanar surfaces with nothing to separate them in the depth buffer. The face replaces the
    // quad while it is up, and the material's polygon offset keeps it clear of the model's own cut
    // face where the clip leaves one.
    const planeQuad = cutPlaneMeshRef.current
    const planeWasVisible = planeQuad?.visible ?? false

    // The ghost is built at the ORIGIN and moved by the hover callback, so its geometry is the
    // connector's own shape in the cut's frame rather than a shape re-made on every pointer move.
    const ghostSoup = connectorSoup(
      { ...connectorSettings, id: 'ghost', x: 0, y: 0, z: 0 },
      cutAxis,
      { grown: false }
    )
    const ghostGeometry = new THREE.BufferGeometry()
    ghostGeometry.setAttribute('position', new THREE.BufferAttribute(ghostSoup, 3))
    ghostGeometry.computeVertexNormals()
    ghostGeometry.computeBoundingSphere()
    const ghost = new THREE.Mesh(ghostGeometry, new THREE.MeshStandardMaterial({
      color: 0x9fd0ff,
      emissive: 0x2a4c6e,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      roughness: 0.5
    }))
    ghost.visible = false
    ghost.renderOrder = 6
    scene.add(ghost)
    connectorGhostRef.current = ghost

    let section: THREE.Mesh | null = null
    if (cap.length > 0) {
      if (planeQuad) planeQuad.visible = false
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(cap, 3))
      geometry.computeVertexNormals()
      geometry.computeBoundingSphere()
      geometry.computeBoundingBox()
      section = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0x7fb8ff,
        emissive: 0x14304a,
        side: THREE.DoubleSide,
        roughness: 0.6,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      }))
      section.renderOrder = 3
      scene.add(section)
      targets.section = section
    }
    return () => {
      for (const entry of restore) {
        entry.material.clippingPlanes = entry.planes
        entry.material.needsUpdate = true
      }
      if (section) {
        scene.remove(section)
        disposeObject3D(section)
      }
      if (planeQuad) planeQuad.visible = planeWasVisible
      scene.remove(ghost)
      disposeObject3D(ghost)
      connectorGhostRef.current = null
      targets.section = null
    }
  }, [cutPreviewHalf, cutConnectorFace, cutConnectors, connectorSettings, cutAxis, clampedCutOffset, selectedKey])

  // Connector markers: one mesh per connector on the SCENE, beside the cut plane, drawn as the peg
  // will actually be made so the size controls mean something before the cut runs. Invalid ones are
  // tinted, matching Studio's own red (`CONNECTOR_ERR_COLOR`).
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || gizmoMode !== 'cut') return undefined
    const targets = cutConnectorTargetsRef.current
    const markers: THREE.Object3D[] = []
    for (const connector of cutConnectors) {
      // A connector is a PEG on one half and a BORE on the other, and the marker has to say which:
      // drawing a proud peg on the half that gets a hole describes the joint backwards. The bore is
      // still drawn rather than left to the hole in the face alone, because the marker is also the
      // thing a click removes -- an invisible connector could be placed and never taken off.
      const volumes = connectorVolumes(connector, cutAxis)
      const here = cutConnectorFace === 'upper' ? volumes.upper : volumes.lower
      const isBore = here.subtype === 'negative_part'
      const soup = isBore ? here.soup.slice() : connectorSoup(connector, cutAxis, { grown: false })
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(soup, 3))
      geometry.computeVertexNormals()
      // Bounds are precomputed rather than left to the lazy path, following this plugin's rule for
      // hand-built geometry: `Mesh.raycast` rejects on the bounding sphere first, and a marker that
      // is never hit is a connector that cannot be clicked back off.
      geometry.computeBoundingSphere()
      geometry.computeBoundingBox()
      const invalid = activeProblems.has(connector.id)
      const marker = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        // A bore reads as a recess: darker, and drawn behind the surface rather than over it.
        color: invalid ? 0xff4d4d : isBore ? 0x24405c : 0x7fb8ff,
        transparent: true,
        opacity: invalid ? 0.75 : isBore ? 0.85 : 0.55,
        roughness: isBore ? 0.9 : 0.4,
        metalness: 0,
        depthWrite: false
      }))
      marker.userData.connectorId = connector.id
      marker.renderOrder = 5
      scene.add(marker)
      markers.push(marker)
    }
    targets.markers = markers
    // No explicit repaint request: `useEditorScene` already asks for one per React commit.
    return () => {
      targets.markers = []
      for (const marker of markers) {
        scene.remove(marker)
        disposeObject3D(marker)
      }
    }
  }, [cutConnectors, activeProblems, cutAxis, cutConnectorFace, gizmoMode])

  // Leaving the cut tool forgets the connectors: they belong to a cut that never happened, and
  // silently keeping them would apply them to whatever the NEXT cut turned out to be.
  useEffect(() => {
    if (gizmoMode === 'cut') return
    setCutConnectors([])
    setCutConnectorMode(false)
  }, [gizmoMode])

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
      // bed, world-scale radius): local position/rotation/scale are never used.
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
      if (!instance) continue
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
    const hostId = instance ? addedPartHostId(instance) : null
    if (!state || !instance || hostId == null) return
    recordHistoryRef.current?.()
    const current = effectiveBrimEars(state, instance)
    let next: EditorBrimEar[]
    if (edit.kind === 'add') {
      const rotor = (edit.group.userData.rotor as THREE.Group | undefined) ?? edit.group
      rotor.updateWorldMatrix(true, false)
      // Bambu rule: the clicked surface point drops straight down to the bed: brim
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
    state.brimEars[hostId] = next
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
    onContextRefused: setViewerError,
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
    measurePicksRef: measurePointsRef,
    recordHistoryRef,
    regenerateActiveThumbnailRef,
    paintCommittedRef,
    rebuildFaceHullRef,
    openContextMenuRef,
    suppressEditorEscapeRef,
    setSceneReady,
    writeBackGroupTransform
  })

  /**
   * Mirror a transform into the manual-input panel: an instance group's plate-local TRS,
   * or, when the gizmo holds a part (added mesh / baked part group), the part's
   * OBJECT-local placement, BambuStudio's "Volume Operations" behaviour.
   */
  // Compute the manual-panel transform (position/rotation/scale) from a gizmo target. Pure: the
  // caller decides whether to push it live (drag) or into state (selection); see below.
  const computeSelectedTransform = useCallback((object: THREE.Object3D): SelectedTransform | null => {
    const fromTrs = (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3): SelectedTransform => ({
      position: { x: position.x, y: position.y, z: position.z },
      rotationDeg: {
        x: THREE.MathUtils.radToDeg(rotation.x),
        y: THREE.MathUtils.radToDeg(rotation.y),
        z: THREE.MathUtils.radToDeg(rotation.z)
      },
      scalePct: { x: scale.x * 100, y: scale.y * 100, z: scale.z * 100 }
    })
    if (typeof object.userData.addedPartKey === 'string') {
      // Added part mesh: its local TRS IS the object-local placement.
      return fromTrs(object.position, object.rotation as THREE.Euler, object.scale)
    }
    if (partGroupRef(object)) {
      // Baked/import part group: effective placement = drag delta x baked child matrix.
      const mesh = object.children.find((child) => (child as THREE.Mesh).isMesh === true)
      if (!mesh) return null
      object.updateMatrix()
      mesh.updateMatrix()
      const effective = new THREE.Matrix4().multiplyMatrices(object.matrix, mesh.matrix)
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      effective.decompose(position, quaternion, scale)
      return fromTrs(position, new THREE.Euler().setFromQuaternion(quaternion, 'XYZ'), scale)
    }
    return fromTrs(object.position, rotorOf(object).rotation, object.scale)
  }, [])
  // High-frequency path (drag / gizmo): push live values straight into the isolated LiveTransformPanel
  // via its setter ref, so a drag never re-renders EditorView (and the many-part sidebar). Selection
  // changes seed the panel through `selectedTransform` state instead (the low-frequency effect below).
  const syncSelectedTransform = useCallback((object: THREE.Object3D) => {
    const value = computeSelectedTransform(object)
    if (value) transformReadoutSetterRef.current?.(value)
  }, [computeSelectedTransform])
  syncSelectedTransformRef.current = syncSelectedTransform

  // Rebuild the viewport whenever the active plate changes or its instance set
  // changes (add/remove/duplicate). Gizmo drags mutate Three.js groups directly,
  // so they do NOT trigger a rebuild.
  //
  // SORTED, so this is a signature of the instance SET and not of its order. The built scene is a
  // key-addressed map (`groupByKeyRef`), so instance order decides only the sequence groups are
  // built in, nothing about the result -- while an order-sensitive signature made a sidebar
  // reorder, which moves no geometry at all, tear down and rebuild every group on the plate.
  const activeInstanceKeys = useMemo(
    () => (activePlate?.instances.map((instance) => instance.key) ?? []).sort().join(','),
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
    // only reads the bed centre/distance refs set just above, it's independent of the geometry,
    // and on open the build effect can run several times while slice-config/filament data
    // settles. If the reframe waited for the swap, the first run would latch the view key but
    // get superseded before swapping, and the surviving run (key already latched) would skip the
    // reframe entirely, leaving the initial plate framed on the default camera.
    if (isPlateSwitch || framedViewKeyRef.current !== viewKey) {
      // Don't latch the key while this plate's scene is still loading: it is framed on the
      // borrowed/placeholder bed, and if the real bed differs the post-fill rebuild must still
      // see a key change and reframe.
      // Keyed on the plate's session IDENTITY, like every other read of this set: `index` is a
      // position that a reorder or delete rewrites, so asking with it either misses the pending
      // plate (latching a key framed on the placeholder bed) or hits an unrelated one.
      if (!pendingScenePlatesRef.current.has(activePlate.plateId)) framedViewKeyRef.current = viewKey
      frameDefaultViewRef.current?.()
    }

    // Render strategy turns on whether the live plate is EMPTY:
    //  - A genuine plate switch clears it (just below), and the first open starts empty: build
    //    straight onto the live plateRoot and reveal each model as it finishes, so loading reads
    //    as steady progress instead of one late pop-in, and we never hold two plates' geometry
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
    // progress bar shows the real total from the first frame, otherwise a partly-loaded plate reads
    // as finished while the count is still null. Count per-PART (the actual download units, mirroring
    // the prefetch fan-out below), not per-object, so a single multi-solid assembly still shows
    // granular progress instead of a stuck "1 of 1". The prefetch bumps `done` as each part settles.
    const totalLoadUnits = activePlate.instances.reduce((sum, instance) => sum + (
      instance.source.kind === 'import'
        ? (instance.parts.length > 1 ? instance.parts.length : 1)
        : instance.parts.length
    ), 0)
    setBuildProgress(totalLoadUnits > 0 ? { done: 0, total: totalLoadUnits } : null)
    // Identifies the bed currently on the plate. On an incremental (empty-plate) rebuild the plate
    // is not cleared, so a bed added on a previous pass persists while its DIMENSIONS and its 3D
    // plate mesh both change underneath it (a printer switch refetches each, separately, so they
    // land on different renders). Replace the bed when its signature changed rather than skipping
    // because "a bed already exists", which stranded the stale bed until an Arrange / add-model
    // forced the atomic-swap path. The rule itself lives in lib/bedSurfaceSignature.ts, which
    // documents what it has already got wrong; the atomic (staging) path rebuilds unconditionally.
    const bedModel = showBedModel ? bedModelGeometry : null
    const bedSignature = bedSurfaceSignature({
      width: bedWidth,
      depth: bedDepth,
      centerX: bedCenterX,
      centerY: bedCenterY,
      excludeAreas: activePlate.bed.excludeAreas,
      bedModel
    })
    if (incremental) {
      const existingBed = plateRoot.children.find((child) => child.userData?.isBedSurface)
      if (!existingBed || existingBed.userData.bedSignature !== bedSignature) {
        if (existingBed) {
          disposeObject3D(existingBed)
          plateRoot.remove(existingBed)
        }
        // Show the destination plate's empty bed straight away; models append onto it as they build.
        const liveBed = createPreviewPlateSurface({ width: bedWidth, depth: bedDepth, centerX: bedCenterX, centerY: bedCenterY, excludeAreas: activePlate.bed.excludeAreas, showSurfaceFill: !bedModel, axisLabelEdge: bedModel ? 'rear' : 'front' })
        liveBed.userData.isBedSurface = true
        liveBed.userData.bedSignature = bedSignature
        if (bedModel) liveBed.add(createBedModelObject({ geometry: bedModel, originX: bedCenterX - bedWidth / 2, originY: bedCenterY - bedDepth / 2 }))
        plateRoot.add(liveBed)
      }
    }

    void (async () => {
      // Incremental: add straight to the live plateRoot (already bearing its bed). Atomic: assemble
      // in a detached staging group (with its own bed) and swap it in at the end.
      const staging = incremental ? null : new THREE.Group()
      const target = staging ?? plateRoot
      if (staging) {
        const bedSurface = createPreviewPlateSurface({ width: bedWidth, depth: bedDepth, centerX: bedCenterX, centerY: bedCenterY, excludeAreas: activePlate.bed.excludeAreas, showSurfaceFill: !bedModel, axisLabelEdge: bedModel ? 'rear' : 'front' })
        // Tagged so the thumbnail renderer hides it (Bambu-style model-only thumbnails); the
        // signature lets a later incremental rebuild detect a bed-dimension change.
        bedSurface.userData.isBedSurface = true
        bedSurface.userData.bedSignature = bedSignature
        if (bedModel) bedSurface.add(createBedModelObject({ geometry: bedModel, originX: bedCenterX - bedWidth / 2, originY: bedCenterY - bedDepth / 2 }))
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
      // indicator reflects real download progress, even for one big multi-part assembly. Guarded on
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
            // (in place, like writeBack, no re-render). Objects must sit on the bed for slicing,
            // and this guarantees nothing is ever displayed floating/sunk, so a later move/scale
            // never "snaps" it to the bed (the long-standing jump bug).
            restObjectOnBed(group)
            instance.position.z = group.position.z
            setObjectPrintedStyle(group, isInstancePrintedRef.current(instance))
            target.add(group)
            builtGroups.set(instance.key, group)
            // Incremental: register each model live as it lands so a superseding rebuild sees the
            // plate is non-empty and takes the atomic-swap path (no duplicate, no empty flash).
            if (incremental) {
              groupByKeyRef.current.set(instance.key, group)
              // ...and let the object list show it now that it is actually on screen.
              const landedKey = instance.key
              setRenderedInstanceKeys((prev) => (prev.has(landedKey) ? prev : new Set(prev).add(landedKey)))
            }
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
      // depth depends on height) and place it on the bed, but only when the print would actually
      // USE more than one material (the live session set: parts, paint, layer changes, support
      // references), since that's the only time a purge/prime tower is generated. A project that
      // merely CARRIES extra materials, or a switched-in process preset with the tower enabled,
      // must not summon one.
      if (activePlate.primeTower && towerRequiredRef.current) {
        // Idempotent: the live toggle effect below may already have added one to this root.
        removePrimeTowers(target)
        const printHeight = computePrimeTowerHeightRef.current(builtGroups, activePlate.index)
        builtTower = createPrimeTowerObject(activePlate.primeTower, projectFilamentCountRef.current, printHeight || 30)
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
      // All of this plate's models are now in the scene: refresh placement warnings now so a
      // rebuild-driven change (undo/redo, delete, duplicate, plate switch) reflects in the panel
      // immediately rather than on the next rAF poll tick (which can lag, or never arrive if a
      // drag flag was left stuck). The poll remains as a backstop for non-rebuild moves.
      // Everything this build produced is now on screen (the atomic swap above reveals it all at
      // once; incremental builds have been adding to this as each model landed).
      setRenderedInstanceKeys(new Set(builtGroups.keys()))
      recomputeWarningsRef.current()
      // Reconcile part colours from the CURRENT state. An incremental build colours each mesh from
      // the instance snapshot it was built with, so a material reassigned WHILE the solids were
      // still streaming in would otherwise keep its old colour until the next rebuild. The
      // material-sync effect is not a dependency of this build effect, so this never re-triggers it.
      setMaterialSyncToken((token) => token + 1)
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
    // showBedModel/bedModelGeometry are read when building the bed surface, so a toggle (or a
    // late-arriving mesh) has to rebuild the plate, without them the option appears to do nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlateIndex, activeInstanceKeys, buildInstanceGroup, sceneReady, rebuildToken, showBedModel, bedModelGeometry])

  const reattachGizmo = useCallback(() => {
    const transform = transformRef.current
    if (!transform) return
    const group = selectedKey ? groupByKeyRef.current.get(selectedKey) : null
    // With a part on the gizmo, drop the object-level selection box (BambuStudio's
    // volume selection): only the part's own highlight shows, so the whole object,
    // and especially the main part, no longer reads as selected.
    setSelectionHighlightRef.current?.(gizmoPart ? null : group ?? null)
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
    // The manual-input panel mirrors whatever the gizmo holds: the object, or a selected
    // part's object-local placement (BambuStudio's "Volume Operations").
    let panelTarget: THREE.Object3D = group
    /**
     * Attach the gizmo to the pivot proxy centred on `boxes`, as BambuStudio centres every gizmo on
     * its selection, falling back to the group only when there is no proxy or nothing to measure.
     *
     * Shared by the object path and the BODY row, because moving a body moves its object: both are
     * object transforms and both must pivot on the object's geometric centre. The group and the
     * rotor sit at the object's local ORIGIN, which is wherever the file's exporter left it.
     */
    const attachToSelectionPivot = (boxes: THREE.Box3[]): void => {
      const proxy = multiPivotRef.current
      const pivot = selectionPivot(boxes, isTransformGizmoMode(gizmoMode) ? gizmoMode : 'translate')
      if (proxy && pivot) {
        proxy.position.copy(pivot)
        proxy.quaternion.identity()
        proxy.scale.set(1, 1, 1)
        transform.attach(proxy)
      } else {
        // No proxy yet (viewport still mounting) or an empty box: the origin-attached gizmo is the
        // honest fallback rather than a pivot guessed from nothing.
        transform.attach(gizmoMode === 'rotate' ? rotorOf(group) : group)
      }
    }
    // The Text tool has NO transform gizmo, matching BambuStudio, which renders a grab cube and a
    // rotation ring instead (`GLGizmoText.cpp:1932`) and moves text by dragging it over the surface
    // (`SurfaceDrag.hpp`). A translate gizmo is world-space and so offers X/Y only on an added part,
    // which makes a side wall unreachable: you cannot slide text UP a wall with it. Text is moved by
    // pointing at the model, which follows whatever surface is under the cursor, walls included.
    if (!isTransformGizmoMode(gizmoMode)) {
      transform.detach()
    } else if (gizmoPart) {
      // The selected part takes the gizmo (object-local transform), whichever kind it is. Only the
      // LOOKUP differs, because the two are tagged differently in the scene: a volume added this
      // session by its own key on the mesh, a baked part by the ref on its part GROUP. That group
      // starts at identity (its children carry the baked matrix), so the gizmo drags a delta and the
      // edge outlines and paint overlays follow; `writeBackBakedPart` composes the delta with the
      // child matrix into the part's new object-local placement.
      const member = gizmoPart.member
      let partNode: THREE.Object3D | null = null
      if (member.kind === 'body') {
        // The body has no transform of its own -- the instance's placement IS where its geometry
        // sits -- so moving the body moves the OBJECT, and it therefore takes the object's own
        // pivot rather than the group. Attaching to the group/rotor here pivoted on the file's
        // local origin, so rotating with the body row selected span the model about a corner while
        // rotating the very same model from the OBJECT row span it about its centre: the
        // single-object special case this plugin's guide says must not exist. The row exists so
        // the body can be SELECTED (named, typed, exported, booleaned) alongside the volumes added
        // beside it, which it could not be while it had no row at all.
        attachToSelectionPivot([printableMeshBox(group, false)])
        transform.setMode(gizmoMode)
        const seededBody = computeSelectedTransform(group)
        if (seededBody) setSelectedTransform(seededBody)
        return
      } else {
        group.traverse((node) => {
          if (partNode) return
          if (member.kind === 'added') {
            if (node.userData.addedPartKey === member.key) partNode = node
            return
          }
          const ref = partGroupRef(node)
          if (ref && ref.partIndex === member.partIndex) partNode = node
        })
      }
      if (partNode) {
        transform.attach(partNode)
        transform.setMode(gizmoMode)
        panelTarget = partNode
      } else {
        transform.attach(gizmoMode === 'rotate' ? rotorOf(group) : group)
        transform.setMode(gizmoMode)
      }
    } else {
      // OBJECT selection, one or many: the gizmo attaches to the pivot proxy at the selection's
      // GEOMETRIC centre, and `useEditorScene` applies the proxy's per-frame delta rigid-body to
      // every member.
      //
      // BambuStudio centres its gizmos on the selection unconditionally, with no single-vs-multi
      // distinction: `GLGizmoMove` on `selection.get_bounding_box().center()` (:49), `GLGizmoScale`
      // on the box transform's translation (:246), `GLGizmoRotate` on the bounding SPHERE centre
      // (:549, `init_data_from_selection`, which runs for a selection of one). We used to attach a
      // single object to its group (move/scale) or rotor (rotate), both of which sit at the object's
      // local ORIGIN, and an origin is wherever the file's exporter put it, so an object rotated
      // about a corner, or about the middle of one end once a z-from-zero model was laid flat.
      // Normalising IMPORT geometry (`ImportNormalization`) makes origin and centre coincide for a
      // staged import, but an in-project Bambu object carries plate coordinates and can never be
      // fixed that way; centring the pivot is what covers both.
      //
      // No new inaccuracy for the single case: `applySelectionDelta` composes a world rotation into
      // the rotor quaternion, which is exact for uniform scale and, for a non-uniformly scaled
      // member, is the SAME approximation the single-object rotate gizmo already made.
      //
      // Cheap boxes on purpose: this runs on every selection change, where a precise per-vertex walk
      // is the select-hitch the cheap selection box already removed. The readout panel keeps showing
      // the PRIMARY object's values (panelTarget stays `group`).
      const boxes: THREE.Box3[] = []
      for (const key of allSelectedKeysRef.current()) {
        const memberGroup = groupByKeyRef.current.get(key)
        if (memberGroup) boxes.push(printableMeshBox(memberGroup, false))
      }
      attachToSelectionPivot(boxes)
      transform.setMode(gizmoMode)
    }
    // Selection/gizmo change is low-frequency: seed the readout through state, which both mounts the
    // panel (the gate) and re-seeds its value. Live drag updates then flow through the setter ref.
    const seeded = computeSelectedTransform(panelTarget)
    if (seeded) setSelectedTransform(seeded)
    // `extraSelectedKeys` is a re-run TRIGGER, not a value read here: the member boxes come from
    // `allSelectedKeysRef` (a ref, so it cannot change this callback's identity), and the pivot has
    // to be re-seated whenever the selection gains or loses a member. Dropping it as the rule
    // suggests would freeze the pivot at whatever the selection was when the mode last changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, gizmoMode, gizmoPart, extraSelectedKeys,
    computeSelectedTransform, addedPartMeshVersion])

  const reattachGizmoRef = useRef(reattachGizmo)
  reattachGizmoRef.current = reattachGizmo

  // Keep the gizmo synced to the current selection + mode.
  useEffect(() => {
    reattachGizmo()
  }, [reattachGizmo])

  // Selecting a different instance drops back to object-level transform, unless the
  // selected part belongs to the newly selected instance's object (the added-part list
  // row selects the instance and the part together; clearing here would undo it).
  useEffect(() => {
    // Both checks resolve the host through `addedPartHostId` rather than testing for an in-project
    // object: an unsaved import hosts added volumes and selectable sub-parts too, and gating on
    // `source.kind` here would clear the selection the moment it was made.
    setGizmoPart((current) => {
      if (!current) return current
      const instance = activePlateRef.current?.instances.find((entry) => entry.key === selectedKey)
      if (!instance || addedPartHostId(instance) !== current.objectId) return null
      // The part must still be one of the host's, whichever kind it is: the two kinds used to be
      // pruned by separate updaters that disagreed about how strict to be.
      return selectionHasMember(ownerPartMembers(instance, stateRef.current ?? null), current.member)
        ? current
        : null
    })
  }, [selectedKey])

  // Re-dim instances whose print toggle changed, without rebuilding the plate.
  useEffect(() => {
    for (const [key, group] of groupByKeyRef.current) {
      const instance = activePlate?.instances.find((entry) => entry.key === key)
      if (instance) setObjectPrintedStyle(group, isInstancePrinted(instance))
    }
  }, [isInstancePrinted, activePlate, rebuildToken])

  // Show the convex-hull face overlay while "place on face" is active so the user
  // can pick a face to lay down, including pseudo-faces over open ends.
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
    // Closing the tool forgets which object the groove was sized for, so reopening it on the same
    // object sizes afresh rather than keeping a groove scaled for whatever was selected before.
    if (gizmoMode !== 'cut' || !selectedKey) { setCutRange(null); grooveSizedForRef.current = null; return undefined }
    const scene = sceneRef.current
    const group = groupByKeyRef.current.get(selectedKey)
    if (!scene || !group) { setCutRange(null); return undefined }
    const box = printableMeshBox(group)
    if (box.isEmpty()) { setCutRange(null); return undefined }
    const targets = cutConnectorTargetsRef.current
    setCutRange({ min: box.min[cutAxis], max: box.max[cutAxis] })
    setCutOffset((box.min[cutAxis] + box.max[cutAxis]) / 2)
    const margin = 6
    const size = new THREE.Vector3().subVectors(box.max, box.min)
    setCutObjectSize({ x: size.x, y: size.y, z: size.z })
    // Size the joint to the model, but only once per object: this effect also re-runs on an AXIS
    // change, and resizing there would throw away a depth the user had just dialled in.
    if (grooveSizedForRef.current !== selectedKey) {
      grooveSizedForRef.current = selectedKey
      setGroove((current) => ({ ...current, ...grooveDefaultsForSize(size) }))
    }
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
    // The connector tool clicks against this plane and validates against these triangles. Both are
    // captured here rather than recomputed per click: the soup is the object's whole geometry, and
    // a click is not the moment to walk it.
    targets.plane = plane
    setCutSoup(collectWorldTriangles(group))
    return () => {
      targets.plane = null
      setCutSoup(null)
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
    // Flagged HERE rather than beside the arrowheads that first needed it. The sync walks the scene's
    // top-level children plus one level inside a flagged group, and every highlight marker is sized
    // in screen pixels, so setting it only where a dimension is drawn left a lone pick's markers at
    // their raw 1mm world size for the whole time between the first click and the second.
    group.userData[SCREEN_SPACE_OVERLAY_KEY] = true
    const centreTargets: Array<{ object: THREE.Object3D; slot: number }> = []
    measurePoints.forEach((pick, index) => {
      // Each selection takes a colour of its own, distinct from the hover's -- see
      // MEASURE_POINT_COLORS for why a click used to change nothing visible at all.
      const color = MEASURE_POINT_COLORS[index] ?? MEASURE_POINT_COLORS[0]
      // The SOURCE is drawn, not the measured feature: picking a hole's centre in point mode gives a
      // bare point, and drawing only that loses the ring that says which hole it came from.
      // FLATTENED into the overlay group rather than nested: the screen-space sync walks the scene's
      // top-level children plus ONE level inside a flagged group, so a highlight kept as a group of
      // its own hides its markers two levels down where nothing scales them. They then draw at their
      // world size -- 1mm across, which happens to look about right at one zoom and grows with the
      // model at every other.
      //
      // Which of a circle's two parts was picked decides which one is drawn LOUD. A centre selected
      // out of a hole is the source circle's own centre marker promoted, not a second highlight over
      // it: drawing the point separately would stack a marker on the dot already there and leave the
      // ring at full strength, so the two selections would look alike.
      const centreOfSource = isCircleCentrePick(pick.feature, pick.source)
      const sourceHighlight = createMeasureFeatureHighlight(
        pick.source,
        color,
        centreOfSource ? 'centre' : 'rim'
      )
      const centre = sourceHighlight.getObjectByName(MEASURE_CENTRE_MARKER_NAME)
      group.add(...sourceHighlight.children)
      if (pick.source !== pick.feature && !centreOfSource) {
        group.add(...createMeasureFeatureHighlight(pick.feature, color).children)
      }
      // Collected HERE rather than by position afterwards: a pick with a derived point contributes a
      // second highlight, and the dimension line, legs and arc are appended after every pick, so no
      // index into the finished group maps back to a slot.
      if (centre && pick.source.kind === 'circle') centreTargets.push({ object: centre, slot: index })
    })
    // The dimension itself spans whatever the measurement anchored to, which is not simply the two
    // features' own positions: a point-to-edge distance lands on the edge's nearest point, and an
    // oblique edge-to-plane one lands on a boundary edge of the face.
    const measured = measureResult?.distanceInfinite ?? measureResult?.distanceStrict
    // A ZERO-LENGTH dimension is not drawn. Two edges meeting at a corner are genuinely 0.00mm
    // apart, and a dimension line of no length with a "0.00 mm" tag floating on the corner is
    // clutter over a fact the panel already states. Studio's own guard, and both of its conditions:
    // coincident anchors, or a distance under a micron (`GLGizmoMeasure.cpp:1508`).
    const anchors = measured
      && measured.from.distanceToSquared(measured.to) >= 1e-6
      && Math.abs(measured.dist) >= 0.001
      ? measured
      : null
    if (anchors) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([anchors.from, anchors.to]),
        new THREE.LineBasicMaterial({ color: MEASURE_HOVER_COLOR, transparent: true, opacity: 0.9, depthTest: false })
      )
      line.renderOrder = 7
      line.frustumCulled = false
      group.add(line)
      // ARROWHEADS at each end, which is what makes this read as a dimension rather than as a line
      // that happens to join two things. Sized in SCREEN pixels like the markers, so they stay
      // legible at any zoom; a cone scales uniformly, so one value does it.
      const along = anchors.to.clone().sub(anchors.from).normalize()
      // Each head's TIP sits on its anchor with the body lying back along the dimension, which is
      // what a dimension arrow is. The cone's apex is at its origin and its body runs along -Y, and
      // `setFromUnitVectors` maps +Y onto `facing`, so the body ends up along -facing: the arrow at
      // `from` therefore takes -along, not +along. Given the two the other way round both heads
      // stick out PAST the ends, away from the line they belong to.
      for (const [at, facing] of [
        [anchors.from, along.clone().negate()],
        [anchors.to, along]
      ] as const) {
        const head = new THREE.Mesh(
          // Height 1 with the tip at +Y after the shift below, so the screen-space scale IS its
          // length rather than a factor on a cone that already has one.
          new THREE.ConeGeometry(0.3, 1, 12),
          new THREE.MeshBasicMaterial({ color: MEASURE_HOVER_COLOR, depthTest: false })
        )
        head.geometry.translate(0, -0.5, 0)
        head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), facing)
        head.position.copy(at)
        head.userData[SCREEN_SPACE_PX_KEY] = MEASURE_ARROWHEAD_PX
        head.renderOrder = 7
        group.add(head)
      }
      const label = createMeasureLabelSprite(`${anchors.dist.toFixed(2)} mm`)
      if (label) {
        const midpoint = anchors.from.clone().add(anchors.to).multiplyScalar(0.5)
        label.position.set(midpoint.x, midpoint.y, midpoint.z + 4)
        group.add(label)
      }
    }
    // EXTENSION LINES, where an anchor sits off the feature it belongs to. Measuring a point against
    // an edge it does not overhang anchors on the edge's infinite LINE, so the dimension ends in
    // mid air beside the model with nothing joining it to the edge it describes. Studio draws the
    // same light-grey run (`GLGizmoMeasure.cpp:1717`).
    for (const pick of measurePoints) {
      if (pick.source.kind !== 'edge' || !anchors) continue
      const { start, end } = pick.source
      for (const anchor of [anchors.from, anchors.to]) {
        const along = end.clone().sub(start)
        const t = anchor.clone().sub(start).dot(along) / along.lengthSq()
        // Only an anchor genuinely PAST an end needs one; between them it is already on the edge.
        if (t >= 0 && t <= 1) continue
        const nearest = t < 0 ? start : end
        if (nearest.distanceToSquared(anchor) < 1e-6) continue
        const extension = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([nearest, anchor]),
          new THREE.LineBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.6, depthTest: false })
        )
        extension.renderOrder = 6
        extension.frustumCulled = false
        group.add(extension)
      }
    }
    // The per-axis breakdown, drawn as Studio draws it (`GLGizmoMeasure.cpp:2014`): three
    // axis-aligned legs stepping from one anchor to the other in X, then Y, then Z, in the axis
    // colours. It is what turns "48.2mm apart" into "40 across and 27 up", which is the number a
    // user actually needs when deciding whether a part fits.
    // Gated on the SAME predicate the readout uses (`canSetXyzDistance`, via `measurementRows`), or
    // the two disagree: an edge measured against a plane drew red/green/blue legs on the model while
    // the panel showed no X/Y/Z rows, i.e. a per-axis decomposition with no numbers behind it. The
    // panel side of this was fixed on its own once; this is the viewport half.
    const xyzMeaningful = measurePoints.length === 2
      && measurePoints[0] != null && measurePoints[1] != null
      && canSetXyzDistance(measurePoints[0].feature, measurePoints[1].feature)
    if (anchors && xyzMeaningful) {
      const stepX = anchors.from.clone().setX(anchors.to.x)
      const stepY = stepX.clone().setY(anchors.to.y)
      const legs: Array<[THREE.Vector3, THREE.Vector3, number]> = [
        [anchors.from, stepX, 0xff5252],
        [stepX, stepY, 0x5cd65c],
        [stepY, anchors.to, 0x5c8cff]
      ]
      for (const [start, end, color] of legs) {
        // A zero-length leg is two coincident points: drawn, it is an invisible degenerate line that
        // still costs a draw call and a geometry.
        if (start.distanceToSquared(end) < 1e-6) continue
        const leg = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([start, end]),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false })
        )
        leg.renderOrder = 6
        leg.frustumCulled = false
        group.add(leg)
      }
    }
    // The ANGLE's arc, swept from the first edge to the second about where they meet. Without it an
    // angle is a number in a panel with nothing on the model saying which corner it belongs to --
    // and on a part with several chamfers that is not a small ambiguity.
    const angle = measureResult?.angle
    if (angle && angle.angle > 1e-6) {
      const first = angle.e1[1].clone().sub(angle.e1[0]).normalize()
      const second = angle.e2[1].clone().sub(angle.e2[0]).normalize()
      const axis = new THREE.Vector3().crossVectors(first, second)
      if (axis.lengthSq() > 1e-12) {
        axis.normalize()
        // Studio's own sampling: one segment per ~3 degrees, never fewer than two.
        const steps = Math.max(2, Math.round((64 * angle.angle) / Math.PI))
        const points: THREE.Vector3[] = []
        for (let i = 0; i <= steps; i++) {
          const swept = first.clone().applyAxisAngle(axis, (i / steps) * angle.angle)
          points.push(angle.center.clone().addScaledVector(swept, angle.radius))
        }
        const arc = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: MEASURE_HOVER_COLOR, transparent: true, opacity: 0.9, depthTest: false })
        )
        arc.renderOrder = 7
        arc.frustumCulled = false
        group.add(arc)
        const label = createMeasureLabelSprite(`${((angle.angle * 180) / Math.PI).toFixed(1)}°`)
        if (label) {
          const midpoint = points[Math.floor(points.length / 2)]!
          label.position.copy(midpoint)
          group.add(label)
        }
      }
    }
    scene.add(group)
    // Published only once the group is in the scene, so the markers carry a world matrix.
    measureCentreTargetsRef.current = centreTargets
    return () => {
      measureCentreTargetsRef.current = []
      scene.remove(group)
      disposeObject3D(group)
    }
  }, [measurePoints, measureResult, gizmoMode, sceneReady, rebuildToken])

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
      setPlateThumbnails((current) => ({ ...current, [plate.plateId]: url }))
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
   * merely moved/rotated/scaled: capturing here at save/slice time guarantees the persisted
   * output's thumbnail matches the real layout instead of a stale one. Also refreshes the
   * live plate-strip previews as a side effect, unless `updateLive: false`, for renders of
   * a synthetic state (the single-object 3MF export) that must not repaint the strip.
   * `force: true` renders plates the user never opened (the export's plate is synthetic,
   * so it has no live thumbnail to key the default skip on).
   */
  const captureAllPlateThumbnails = useCallback(
    async (current: EditorState, options?: { force?: boolean; updateLive?: boolean; only?: ReadonlySet<number> }): Promise<Array<{ plateIndex: number; png: string }>> => {
      const renderer = getThumbnailRenderer()
      const out: Array<{ plateIndex: number; png: string }> = []
      for (const plate of current.plates) {
        if (plate.index <= 0) continue
        // `only` (plateIds) narrows a FORCED capture to specific plates, so refreshing a stale
        // embedded thumbnail costs one plate's geometry rather than the whole project's.
        if (options?.only && !options.only.has(plate.plateId)) continue
        // Re-render plates the user has actually opened, they have a live thumbnail and their
        // geometry is already cached, so this is cheap, plus plates whose POSITION no longer
        // matches the source archive's. The bake copies the source's per-plate PNG entries in
        // place and the reopened file resolves each plate's preview by position, so a displaced
        // plate saved without a fresh capture shows another plate's image after reopen. Other
        // unopened plates are skipped: their original embedded PNG is still right, so a large
        // multi-plate project never loads every plate's geometry just to save. A displaced plate
        // whose scene has not arrived yet renders nothing useful: leave it skipped (its bytes
        // are no staler than they were).
        const displaced = plate.sourcePlateIndex !== plate.index
          && !pendingScenePlatesRef.current.has(plate.plateId)
        if (!options?.force && !plateThumbnailsRef.current[plate.plateId] && !displaced) continue
        const group = new THREE.Group()
        try {
          for (const instance of plate.instances) {
            const built = await buildInstanceGroup(instance)
            if (built) group.add(built)
          }
          const url = renderer.render(group, plate.bed)
          if (options?.updateLive !== false) setPlateThumbnails((existing) => ({ ...existing, [plate.plateId]: url }))
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

  /**
   * Watch the live filament colours and invalidate the embedded thumbnails a recolour makes wrong.
   *
   * Keyed on the COLOUR MAP rather than `materialSyncToken` deliberately: that token is also
   * bumped at the end of every plate build to reconcile part colours, so marking from it invalidated
   * every unopened plate on OPEN and dragged the whole project's geometry into the background,
   * exactly the up-front build cost the plate strip exists to avoid. A colour map that changed
   * VALUES is the narrow signal; first population is a seed, not a change.
   */
  const previousFilamentColorsRef = useRef<Record<number, string> | null>(null)
  useEffect(() => {
    const previous = previousFilamentColorsRef.current
    previousFilamentColorsRef.current = filamentColors
    if (!previous) return
    const recoloured = Object.entries(filamentColors).some(([id, color]) => {
      const before = previous[Number(id)]
      return before !== undefined && before !== color
    })
    if (!recoloured) return
    const current = stateRef.current
    if (!current) return
    // EVERY plate but the active one, whichever source it is showing. Filtering to plates without a
    // live thumbnail was wrong: after one recolour they all HAVE a live thumbnail (this pass made
    // it), so undoing that colour marked nothing and the strip kept the undone colour.
    const affected = current.plates
      .filter((plate) => plate.index > 0 && plate.index !== activePlateIndex)
      .map((plate) => plate.plateId)
    // Drop the cached live renders too, or the strip keeps preferring them over the loading tile.
    setPlateThumbnails((existing) => {
      const next = { ...existing }
      for (const plateId of affected) delete next[plateId]
      return next
    })
    setStaleEmbeddedPlates(new Set(affected))
  }, [filamentColors, stateRef, activePlateIndex])

  /**
   * Re-render the plates whose embedded thumbnail a recolour invalidated, ONE per pass, so a
   * multi-plate project refreshes progressively instead of blocking on the whole set.
   *
   * This is the deliberate exception to the "never build a non-active plate in the background"
   * rule below: it runs only after a material was actually recoloured, only for plates the user
   * has not opened, and it is bounded by that set draining. It also costs far less than it used
   * to: the project's meshes come from the archive already inflated in the tab, so building a
   * plate is local work rather than a per-entry fetch.
   */
  useEffect(() => {
    if (staleEmbeddedPlates.size === 0) return
    const next = [...staleEmbeddedPlates][0]
    if (next === undefined) return
    const current = stateRef.current
    if (!current) return
    let cancelled = false
    void (async () => {
      try {
        await captureAllPlateThumbnails(current, { force: true, only: new Set([next]) })
      } finally {
        // Drop it either way: a plate that failed to render must not wedge the queue behind it,
        // and it simply keeps showing the loading tile.
        if (!cancelled) setStaleEmbeddedPlates((pending) => {
          const remaining = new Set(pending)
          remaining.delete(next)
          return remaining
        })
      }
    })()
    return () => { cancelled = true }
  }, [staleEmbeddedPlates, captureAllPlateThumbnails, stateRef])

  // Non-active plates no longer render in the background to fill the plate strip, that made
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

  // Layer G-code edits recolour via the shared band-shader uniforms (the effect above, keyed on
  // state), every part material already reads them, and the continuous render loop shows the new
  // bands next frame, so they need no rebuild ('inert').
  /** Replace the active plate's layer-based filament changes (history-recorded). */
  const setActivePlateFilamentChanges = useCallback((changes: EditorFilamentChange[]) => {
    updatePlates((plates) => plates.map((plate) => (
      plate.index === activePlateIndex ? { ...plate, filamentChangesOverride: changes } : plate
    )), 'inert')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlateIndex])

  /** Replace the active plate's layer pauses (history-recorded). */
  const setActivePlatePauses = useCallback((pauses: EditorPause[]) => {
    updatePlates((plates) => plates.map((plate) => (
      plate.index === activePlateIndex ? { ...plate, pausesOverride: pauses } : plate
    )), 'inert')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlateIndex])

  /**
   * How a plate edit affects the live 3D scene, so it only pays for the work it needs:
   * - `structure` (default): geometry/identity changed (add, delete, cut, split, replace, paste,
   *   move-to-plate) → full teardown + rebuild of the active plate.
   * - `transform`: positions/rotations/scales only (auto-arrange, prime-tower move) → copy the new
   *   transforms onto the existing groups; no geometry re-parse.
   * - `material`: part filament reassignment → recolour the existing meshes in place.
   * - `visibility`: printable toggles → the re-dim effect (keyed on state) already handles it.
   * - `inert`: no active-plate viewport change (renames, per-plate layer G-code, other-plate edits).
   * Non-`structure` kinds MUST NOT change the geometry or key set of the active plate, only the
   * listed attribute, or the in-place sync will desync from state. When unsure, use `structure`.
   */
  const updatePlates = useCallback((updater: (plates: EditorPlate[]) => EditorPlate[], kind: PlateEditKind = 'structure') => {
    recordHistory()
    setState((current) => {
      if (!current) return current
      // Spread `...current` so the session-only fields kept on the state object, support/seam/
      // colour paint, brim ears, and added part volumes (all mutated in place via stateRef),
      // survive a plate-structure edit instead of being silently dropped.
      const plates = updater(current.plates)
      // A STRUCTURE edit can add an instance (duplicate, paste, fill bed, move to plate) and those
      // append, which would leave an object's copies split around another object. The saved file
      // groups build items by object regardless, so an ungrouped list is a sidebar that disagrees
      // with what BambuStudio will show, and a drag in it lands somewhere the user did not point
      // at. Idempotent and order-preserving, so an edit that added nothing changes nothing.
      return { ...current, plates: kind === 'structure' ? normalizePlateObjectOrder(plates) : plates }
    })
    // Route to the cheapest sync that covers `kind`. `visibility`/`inert` need no viewport work
    // beyond effects that already react to the state change.
    if (kind === 'structure') setRebuildToken((token) => token + 1)
    else if (kind === 'transform') setTransformSyncToken((token) => token + 1)
    else if (kind === 'material') setMaterialSyncToken((token) => token + 1)
  }, [recordHistory])

  // TRANSFORM sync: copy each instance's position/rotation/scale onto its live group, mirroring the
  // build (group.position/scale + rotor.rotation, EditorView build lines ~1440). Runs after the
  // state commit (stateRef is refreshed in the render body). An exact-matrix instance renders a
  // baked matrix with matrixAutoUpdate off and rotor identity, so its transform can't be set this
  // way: if any is present we fall back to a full rebuild (rare: rotated + non-uniformly scaled).
  useEffect(() => {
    if (transformSyncToken === 0) return
    const current = stateRef.current
    if (!current) return
    const byKey = new Map<string, EditorInstance>()
    for (const plate of current.plates) for (const instance of plate.instances) byKey.set(instance.key, instance)
    let needsRebuild = false
    for (const [key, group] of groupByKeyRef.current) {
      const instance = byKey.get(key)
      if (!instance) continue
      // A group in exact-matrix render mode (matrixAutoUpdate off, built for a shearing object)
      // can't be moved by setting position, and an arrange can bake such an object to T·S·R,
      // leaving its group still in that mode until a rebuild. Detect the render state, not the
      // instance flag, and fall back to a full rebuild for the whole plate (rare).
      if (!group.matrixAutoUpdate) { needsRebuild = true; break }
      group.position.copy(instance.position)
      group.scale.copy(instance.scale)
      rotorOf(group).rotation.copy(instance.rotation)
    }
    if (needsRebuild) { setRebuildToken((token) => token + 1); return }
    recomputeWarningsRef.current()
    regenerateActiveThumbnailRef.current?.()
  }, [transformSyncToken])

  // MATERIAL sync: recolour the live meshes in place after a filament reassignment, mirroring the
  // build's per-part colouring (recolor.filamentId + fallbackColor) and the swatch recolour effect
  // in useEditorPaint. A part mesh's owning part is its nearest partRef/importPartRef ancestor; a
  // single-mesh import has neither, so it tracks the instance filament.
  useEffect(() => {
    if (materialSyncToken === 0) return
    const current = stateRef.current
    if (!current) return
    const byKey = new Map<string, EditorInstance>()
    for (const plate of current.plates) for (const instance of plate.instances) byKey.set(instance.key, instance)
    for (const [key, group] of groupByKeyRef.current) {
      const instance = byKey.get(key)
      if (!instance) continue
      group.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        const recolor = mesh.userData.recolor as { filamentId: number | null; fallbackColor?: string } | undefined
        if (!recolor) return
        // A volume ADDED this session is not in `instance.parts` at all -- it lives in
        // `state.addedParts` and its meshes carry `addedPartKey` rather than a `partRef`. Looked up
        // FIRST, because falling through to the object's filament is exactly what went wrong: on
        // every full rebuild (an undo, most visibly) this effect repainted each added volume with
        // its OBJECT's material, so a two-colour logo flashed its real colours and then settled on
        // material 1. The sidebar kept showing the part's own material, which is what made the two
        // disagree.
        let addedKey: string | undefined
        for (let node2: THREE.Object3D | null = mesh; node2 && !addedKey; node2 = node2.parent) {
          addedKey = node2.userData.addedPartKey as string | undefined
        }
        if (addedKey) {
          const added = Object.values(current.addedParts ?? {}).flat().find((entry) => entry.key === addedKey)
          // A helper volume (blocker, enforcer, modifier, negative) prints no filament and is drawn
          // in its subtype's colour by the build. Recolouring it here would repaint an aid as a
          // material, which is the same class of overwrite this branch exists to stop.
          if (!added || !threeMfPartSubtypeCarriesFilament(added.subtype)) return
          const addedFilamentId = resolveColorFilamentIdRef.current(added.filamentId ?? instance.filamentId)
          recolor.filamentId = addedFilamentId
          const addedLive = addedFilamentId != null ? filamentColorsRef.current?.[addedFilamentId] : undefined
          const addedHex = addedLive || recolor.fallbackColor || '#D3DDE7'
          const addedMaterial = mesh.material as THREE.MeshStandardMaterial
          addedMaterial.color.set(addedHex)
          if (addedMaterial.emissive) addedMaterial.emissive.set(addedHex).multiplyScalar(0.12)
          return
        }
        // Find this mesh's part via the nearest ancestor carrying a part ref.
        let ref: { partIndex: number } | undefined
        for (let node2: THREE.Object3D | null = mesh; node2 && !ref; node2 = node2.parent) {
          ref = (node2.userData.partRef ?? node2.userData.importPartRef) as { partIndex: number } | undefined
        }
        const part = ref ? instance.parts.find((entry) => entry.partIndex === ref!.partIndex) : undefined
        // Through `effectivePartFilamentId`, exactly as the build does: a part's null filament means
        // "inherit the object's", and resolving the bare value sends it to `resolveColorFilamentId`'s
        // dangling-id fallback, i.e. the project's FIRST material. This effect runs at the end of
        // every plate build (`materialSyncToken` is bumped there), so getting it wrong here does not
        // merely mis-colour a reassignment, it overwrites the colour the build just computed
        // correctly: a replaced object showed its real material in the sidebar and material 1 in the
        // viewport.
        const filamentId = resolveColorFilamentIdRef.current(
          part ? effectivePartFilamentId(part, instance.filamentId) : instance.filamentId
        )
        recolor.filamentId = filamentId
        const live = filamentId != null ? filamentColorsRef.current?.[filamentId] : undefined
        const hex = live || recolor.fallbackColor || '#D3DDE7'
        const material = mesh.material as THREE.MeshStandardMaterial
        material.color.set(hex)
        if (material.emissive) material.emissive.set(hex).multiplyScalar(0.12)
        // The colour-paint overlay tint follows the live filament colour; its cache is keyed by code
        // (not colour), so drop it and let the overlay refresh rebuild the new tint.
        mesh.userData['paintOverlayCache:color'] = undefined
      })
    }
    refreshPaintOverlaysRef.current()
    // A material-only edit deliberately skips the plate rebuild, which is the other place a
    // snapshot is taken, so mirror the recolour into the plate strip here, as the transform sync
    // does. Without this the strip keeps showing the pre-reassignment colours until the next
    // structural edit or plate switch.
    regenerateActiveThumbnailRef.current?.()
    // Keyed ONLY on materialSyncToken: colours are read via refs so a swatch-colour tick does NOT
    // re-run this full-scene traversal (that's the useEditorPaint recolour effect's job).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialSyncToken])

  /**
   * The prime tower's height: the last layer that still needs a PURGE, not the top of the print.
   *
   * Two rules, both BambuStudio's:
   *  - HELPER VOLUMES DO NOT COUNT. Support blockers/enforcers, negative parts and modifiers are
   *    not printed geometry (BS's `instance_bounding_box` is explicitly "without modifiers"), so a
   *    blocker taller than the model must not stretch the tower. `printableMeshBox` is the shared
   *    rule for that (it also drops the tower itself, paint overlays and brim markers).
   *  - THE TOWER ENDS AT THE LAST MATERIAL CHANGE. Above the SECOND-tallest filament only one
   *    material is still printing, so nothing purges past that height; a layer-based filament
   *    change purges at its own z. A filament we cannot place geometrically (a support material the
   *    baked index attributes to the plate has no mesh of its own, it prints wherever its objects
   *    do) forces the full printable height instead of guessing low.
   *
   * Per-filament heights are attributed per INSTANCE, so a filament used only by a short part is
   * credited with its object's full height, deliberately the conservative direction (a slightly
   * tall tower is harmless; a short one would misrepresent the purge).
   */
  const computePrimeTowerHeight = useCallback((groups: Map<string, THREE.Group>, plateIndex: number): number => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === plateIndex)
    if (!plate) return 0
    const paintByKey = stateRef.current?.colorPaint ?? {}
    const filamentTop = new Map<number, number>()
    let printableTop = 0
    for (const instance of plate.instances) {
      const group = groups.get(instance.key)
      if (!group) continue
      const box = printableMeshBox(group, false)
      if (box.isEmpty()) continue
      const top = box.max.z
      printableTop = Math.max(printableTop, top)
      const ids = new Set<number>()
      if (instance.filamentId != null) ids.add(instance.filamentId)
      for (const part of instance.parts) {
        if (part.filamentId != null && threeMfPartSubtypeCarriesFilament(part.subtype)) ids.add(part.filamentId)
      }
      const hostId = addedPartHostId(instance)
      if (hostId != null) {
        for (const [key, codes] of Object.entries(paintByKey)) {
          if (Number.parseInt(key.split(':')[0] ?? '', 10) !== hostId) continue
          for (const code of Object.values(codes)) collectColorPaintFilamentIds(code, ids)
        }
      }
      for (const id of ids) filamentTop.set(id, Math.max(filamentTop.get(id) ?? 0, top))
    }
    if (printableTop <= 0) return 0
    // A material the baked index attributes to this plate but that owns no mesh here (support) may
    // purge at any layer its objects reach. The baked index speaks SOURCE plate numbers: resolve
    // through the live plate's own source identity (the live index drifts after a reorder); a
    // session-added plate has no baked entry to consult.
    const bakedPlate = plate.sourcePlateIndex !== null
      ? platesQuery.data?.plates.find((entry) => entry.index === plate.sourcePlateIndex)
      : undefined
    for (const filament of bakedPlate?.filaments ?? []) {
      if (!filamentTop.has(filament.id)) return printableTop
    }
    let purgeTop = 0
    for (const change of effectiveFilamentChanges(plate)) purgeTop = Math.max(purgeTop, change.z)
    const tops = [...filamentTop.values()].sort((left, right) => right - left)
    if (tops.length >= 2) purgeTop = Math.max(purgeTop, tops[1]!)
    return Math.min(printableTop, purgeTop)
  }, [platesQuery.data, stateRef])
  computePrimeTowerHeightRef.current = computePrimeTowerHeight

  // Keep the prime tower's PRESENCE in step with the live used-material count. The tower is created
  // during a plate rebuild, but assigning a material or painting is a 'material'/paint edit that
  // deliberately skips the rebuild, so without this the tower only appeared/vanished at the next
  // structural edit (undo/redo, delete, plate switch), which is exactly how a single-material plate
  // ended up showing one. Add/remove in place instead; the tower is a bed fixture with no per-model
  // state, so re-creating it is cheap. The scene's on-demand render loop paints it on the next frame
  // (a React commit already flags a repaint).
  const activePlatePrimeTower = state?.plates.find((plate) => plate.index === activePlateIndex)?.primeTower ?? null
  // BambuStudio's own gate (`Print::has_wipe_tower`): the tower exists when the process enables it
  // (which is what makes `primeTower` non-null at parse time) AND either a forcing condition holds
  // (wrapping detection / smooth timelapse: `sizing.needWipeTower`) or the PROJECT carries more
  // than one filament. Per-PLATE usage is deliberately NOT part of it: BS keys on the project's
  // filament count, which is why a single-material plate of a multi-material project really does
  // get a (small) tower in the slice: verified in our own sliced output. Mirroring the slicer
  // keeps the preview honest; second-guessing it made the editor hide a tower the G-code contains.
  // Spiral (vase) mode suppresses the tower outright, but only against the filament-count term:
  // BS returns early for the forcing conditions, so a wrapping/timelapse tower still exists in vase
  // mode. The ordering below mirrors that.
  const projectFilamentCount = sliceConfig?.projectFilaments.length ?? platesQuery.data?.projectFilaments.length ?? 0
  const towerRequired = activePlatePrimeTower != null
    && (activePlatePrimeTower.sizing.needWipeTower
      || (!activePlatePrimeTower.sizing.spiralMode && projectFilamentCount > 1))
  towerRequiredRef.current = towerRequired
  projectFilamentCountRef.current = projectFilamentCount
  useEffect(() => {
    const plateRoot = plateRootRef.current
    if (!plateRoot || !sceneReady) return
    const shouldShow = towerRequired
    // Sweep EVERY tower in the root, not just the ref'd one: the async plate build also adds one,
    // so trusting the ref left an orphaned tower in the scene (the duplicate towers report).
    removePrimeTowers(plateRoot)
    primeTowerObjRef.current = null
    if (!shouldShow) return
    const printHeight = computePrimeTowerHeight(groupByKeyRef.current, activePlateIndex)
    const tower = createPrimeTowerObject(activePlatePrimeTower, projectFilamentCount, printHeight || 30)
    plateRoot.add(tower)
    primeTowerObjRef.current = tower
  }, [activePlatePrimeTower, towerRequired, projectFilamentCount, computePrimeTowerHeight, activePlateIndex, sceneReady, rebuildToken])

  // A filament SWATCH edit recolours the live meshes through useEditorPaint's in-place effect
  // (declared earlier, so it has already run when this fires), no rebuild, hence no snapshot.
  // Refresh the strip on the settled colour; see {@link THUMBNAIL_RECOLOUR_DEBOUNCE_MS}.
  const thumbnailColourSettledRef = useRef(false)
  useEffect(() => {
    // Skip the mount pass: the plate build takes its own snapshot when it finishes, and firing here
    // could otherwise snapshot a plate that is still streaming its models in.
    if (!thumbnailColourSettledRef.current) { thumbnailColourSettledRef.current = true; return }
    const timer = setTimeout(() => regenerateActiveThumbnailRef.current?.(), THUMBNAIL_RECOLOUR_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filamentColors])

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

  // Part-row selection. A PLAIN click on an in-project object's part selects the part
  // for transform (BambuStudio's volume click): the instance stays selected and the part
  // takes the gizmo, so it can be moved/rotated/scaled. Ctrl/Shift enter the BULK part
  // selection (rules in lib/selectionModel.ts): Ctrl toggles siblings, Shift ranges
  // between siblings, a part of a different object CONVERTS the selection, and bulk mode
  // always leaves object mode.
  const handleSelectPart = useCallback((objectId: number, member: PartMember, modifiers: { additive: boolean; range: boolean }, instanceKey: string, options?: { keepTool?: boolean }) => {
    if (!modifiers.additive && !modifiers.range) {
      const instance = stateRef.current?.plates.flatMap((plate) => plate.instances)
        .find((entry) => entry.key === instanceKey)
      // Which rows can take the gizmo. A volume added this session always has a mesh of its own, so
      // it always can. A BAKED part only can where the object renders per-part groups: an in-project
      // object always does, and a multi-solid import does too (tagged `importPartRef`, and its
      // placement emits as `importPartTransforms` instead of `partTransforms`); a single-mesh
      // instance has no part group to attach to and falls through to the bulk selection.
      // The BODY always can: its gizmo is the OBJECT's, which every instance has by definition (see
      // `selectedPartObject`, which hands back the instance group for it). Without this it fell to
      // the bulk path on every IMPORT-backed object -- so on every primitive, cut half, boolean
      // result and single-solid STL -- and the bulk path nulls `selectedKey`, which leaves the whole
      // tool rail inert and shows no placement panel. Selecting the body was then the one row click
      // that took tools AWAY.
      const canTakeGizmo = member.kind === 'added'
        || member.kind === 'body'
        || (instance != null && (instance.source.kind === 'object' || instance.parts.length > 1))
      if (instance && canTakeGizmo) {
        // Clicking the already-gizmo'd part steps back up to the whole object.
        if (samePartRef(gizmoPartRef.current, { objectId, member })
          && selectedKeyRef.current === instanceKey) {
          setGizmoPart(null)
          return
        }
        selectExclusive(instanceKey)
        setGizmoPart({ objectId, member })
        partAnchorRef.current = { objectId, member }
        // Drop a tool that ACTS on what it is pointed at; leave a selection-capable mode alone. Spelled
    // out as translate/rotate/scale this forced Move on every part click once Select became the
    // resting mode, so merely picking a part switched tools. `keepTool` is for callers that are not
    // pointing the tool at anything -- opening a row's menu selects the row the way Studio does, but
    // ending a paint session to look at a part's options is not something anyone asked for.
    if (!options?.keepTool && !allowsSelectionPicking(gizmoModeRef.current)) setGizmoMode(RESTING_GIZMO_MODE)
        return
      }
      // No per-part group to hand the gizmo to (a single-mesh import); fall through to
      // the bulk selection so the row still highlights and bulk actions work.
    }
    // A part already holding the gizmo seeds the bulk set, so gizmo-select then Ctrl-click builds a
    // two-part selection instead of dropping the first part.
    //
    // Read HERE, before the state calls, never from inside the updater below. React resolves each
    // `useState` queue at that hook's own position in the component body, and `gizmoPart` is
    // declared long before `partSelection` -- so by the time the updater runs, the clearing call at
    // the end of this function has already been applied and `gizmoPartRef` reassigned to null. The
    // seed then read the very value this click was about to clear, and silently dropped the first
    // part. Same trap this file documents at `booleanLists`, one hook apart instead of one render.
    const gizmoSeed = gizmoPartRef.current
    setSelectedKey(null)
    setExtraSelectedKeys((current) => (current.length > 0 ? [] : current))
    setPartSelection((current) => {
      const seeded = current ?? (gizmoSeed && gizmoSeed.objectId === objectId
        ? { objectId, members: [gizmoSeed.member] }
        : current)
      if (modifiers.range) {
        const owner = stateRef.current?.plates.flatMap((plate) => plate.instances).find((instance) => {
          const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
          return ownerId === objectId
        })
        // Both kinds, in sidebar order, so a shift-range can span a run of baked parts and the
        // volumes listed after them rather than skipping whichever kind it did not start on.
        const ordered = owner ? ownerPartMembers(owner, stateRef.current ?? null) : [member]
        return rangePartSelection(objectId, ordered, partAnchorRef.current, member)
      }
      partAnchorRef.current = { objectId, member }
      if (modifiers.additive) return togglePartInSelection(seeded, objectId, member)
      // Plain click on the sole selected part deselects it (parity with object rows).
      if (seeded && seeded.objectId === objectId && seeded.members.length === 1
        && samePartMember(seeded.members[0]!, member)) {
        return null
      }
      return { objectId, members: [member] }
    })
    setGizmoPart((current) => (current ? null : current))
  }, [selectExclusive])

  // Right-click on list rows: keep the selection when clicking a member (bulk menu),
  // otherwise select just the clicked row first: same rule as the viewport.
  const handleObjectRowContextMenu = useCallback((key: string, position: ContextMenuAnchor) => {
    // Select what the menu is about to act on, as BambuStudio does, but never deselect: a row that
    // is already part of the selection keeps it, so the menu can offer the bulk actions.
    if (!allSelectedKeysRef.current().includes(key)) selectExclusive(key)
    setContextMenu({ ...position, kind: 'object', key })
  }, [selectExclusive])
  const handlePartRowContextMenu = useCallback((objectId: number, member: PartMember, position: ContextMenuAnchor, instanceKey: string) => {
    const { selectFirst, members } = partRowMenuSelection(
      { objectId, member },
      partSelectionRef.current,
      gizmoPartRef.current,
      selectedKeyRef.current,
      instanceKey
    )
    // Select exactly as a plain CLICK would, minus the tool drop: see `partRowMenuSelection`. The
    // targets are read synchronously, since this selection only lands on a later render.
    if (selectFirst) handleSelectPart(objectId, member, { additive: false, range: false }, instanceKey, { keepTool: true })
    setContextMenu({ ...position, kind: 'parts', objectId, members: [...members] })
  }, [handleSelectPart])

  // Reassign the filament of a set of object parts (keyed by objectId+componentObjectId).
  // Filament is a property of the object's part, shared across instances/plates, so we
  // update every matching part. The 3D preview recolours from part.filamentId.
  const reassignFilament = useCallback((targets: Array<{ objectId: number; partIndex: number }>, filamentId: number) => {
    if (targets.length === 0) return
    const targetSet = new Set(targets.map((target) => partSlotKey(target.objectId, target.partIndex)))
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) => {
        // Object parts key on the Bambu object id; multi-solid import parts key on the import's
        // synthetic object identity (replacedObjectId) so a not-yet-saved assembly is reassignable.
        const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
        if (ownerId == null) return instance
        let changed = false
        const parts = instance.parts.map((part) => {
          // A support blocker/enforcer or negative volume has no material, so it is never a
          // reassignment target even when a bulk selection sweeps it up. Enforced here rather
          // than at each call site so no caller can bake an extruder onto a helper volume.
          if (targetSet.has(partSlotKey(ownerId, part.partIndex)) && threeMfPartSubtypeCarriesFilament(part.subtype)) {
            changed = true
            return { ...part, filamentId }
          }
          return part
        })
        if (!changed) return instance
        // The object-level `filamentId` is the bake's fallback for a multi-solid import's
        // unassigned parts; derive it from part consensus so retargeting one part never collapses
        // the others onto it. See {@link deriveObjectFilamentId}.
        return { ...instance, parts, filamentId: deriveObjectFilamentId(parts, instance.filamentId) }
      })
    })), 'material')
  }, [updatePlates])

  /**
   * Set the material of whole INSTANCES, whichever shape they are.
   *
   * The object-level counterpart to {@link reassignFilament}, which addresses PARTS. A model with
   * no parts list -- a primitive, a single-solid STL or 3MF import, a single-shell Cut output, and
   * any single-mesh object in a saved project -- carries its material on the instance itself, and
   * the bake emits that (`filamentId` rides every `SceneEditInstance`). Expressing a material
   * change only as `{objectId, partIndex}` targets therefore made it a silent no-op for all of
   * them: `reassignFilament` maps over `instance.parts`, so an empty list changes nothing and
   * returns the instance untouched, while the sidebar's own `materialParts.length > 0` gate
   * dropped the picker and left a swatch that looked informational rather than broken.
   *
   * Parts still win where they exist, so a multi-part object keeps behaving exactly as before:
   * every printed part is retargeted and the object's own id is re-derived from their consensus.
   * Helper volumes are skipped here for the same reason `reassignFilament` skips them -- a blocker
   * has no material and a modifier's region is deliberately its own.
   *
   * It reaches LINKED COPIES too, which is why it resolves the named keys to object identities
   * first rather than just matching them. Material is a property of the OBJECT, and the sidebar
   * says so ("Linked copy: N instances share this object's parts, materials, paint and settings");
   * the part-addressed path got that for free by keying on the object id, so matching instance keys
   * alone would have quietly recoloured one copy and left its siblings behind.
   */
  const reassignInstanceFilament = useCallback((
    keys: readonly string[],
    filamentId: number,
    /**
     * Whether the object's session-added volumes go with it. TRUE for "set all parts' material",
     * which is what this action is; FALSE when the caller is changing only the BODY, whose material
     * is the instance's own. Sweeping the volumes up there retargeted materials the user had set on
     * volumes they had not selected, under a control labelled "Change material" for the body row.
     */
    options?: { includeVolumes?: boolean }
  ) => {
    const includeVolumes = options?.includeVolumes ?? true
    const keySet = new Set(keys)
    if (keySet.size === 0) return
    // The object identities behind those keys. An import-backed instance uses its synthetic id,
    // which is unique per import, so a fresh import matches only itself -- correct, since nothing
    // else shares its geometry.
    const ownerIds = new Set<number>()
    for (const plate of stateRef.current?.plates ?? []) {
      for (const instance of plate.instances) {
        if (!keySet.has(instance.key)) continue
        const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
        if (ownerId != null) ownerIds.add(ownerId)
      }
    }
    const targeted = (instance: EditorInstance) => {
      if (keySet.has(instance.key)) return true
      const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
      return ownerId != null && ownerIds.has(ownerId)
    }
    // The object's SESSION-ADDED volumes are parts of it too, and this is the "set all parts'
    // material" action, so they are retargeted in the same gesture. Left out, the badge summarising
    // them showed a mixed swatch that the action could not resolve, and the volume changed material
    // by itself on the next save, when it became a baked part and started following this path.
    // Keys, not ids, because that is what the added-part seam addresses.
    const volumeKeys = (includeVolumes ? Object.entries(stateRef.current?.addedParts ?? {}) : [])
      .filter(([hostId]) => ownerIds.has(Number(hostId)))
      .flatMap(([, parts]) => parts)
      .filter((part) => threeMfPartSubtypeCarriesFilament(part.subtype))
      .map((part) => part.key)
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) => (targeted(instance)
        ? assignInstanceFilament(instance, filamentId)
        : instance))
    })), 'material')
    // `updatePlates` already checkpointed this gesture, so the volume half must not checkpoint
    // again: two entries would make one material change take two Ctrl+Z.
    if (volumeKeys.length > 0) {
      handleChangeAddedPartFilamentsRef.current(volumeKeys, filamentId, { recordHistory: false })
    }
  }, [updatePlates])

  /**
   * Whether a material change means anything for these parts: true as soon as ONE of them can
   * hold a filament. A selection of only support blockers/enforcers and negative volumes has no
   * material to change, so the part context menu drops the item instead of offering a no-op
   * (`reassignFilament` would skip them anyway).
   */
  const partsAcceptFilament = useCallback((objectId: number, members: ReadonlyArray<PartMember>) => {
    // The BODY carries the OBJECT's material, which is a real, changeable material -- the second of
    // the two places one can live. Excluded, the body row was the only volume row with no material
    // control at all, and it grew one on the next save when the body became a baked part.
    if (members.some((member) => member.kind === 'body')) return true
    const ids = new Set(members.flatMap((member) => (member.kind === 'baked' ? [member.partIndex] : [])))
    const keys = new Set(members.flatMap((member) => (member.kind === 'added' ? [member.key] : [])))
    for (const instance of activePlateRef.current?.instances ?? []) {
      if (addedPartHostId(instance) !== objectId) continue
      if (instance.parts.some((part) => ids.has(part.partIndex) && threeMfPartSubtypeCarriesFilament(part.subtype))) return true
      // A volume carries a material on exactly the same rule (`threeMfPartSubtypeCarriesFilament`),
      // so a mixed selection offers the picker when ANY member can take one, as it does for parts.
      if (effectiveAddedParts(stateRef.current, instance)
        .some((part) => keys.has(part.key) && threeMfPartSubtypeCarriesFilament(part.subtype))) return true
    }
    return false
  }, [])

  /**
   * Whether the part CONTEXT MENU should offer Delete for this selection: the same last-printed-part
   * rule the sidebar's trash button applies, asked of the whole selection at once so selecting every
   * part of an object hides the item rather than offering a refused action.
   */
  const partSelectionRemovable = useCallback((objectId: number, members: ReadonlyArray<PartMember>) => {
    const instance = stateRef.current?.plates
      .flatMap((plate) => plate.instances)
      .find((entry) => addedPartHostId(entry) === objectId)
    if (!instance) return false
    // ONE question, asked of every kind at once: does this object still print something afterwards?
    // Splitting it per kind is what let it be answered wrong -- an added-only selection used to
    // return true outright, on the reasoning that a volume is never the last printed thing. It is,
    // on an object whose body has already gone: the last volume then left an object with no
    // geometry, invisible in the viewport, and the save wrote the DELETED BODY back, because
    // `removedObjectBodies` is only honoured for a host that still has added parts to write.
    const goingKeys = new Set(members.flatMap((member) => (member.kind === 'added' ? [member.key] : [])))
    const bakedIndexes = new Set(members.flatMap((member) => (member.kind === 'baked' ? [member.partIndex] : [])))
    const survivingVolumes = effectiveAddedParts(stateRef.current, instance)
      .filter((part) => !goingKeys.has(part.key)
        && !isNonRenderableThreeMfPartSubtype(canonicalThreeMfPartSubtype(part.subtype)))
      .length
    // The body is printed geometry too, for exactly the objects whose part list does not describe
    // them -- `canRemoveParts` counts baked parts and cannot see it, so it is passed in alongside
    // the volumes rather than special-cased ahead of it.
    const bodySurvives = instance.parts.length === 0
      && !instance.bodyRemoved
      && !members.some((member) => member.kind === 'body')
      && !isNonRenderableThreeMfPartSubtype(bodyPartSubtype(stateRef.current, instance))
    return canRemoveParts(instance, bakedIndexes, survivingVolumes + (bodySurvives ? 1 : 0))
  }, [])

  // Change parts' Bambu volume type (BambuStudio's "Change type": normal / negative /
  // modifier / support blocker / enforcer), for one part or a whole part selection. The
  // type is a property of the object's part, shared across instances and plates, so it
  // is recorded once per part in partTypeChanges (for the bake) and reflected onto every
  // matching part.subtype (for the list and the viewport, which restyles on the rebuild).
  const handleChangePartTypes = useCallback((targets: ReadonlyArray<{ objectId: number; partIndex: number }>, subtype: SceneEditPartSubtype) => {
    if (targets.length === 0) return
    const targetSet = new Set(targets.map((target) => partSlotKey(target.objectId, target.partIndex)))
    recordHistory()
    setState((current) => {
      if (!current) return current
      const plates = current.plates.map((plate) => ({
        ...plate,
        instances: plate.instances.map((instance) => {
          // Object parts key on the Bambu object id; import parts on the import's synthetic
          // object identity (replacedObjectId): same ownership rule as filament reassignment.
          const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
          if (ownerId == null || !instance.parts.some((part) => targetSet.has(partSlotKey(ownerId, part.partIndex)))) return instance
          // Retyping to a support blocker/enforcer or negative volume drops the part's material:
          // it no longer has one, and a leftover filamentId would be baked back as `extruder`
          // metadata on the next save. Retyping back to a printed part leaves it unassigned, so
          // it inherits the object's filament again.
          const keepsFilament = threeMfPartSubtypeCarriesFilament(subtype)
          return {
            ...instance,
            parts: instance.parts.map((part) => targetSet.has(partSlotKey(ownerId, part.partIndex))
              ? { ...part, subtype, ...(keepsFilament ? {} : { filamentId: null, color: null }) }
              : part)
          }
        })
      }))
      const partTypeChanges = { ...(current.partTypeChanges ?? {}) }
      for (const target of targets) partTypeChanges[partSlotKey(target.objectId, target.partIndex)] = subtype
      return { ...current, plates, partTypeChanges }
    })
    setRebuildToken((token) => token + 1)
  }, [recordHistory])

  /**
   * The sidebar's single-part case, and the ONE added-parts reader it is given.
   *
   * Both exist only to be stable. `ObjectList` is memoised, and it is by far the most expensive
   * thing the editor renders (measured: with a 166-row sidebar it is ~82% of the render cost of a
   * keystroke in the Text tool), so a prop rebuilt inline in JSX defeats the memo and re-renders
   * every row for an edit that touched none of them.
   *
   * `addedPartsFor` reads the IN-PLACE-mutated session map off a ref, so nothing about its result is
   * visible to React. `addedPartMeshVersion` is the signal that the map moved; see its declaration.
   */
  const handleChangeOnePartType = useCallback(
    (objectId: number, partIndex: number, subtype: SceneEditPartSubtype) =>
      handleChangePartTypes([{ objectId, partIndex }], subtype),
    [handleChangePartTypes]
  )
  /**
   * Right-click a session-added volume.
   *
   * Now the SAME handler as every other part row, which is the point of the merge: it was a separate
   * path only because the volume's selection lived in a state of its own, and that path had drifted
   * (it replaced the selection outright rather than keeping a set the row already belonged to, so
   * right-clicking one member of a multi-selection narrowed the menu to that row).
   */
  const handleAddedPartContextMenu = useCallback((objectId: number, partKey: string, position: ContextMenuAnchor, instanceKey: string) => {
    // Spread the whole anchor: naming x and y by hand silently dropped `align`, so the kebab on a
    // session-added volume -- the row the kebab exists for, since a touch user has no right-click --
    // was the one that still opened diagonally off its own button.
    handlePartRowContextMenu(objectId, { kind: 'added', key: partKey }, position, instanceKey)
  }, [handlePartRowContextMenu])

  /**
   * The body row's subtype, stable for the memoised list.
   *
   * Keyed on the map it reads rather than a version counter: `partTypeChanges` is REPLACED on every
   * change (unlike `addedParts`, which is mutated in place), so its identity is the honest signal.
   */
  const bodySubtypeFor = useCallback(
    (instance: EditorInstance) => bodyPartSubtype(stateRef.current, instance),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state?.partTypeChanges]
  )
  const addedPartsFor = useCallback(
    (instance: EditorInstance) => effectiveAddedParts(stateRef.current, instance),
    // The version IS the dependency, though the body never names it: the map this reads is mutated
    // IN PLACE behind a ref, so its contents changing is invisible to React and to the rule, which
    // therefore calls the only thing keeping the sidebar correct "unnecessary".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addedPartMeshVersion]
  )

  /**
   * The sidebar's slice-config controls, as one stable object.
   *
   * Hoisted out of the JSX for the memo above: it was an object literal rebuilding a `Set` from
   * three sources on every render, so `ObjectList` re-rendered for every keystroke anywhere in the
   * editor. The membership it computes is unchanged -- see the notes on each source.
   */
  const objectListPerObject = useMemo<ObjectListPerObject | undefined>(() => {
    if (!perObject) return undefined
    return {
      // Baked objects from the slice index PLUS each not-yet-saved import's synthetic object id, so
      // per-object process is editable before any save.
      sliceObjectIds: new Set<number>([
        ...(sliceConfig?.plateObjects ?? []).map((object) => object.id),
        ...(activePlate?.instances ?? []).flatMap((instance) =>
          instance.source.kind === 'import' && instance.source.replacedObjectId != null
            ? [instance.source.replacedObjectId]
            : []),
        // An independent COPY has no baked slice-index id yet either; its placeholder is re-keyed
        // onto the copy's real object at save/slice time (`clonedObjectIds`), so its process
        // settings need no save first.
        ...Object.keys(state?.objectClones ?? {}).map(Number)
      ]),
      overrideCountFor: (objectId) => Object.keys(perObject.value[String(objectId)] ?? {}).length,
      onEditObject: (objectId, name) => setEditingObject({ ids: [objectId], name }),
      onEditPart: (objectId, partIndex, name) => setEditingPart({ objectId, members: [{ kind: 'baked', partIndex }], name }),
      partOverrideCountFor: (objectId, partIndex) =>
        Object.keys(stateRef.current?.partProcessOverrides?.[partSlotKey(objectId, partIndex)] ?? {}).length
    }
    // `partProcessOverrides` IS a dependency, though the body never names it: the count above is
    // read from a live REF, so this object's identity is the only thing telling the memoised rows
    // that a badge changed. Without it the badge did not appear until some other prop moved the row
    // -- deselecting it, in practice, which made a saved change look unsaved. Applying settings
    // replaces the map, so the whole-list re-render lands on that deliberate action, not a keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perObject, sliceConfig?.plateObjects, activePlate?.instances, state?.objectClones,
    state?.partProcessOverrides])

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
    // A rename changes only the object-list label; the 3D viewport shows no names ('inert').
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) =>
        sameObject(instance) ? { ...instance, name: trimmed, nameOverridden: true } : instance
      )
    })), 'inert')
  }, [promptText, updatePlates])

  // Place a freshly created instance at a free spot on the active plate, then add it.
  const addInstanceToActivePlate = useCallback((
    instance: EditorInstance,
    /** The new model's XY footprint: where its centre sits in mesh coords, and how big it is. */
    footprint?: { center: { x: number; y: number }; size: { width: number; depth: number } }
  ) => {
    // BambuStudio parity: a project must have a material before any object (import, primitive,
    // cut/split half) can be added. This is the single chokepoint for every add path.
    if ((sliceConfigRef.current?.projectFilaments?.length ?? 0) === 0) {
      toast.error('Add a material to the project before adding objects.')
      return
    }
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (plate) {
      // Measure what is already on the plate (cheap AABB per built model) so placement accounts for
      // the real footprints instead of a fixed radius around each origin, otherwise a large model
      // lands on top of its neighbours. Empty => let findFreePlatePosition use its nominal fallback.
      const occupied: PlateFootprintRect[] = []
      for (const placed of plate.instances) {
        const group = groupByKeyRef.current.get(placed.key)
        if (!group) continue
        const box = printableMeshBox(group, false)
        if (!box.isEmpty()) occupied.push({ minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y })
      }
      const spot = findFreePlatePosition(plate, {
        size: footprint?.size,
        occupied: occupied.length > 0 ? occupied : undefined
      })
      // `instance.position` places the object's LOCAL ORIGIN, but an imported mesh keeps its file
      // coordinates (origin often at a corner), so dropping the origin on the free spot lands the
      // model off-centre. Offset by the mesh's XY centroid so the model's CENTRE sits on the spot.
      // Primitives are already origin-centred (centroid ~ 0), so this is a no-op for them.
      instance.position.set(spot.x - (footprint?.center.x ?? 0), spot.y - (footprint?.center.y ?? 0), instance.position.z)
    }
    updatePlates((plates) =>
      plates.map((plate) =>
        plate.index === activePlateIndex ? { ...plate, instances: [...plate.instances, instance] } : plate
      )
    )
    setSelectedKey(instance.key)
  }, [activePlateIndex, updatePlates])

  // Persist a dragged prime tower's new lower-left corner into the active plate. The drag already
  // moved the live tower object (useEditorScene), so this is an `inert` state write, a full plate
  // rebuild here just flashes the "loading object" overlay for a move that is already on screen.
  const handleMovePrimeTower = useCallback((cornerX: number, cornerY: number) => {
    updatePlates((plates) => plates.map((plate) => {
      if (plate.index !== activePlateIndex || !plate.primeTower) return plate
      // Every extruder purges into the tower, so it may not be dropped in a single-nozzle-only
      // zone: clamp the drag instead of letting the user create an unprintable plate and only
      // learn about it from a warning. See `lib/primeTowerReach.ts`.
      const tower = primeTowerObjRef.current
      const width = typeof tower?.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0
      const depth = typeof tower?.userData.towerDepth === 'number' ? tower.userData.towerDepth : 0
      const reachable = width > 0 && depth > 0
        ? clampPrimeTowerIntoReach(
          { minX: cornerX, maxX: cornerX + width, minY: cornerY, maxY: cornerY + depth },
          plate.bed,
          plate.bed.excludeAreas
        )
        : { x: cornerX, y: cornerY }
      return { ...plate, primeTower: { ...plate.primeTower, x: reachable.x, y: reachable.y } }
    }), 'inert')
  }, [activePlateIndex, updatePlates])
  movePrimeTowerRef.current = handleMovePrimeTower

  /** Add an import-backed instance onto the active plate from a staged foreign model. */
  const addStagedImport = useCallback((staged: StagedImport) => {
    // The material guard lives in addInstanceToActivePlate (the shared add chokepoint).
    // Centre the model on the drop spot using its bounds' XY midpoint (imports keep file coords),
    // and hand over its size so placement keeps it clear of what's already on the plate.
    addInstanceToActivePlate(instanceFromStagedImport(staged, importStore.meshUrl), stagedFootprint(staged))
  }, [addInstanceToActivePlate, importStore])

  /**
   * The object's HELPER volumes (modifier / negative / support blocker / enforcer) as WORLD triangle
   * soups plus what each one is, so an operation that rebuilds the object's geometry can carry them
   * across. Covers both kinds the editor can hold: session-added volumes (`state.addedParts`) and
   * volumes baked into the project's 3MF.
   *
   * World space on purpose. The carried volume is re-attached with an IDENTITY transform against the
   * new piece's rebased mesh, so every rotation/scale/placement it inherited is already in its
   * vertices and there is no frame left to get wrong.
   */
  const collectHelperVolumesFor = useCallback((instance: EditorInstance, group: THREE.Group): Array<{
    soup: Float32Array
    subtype: SceneEditPartSubtype
    name: string
    filamentId: number | null
  }> => {
    const addedByKey = new Map(effectiveAddedParts(stateRef.current, instance).map((part) => [part.key, part]))
    const out: Array<{ soup: Float32Array; subtype: SceneEditPartSubtype; name: string; filamentId: number | null }> = []
    group.traverse((node) => {
      if (node.userData.isHelperVolume !== true) return
      // A BAKED helper part tags both its group and the mesh inside it; take the group only, or the
      // volume is collected twice.
      if (node.parent?.userData.isHelperVolume === true) return
      const soup = collectWorldTriangles(node, { includeModifierVolumes: true })
      if (soup.length === 0) return
      const addedKey = typeof node.userData.addedPartKey === 'string' ? node.userData.addedPartKey : null
      const addedPart = addedKey ? addedByKey.get(addedKey) : undefined
      if (addedPart) {
        out.push({ soup, subtype: addedPart.subtype, name: addedPart.name, filamentId: addedPart.filamentId ?? null })
        return
      }
      const ref = partGroupRef(node)
      // Resolved by ORDINAL, not by array position: `partIndex` is a base-file identity that the
      // list does not renumber, so a removed part (which filters the array) or a reordered one
      // makes the two disagree. Indexing here carried a support ENFORCER onto a cut half as the
      // BLOCKER that had slid into its slot, suppressing supports exactly where they were asked
      // for -- or dropped the volume silently when the slot held a normal part.
      const bakedPart = ref ? instance.parts.find((entry) => entry.partIndex === ref.partIndex) : undefined
      const subtype = bakedPart?.subtype ?? null
      // `helperVolumeSpec` is the same predicate the renderer used to decide this IS a helper
      // volume, so a subtype it does not recognise cannot have been tagged in the first place.
      if (subtype == null || helperVolumeSpec(subtype) == null) return
      out.push({
        soup,
        subtype: subtype as SceneEditPartSubtype,
        name: bakedPart?.name ?? addedPartLabel(subtype as SceneEditPartSubtype),
        filamentId: bakedPart?.filamentId ?? null
      })
    })
    return out
  }, [])

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
    const worldSoup = collectWorldTriangles(group)
    const { upper, lower } = cutMode === 'dovetail'
      ? cutTriangleSoupWithGroove(worldSoup, cutAxis, clampedCutOffset, groove)
      : cutTriangleSoup(worldSoup, cutAxis, clampedCutOffset)
    // A grooved half can come back with a boundary on some model sizes and placements, including at
    // the tool's own defaults (see the KNOWN DEFECT note on `cutTriangleSoupWithGroove`). It is
    // cheap to SEE -- the same predicate the mesh boolean gates on -- so the cut says so rather than
    // handing over a piece that slices oddly and is later refused as a boolean operand with no hint
    // of where it came from. Only the dovetail is checked: the plane cut has its own tests and this
    // walk is not free.
    if (cutMode === 'dovetail' && ((upper.length > 0 && !isClosedSoup(upper)) || (lower.length > 0 && !isClosedSoup(lower)))) {
      toast.error('That groove leaves an open edge on this model. Try a different depth, width or axis.')
      return
    }
    const sides = CUT_AXIS_SIDES[cutAxis]
    type CutHalf = { soup: Float32Array; suffix: string; side: 'lower' | 'upper'; orientation: CutHalfOrientation }
    const halves = [
      cutKeepLower && lower.length > 0
        ? { soup: lower, suffix: sides.lower, side: 'lower' as const, orientation: cutOrientLower }
        : null,
      cutKeepUpper && upper.length > 0
        ? { soup: upper, suffix: sides.upper, side: 'upper' as const, orientation: cutOrientUpper }
        : null
    ].filter((half): half is CutHalf => half !== null)
    if (halves.length === 0) {
      toast.error('Nothing to keep: move the cut plane or keep at least one side.')
      return
    }
    // Studio disables Perform on any invalid connector (`can_perform_cut`). The button is disabled
    // here too; this is the guard behind it, because the panel and the cut must never disagree
    // about what is cuttable.
    const problemText = connectorProblemSummary(activeProblems)
    if (problemText) {
      toast.error(`Invalid connectors: ${problemText}.`)
      return
    }
    // Connectors need both halves: one carries the hole and the other the peg, so keeping a single
    // half would silently drop half of every joint.
    if (activeConnectors.length > 0 && halves.length < 2) {
      toast.error('Connectors need both halves kept.')
      return
    }
    setCutting(true)
    try {
      // Collected BEFORE the geometry is replaced: the halves are fresh imports, so anything still
      // addressed through the original instance is gone once it leaves the plate.
      const helperVolumes = collectHelperVolumesFor(instance, group)
      const staged = await Promise.all(halves.map(async (half) => {
        // Cut the connector HOLES into the half's own geometry, so the hole is real: it shows in the
        // viewport, it is already in the staged STL, and the preview matches what prints. Studio
        // leaves them as negative volumes for the slicer, and so did this, but a negative volume is
        // invisible from outside -- it renders as a translucent aid seen THROUGH the surface, so a
        // hole never looks like one and the joint cannot be judged before it is printed.
        //
        // No boolean is involved; see `drillBoresIntoHalf` for why our evaluator cannot do this and
        // does not need to. It reports PER BORE, and a bore it declined to drill keeps its negative
        // volume below, so a failure costs the hole rather than the part -- and only for the
        // connector it failed on. One flag for the whole half dropped the volume of a hole that was
        // never cut, which leaves the matching peg with nothing to mate with.
        const bores = connectorBoresForSide(activeConnectors, cutAxis, half.side)
        const { soup: drilledSoup, drilled } = drillBoresIntoHalf(
          half.soup,
          bores.map((bore) => bore.soup),
          cutAxis,
          clampedCutOffset,
          half.side
        )
        const drilledConnectors = new Set(
          bores.filter((_, index) => drilled[index]).map((bore) => bore.connectorIndex)
        )
        half.soup = drilledSoup
        // Where the piece BELONGS on the plate, measured before any rotation: a reoriented half's
        // rebased centre is expressed in the rotated frame, so using it as a world position drops
        // the piece wherever the rotation sent it (a tall model cut along X landed off the plate).
        const placement = triangleSoupXYCenter(half.soup)
        // Orient BEFORE rebasing, so the rebase floors the piece on the face it now rests on.
        // Which side of the cut a helper volume belongs to was decided above, off the un-rotated
        // soups, because `helperVolumeCutSides` reasons in the cut's own axis frame.
        orientCutHalfSoup(half.soup, cutAxis, half.side, half.orientation)
        const { offset } = rebaseTriangleSoup(half.soup)
        const stl = triangleSoupToBinaryStl(half.soup)
        const file = new File([stl], `${instance.name} (${half.suffix}).stl`, { type: 'application/octet-stream' })
        const mainImport = await importStore.stageFile(file, 'object')
        // BambuStudio never cuts a helper volume: each is carried WHOLE onto the half (or both
        // halves) it overlaps: see `helperVolumeCutSides`. Staged per half because each half is its
        // own import, and shifted by that half's rebase so an identity placement is exact.
        const carried = await Promise.all(helperVolumes
          .filter((volume) => helperVolumeCutSides(volume.soup, cutAxis, clampedCutOffset)[half.side])
          .map(async (volume) => {
            // The SAME rotation as its half, applied before the same rebase shift: a volume that
            // skipped it would stay in the un-rotated frame and detach from the geometry it marks.
            const soup = shiftTriangleSoup(
              orientCutHalfSoup(volume.soup.slice(), cutAxis, half.side, half.orientation),
              offset
            )
            // `part`, NOT `object`: this volume is carried at IDENTITY (its world triangles are
            // already baked into `soup`, shifted by the half's own rebase) and is placed below with
            // a zero position. Normalising it would re-centre those triangles and move the blocker
            // off the geometry it was drawn on.
            const stagedVolume = await importStore.stageFile(new File(
              [triangleSoupToBinaryStl(soup)],
              `${volume.name}.stl`,
              { type: 'application/octet-stream' }
            ), 'part')
            return { volume, importId: stagedVolume.importId, soup }
          }))
        // Connectors ride the SAME orientation and rebase as the half they attach to, so a peg
        // stays on the face it was placed on. Each is its own staged `part` at identity, exactly as
        // a carried helper volume is -- which is the whole reason connectors needed no new seam.
        const connectorParts = await Promise.all(activeConnectors.map(async (connector, index) => {
          const volumes = connectorVolumes(connector, cutAxis)
          const side = half.side === 'upper' ? volumes.upper : volumes.lower
          // A hole already cut into the geometry needs no volume describing it. Asked per connector,
          // so one the drill skipped still gets its negative volume and still becomes a hole.
          if (drilledConnectors.has(index)) return null
          const soup = shiftTriangleSoup(
            orientCutHalfSoup(side.soup.slice(), cutAxis, half.side, half.orientation),
            offset
          )
          const name = `Connector-${index + 1}`
          const stagedPart = await importStore.stageFile(new File(
            [triangleSoupToBinaryStl(soup)],
            `${name}.stl`,
            { type: 'application/octet-stream' }
          ), 'part')
          return { importId: stagedPart.importId, subtype: side.subtype, name, soup, connector }
        })).then((parts) => parts.filter((part): part is NonNullable<typeof part> => part !== null))
        // Half-extents of the piece as it now lies, for the bed clamp below.
        let halfWidth = 0
        let halfDepth = 0
        for (let i = 0; i < half.soup.length; i += 3) {
          halfWidth = Math.max(halfWidth, Math.abs(half.soup[i]!))
          halfDepth = Math.max(halfDepth, Math.abs(half.soup[i + 1]!))
        }
        return { import: mainImport, placement, halfWidth, halfDepth, carried, connectorParts }
      }))
      // A DOWEL is also a loose pin, printed beside the halves and pushed into both holes
      // (`CutUtils.cpp:198`). It is a whole object rather than a volume, because it is not part of
      // either half -- which is the one place a connector adds something to the plate rather than
      // to a piece. Staged as `object`, so it is normalised onto the bed like any other import.
      const dowelPins = await Promise.all(activeConnectors
        .filter((connector) => connector.type === 'dowel')
        .map(async (connector, index) => {
          const soup = connectorVolumes(connector, cutAxis).pin!
          rebaseTriangleSoup(soup)
          const name = `${instance.name} (dowel ${index + 1})`
          const staged = await importStore.stageFile(new File(
            [triangleSoupToBinaryStl(soup)],
            `${name}.stl`,
            { type: 'application/octet-stream' }
          ), 'object')
          return { staged, name }
        }))
      const replacements = staged.map(({ import: stagedImport, placement, halfWidth, halfDepth }, index) => {
        const next = instanceFromStagedImport(stagedImport, importStore.meshUrl)
        // Keep the piece where it was cut, but not off the bed: laying a half on its cut face
        // swaps its height into its footprint, so a tall model's original centre no longer fits.
        // A no-op for an un-reoriented half, which came from a model that was already on the bed.
        next.position.set(
          clampOntoBed(placement.x, halfWidth, plate.bed.minX, plate.bed.maxX),
          clampOntoBed(placement.y, halfDepth, plate.bed.minY, plate.bed.maxY),
          0
        )
        next.filamentId = instance.filamentId
        next.printable = instance.printable
        if (index > 0) {
          const spot = findFreePlatePosition(plate)
          next.position.set(spot.x, spot.y, 0)
        }
        return next
      })
      for (const { staged: stagedPin, name } of dowelPins) {
        const pin = instanceFromStagedImport(stagedPin, importStore.meshUrl)
        const spot = findFreePlatePosition(plate)
        pin.position.set(spot.x, spot.y, 0)
        pin.name = name
        pin.filamentId = instance.filamentId
        pin.printable = instance.printable
        replacements.push(pin)
      }
      // What BambuStudio needs to reopen this as a CUT rather than as unrelated objects. Recorded
      // HERE because this is the only moment the relationship exists: afterwards the halves are
      // ordinary import-backed instances and a connector volume looks like any other added part.
      //
      // Only connectors that still EXIST as volumes are listed. Where the hole was drilled into the
      // geometry there is nothing to point at -- for a dowel, on either half -- so `connectorCount`
      // carries what the cut actually placed while the list carries what can honestly be named.
      //
      // ONE PIECE IS NOT A CUT, and recording it as one is not a cosmetic mistake: `cutGroups`
      // requires at least two importIds (`sceneEditSchema`), so a group naming a single half fails
      // validation at `/api/editor/save` and takes every later save, export and slice of that
      // project down with it -- a 400 naming an array the user has never heard of, from a plain
      // "chop the top off" with Keep upper unticked. Studio declines the same record for the same
      // reason (`update_object_cut_id` returns early unless it kept both halves), and
      // `serializeCutInformation` drops a sub-two group too, so nothing downstream loses anything.
      const cutPieceImportIds = [
        ...staged.map(({ import: stagedImport }) => stagedImport.importId),
        ...dowelPins.map(({ staged: stagedPin }) => stagedPin.importId)
      ]
      const cutGroup: EditorCutGroup | null = cutPieceImportIds.length < 2 ? null : {
        importIds: cutPieceImportIds,
        connectorCount: activeConnectors.length,
        connectors: staged.flatMap(({ import: stagedImport, connectorParts }) =>
          connectorParts.map(({ importId, connector }) => ({
            importId: stagedImport.importId,
            meshImportId: importId,
            type: connector.type,
            radius: connector.radius,
            height: connector.height,
            radiusTolerance: connector.radiusTolerance,
            heightTolerance: connector.heightTolerance
          })))
      }

      // Each half's carried volumes, keyed by that half's host identity (an import's synthetic
      // object id: see `addedPartHostId`), so they need no save first.
      const carriedByHost = new Map<number, EditorAddedPart[]>()
      replacements.forEach((replacement, index) => {
        const hostId = addedPartHostId(replacement)
        const carried = staged[index]?.carried ?? []
        const connectorParts = staged[index]?.connectorParts ?? []
        if (hostId == null || (carried.length === 0 && connectorParts.length === 0)) return
        const connectorEntries: EditorAddedPart[] = connectorParts.map(({ importId, subtype, name, soup }) => ({
          key: nextInstanceKey(),
          importId,
          subtype,
          name,
          // Identity placement: the soup already carries the world transform and the half's rebase.
          position: new THREE.Vector3(),
          rotation: new THREE.Euler(),
          scale: new THREE.Vector3(1, 1, 1),
          soup
        }))
        carriedByHost.set(hostId, [...connectorEntries, ...carried.map(({ volume, importId, soup }) => ({
          key: nextInstanceKey(),
          importId,
          subtype: volume.subtype,
          name: volume.name,
          ...(threeMfPartSubtypeCarriesFilament(volume.subtype) && volume.filamentId != null
            ? { filamentId: volume.filamentId }
            : {}),
          // Identity: the volume's world triangles are already baked into `soup`.
          position: new THREE.Vector3(),
          rotation: new THREE.Euler(),
          scale: new THREE.Vector3(1, 1, 1),
          soup
        }))])
      })
      // One history entry for the whole cut, so a single undo restores the object AND its volumes.
      // Hand-rolled rather than `updatePlates` because the carried volumes and the plate swap must
      // land in the same commit: added parts live beside `plates` on the state root.
      recordHistoryRef.current?.()
      setState((current) => {
        if (!current) return current
        const addedParts = { ...(current.addedParts ?? {}) }
        for (const [hostId, parts] of carriedByHost) addedParts[hostId] = parts
        return {
          ...current,
          addedParts,
          // Appended, never replaced: a project can hold several cuts, and each is its own group.
          // Rides the same commit as the pieces so one undo takes the cut and its record together.
          ...(cutGroup ? { cutGroups: [...(current.cutGroups ?? []), cutGroup] } : {}),
          plates: current.plates.map((entry) => entry.index === activePlateIndex
            ? { ...entry, instances: [...entry.instances.filter((item) => item.key !== key), ...replacements] }
            : entry)
        }
      })
      // Carried volumes moved between hosts, so every reader of `addedParts` is stale. The instance
      // list changes here too, which would invalidate the sidebar by itself -- bumped anyway,
      // because "some other prop happens to change as well" is the reasoning that makes the next
      // caller's omission invisible.
      setAddedPartMeshVersion((version) => version + 1)
      setRebuildToken((token) => token + 1)
      setSelectedKey(replacements[0]!.key)
      setGizmoMode('translate')
      // Counted off the CARRIED volumes, not off `carriedByHost`, which now also holds the connector
      // volumes: those are reported on their own line and would otherwise be announced twice, once
      // as connectors and again as helper volumes the user never placed.
      const carriedCount = staged.reduce((total, half) => total + half.carried.length, 0)
      const pieceCount = replacements.length - dowelPins.length
      toast.success(`Cut ${instance.name} into ${pieceCount === 2 ? 'two parts' : 'one part'}.`
        + (activeConnectors.length > 0 ? ` Added ${activeConnectors.length} connector${activeConnectors.length === 1 ? '' : 's'}.` : '')
        + (dowelPins.length > 0 ? ` Printed ${dowelPins.length} dowel pin${dowelPins.length === 1 ? '' : 's'} alongside.` : '')
        + (carriedCount > 0 ? ` Kept ${carriedCount} helper volume${carriedCount === 1 ? '' : 's'}.` : ''))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to cut the model.')
    } finally {
      setCutting(false)
    }
  }, [selectedKey, activePlateIndex, cutMode, groove, activeConnectors, activeProblems, cutAxis, clampedCutOffset, cutKeepLower, cutKeepUpper, cutOrientLower, cutOrientUpper, collectHelperVolumesFor, recordHistoryRef, importStore])

  /**
   * Split the selected object into its connected mesh components (Bambu's "split to
   * objects"): each shell becomes its own import-backed instance, replacing the
   * original in one undoable step. Parts keep their world XY spots and rest on the bed.
   *
   * Helper volumes (modifiers/blockers) are DISCARDED, matching BambuStudio, its
   * `ModelObject::split` skips every `!MODEL_PART` volume, because which shell should own a volume
   * that overlaps several has no obvious answer. Unlike BambuStudio we say so rather than dropping
   * them silently, since it is the user's work going away. (The CUT does carry them, there the
   * plane gives an unambiguous rule.)
   */
  const handleSplitToObjects = useCallback(async (key: string) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = groupByKeyRef.current.get(key)
    if (!plate || !instance || !group) return
    const discardedHelpers = collectHelperVolumesFor(instance, group).length
    const parts = splitTriangleSoup(collectWorldTriangles(group))
    if (parts.length < 2) {
      toast.error(`${instance.name} is already a single connected part.`)
      return
    }
    if (parts.length > 50) {
      toast.error(`${instance.name} has ${parts.length} shells, too many to split into objects.`)
      return
    }
    setImporting(true)
    try {
      const staged = await Promise.all(parts.map(async (soup, index) => {
        const { offset } = rebaseTriangleSoup(soup)
        const stl = triangleSoupToBinaryStl(soup)
        const file = new File([stl], `${instance.name} (part ${index + 1}).stl`, { type: 'application/octet-stream' })
        return { import: await importStore.stageFile(file, 'object'), offset }
      }))
      const replacements = staged.map(({ import: stagedImport, offset }) => {
        const next = instanceFromStagedImport(stagedImport, importStore.meshUrl)
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
      toast.success(`Split ${instance.name} into ${replacements.length} objects.`
        + (discardedHelpers > 0
          ? ` ${discardedHelpers} helper volume${discardedHelpers === 1 ? '' : 's'} could not be carried over: undo to get ${discardedHelpers === 1 ? 'it' : 'them'} back.`
          : ''))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to split the model.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, updatePlates, collectHelperVolumesFor, importStore])

  /** Active-plate instances + live render groups for the given keys (missing entries dropped). */
  const exportMembersFor = useCallback((keys: ReadonlyArray<string>) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    return keys
      .map((key) => ({ instance: plate?.instances.find((entry) => entry.key === key), group: groupByKeyRef.current.get(key) }))
      .filter((member): member is { instance: EditorInstance; group: THREE.Group } => Boolean(member.instance && member.group))
  }, [activePlateIndex])

  /**
   * Build ONE STL for the given objects (BambuStudio's "Export as one STL"): model
   * parts merged with world placement baked (a multi-object selection keeps its
   * relative layout), re-centred on the origin. Helper volumes (negative parts,
   * modifiers, support blockers/enforcers) are dropped, there is no client-side mesh
   * boolean, so `droppedVolumes` lets the caller tell the user. Returns null (with an
   * error toast) when nothing solid remains, e.g. every part is a modifier.
   */
  const buildSelectionStl = useCallback((keys: ReadonlyArray<string>): { stl: ArrayBuffer; name: string; droppedVolumes: boolean } | null => {
    const members = exportMembersFor(keys)
    if (members.length === 0) return null
    const stl = buildObjectsStl(members.map((member) => member.group))
    if (!stl) {
      toast.error(members.length === 1
        ? `${members[0]!.instance.name} has no solid geometry to export.`
        : 'The selected objects have no solid geometry to export.')
      return null
    }
    return { stl, name: members[0]!.instance.name, droppedVolumes: members.some((member) => groupHasExcludedVolumes(member.group)) }
  }, [exportMembersFor])

  /**
   * Build one STL PER object (BambuStudio's "Export as STLs…"), each named after its
   * object with a " (2)"-style suffix deduping repeats. Objects with no solid geometry
   * are skipped; null (with an error toast) when nothing at all can be exported.
   */
  const buildSelectionStlFiles = useCallback((keys: ReadonlyArray<string>): Array<{ fileName: string; stl: ArrayBuffer; droppedVolumes: boolean }> | null => {
    const members = exportMembersFor(keys)
    if (members.length === 0) return null
    const nameCounts = new Map<string, number>()
    const files: Array<{ fileName: string; stl: ArrayBuffer; droppedVolumes: boolean }> = []
    for (const member of members) {
      const stl = buildObjectStl(member.group)
      if (!stl) continue
      const base = stlExportBaseName(member.instance.name)
      const count = (nameCounts.get(base) ?? 0) + 1
      nameCounts.set(base, count)
      files.push({
        fileName: `${count === 1 ? base : `${base} (${count})`}.stl`,
        stl,
        droppedVolumes: groupHasExcludedVolumes(member.group)
      })
    }
    if (files.length === 0) {
      toast.error('The selected objects have no solid geometry to export.')
      return null
    }
    return files
  }, [exportMembersFor])

  /**
   * Build one STL for specific PARTS of one object (the part menu's export), including
   * a selected helper volume, since picking it is the deliberate ask. `ownerId` is the
   * part selection's object key: the Bambu object id, or an import's synthetic
   * `replacedObjectId` (the same ownership rule as part type/material changes).
   */
  const buildPartsExport = useCallback((ownerId: number, members: ReadonlyArray<PartMember>): { stl: ArrayBuffer; name: string; droppedVolumes: boolean } | null => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => addedPartHostId(entry) === ownerId)
    const group = instance ? groupByKeyRef.current.get(instance.key) : undefined
    if (!instance || !group) return null
    const stl = buildSelectedPartsStl(group, members)
    if (!stl) {
      toast.error('The selected parts have no geometry to export.')
      return null
    }
    const name = partsExportName(instance, members, effectiveAddedParts(stateRef.current, instance))
    return { stl, name, droppedVolumes: false }
  }, [activePlateIndex])

  const downloadExportedStl = useCallback((built: { stl: ArrayBuffer; name: string; droppedVolumes: boolean }) => {
    const fileName = stlExportFileName(built.name)
    downloadBlob(new Blob([built.stl], { type: 'application/octet-stream' }), fileName)
    if (built.droppedVolumes) {
      toast.warn(`Exported ${fileName}: negative, modifier, and support volumes are not included.`)
    } else {
      toast.success(`Exported ${fileName}.`)
    }
  }, [])

  const handleExportMergedDownload = useCallback((keys: ReadonlyArray<string>) => {
    const built = buildSelectionStl(keys)
    if (built) downloadExportedStl(built)
  }, [buildSelectionStl, downloadExportedStl])

  const handleExportSeparateDownload = useCallback((keys: ReadonlyArray<string>) => {
    const files = buildSelectionStlFiles(keys)
    if (!files) return
    for (const file of files) {
      downloadBlob(new Blob([file.stl], { type: 'application/octet-stream' }), file.fileName)
    }
    if (files.some((file) => file.droppedVolumes)) {
      toast.warn(`Exported ${files.length} STLs: negative, modifier, and support volumes are not included.`)
    } else {
      toast.success(`Exported ${files.length} STLs.`)
    }
  }, [buildSelectionStlFiles])

  const handleExportPartsDownload = useCallback((ownerId: number, members: ReadonlyArray<PartMember>) => {
    const built = buildPartsExport(ownerId, members)
    if (built) downloadExportedStl(built)
  }, [buildPartsExport, downloadExportedStl])

  /**
   * Build a vanilla 3MF for the given objects (BambuStudio's "Export Generic 3MF"), each object a
   * separately named solid in ONE file.
   *
   * Async where the STL builders are not, because the archive is deflated off the main thread
   * (`zipArchiveEntries`); a plate's worth of geometry zipped inline is a visible freeze.
   */
  const buildSelectionGenericThreeMf = useCallback(async (
    keys: ReadonlyArray<string>
  ): Promise<{ bytes: Uint8Array; name: string; droppedVolumes: boolean } | null> => {
    const members = exportMembersFor(keys)
    if (members.length === 0) return null
    const bytes = await buildGenericThreeMf(members.map((member) => ({ name: member.instance.name, group: member.group })))
    if (!bytes) {
      toast.error(members.length === 1
        ? `${members[0]!.instance.name} has no solid geometry to export.`
        : 'The selected objects have no solid geometry to export.')
      return null
    }
    return { bytes, name: members[0]!.instance.name, droppedVolumes: members.some((member) => groupHasExcludedVolumes(member.group)) }
  }, [exportMembersFor])

  const handleExportGenericThreeMfDownload = useCallback((keys: ReadonlyArray<string>) => {
    // Every sibling STL export is synchronous and cannot fail this way; this one deflates the
    // archive off-thread, so it has two rejection paths (a worker zip failure that does not fall
    // back, and the writer's own "no solid had usable geometry"). Unhandled, both leave the user
    // with no file, no toast and no error, i.e. a menu item that silently does nothing.
    void (async () => {
      try {
        const built = await buildSelectionGenericThreeMf(keys)
        if (!built) return
        const fileName = genericThreeMfExportFileName(built.name)
        downloadBlob(new Blob([built.bytes as BlobPart], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }), fileName)
        // The same caveat the STL export reports, and for the same reason: no client-side mesh
        // boolean, so a negative volume cannot be applied and is left out rather than written solid.
        if (built.droppedVolumes) {
          toast.warn(`Exported ${fileName}: negative, modifier, and support volumes are not included.`)
        } else {
          toast.success(`Exported ${fileName}.`)
        }
      } catch (error) {
        toast.error(`Could not export the 3MF: ${extractErrorMessage(error, 'the file could not be written')}`)
      }
    })()
  }, [buildSelectionGenericThreeMf])

  /** Destination-dialog submit for export-to-library: upload through the shared queue (its toast reports progress). */
  const handleExportToLibrarySubmit = useCallback((outputFileName: string | null, outputFolderId: string | null) => {
    const request = exportRequest
    setExportRequest(null)
    if (!request) return
    const destination = { folderId: outputFolderId, bridgeId: saveAsBridgeId }
    if (request.kind === 'separate') {
      const files = buildSelectionStlFiles(request.keys)
      if (!files) return
      enqueueLibraryUploads(
        files.map((file) => ({ file: new File([file.stl], file.fileName, { type: 'application/octet-stream' }), folderSegments: [] })),
        destination
      )
      if (files.some((file) => file.droppedVolumes)) {
        toast.warn('Negative, modifier, and support volumes are not included in the exported STLs.')
      }
      return
    }
    if (!outputFileName) return
    if (request.kind === 'generic3mf') {
      // Async, unlike every sibling: the archive is deflated off the main thread. Fire-and-forget
      // because the upload queue owns the progress toast from here on -- but NOT unguarded: the
      // dialog has already closed by this point, so an unhandled rejection would leave the user
      // looking at a dismissed dialog and no file, with nothing said.
      void (async () => {
        try {
          const built = await buildSelectionGenericThreeMf(request.keys)
          if (!built) return
          const file = new File([built.bytes as BlobPart], `${outputFileName}.3mf`, {
            type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
          })
          enqueueLibraryUploads([{ file, folderSegments: [] }], destination)
          if (built.droppedVolumes) {
            toast.warn(`Exporting ${file.name}: negative, modifier, and support volumes are not included.`)
          }
        } catch (error) {
          toast.error(`Could not export the 3MF: ${extractErrorMessage(error, 'the file could not be written')}`)
        }
      })()
      return
    }
    // 'project' never lands here (the dialog dispatches it straight to the save hook),
    // but the narrowing treats both single-key kinds the same.
    const built = request.kind === 'parts'
      ? buildPartsExport(request.ownerId, request.members)
      : buildSelectionStl(request.kind === 'object' || request.kind === 'project' ? [request.key] : request.keys)
    if (!built) return
    const file = new File([built.stl], `${outputFileName}.stl`, { type: 'application/octet-stream' })
    enqueueLibraryUploads([{ file, folderSegments: [] }], destination)
    if (built.droppedVolumes) {
      toast.warn(`Exporting ${file.name}: negative, modifier, and support volumes are not included.`)
    }
  }, [exportRequest, buildSelectionStlFiles, buildPartsExport, buildSelectionStl, buildSelectionGenericThreeMf, saveAsBridgeId])

  /**
   * Add a new part volume (negative part / modifier / support blocker / enforcer)
   * inside an object: a cube sized to the object, placed at its centre, staged as an
   * import so the save bakes it in as a `<component>` with the Bambu subtype. The
   * part is selected immediately so the gizmo can position it.
   */
  /**
   * Mark the right-clicked object's mesh for repair on save. The repair itself runs server-side
   * while baking (`SceneEdit.repairedObjectIds`), where it can rewrite the mesh in place and keep
   * the object's paint and part volumes, so there is nothing to apply to the local scene, and
   * nothing to see: welding cracked vertices and dropping junk facets is visually a no-op. Marking
   * is the whole edit, which is why it just records history and reports what will happen.
   */
  const handleRepairMesh = useCallback((key: string) => {
    const state = stateRef.current
    const plate = state?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    if (!state || !instance) return
    // Works on a not-yet-saved import too: it is marked by the import's synthetic object identity
    // and emitted as `repairedImportIds`, which the bake applies to the staged geometry. Nothing in
    // this editor may require a save first (see the plugin guide's no-save-first rule).
    const markId = addedPartHostId(instance)
    if (markId == null) return
    if (isObjectMarkedForRepair(state, markId)) return
    recordHistoryRef.current?.()
    state.repairedObjectIds = [...(state.repairedObjectIds ?? []), markId]
    toast.success('Mesh repair will run for this object when you save.')
  }, [activePlateIndex, recordHistoryRef])

  /**
   * Add a new part volume inside a model: BambuStudio's "Add part / negative part / modifier /
   * support blocker / enforcer", from a generated primitive or a loaded mesh.
   *
   * Works on an unsaved import as well as an in-project object: both address the part's host by
   * {@link addedPartHostId}, and the bake resolves an import host through the same map that places
   * the import itself. A NORMAL part inherits its host's material, which is what BambuStudio does
   * (`load_generic_subobject` seeds the volume's extruder from the object's), otherwise the new
   * geometry would silently print in filament 1.
   */
  const handleAddPartVolume = useCallback(async (key: string, subtype: SceneEditPartSubtype, source: AddedPartSource) => {
    const state = stateRef.current
    const plate = state?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = groupByKeyRef.current.get(key)
    if (!state || !instance || !group) return
    const hostId = addedPartHostId(instance)
    if (hostId == null) {
      toast.error('This model cannot take added parts yet.')
      return
    }
    const label = addedPartLabel(subtype)
    const box = printableMeshBox(group)
    const maxDim = box.isEmpty() ? 20 : Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    const size = Math.min(20, Math.max(4, maxDim * 0.25))
    setImporting(true)
    try {
      const staged = await stageAddedPartGeometry(importStore, source, size)
      recordHistoryRef.current?.()
      const rotor = rotorOf(group)
      rotor.updateWorldMatrix(true, false)
      const part: EditorAddedPart = {
        key: nextInstanceKey(),
        importId: staged.importId,
        subtype,
        name: source.kind === 'primitive' ? label : staged.name,
        ...(threeMfPartSubtypeCarriesFilament(subtype) ? { filamentId: instance.filamentId } : {}),
        position: addedPartDropPosition(subtype, box, soupSize(staged.soup), (point) => rotor.worldToLocal(point)),
        rotation: new THREE.Euler(),
        scale: new THREE.Vector3(1, 1, 1),
        soup: staged.soup
      }
      if (!state.addedParts) state.addedParts = {}
      ;(state.addedParts[hostId] ??= []).push(part)
      refreshAddedPartMeshes()
      setGizmoPart({ objectId: hostId, member: { kind: 'added', key: part.key } })
      setGizmoMode('translate')
      regenerateActiveThumbnailRef.current?.()
      toast.success(`Added a ${label.toLowerCase()}: drag it into position.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to add the part.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, refreshAddedPartMeshes, recordHistoryRef, importStore])

  /**
   * Read an SVG the user picks and keep its outlines for the tool to extrude.
   *
   * Read in the tab and never uploaded, like every other model the editor opens. A file whose paths
   * paint NOTHING (neither fill nor stroke) parses fine and yields no shapes, which is reported here
   * rather than being added as a part with no geometry.
   */
  const handleChooseSvgFile = useCallback(() => svgInputRef.current?.click(), [])

  /** Parse a chosen SVG. Split from the click so the hidden input can call it directly. */
  const handleSvgFileChosen = useCallback(async (file: File) => {
    setImporting(true)
    try {
      archiveEntriesRef.current = await projectSourceRef.current.listEntries?.() ?? []
      const markup = await file.text()
      // Refused HERE, naming the artwork, because the alternative is silent and much later: the
      // markup rides every subsequent save of this project, so an oversized file makes each save AND
      // each slice fail on the API's JSON body limit, before validation runs and with nothing in the
      // message pointing at the SVG. The only recovery would be deleting every part it produced.
      if (markup.length > MAX_SVG_SOURCE_BYTES) {
        setSvgArtwork(null)
        setSvgMarkup(null)
        setSvgFileName(file.name)
        setSvgEmptyReason(
          `That file is ${Math.round(markup.length / 1024)}KB, over the ${Math.round(MAX_SVG_SOURCE_BYTES / 1024)}KB limit. `
          + 'The artwork is stored in the project so it stays editable, so it has to fit in a save. '
          + 'Simplify the drawing or flatten it in your vector editor first.'
        )
        return
      }
      const parsed = parseSvgShapes(markup)
      setSvgFileName(file.name)
      // The MARKUP is kept, not just the parse: neither our record nor BambuStudio's stores the
      // shapes, so these bytes are what makes a saved part re-editable, and by the time the save
      // runs the File is long gone.
      setSvgMarkup(markup)
      if (parsed.pieces.length === 0) {
        setSvgArtwork(null)
        setSvgEmptyReason('Nothing in this file is painted, so there is no shape to extrude. Paths need a fill or a stroke.')
        return
      }
      setSvgArtwork(parsed)
      setSvgEmptyReason(null)
    } catch (error) {
      setSvgArtwork(null)
      setSvgEmptyReason(extractErrorMessage(error) || 'That file could not be read as SVG.')
    } finally {
      setImporting(false)
    }
  }, [])

  /**
   * Commit the artwork: a part of the selected model, or its own object when nothing is selected.
   *
   * Both routes hand a soup to the SAME pipeline the text tool and the primitives use, so placement,
   * material seeding and the bake are shared rather than re-implemented for artwork.
   */
  const handleAddSvg = useCallback(async () => {
    if (!svgArtwork) return
    const backgroundIndex = detectSvgBackgroundPiece(svgArtwork)
    const dropped = svgTool.includeBackground ? null : backgroundIndex
    // Filtered by the piece's 1-based index, which `buildSvgPieceSoups` carries, so the numbering in
    // the part names still matches the file's paint order after one is left out.
    const pieces = buildSvgPieceSoups(svgArtwork, { widthMm: svgTool.widthMm, thickness: svgTool.thickness })
      .filter((piece) => dropped == null || piece.index !== dropped + 1)
    if (pieces.length === 0) return
    const base = (svgFileName ?? 'Artwork').replace(/\.svg$/i, '').slice(0, 32) || 'Artwork'
    // One part per drawn shape, so a logo's background can be deleted and each mark can take its own
    // filament. Above the cap the pieces are merged into one: an illustration with hundreds of paths
    // would otherwise bury the object list, and the user is told rather than left to count rows.
    const split = pieces.length > 1 && pieces.length <= SVG_MAX_PARTS
    // Merged from the pieces that SURVIVED the background filter, not rebuilt from the whole file:
    // going back to the artwork here would quietly reinstate the background above the cap.
    const soups = split ? pieces : [{ soup: mergeSoups(pieces.map((piece) => piece.soup)), index: 1, coverage: 1 }]
    const partName = (index: number) => (split ? `${base} ${index}` : base)

    const state = stateRef.current
    // Resolved against every entry the PROJECT already names, including those in the opened archive,
    // and reusing the entry outright when these exact bytes are already stored. See
    // `resolveSvgArchiveEntry`.
    // Re-editing the SAME artwork keeps the entry it already has, and stores nothing: those bytes are
    // in the archive and the bake's copy pass carries them through untouched. Only a REPLACED file
    // (different bytes) resolves a fresh entry.
    const reeditUnchanged = reeditSvgRef.current != null && svgMarkup === reeditSvgRef.current.loadedMarkup
    const svgEntry = svgMarkup == null
      ? null
      : reeditUnchanged
        ? { entryPath: reeditSvgRef.current!.entryPath, reused: true }
        : resolveSvgArchiveEntry(state, svgFileName ?? 'artwork.svg', svgMarkup, archiveEntriesRef.current)
    const svgEntryPath = svgEntry?.entryPath ?? null
    // Nothing to register when the bytes are already stored under this name.
    const svgMarkupToStore = svgEntry && !svgEntry.reused ? svgMarkup : null
    /**
     * The record each part carries. `pieceIndex` 0 means "all of it", which is what a merged import
     * is, and is why the merged and split cases cannot share a numbering.
     */
    const svgRecordFor = (pieceIndex: number): SvgPartRecord | null => (svgEntryPath == null ? null : {
      entryPath: svgEntryPath,
      fileName: svgFileName ?? 'artwork.svg',
      pieceIndex: split ? pieceIndex : 0,
      widthMm: svgTool.widthMm,
      thickness: svgTool.thickness,
      includeBackground: svgTool.includeBackground
    })
    /**
     * BambuStudio's interop record, for a MERGED import only.
     *
     * A split import must not carry one on each part: the element describes a whole artwork, so N
     * copies would each tell Studio they are the entire drawing and editing any single mark there
     * would regenerate the logo over it. Absent is correct; see `three-mf/svg-shape.ts`.
     */
    /**
     * True when the baked geometry is the WHOLE file, which is what Studio's record claims.
     *
     * A dropped backdrop makes that claim false just as surely as a split does: Studio re-parses the
     * SVG and regenerates every shape in it, so a volume built from the artwork MINUS its background
     * would come back WITH the background, replacing geometry the user explicitly excluded. Same
     * class of destruction as stamping the record on a split part, so it gets the same answer.
     */
    const wholeArtwork = !split && dropped == null
    const bambuShapeFor = (): BambuStudioShape | null => (svgEntryPath == null || !wholeArtwork ? null : {
      filePath: svgFileName ?? 'artwork.svg',
      filePathIn3mf: svgEntryPath,
      scale: studioShapeScale(svgTool.widthMm / (svgArtwork?.width || 1)),
      unhealed: false,
      depth: svgTool.thickness,
      useSurface: false,
      fixTransform: studioShapeFixTransform(svgTool.thickness)
    })
    const plate = state?.plates.find((entry) => entry.index === activePlateIndex)
    const hostKey = selectedKeyRef.current
    const instance = hostKey ? plate?.instances.find((entry) => entry.key === hostKey) : null
    const group = hostKey ? groupByKeyRef.current.get(hostKey) : null
    const hostId = instance ? addedPartHostId(instance) : null

    setImporting(true)
    try {
      // RE-EXTRUDING artwork already in the project. This RECONCILES the piece set rather than
      // simply replacing what is there, because the new extrusion may not have the same pieces at
      // all: the background toggle adds or drops one, a replaced file can have more or fewer shapes,
      // and crossing the split threshold in either direction renumbers every piece (a merged import
      // is piece 0, a split one is 1..N). A replace-only pass silently did nothing in each of those
      // cases -- the background checkbox was inert, extra shapes never appeared, and a dropped piece
      // kept its OLD geometry while reporting success.
      const reediting = reeditSvgRef.current
      if (state && reediting) {
        // Resolved from the ARTWORK's own host, never from the current selection: the reopen and the
        // commit are separate gestures, and clicking another object between them used to make a new
        // piece inherit an unrelated model's material and drop point.
        const artworkHost = state.plates
          .flatMap((entry) => entry.instances)
          .find((entry) => addedPartHostId(entry) === reediting.hostId) ?? null
        const artworkGroup = artworkHost ? groupByKeyRef.current.get(artworkHost.key) : null
        // Where a piece with no predecessor lands. Only reached when the new artwork has shapes the
        // old one did not, so there is no existing placement to inherit.
        const artworkDropPosition = artworkHost && artworkGroup
          ? addedPartDropPosition(
            svgTool.operation,
            printableMeshBox(artworkGroup),
            soupSize(soups[0]!.soup),
            (point) => rotorOf(artworkGroup).worldToLocal(point)
          )
          : new THREE.Vector3()
        const survivors = svgArtworkParts(state, reediting.hostId, reediting.entryPath)
        // The piece index a part records, on the SAME rule `svgRecordFor` writes it: 0 when this
        // extrusion is merged, else the piece's own paint order. Both sides must agree or nothing
        // matches, which is exactly what a split/merge flip used to break.
        const pieceKey = (index: number) => (split ? index : 0)
        // The decision itself is pure and lives in `planSvgReextrude`, where the awkward cases (a
        // toggled background, a replaced file with a different shape count, a split/merge flip) are
        // tested; this branch only carries it out.
        const plan = planSvgReextrude(survivors, soups.map((piece) => piece.index), split)
        const survivorByPiece = new Map(
          plan.replace.map(({ pieceIndex, survivor }) => [pieceKey(pieceIndex), survivor])
        )
        // Stage every piece the new extrusion has, whether it is replacing a part or adding one.
        const staged = await Promise.all(soups.map(async (piece) => ({
          piece,
          staged: await stageAddedPartGeometry(
            importStore, { kind: 'soup', soup: piece.soup, name: partName(piece.index) }, 0
          )
        })))
        // A survivor whose piece the new artwork no longer has. Removing it is the only honest
        // answer: leaving it would keep geometry from a drawing that is no longer in the project.
        const orphaned = plan.remove
        recordHistoryRef.current?.()
        if (svgEntryPath != null && svgMarkupToStore != null) {
          state.svgSources = { ...state.svgSources, [svgEntryPath]: svgMarkupToStore }
        }
        const parts = ((state.addedParts ??= {})[reediting.hostId] ??= [])
        const removedBaked = new Set<number>()
        const droppedAdded = new Set<string>()
        let replacedCount = 0
        let addedCount = 0
        for (const { piece, staged: geometry } of staged) {
          const record = svgRecordFor(piece.index)
          const survivor = survivorByPiece.get(pieceKey(piece.index))
          // The panel's Operation applies to the whole artwork, so a re-edit retypes every piece.
          // Reading it back off each part instead made the control inert on a re-edit: it was
          // rendered, pre-filled and ignored.
          const subtype = svgTool.operation
          if (survivor?.kind === 'added') {
            const existing = parts.find((entry) => entry.key === survivor.key)
            if (!existing) continue
            existing.importId = geometry.importId
            existing.soup = geometry.soup
            existing.subtype = subtype
            existing.name = partName(piece.index)
            if (!threeMfPartSubtypeCarriesFilament(subtype)) delete existing.filamentId
            if (record) existing.svgPart = record
            // The Studio record describes the WHOLE artwork, so a re-edit that changed the width or
            // the thickness invalidates it. Rewriting it here (and clearing it when the new import no
            // longer qualifies as whole-artwork) is what stops a stale `scale`/`depth` surviving:
            // `three-mf/svg-shape.ts` puts it plainly, a record that lies is worse than one absent.
            const reeditShape = bambuShapeFor()
            if (reeditShape) existing.bambuShape = reeditShape
            else delete existing.bambuShape
            replacedCount += 1
            continue
          }
          // A baked piece has no soup to swap, so it is replaced the way a re-edited text part is: a
          // removal plus a new volume. It inherits the PART's own material and full placement, not
          // the object's and not just a translation -- a width change must not repaint a mark the
          // user coloured, nor un-rotate one that was turned in BambuStudio.
          const placement = survivor ? decomposeThreeMfTransform(survivor.transform) : null
          if (survivor?.kind === 'baked') removedBaked.add(survivor.partIndex)
          if (survivor) replacedCount += 1
          else addedCount += 1
          const inheritedFilament = survivor?.kind === 'baked' ? survivor.filamentId : null
          parts.push({
            key: nextInstanceKey(),
            importId: geometry.importId,
            subtype,
            name: partName(piece.index),
            ...(threeMfPartSubtypeCarriesFilament(subtype)
              ? { filamentId: inheritedFilament ?? artworkHost?.filamentId ?? 1 }
              : {}),
            position: placement?.position ?? artworkDropPosition.clone(),
            rotation: placement?.rotation ?? new THREE.Euler(),
            scale: placement?.scale ?? new THREE.Vector3(1, 1, 1),
            soup: geometry.soup,
            ...(record ? { svgPart: record } : {}),
            ...(bambuShapeFor() ? { bambuShape: bambuShapeFor()! } : {})
          })
        }
        for (const part of orphaned) {
          if (part.kind === 'baked') removedBaked.add(part.partIndex)
          else droppedAdded.add(part.key)
        }
        if (droppedAdded.size > 0) {
          const kept = parts.filter((entry) => !droppedAdded.has(entry.key))
          parts.length = 0
          parts.push(...kept)
        }
        if (removedBaked.size > 0) {
          // `withRemovedParts` refuses when nothing printed would survive, and absorbing that with
          // `?? current` leaves the object holding BOTH the original artwork and its replacement
          // while the toast reports success. The text tool's promotion decides this off the live
          // state for the same reason; here the replacement parts are already in `parts`, so the
          // honest answer is to say the old ones could not go rather than to imply they did.
          let refused = false
          setState((current) => {
            if (!current) return current
            const next = withRemovedParts(current, reediting.hostId, removedBaked)
            if (next) return next
            refused = true
            return current
          })
          if (refused) {
            toast.error('Kept the original artwork: removing it would leave the object with nothing to print.')
          }
        }
        refreshAddedPartMeshes()
        regenerateActiveThumbnailRef.current?.()
        setGizmoMode(RESTING_GIZMO_MODE)
        const removedCount = orphaned.length
        toast.success([
          replacedCount > 0 ? `Updated ${replacedCount} part${replacedCount === 1 ? '' : 's'}` : null,
          addedCount > 0 ? `added ${addedCount}` : null,
          removedCount > 0 ? `removed ${removedCount}` : null
        ].filter(Boolean).join(', ') + ' of the artwork.')
        return
      }
      if (state && instance && group && hostId != null) {
        // Every piece lands at the SAME point: the soups already carry each shape's offset from the
        // artwork's centre, so a per-part drop position (which offsets by each part's own size)
        // would scatter the logo across the model.
        const box = printableMeshBox(group)
        const rotor = rotorOf(group)
        rotor.updateWorldMatrix(true, false)
        const position = addedPartDropPosition(svgTool.operation, box, soupSize(soups[0]!.soup), (point) => rotor.worldToLocal(point))
        const staged = await Promise.all(soups.map((piece) =>
          stageAddedPartGeometry(importStore, { kind: 'soup', soup: piece.soup, name: partName(piece.index) }, 0)))
        recordHistoryRef.current?.()
        if (!state.addedParts) state.addedParts = {}
        if (svgEntryPath != null && svgMarkupToStore != null) {
          state.svgSources = { ...state.svgSources, [svgEntryPath]: svgMarkupToStore }
        }
        const parts = (state.addedParts[hostId] ??= [])
        staged.forEach((entry, at) => {
          const record = svgRecordFor(soups[at]!.index)
          const shape = bambuShapeFor()
          parts.push({
            key: nextInstanceKey(),
            importId: entry.importId,
            subtype: svgTool.operation,
            name: partName(soups[at]!.index),
            ...(threeMfPartSubtypeCarriesFilament(svgTool.operation) ? { filamentId: instance.filamentId } : {}),
            position: position.clone(),
            rotation: new THREE.Euler(),
            scale: new THREE.Vector3(1, 1, 1),
            soup: entry.soup,
            ...(record ? { svgPart: record } : {}),
            ...(shape ? { bambuShape: shape } : {})
          })
        })
        refreshAddedPartMeshes()
        regenerateActiveThumbnailRef.current?.()
        setGizmoMode(RESTING_GIZMO_MODE)
        toast.success(split ? `Added ${soups.length} parts from the artwork.` : 'Added the artwork as a part.')
        return
      }

      // Standalone. The object needs a body, so the LARGEST piece becomes it and the rest are parts
      // of it: for a logo that is the background, with the marks sitting on it, which is also the
      // order that makes the marks individually deletable and individually colourable.
      const ordered = [...soups].sort((a, b) => b.coverage - a.coverage)
      const body = ordered[0]!
      // Staged RAW: `object` normalisation re-centres XY and floors Z itself, and the parts below
      // need to know exactly what it did, which `svgObjectFrameShift` states rather than guesses.
      const frame = svgObjectFrameShift(body.soup)
      const stagedBody = await importStore.stageFile(
        new File([triangleSoupToBinaryStl(body.soup)], `${partName(body.index)}.stl`, { type: 'application/octet-stream' }),
        'object'
      )
      recordHistoryRef.current?.()
      const created = instanceFromStagedImport(stagedBody, importStore.meshUrl)
      // The BODY's record is session-scoped, exactly as a standalone text object's `textInfo` is and
      // for the same reason: a part's record rides `SceneEdit.addedParts`, and an OBJECT has no
      // equivalent channel. A merged standalone import is therefore re-editable until saved and
      // plain geometry afterwards. Persisting it needs an object-level seam, which standalone text
      // has always wanted too, so it belongs to both tools rather than being bolted onto this one.
      const bodyRecord = svgRecordFor(body.index)
      if (bodyRecord) created.svgPart = bodyRecord
      // Registered unconditionally, not inside the "there are other pieces" branch below, or a
      // standalone import whose pieces all fit in the body stored no artwork at all. Unreferenced
      // bytes cost nothing: `collectSvgSources` emits only what a surviving part still names.
      const liveForSources = stateRef.current
      if (liveForSources && svgEntryPath != null && svgMarkupToStore != null) {
        liveForSources.svgSources = { ...liveForSources.svgSources, [svgEntryPath]: svgMarkupToStore }
      }
      addInstanceToActivePlate(created, stagedFootprint(stagedBody))
      setGizmoMode(RESTING_GIZMO_MODE)
      toast.success(ordered.length > 1
        ? `Added the artwork. Its ${ordered.length - 1} other shapes are parts of it.`
        : 'Added the artwork.')
      // The remaining pieces attach to the object just created, in the same frame, so the artwork
      // reassembles exactly as drawn.
      const restHostId = addedPartHostId(created)
      if (ordered.length > 1 && restHostId != null) {
        const stagedRest = await Promise.all(ordered.slice(1).map((piece) =>
          stageAddedPartGeometry(importStore, { kind: 'soup', soup: piece.soup, name: partName(piece.index) }, 0)))
        const live = stateRef.current
        if (live) {
          if (!live.addedParts) live.addedParts = {}
          const parts = (live.addedParts[restHostId] ??= [])
          stagedRest.forEach((entry, at) => {
            const record = svgRecordFor(ordered[at + 1]!.index)
            parts.push({
              key: nextInstanceKey(),
              importId: entry.importId,
              subtype: 'normal_part',
              name: partName(ordered[at + 1]!.index),
              filamentId: created.filamentId,
              // The pieces are all in ARTWORK coordinates; the body was moved out of them by the
              // object normalisation, so this puts them back beside it.
              position: new THREE.Vector3(frame.x, frame.y, frame.z),
              rotation: new THREE.Euler(),
              scale: new THREE.Vector3(1, 1, 1),
              soup: entry.soup,
              ...(record ? { svgPart: record } : {})
            })
          })
          refreshAddedPartMeshes()
          regenerateActiveThumbnailRef.current?.()
        }
      }
    } catch (error) {
      toast.error(extractErrorMessage(error) || 'That artwork could not be added.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, addInstanceToActivePlate, importStore, recordHistoryRef, refreshAddedPartMeshes,
    svgArtwork, svgFileName, svgMarkup, svgTool])


  /**
   * Change an added part volume's subtype (negative part / modifier / support blocker /
   * enforcer). Added parts live in the in-place-mutated `addedParts` session map, so after
   * the mutation the state identity is refreshed to re-render the panel, and the viewport
   * meshes are rebuilt to pick up the subtype's colour.
   */
  const handleChangeAddedPartTypes = useCallback((keys: ReadonlyArray<string>, subtype: SceneEditPartSubtype) => {
    const state = stateRef.current
    const wanted = new Set(keys)
    const parts = Object.values(state?.addedParts ?? {}).flat()
      .filter((entry) => wanted.has(entry.key) && entry.subtype !== subtype)
    if (!state || parts.length === 0) return
    // ONE history entry for the whole set: a per-volume record would make a multi-select retype take
    // as many undos as it had members, which is not what the user did.
    recordHistoryRef.current?.()
    for (const part of parts) {
      part.subtype = subtype
      // Retyping to a subtype that carries no material must drop the material, not hide it: a
      // support blocker with a lingering filament would reappear the moment it was retyped back.
      if (!threeMfPartSubtypeCarriesFilament(subtype)) part.filamentId = null
    }
    refreshAddedPartMeshes()
    regenerateActiveThumbnailRef.current?.()
    setState((current) => (current ? { ...current } : current))
  }, [refreshAddedPartMeshes, recordHistoryRef])

  /** Reassign an added part's material (normal parts and modifiers only: see the type Select). */
  const handleChangeAddedPartFilaments = useCallback((
    keys: ReadonlyArray<string>,
    filamentId: number,
    // A gesture that changes an object's material reaches both seams (the instance/its baked parts,
    // and its volumes) and must still be ONE undo, so the caller can say it has already recorded.
    // Same shape as `handleRemoveAddedParts`, for the same reason.
    options?: { recordHistory?: boolean }
  ) => {
    const state = stateRef.current
    const wanted = new Set(keys)
    const parts = Object.values(state?.addedParts ?? {}).flat()
      .filter((entry) => wanted.has(entry.key) && entry.filamentId !== filamentId)
    if (!state || parts.length === 0) return
    if (options?.recordHistory !== false) recordHistoryRef.current?.()
    for (const part of parts) part.filamentId = filamentId
    refreshAddedPartMeshes()
    regenerateActiveThumbnailRef.current?.()
    setState((current) => (current ? { ...current } : current))
  }, [refreshAddedPartMeshes, recordHistoryRef])
  const handleChangeAddedPartFilamentsRef = useRef(handleChangeAddedPartFilaments)
  handleChangeAddedPartFilamentsRef.current = handleChangeAddedPartFilaments

  /**
   * Change the volume TYPE / the material of a whole part selection, of either kind, in one gesture.
   *
   * Each half goes to the seam that owns it -- a baked part's type is recorded in `partTypeChanges`
   * for the bake, a volume's lives on the volume -- but the user made ONE choice, so each seam
   * records at most one history entry and a mixed set undoes in a single step.
   */
  const handleChangeMemberTypes = useCallback(
    (objectId: number, members: ReadonlyArray<PartMember>, subtype: SceneEditPartSubtype) => {
      // A body retypes through the SAME seam as a baked part, at the ordinal the bake promotes it
      // into (`BODY_PART_INDEX`). It has no entry in `instance.parts` to reflect onto, so the
      // sidebar and the viewport read the stored change back instead -- which is what makes the
      // control work before a save rather than appearing after one.
      const baked = members.flatMap((member) => (member.kind === 'baked'
        ? [{ objectId, partIndex: member.partIndex }]
        : member.kind === 'body'
          ? [{ objectId, partIndex: BODY_PART_INDEX }]
          : []))
      if (baked.length > 0) handleChangePartTypes(baked, subtype)
      const added = members.flatMap((member) => (member.kind === 'added' ? [member.key] : []))
      if (added.length > 0) handleChangeAddedPartTypes(added, subtype)
    },
    [handleChangePartTypes, handleChangeAddedPartTypes]
  )
  const handleChangeMemberFilament = useCallback(
    (objectId: number, members: ReadonlyArray<PartMember>, filamentId: number) => {
      // The BODY's material is the OBJECT's, which is the second of the two places one can live, so
      // it routes to the instance-level change. Each kind in the selection then goes through its own
      // seam below. That does mean a MIXED selection can record more than one history entry, which
      // is the lesser of the two evils: the alternative, letting the instance-level call sweep up
      // the object's volumes, changed materials on volumes the user had not selected.
      const bodySelected = members.some((member) => member.kind === 'body')
      if (bodySelected) {
        const owner = stateRef.current?.plates.flatMap((plate) => plate.instances)
          .find((instance) => addedPartHostId(instance) === objectId)
        // The volumes are excluded because they are not part of this SELECTION. "Set all parts'
        // material" is the object row's badge and passes them; a member selection changes the
        // members it names, and the added ones below are handled on their own terms.
        if (owner) reassignInstanceFilament([owner.key], filamentId, { includeVolumes: false })
      }

      const baked = members.flatMap((member) => (member.kind === 'baked' ? [{ objectId, partIndex: member.partIndex }] : []))
      if (baked.length > 0) reassignFilament(baked, filamentId)
      const added = members.flatMap((member) => (member.kind === 'added' ? [member.key] : []))
      if (added.length > 0) handleChangeAddedPartFilaments(added, filamentId)
    },
    [reassignFilament, handleChangeAddedPartFilaments, reassignInstanceFilament]
  )

  /** Remove an added part volume by key (default: the currently selected one). */
  const handleRemoveAddedParts = useCallback((keys: ReadonlyArray<string>, options?: { recordHistory?: boolean }) => {
    const state = stateRef.current
    if (!state?.addedParts || keys.length === 0) return
    const targets = new Set(keys)
    // A mixed delete removes through both seams and must still be ONE undo, so the caller can say
    // it has already recorded.
    if (options?.recordHistory !== false) recordHistoryRef.current?.()
    for (const [objectId, parts] of Object.entries(state.addedParts)) {
      const next = parts.filter((part) => !targets.has(part.key))
      if (next.length !== parts.length) state.addedParts[Number(objectId)] = next
    }
    // The selection cannot outlive the geometry it names. Both shapes are cleared, since either may
    // hold a volume that has just gone.
    setGizmoPart((current) => (current && current.member.kind === 'added' && targets.has(current.member.key)
      ? null
      : current))
    setPartSelection((current) => (current && current.members.some(
      (entry) => entry.kind === 'added' && targets.has(entry.key)) ? null : current))
    refreshAddedPartMeshes()
    regenerateActiveThumbnailRef.current?.()
    // addedParts is mutated in place; refresh the state identity so the list rows re-render.
    setState((current) => (current ? { ...current } : current))
  }, [refreshAddedPartMeshes, recordHistoryRef])

  /**
   * Delete BAKED parts from a model (BambuStudio's per-volume Delete).
   *
   * Geometry-level, like every other part edit: it applies to every copy of the object. Refused
   * when it would take the object's last printed part, because an object with nothing to print is
   * not a state to leave a user in: deleting the OBJECT is the action for that, and it is right
   * there in the object menu. `withRemovedParts` owns both rules; this only feeds it the host id
   * the row/menu was opened against and rebuilds the scene.
   */
  /**
   * Delete an object's BODY: the object keeps no geometry of its own and its added volumes become
   * the whole of it, which is exactly the state a save-then-delete reaches.
   *
   * A flag rather than a promotion. Promoting a volume into the body worked and read correctly
   * until the next SAVE, which names a promoted body after the OBJECT -- so the same delete showed
   * `["Cube","Part"]` before a save and `["Part","Part"]` after one. The flag instead rides
   * `SceneEdit.removedObjectBodies`, and the bake simply never creates that component, so the
   * surviving parts keep their OWN names and the file matches what the editor showed.
   *
   * Nothing else has to honour it: the body mesh is never added to the render group, and bounds,
   * footprint, the thumbnail, export and the boolean all walk that group.
   */
  const removeInstanceBody = useCallback((hostId: number) => {
    setState((state) => {
      if (!state) return state
      return {
        ...state,
        plates: state.plates.map((plate) => ({
          ...plate,
          instances: plate.instances.map((item) => (addedPartHostId(item) === hostId
            ? { ...item, bodyRemoved: true }
            : item))
        }))
      }
    })
  }, [])

  const handleRemoveParts = useCallback((hostId: number, members: ReadonlyArray<PartMember>) => {
    if (members.length === 0) return
    // A mixed set deletes through BOTH seams in one gesture, because that is what the user selected.
    // The order matters: `withRemovedParts` counts the printed parts that survive, and the volumes
    // going away in the same breath must already be gone from that count or it can refuse a delete
    // that leaves the object with geometry.
    // ONE history entry for the whole gesture, recorded here rather than inside each seam: a mixed
    // delete that recorded twice would take two undos to put back what one click removed.
    recordHistory()
    const addedKeys = members.flatMap((member) => (member.kind === 'added' ? [member.key] : []))
    if (addedKeys.length > 0) handleRemoveAddedParts(addedKeys, { recordHistory: false })
    const bakedIndexes = new Set(members.flatMap((member) => (member.kind === 'baked' ? [member.partIndex] : [])))
    if (bakedIndexes.size > 0) {
      setState((current) => (current ? withRemovedParts(current, hostId, bakedIndexes) ?? current : current))
    }
    // A deleted part leaves the selection pointing at geometry that no longer exists.
    setPartSelection(null)
    setGizmoPart(null)
    if (members.some((member) => member.kind === 'body')) removeInstanceBody(hostId)
    setRebuildToken((token) => token + 1)
    regenerateActiveThumbnailRef.current?.()
  }, [handleRemoveAddedParts, recordHistory, setPartSelection, removeInstanceBody])

  /**
   * Select an added volume from its list row.
   *
   * Delegates to the SAME handler a baked part row uses, which is what gives volume rows Ctrl and
   * Shift for the first time: they used to call a handler of their own that took no modifiers and
   * always replaced the selection, so a volume could not join a multi-part set at all.
   */
  /** Open per-volume settings from a volume row's own button, through the shared part dialog. */
  const handleEditAddedPartSettings = useCallback((objectId: number, partKey: string) => {
    const owner = stateRef.current?.plates.flatMap((plate) => plate.instances)
      .find((instance) => addedPartHostId(instance) === objectId)
    const name = owner
      ? effectiveAddedParts(stateRef.current, owner).find((part) => part.key === partKey)?.name
      : null
    setEditingPart({ objectId, members: [{ kind: 'added', key: partKey }], name: name ?? 'Part' })
  }, [])

  const handleSelectAddedPartRow = useCallback(
    (objectId: number, partKey: string, modifiers: { additive: boolean; range: boolean }, instanceKey: string) =>
      handleSelectPart(objectId, { kind: 'added', key: partKey }, modifiers, instanceKey),
    [handleSelectPart]
  )

  /**
   * Assemble (the inverse of "Split to objects"): merge every selected object into ONE
   * import-backed instance at its combined world position. Each source object survives
   * as a disconnected shell inside the merged mesh, so "Split to objects" recovers the
   * pieces exactly.
   */
  // Mesh boolean (both of Studio's target modes). Its state, rules and the two apply paths live in
  // `useEditorMeshBoolean`; everything below just renders them.
  const meshBoolean = useEditorMeshBoolean({
    gizmoMode,
    setGizmoMode,
    selectedKey,
    extraSelectedKeys,
    allSelectedKeys,
    activePlateIndex,
    stateRef,
    groupByKeyRef,
    setState,
    importStore,
    recordHistoryRef,
    collectHelperVolumesFor,
    rotorOf,
    nextInstanceKey,
    setSelectedKey,
    setExtraSelectedKeys,
    setPartSelection,
    setGizmoPart,
    setAddedPartMeshVersion,
    setRebuildToken,
    regenerateActiveThumbnailRef,
    addedPartMeshVersion,
    rebuildToken
  })


  const handleAssembleSelection = useCallback(async () => {
    const keys = allSelectedKeysRef.current()
    if (keys.length < 2) return
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    const members = keys
      .map((key) => ({ instance: plate.instances.find((entry) => entry.key === key), group: groupByKeyRef.current.get(key) }))
      .filter((entry): entry is { instance: EditorInstance; group: THREE.Group } => Boolean(entry.instance && entry.group))
    if (members.length < 2) return
    // Assemble merges PRINTED geometry only -- `collectWorldTriangles` drops every helper volume --
    // so say how many went, as the cut and both splits do. Silently, the user's blockers and
    // modifiers simply stopped existing with nothing on screen to say so.
    const discardedHelpers = members
      .reduce((total, member) => total + collectHelperVolumesFor(member.instance, member.group).length, 0)
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
      const staged = await importStore.stageFile(file, 'object')
      const next = instanceFromStagedImport(staged, importStore.meshUrl)
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
      toast.success(`Assembled ${members.length} objects into one.`
        + (discardedHelpers > 0
          ? ` ${discardedHelpers} helper volume${discardedHelpers === 1 ? '' : 's'} could not be carried over: undo to get ${discardedHelpers === 1 ? 'it' : 'them'} back.`
          : ''))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to assemble the selected objects.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, updatePlates, importStore, collectHelperVolumesFor])

  const handleImportFromLibrary = useCallback(async (libraryFileId: string) => {
    setLibraryPickerOpen(false)
    setImporting(true)
    try {
      const staged = await importStore.stageFromLibrary(libraryFileId, 'object', undefined)
      addStagedImport(staged)
      toast.success(`Imported ${staged.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to import the selected model.')
    } finally {
      setImporting(false)
    }
  }, [addStagedImport, importStore])

  const handleImportFile = useCallback(async (file: File) => {
    setImporting(true)
    try {
      const staged = await importStore.stageFile(file, 'object')
      addStagedImport(staged)
      toast.success(`Imported ${staged.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to import the model file.')
    } finally {
      setImporting(false)
    }
  }, [addStagedImport, importStore])

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
    // The replacement RETAINS the object identity that added parts are keyed by, so the old
    // shape's blockers/modifiers would silently reattach to an unrelated mesh. Drop them, matching
    // how paint and brim ears fall away (see `dropAddedPartsForReplacedHost`).
    const state = stateRef.current
    if (state) dropAddedPartsForReplacedHost(state, target)
    // A modifier or blocker is a slicing decision about a NAMED piece of the model, so it survives
    // a swap for a revised export of that model. Recorded as explicit type changes rather than
    // only set on the instance: the bake reads an unsaved import's subtypes from
    // `partTypeChanges` (`collectImportPartTypes`), so a client-only carry would look right on
    // screen and bake five modifiers back as printed geometry.
    const carriedSubtypes = carriedPartSubtypes(target.parts, staged.parts)
    let selectedReplacementKey: string | null = null
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) => {
        if (!isMember(instance)) return instance
        // Per instance, not per selection: each copy sits somewhere different, and each replacement
        // has to land on its own predecessor.
        const replacement = replaceInstanceGeometry(
          instance, staged, replacedObjectId, importStore.meshUrl,
          worldFootprintCenterForRef.current?.(instance.key) ?? null, carriedSubtypes
        )
        if (instance.key === key) selectedReplacementKey = replacement.key
        return replacement
      })
    })))
    // The replacement's host id is what `collectImportPartTypes` keys the emitted
    // `importPartTypes` on, so record the carry there too. Without it the bake reads the STAGED
    // record's subtypes (which a STEP or a plain 3MF does not have) and the volumes print.
    if (carriedSubtypes.size > 0 && replacedObjectId != null) {
      setState((current) => {
        if (!current) return current
        const partTypeChanges = { ...(current.partTypeChanges ?? {}) }
        for (const [partIndex, subtype] of carriedSubtypes) {
          partTypeChanges[partSlotKey(replacedObjectId, partIndex)] = subtype
        }
        return { ...current, partTypeChanges }
      })
    }
    if (selectedReplacementKey) {
      setExtraSelectedKeys([])
      setSelectedKey(selectedReplacementKey)
      setGizmoMode('translate')
    }
  }, [updatePlates, importStore])

  /** Replace `key`'s geometry with an uploaded local model file. */
  const handleReplaceFromFile = useCallback(async (key: string, file: File) => {
    setImporting(true)
    try {
      const staged = await importStore.stageFile(file, 'object')
      handleReplaceWithStaged(key, staged)
      toast.success(`Replaced with ${staged.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to replace the model.')
    } finally {
      setImporting(false)
    }
  }, [handleReplaceWithStaged, importStore])

  /** Replace `key`'s geometry with a model picked from the library. */
  const handleReplaceFromLibrary = useCallback(async (key: string, libraryFileId: string) => {
    setLibraryPickerOpen(false)
    setModelRequest(null)
    setImporting(true)
    try {
      const staged = await importStore.stageFromLibrary(libraryFileId, 'object', undefined)
      handleReplaceWithStaged(key, staged)
      toast.success(`Replaced with ${staged.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to replace the model.')
    } finally {
      setImporting(false)
    }
  }, [handleReplaceWithStaged, importStore])

  /**
   * BambuStudio's "Split -> To parts" (`ObjectList::split` -> `ModelVolume::split`): the same
   * connected-shell split as Split to objects, but the shells stay inside ONE object as its parts
   * rather than becoming objects of their own.
   *
   * The difference that matters is where they land, and our answer is a multi-solid import: the
   * shells are written into one plain 3MF (`@printstream/shared/three-mf` `mesh-archive.ts`) and
   * staged together, so they arrive as one import with a part per shell and the bake writes them as
   * `<component>` parts of a single object. That is the STEP-assembly path, already carrying
   * per-solid selection, transforms, materials and subtypes.
   *
   * Staging them TOGETHER is the whole point, not an optimisation. The shells were one mesh a
   * moment ago and only mean something in a shared coordinate space; staged one at a time, each
   * would be normalised against its own bounds and the assembly would reassemble with every shell
   * stacked on the origin. One import is normalised once, as a group.
   *
   * Studio renames the pieces `<name>_1..n` and keeps the object's config, name and instances,
   * which falls out here: the object keeps its identity through `replacedObjectId`, so its
   * per-object settings follow, and only the geometry is replaced.
   */
  const handleSplitToParts = useCallback(async (key: string) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = groupByKeyRef.current.get(key)
    if (!plate || !instance || !group) return
    const discardedHelpers = collectHelperVolumesFor(instance, group).length
    const shells = splitTriangleSoup(collectWorldTriangles(group))
    if (shells.length < 2) {
      toast.error(`${instance.name} is already a single connected part.`)
      return
    }
    if (shells.length > MAX_SPLIT_SHELLS) {
      toast.error(`${instance.name} has ${shells.length} shells, too many to split into parts.`)
      return
    }
    setImporting(true)
    try {
      const entries = buildVanillaThreeMfEntries(shells.map((triangles, index) => ({
        name: `${instance.name}_${index + 1}`,
        triangles
      })))
      // Level 0: this archive exists for one hop into the staging endpoint and is thrown away,
      // so compressing XML we just generated only adds latency to the split.
      const encoder = new TextEncoder()
      const zipEntries: Record<string, Uint8Array> = {}
      for (const [name, text] of Object.entries(entries)) zipEntries[name] = encoder.encode(text)
      const bytes = await zipArchiveEntries(zipEntries, 0)
      const file = new File([bytes.slice().buffer as ArrayBuffer], `${instance.name}.3mf`, { type: 'application/octet-stream' })
      const staged = await importStore.stageFile(file, 'object')
      handleReplaceWithStaged(key, staged)
      toast.success(`Split ${instance.name} into ${shells.length} parts.`
        + (discardedHelpers > 0
          ? ` ${discardedHelpers} helper volume${discardedHelpers === 1 ? '' : 's'} could not be carried over: undo to get ${discardedHelpers === 1 ? 'it' : 'them'} back.`
          : ''))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to split the model into parts.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, collectHelperVolumesFor, importStore, handleReplaceWithStaged])

  /** Add a built-in primitive (cube/cylinder/sphere/cone) at a free spot on the plate. */
  const handleAddPrimitive = useCallback(async (kind: PrimitiveKind) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    setImporting(true)
    try {
      const stl = triangleSoupToBinaryStl(primitiveTriangleSoup(kind))
      const file = new File([stl], `${PRIMITIVE_LABELS[kind]}.stl`, { type: 'application/octet-stream' })
      const staged = await importStore.stageFile(file, 'object')
      // Centre on the drop spot via the mesh's XY midpoint (addInstanceToActivePlate places it).
      addInstanceToActivePlate(instanceFromStagedImport(staged, importStore.meshUrl), stagedFootprint(staged))
      toast.success(`Added a ${PRIMITIVE_LABELS[kind].toLowerCase()}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to add the primitive.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, addInstanceToActivePlate, importStore])

  /** The whole selection when `key` belongs to it, else just `key`. */
  const selectionFor = useCallback((key: string): string[] => {
    const selection = allSelectedKeysRef.current()
    return selection.includes(key) ? selection : [key]
  }, [])

  /**
   * Give a new independent copy the source object's per-object PROCESS overrides.
   *
   * These live on the borrowed slice controller rather than in `EditorState`, so
   * `makeInstanceIndependent` cannot copy them itself, but leaving them behind would make a copy
   * silently lose settings its source had, and re-adding them after a save is exactly the
   * "save first" wart this editor does not have anywhere else.
   */
  const copyObjectProcessOverrides = useCallback((sourceObjectId: number, cloneObjectId: number) => {
    const perObjectSettings = sliceConfigRef.current?.perObjectSettings
    const existing = perObjectSettings?.value?.[String(sourceObjectId)]
    if (!perObjectSettings || !existing || Object.keys(existing).length === 0) return
    perObjectSettings.onChange({ ...perObjectSettings.value, [String(cloneObjectId)]: { ...existing } })
  }, [])

  /**
   * Give an independent copy's added volumes their OWN staged meshes.
   *
   * `makeInstanceIndependent` mints each copied volume a fresh `key` but spreads the rest of the
   * record, so the copy's volumes kept pointing at the SOURCE's `importId` -- and a volume's paint
   * is keyed by that import, because the import is the mesh its `importPaint` entry names. Two
   * volumes on one import therefore share their paint in the session AND in the file, where the
   * bake maps an import to exactly one mesh object and hangs both `<component>`s off it. Painting
   * the copy repainted the original, which is the same failure the clone pre-pass already avoids
   * for baked meshes by deep-copying the mesh entry ("never let a copy share its source's mesh
   * entry"); this is that rule for the volumes.
   *
   * Deliberately fire-and-forget: the clone itself is synchronous and must stay that way (it runs
   * inside the plate updater), so the volumes are re-homed a beat later. A stage that fails is
   * logged and leaves the volume on the shared mesh rather than dropping its geometry.
   */
  /**
   * Give an independent copy of a SESSION-ADDED model its own staged mesh.
   *
   * The volume version below re-homes an object's added parts; this is the same rule for the base
   * import. Two instances sharing an `importId` share one mesh in the session and one mesh object in
   * the file (the bake maps an import to exactly one), so their paint is the same paint: painting
   * the "independent" copy repainted the original. That is the rule the clone pre-pass already keeps
   * for baked meshes ("never let a copy share its source's mesh entry").
   *
   * Staged as `'part'`, never `'object'`: these bytes are already in the source's normalized frame,
   * and re-normalizing would rebase the copy and move it off where the duplicate was placed.
   *
   * Fire-and-forget for the same reason as the volumes, and a failure leaves the copy on the shared
   * import rather than dropping its geometry: worse than independent, but still a model on the plate.
   */
  const restageIndependentCopyMesh = useCallback(async (instanceKey: string) => {
    const find = () => stateRef.current?.plates.flatMap((plate) => plate.instances).find((entry) => entry.key === instanceKey) ?? null
    const instance = find()
    if (!instance || instance.source.kind !== 'import') return
    const sourceImportId = instance.source.importId
    let staged: { importId: string }
    try {
      const bytes = await importStore.fetchMesh(sourceImportId)
      staged = await importStore.stageFile(
        new File([bytes], `${instance.name || 'copy'}.stl`, { type: 'application/octet-stream' }),
        'part'
      )
    } catch (error) {
      console.warn('[editor] could not re-stage an independent copy\'s mesh', error)
      return
    }
    // Re-read: the copy may have been deleted or undone while the bytes were in flight.
    const live = find()
    if (!live || live.source.kind !== 'import' || live.source.importId !== sourceImportId) return
    live.source = { ...live.source, importId: staged.importId, meshUrl: importStore.meshUrl(staged.importId) }
    setAddedPartMeshVersion((version) => version + 1)
  }, [importStore])

  const restageIndependentCopyVolumes = useCallback(async (cloneObjectId: number) => {
    const parts = stateRef.current?.addedParts?.[cloneObjectId]
    if (!parts || parts.length === 0) return
    const restaged = await Promise.all(parts.map(async (part) => {
      try {
        const staged = await stageAddedPartGeometry(importStore, { kind: 'soup', soup: part.soup, name: part.name }, 0)
        return { key: part.key, importId: staged.importId }
      } catch (error) {
        console.warn('[editor] could not re-stage an independent copy\'s volume', error)
        return null
      }
    }))
    const byKey = new Map(restaged.filter((entry): entry is { key: string; importId: string } => entry != null)
      .map((entry) => [entry.key, entry.importId]))
    if (byKey.size === 0) return
    const live = stateRef.current?.addedParts?.[cloneObjectId]
    if (!live) return
    // Mutated in place like every other `addedParts` write, then announced through the version
    // signal the memoised sidebar and the mesh builder read.
    stateRef.current!.addedParts![cloneObjectId] = live.map((part) => {
      const importId = byKey.get(part.key)
      return importId ? { ...part, importId } : part
    })
    setAddedPartMeshVersion((version) => version + 1)
  }, [importStore])

  /**
   * Duplicate the selection. `independent` picks BambuStudio's two copy semantics: linked (the
   * default, BS's toolbar "+" / `increase_instances`, another instance of the SAME object, so
   * parts, materials, paint and per-object settings stay shared) or independent (BS's Ctrl+C/V /
   * `Model::add_object`, a whole new object that diverges from here on).
   */
  const handleDuplicate = useCallback((key: string, independent = false, copies = 1) => {
    const keys = selectionFor(key)
    let cloneKey: string | null = null
    updatePlates((plates) =>
      plates.map((plate) => {
        if (plate.index !== activePlateIndex) return plate
        let next = plate
        for (const target of keys) {
          const source = next.instances.find((entry) => entry.key === target)
          if (!source) continue
          for (let copy = 0; copy < copies; copy += 1) {
          const clone = duplicateInstance(source)
          // The copy is registered against the LIVE state (the plate map below is rebuilt from it),
          // so the clone registry and the copied session edits land on the same object identity.
          if (independent && stateRef.current) {
            // `addedPartHostId`, not `objectId`: a session-added model carries `objectId: 0` and
            // hangs its per-object settings and added volumes off `source.replacedObjectId`, so
            // keying on `objectId` here copied overrides from 0 to 0 and re-staged the volumes of
            // object 0. Same identity `handleMakeIndependent` uses.
            const sourceObjectId = addedPartHostId(clone)
            makeInstanceIndependent(stateRef.current, clone)
            const cloneObjectId = addedPartHostId(clone)
            if (sourceObjectId != null && cloneObjectId != null) copyObjectProcessOverrides(sourceObjectId, cloneObjectId)
            if (cloneObjectId != null) void restageIndependentCopyVolumes(cloneObjectId)
            // A session-added model's mesh is its staged import, which the clone still shares.
            void restageIndependentCopyMesh(clone.key)
          }
          // Placed against `next`, which already holds the copies made so far this pass, so a run
          // of copies spreads out instead of stacking on one spot.
          const spot = findFreePlatePosition(next)
          placeInstanceAt(clone, spot.x, spot.y)
          cloneKey = clone.key
          next = { ...next, instances: [...next.instances, clone] }
          }
        }
        return next
      })
    )
    if (cloneKey) selectExclusive(cloneKey)
  }, [activePlateIndex, updatePlates, selectionFor, selectExclusive, copyObjectProcessOverrides, restageIndependentCopyVolumes, restageIndependentCopyMesh])

  /**
   * BambuStudio's "Clone" (Ctrl+K, `Plater::clone_selection`): asks for a copy count and makes that
   * many, rather than making the user repeat Duplicate. Studio's copies are INDEPENDENT objects --
   * `Selection::clone` is literally copy-to-clipboard then paste N times, and its paste calls
   * `Model::add_object`, minting a new ModelObject each round -- so this maps onto our independent
   * duplicate, not the linked one. (Studio has no working linked-copy path at all here: both
   * `Plater::increase_instances` and `decrease_instances` have their bodies wrapped in `#if 0`,
   * and `set_number_of_copies` is dead code with no caller. Our linked Duplicate is the one place
   * we go beyond it, and it stays reachable for a single copy or by repeating Ctrl+D.)
   *
   * The 1..1000 range is Studio's own (`wxGetNumberFromUser(..., 1, 0, 1000, this)`), minus its
   * zero, which is a no-op it accepts and then does nothing with. Placement is the same
   * free-spot search a single duplicate uses, so a big count spreads across the plate and falls
   * back to the plate centre once nothing fits, exactly as Studio's `get_nearest_empty_cell` does.
   */
  const handleCloneWithCount = useCallback(async (key: string) => {
    const answer = await promptText({
      title: 'Clone',
      label: 'Number of copies',
      initialValue: '1',
      confirmLabel: 'Clone',
      validateValue: (value) => {
        const count = Number(value.trim())
        if (!Number.isInteger(count) || count < 1) return 'Enter a whole number of copies, 1 or more.'
        if (count > MAX_CLONE_COPIES) return `That is more than ${MAX_CLONE_COPIES} copies.`
        return null
      }
    })
    if (answer === null) return
    const count = Number(answer.trim())
    if (!Number.isInteger(count) || count < 1 || count > MAX_CLONE_COPIES) return
    handleDuplicate(key, true, count)
  }, [promptText, handleDuplicate])

  /**
   * How many placed instances share this instance's object: i.e. how many LINKED copies it has.
   * 1 means it is already independent. Drives both the "Make independent" item and the sidebar
   * badge, so the linkage is visible rather than something users discover by editing one copy and
   * watching another change.
   */
  const linkedCopyCountFor = useCallback((key: string): number => {
    const instances = stateRef.current?.plates.flatMap((plate) => plate.instances) ?? []
    const instance = instances.find((entry) => entry.key === key)
    if (!instance) return 1
    // Shared identity, not `objectId`: a session-added copy has no baked object yet, so it carries
    // its linkage in `source` (see `instanceLinkageKey`). Comparing object ids counted every fresh
    // import as unlinked until a save gave it a real id.
    const identity = instanceLinkageKey(instance)
    if (identity == null) return 1
    return instances.filter((entry) => instanceLinkageKey(entry) === identity).length
  }, [])

  /**
   * Unlink an already-placed copy: it stops sharing its object with the other instances and keeps
   * whatever it looks like right now. The inverse is deliberately absent: re-linking would have to
   * pick which copy's divergent edits survive, and BambuStudio offers no such operation either.
   */
  const handleMakeIndependent = useCallback((key: string) => {
    const state = stateRef.current
    const instance = state?.plates.flatMap((plate) => plate.instances).find((entry) => entry.key === key)
    if (!state || !instance) return
    // Counted on the SHARED IDENTITY, not on `objectId`, so a session-added copy is unlinkable too.
    // This used to bail on anything import-backed, which left the menu item (gated on the sidebar's
    // linked count) offered but inert for exactly the copies that badge now flags.
    const identity = instanceLinkageKey(instance)
    const shared = state.plates.flatMap((plate) => plate.instances)
      .filter((entry) => instanceLinkageKey(entry) === identity)
    if (identity == null || shared.length < 2) {
      toast.error('This model has no other copies, so it is already independent.')
      return
    }
    recordHistoryRef.current?.()
    const sourceObjectId = addedPartHostId(instance)
    makeInstanceIndependent(state, instance)
    const cloneObjectId = addedPartHostId(instance)
    if (sourceObjectId != null && cloneObjectId != null) copyObjectProcessOverrides(sourceObjectId, cloneObjectId)
    if (cloneObjectId != null) void restageIndependentCopyVolumes(cloneObjectId)
    void restageIndependentCopyMesh(instance.key)
    refreshAddedPartMeshes()
    regenerateActiveThumbnailRef.current?.()
    setState((current) => (current ? { ...current } : current))
    toast.success('This copy is now independent: edits to it no longer affect the others.')
  }, [refreshAddedPartMeshes, recordHistoryRef, copyObjectProcessOverrides, restageIndependentCopyVolumes, restageIndependentCopyMesh])

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

  /** Select every object on the active plate (Ctrl/Cmd+A): object mode, so part selection clears. */
  const handleSelectAllObjects = useCallback(() => {
    const keys = activePlateRef.current?.instances.map((instance) => instance.key) ?? []
    if (keys.length === 0) return
    setSelectedKey(keys[0]!)
    setExtraSelectedKeys(keys.slice(1))
    setPartSelection((current) => (current ? null : current))
    setGizmoPart((current) => (current ? null : current))
    objectAnchorKeyRef.current = keys[0]!
  }, [])

  /** Paste cloned instances onto the active plate at free spots, selecting them, one undoable step. */
  const handlePasteInstances = useCallback((instances: EditorInstance[]) => {
    if (instances.length === 0) return
    let lastKey: string | null = null
    updatePlates((plates) =>
      plates.map((plate) => {
        if (plate.index !== activePlateIndex) return plate
        let next = plate
        for (const instance of instances) {
          const spot = findFreePlatePosition(next)
          placeInstanceAt(instance, spot.x, spot.y)
          lastKey = instance.key
          next = { ...next, instances: [...next.instances, instance] }
        }
        return next
      })
    )
    if (lastKey) selectExclusive(lastKey)
  }, [activePlateIndex, updatePlates, selectExclusive])

  // The whole selection (primary + multi-select extras), kept in a ref for the keyboard hook.
  const selectionKeysRef = useRef<string[]>([])
  selectionKeysRef.current = selectedKey ? [selectedKey, ...extraSelectedKeys] : []
  // Shortcuts are live once the editable scene has mounted (the typing guard in the hook keeps them
  // out of form fields; the gcode preview is a separate component, so there is no preview mode here).
  const shortcutsEnabledRef = useRef(false)
  shortcutsEnabledRef.current = sceneReady
  // Delete via the KEYBOARD acts on what is SELECTED, which may be a part rather than an object.
  // A session-added volume is un-staged, a baked part is deleted from its object, and only with no
  // part selected does the key take the whole object: pressing Delete with a part highlighted and
  // watching its entire object disappear would be a surprise. Falls through to deselecting the part
  // when the object would be left with no printed geometry, since that is the one case where the
  // deletion is refused and taking the object instead is exactly the surprise being avoided.
  const handleDeleteShortcut = useCallback((key: string | null) => {
    // While MEASURING, Delete restarts the measurement rather than deleting a model. Studio's
    // measure gizmo owns the key for exactly this (its tooltip reads "Delete: Restart selection"),
    // and the alternative is worse than merely surprising: the tool leaves an object selected
    // underneath, so Delete would silently remove the part someone was measuring. With no picks it
    // falls through, so deleting from within the tool still works when nothing is being measured.
    if (gizmoModeRef.current === 'measure' && measurePointsRef.current.length > 0) {
      setMeasurePoints([])
      return
    }
    // The BULK selection first, which this never consulted: a bulk selection nulls `selectedKey`, so
    // Delete over several selected parts used to reach here with nothing to act on and silently do
    // nothing. Both shapes now delete what is actually highlighted, of either kind.
    const bulk = partSelectionRef.current
    if (bulk) {
      if (partSelectionRemovable(bulk.objectId, bulk.members)) handleRemoveParts(bulk.objectId, bulk.members)
      else setPartSelection(null)
      return
    }
    const gizmo = gizmoPartRef.current
    if (gizmo) {
      if (partSelectionRemovable(gizmo.objectId, [gizmo.member])) {
        handleRemoveParts(gizmo.objectId, [gizmo.member])
      } else {
        setGizmoPart(null)
      }
      return
    }
    // Only reachable with an OBJECT selected: the shortcut does not fire otherwise.
    if (key != null) handleDelete(key)
  }, [handleDelete, handleRemoveParts, partSelectionRemovable, setPartSelection])

  useEditorKeyboardShortcuts({
    enabledRef: shortcutsEnabledRef,
    selectedKeyRef,
    partSelectedRef,
    activePlateRef,
    selectionKeysRef,
    onDuplicate: handleDuplicate,
    onCloneWithCount: (key: string) => { void handleCloneWithCount(key) },
    onDelete: handleDeleteShortcut,
    onSelectAll: handleSelectAllObjects,
    onPasteInstances: handlePasteInstances,
    undoRef,
    redoRef,
    setGizmoModeRef,
    gizmoModeRef
  })

  /**
   * Move an instance, or, when it belongs to the multi-selection, the whole selection,
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

  /** Set (not toggle) the Printable flag on a set of instances: the bulk context-menu action. */
  const handleSetPrintableSelection = useCallback((keys: ReadonlyArray<string>, printable: boolean) => {
    const keySet = new Set(keys)
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((entry) =>
        keySet.has(entry.key) && entry.printable !== printable ? { ...entry, printable } : entry)
    })), 'visibility')
  }, [updatePlates])

  /**
   * Assign one material to EVERY part of the clicked object, or of the whole selection
   * when it belongs to one (the context menu's bulk "Change material").
   */
  /**
   * The context menu's "Change material" on an object selection.
   *
   * Goes through {@link reassignInstanceFilament} rather than assembling `{objectId, partIndex}`
   * targets itself: built that way it dropped any member with no printed parts (a primitive, a
   * single-solid import, a single-mesh saved object) and, for a selection made only of those, sent
   * an EMPTY target list, which `reassignFilament` returns from immediately. The menu item was
   * enabled and did nothing.
   */
  const reassignSelectionFilament = useCallback((key: string, filamentId: number) => {
    reassignInstanceFilament(selectionFor(key), filamentId)
  }, [selectionFor, reassignInstanceFilament])

  /**
   * The sidebar row's badge: this object only, never the wider selection.
   *
   * Deliberately not `reassignSelectionFilament` -- clicking one row's swatch means that row, the
   * same as it did when the badge addressed parts directly. The context menu is where a bulk
   * change lives, because there the selection is what was right-clicked.
   */
  const reassignOneInstanceFilament = useCallback(
    (key: string, filamentId: number) => { reassignInstanceFilament([key], filamentId) },
    [reassignInstanceFilament]
  )

  /**
   * Reveal a parameter-table row's object in the viewport, following it to another plate if that is
   * where it lives. BambuStudio's table does the same on row select (`OnSelectCell` ->
   * `select_items`), and without it the table is a list you cannot act on: the settings it shows are
   * per object, and finding the object is the next thing anyone wants.
   *
   * The plate preference and the identity rule both live in `locateObjectForReveal`, with the rest
   * of the scene model.
   */
  const handleSelectObjectFromTable = useCallback((objectId: number) => {
    const found = locateObjectForReveal(stateRef.current, objectId, activePlateIndex)
    if (!found) return
    if (found.plateIndex !== activePlateIndex) setActivePlateIndex(found.plateIndex)
    selectExclusive(found.instance.key)
  }, [activePlateIndex, selectExclusive])

  // The parameter table's rows are memoised, and the dialog composes these three into the two
  // callbacks it hands the grid, so an inline arrow here reaches every row: `EditorView` re-renders
  // on each live printer-status event, which would rebuild all of a large project's rows (and their
  // Joy tooltip/button furniture) every time. That is the cost the memo was added to remove, and it
  // fails silently, since a defeated `React.memo` still renders correctly.
  const handleCloseParameterTable = useCallback(() => { setParameterTableOpen(false) }, [])
  const handleEditObjectFromTable = useCallback((objectId: number, name: string) => {
    setEditingObject({ ids: [objectId], name })
  }, [])
  const handleEditPartFromTable = useCallback((objectId: number, member: PartMember, name: string) => {
    setEditingPart({ objectId, members: [member], name })
  }, [])

  /**
   * Open per-object process settings for the clicked object, or the whole selection when it
   * belongs to one (bulk: the dialog seeds from every member's overrides, showing "Mixed" where
   * they disagree, and merges edits back onto each member).
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
    // Either shape: the menu offers this over a bulk set and over the single gizmo'd part alike.
    const selection = partSelectionRef.current
      ?? (gizmoPartRef.current
        ? { objectId: gizmoPartRef.current.objectId, members: [gizmoPartRef.current.member] }
        : null)
    if (!selection || selection.members.length === 0) return
    const owner = stateRef.current?.plates.flatMap((plate) => plate.instances)
      .find((instance) => addedPartHostId(instance) === selection.objectId)
    const only = selection.members.length === 1 ? selection.members[0]! : null
    const name = only == null
      ? `${selection.members.length} parts`
      : (only.kind === 'baked'
        ? owner?.parts.find((part) => part.partIndex === only.partIndex)?.name
        : only.kind === 'added'
          ? owner && effectiveAddedParts(stateRef.current, owner).find((part) => part.key === only.key)?.name
          : owner?.name)
        ?? 'Part'
    setEditingPart({ objectId: selection.objectId, members: [...selection.members], name })
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
    })), 'visibility')
  }, [updatePlates])

  /**
   * Replace one object's COMPLETE height-range set. Bands are object-level, so this is keyed by the
   * model's editor identity (`addedPartHostId`) and applies to every copy of the object, exactly
   * like brim ears. An `inert` edit: bands change no geometry, so the viewport needs no rebuild.
   */
  const setObjectHeightRanges = useCallback((hostId: number, ranges: EditorHeightRange[]) => {
    recordHistoryRef.current?.()
    setState((current) => {
      if (!current) return current
      return { ...current, heightRanges: { ...(current.heightRanges ?? {}), [hostId]: ranges } }
    })
  }, [recordHistoryRef])

  /**
   * Replace one object's COMPLETE layer height profile. Geometry is untouched, so `inert`.
   *
   * `checkpoint` is what keeps a brush STROKE to one undo step: a drag fires a sample per pointer
   * event, so recording on each would bury every earlier action under hundreds of entries. Only the
   * pointer-down sample checkpoints, matching how a body drag records on its first move.
   */
  const setObjectLayerHeightProfile = useCallback((hostId: number, profile: number[], checkpoint = true) => {
    if (checkpoint) recordHistoryRef.current?.()
    setState((current) => {
      if (!current) return current
      return { ...current, layerHeightProfiles: { ...(current.layerHeightProfiles ?? {}), [hostId]: profile } }
    })
  }, [recordHistoryRef])

  /**
   * The extruder's layer-height band. BambuStudio DISCARDS a whole profile with any height outside
   * it rather than clamping, so this is what every generator and edit clamps into.
   */
  const layerHeightBounds = useMemo(() => {
    // The project's own machine band first. These are PRINTER settings, not process overrides, so
    // they arrive on the scene rather than through `perObject`; reading them from the wrong place
    // is how this silently allowed a 0.30mm layer on a machine capped at 0.28, which makes the
    // engine discard the entire profile instead of clamping it.
    const stated = state?.plates.find((entry) => entry.index === activePlateIndex)?.layerHeightLimits
    if (stated && stated.min > 0 && stated.max > stated.min) return stated
    // BambuStudio's own defaults when a project states none: 0.07 floor, 0.75 x nozzle ceiling.
    const nozzle = Number.parseFloat(String(sliceConfig?.nozzleDiameter ?? '')) || 0.4
    const min = 0.07
    return { min, max: Math.max(min, 0.75 * nozzle) }
  }, [state, activePlateIndex, sliceConfig?.nozzleDiameter])

  /**
   * Shade the edited object by layer thickness and mark the brush's band on it, for as long as the
   * layer-height panel is open.
   *
   * This is what makes the thickness bar mean anything: on its own it is a strip with no visible
   * relationship to the model, so a drag lands somewhere the user cannot see. The bar and the model
   * are shaded from the same normalized position in the extruder band, so they read as one control.
   *
   * Deliberately re-synced on every relevant commit rather than only on open: a scene rebuild
   * (material change, undo, plate switch) drops the overlay meshes with the groups they hang off,
   * and `syncLayerHeightVisuals` is idempotent, so a plain effect self-heals instead of needing an
   * invalidation signal that would have to know about every such rebuild.
   */
  useEffect(() => {
    const group = editingLayerHeight ? groupByKeyRef.current.get(editingLayerHeight.key) : null
    if (!group || !editingLayerHeight) return
    const instance = state?.plates.flatMap((plate) => plate.instances)
      .find((entry) => entry.key === editingLayerHeight.key)
    if (!instance) return
    const box = printableMeshBox(group)
    if (!(box.max.z - box.min.z > 0)) return
    syncLayerHeightVisuals(group, {
      box,
      profile: effectiveLayerHeightProfile(state, instance),
      bounds: layerHeightBounds,
      nominalHeight: defaultLayerHeightMm,
      brush: layerHeightBrush
    })
  }, [editingLayerHeight, state, layerHeightBounds, defaultLayerHeightMm, layerHeightBrush])

  /**
   * Enter layers editing for `key`. Shared by the tool rail and the object context menu, because
   * both must set the MODE as well as the target: the mode is what detaches the move gizmo.
   * Silently does nothing for an instance with no host object id, so the rail cannot strand the
   * editor in a mode with no panel.
   */
  const openLayerHeightFor = useCallback((key: string) => {
    const instance = stateRef.current?.plates
      .flatMap((plate) => plate.instances).find((entry) => entry.key === key)
    const hostId = instance ? addedPartHostId(instance) : null
    if (!instance || hostId == null) return
    setEditingLayerHeight({ key, objectId: hostId, name: instance.name })
    setGizmoMode('layerHeight')
  }, [])

  /**
   * The tool rail's mode changes. `layerHeight` needs a target as well as a mode, so it is routed
   * through {@link openLayerHeightFor} rather than setting the mode directly; every other tool is
   * the mode itself.
   */
  /**
   * Find an added part that is TEXT, by key, with the instance that hosts it.
   *
   * Returns null for a part with no `textInfo`: a primitive or an imported volume is not text and
   * must not be adopted by the text tool, which would rewrite it as letterforms.
   */
  const findAddedTextPart = useCallback((partKey: string) => {
    const state = stateRef.current
    for (const [hostId, parts] of Object.entries(state?.addedParts ?? {})) {
      const part = parts.find((entry) => entry.key === partKey)
      if (!part?.textInfo) continue
      // The host is addressed by INSTANCE key, which is what every other text path uses; the
      // addedParts map is keyed by object id, so it has to be translated back.
      const instance = activePlateRef.current?.instances.find(
        (entry) => `${addedPartHostId(entry)}` === hostId
      )
      if (instance) return { part, hostInstanceKey: instance.key }
    }
    return null
  }, [])

  /** Find a session-added part that is SVG artwork, by key. The counterpart of `findAddedTextPart`. */
  const findAddedSvgPart = useCallback((partKey: string) => {
    const state = stateRef.current
    for (const [hostId, parts] of Object.entries(state?.addedParts ?? {})) {
      const part = parts.find((entry) => entry.key === partKey)
      if (part?.svgPart) return { part, hostId: Number(hostId) }
    }
    return null
  }, [])

  /**
   * Fill the SVG panel from a saved record, re-reading the artwork from the archive entry it names.
   *
   * The bytes are the artwork: neither record stores shapes, so without this the panel could show
   * the settings a part was made with and still have nothing to re-extrude. A missing or unreadable
   * entry is reported and leaves the tool in its fresh-import state rather than half-loaded, because
   * a panel showing a width for artwork it cannot rebuild is worse than one asking for a file.
   */
  const reopenSvgArtwork = useCallback(async (
    record: SvgPartRecord,
    hostId: number,
    operation: SceneEditPartSubtype
  ) => {
    setImporting(true)
    try {
      archiveEntriesRef.current = await projectSourceRef.current.listEntries?.() ?? []
      const bytes = await projectSourceRef.current.loadEntry(record.entryPath).catch(() => {
        // Reworded because `loadEntry` speaks for the MESH loader it was written for, and its
        // "missing mesh entries" reads as a corrupt model rather than as absent artwork.
        throw new Error(`The artwork ${record.entryPath} is not in this project any more.`)
      })
      const markup = new TextDecoder().decode(bytes)
      const parsed = parseSvgShapes(markup)
      if (parsed.pieces.length === 0) throw new Error('The stored artwork has nothing paintable in it.')
      setSvgArtwork(parsed)
      setSvgMarkup(markup)
      setSvgFileName(record.fileName || record.entryPath)
      setSvgEmptyReason(null)
      setSvgTool((current) => ({
        ...current,
        widthMm: record.widthMm > 0 ? record.widthMm : current.widthMm,
        thickness: record.thickness > 0 ? record.thickness : current.thickness,
        includeBackground: record.includeBackground,
        operation
      }))
      // `loadedMarkup` is what makes a re-edit reuse its archive entry instead of minting a second
      // copy. On reopen `state.svgSources` is EMPTY -- the bytes live in the archive, not in session
      // state -- so the content dedup in `resolveSvgArchiveEntry` cannot see them, and the entry name
      // reads as taken by this artwork's own parts. Left to itself that stores the same drawing again
      // under `_2` on every edit, and repoints the records at the copy.
      reeditSvgRef.current = { entryPath: record.entryPath, hostId, fileName: record.fileName, loadedMarkup: markup }
      setReeditSvgCount(svgArtworkParts(stateRef.current, hostId, record.entryPath).length)
    } catch (error) {
      // Logged as well as shown: the panel's message tells the user what to do about it, but an
      // artwork entry that a record still names and the archive cannot produce means the saved file
      // is inconsistent, which is worth seeing in the log buffer rather than only in one dialog. The
      // entry path is a name inside the user's own project, never a secret.
      console.warn('[editor] could not read stored SVG artwork', record.entryPath, extractErrorMessage(error))
      reeditSvgRef.current = null
      setReeditSvgCount(0)
      setSvgArtwork(null)
      setSvgMarkup(null)
      setSvgFileName(record.fileName || null)
      setSvgEmptyReason(
        `${extractErrorMessage(error) || 'The stored artwork could not be read.'} Choose the file again to re-extrude it.`
      )
    } finally {
      setImporting(false)
    }
  }, [])

  /**
   * Find a BAKED part that carries an authoring record, with the instance that hosts it.
   *
   * The counterpart of {@link findAddedTextPart} for parts a previous session saved. Both records
   * ride the scene onto {@link EditorInstancePart}, so a part is re-editable across a close, not
   * merely within the session that authored it.
   *
   * Returns the ORDINAL as well as the record, because promoting the part on the first edit has to
   * address the base-file volume it replaces, and that is the only handle a baked part has.
   */
  const findBakedAuthoredPart = useCallback((objectId: number, partIndex: number) => {
    for (const instance of activePlateRef.current?.instances ?? []) {
      if (addedPartHostId(instance) !== objectId) continue
      const part = instance.parts.find((entry) => entry.partIndex === partIndex)
      if (!part) continue
      if (!part.textInfo && !part.svgPart) return null
      return { part, instance, hostId: objectId, partIndex }
    }
    return null
  }, [])

  /**
   * Does the text being edited actually have a host?
   *
   * NOT "is something selected": a selection key can outlive the instance it named (a reload, a
   * deleted object, another plate), and `applyTextPart` then falls through to the standalone path
   * while the panel still offered Placement and Operation -- controls describing a relationship to a
   * host that does not exist. Resolve the instance, and answer on that.
   */
  const textHasHost = useMemo(() => {
    // A standalone session has no host BY DECISION, whatever is selected. Creating the object
    // selects it, and it reports a synthetic host id like any staged import -- so asking the
    // instance would say yes and offer Placement and Operation, which `applyTextPart` ignores
    // because the standalone path is pinned. `editingTextObjectKey` is the state this depends on,
    // held in a ref for the paths that must not re-render; the counter makes the memo see it.
    if (editingTextObjectKey != null) return false
    const key = editingTextHostKey ?? selectedKey
    if (!key) return false
    const instance = activePlate?.instances.find((entry) => entry.key === key)
    return instance != null && addedPartHostId(instance) != null
  }, [selectedKey, activePlate, editingTextObjectKey, editingTextHostKey])

  const handleGizmoModeChange = useCallback((mode: GizmoMode) => {
    // Cleared on EVERY mode change, before any branch can return early, and re-set below only when
    // this change is opening the text tool on a baked part. Clearing it on one exit path was enough
    // for the ref to outlive its session: opening the tool on a baked part, pressing Escape, then
    // reopening it on a standalone text object returned before the old clear was reached, and the
    // promotion later deleted a base-file volume in a session that never pointed at it.
    reeditBakedPartRef.current = null
    if (mode === 'layerHeight') {
      if (selectedKey) openLayerHeightFor(selectedKey)
      return
    }
    if (mode === 'svg') {
      // REOPEN artwork already in the project rather than starting a second import over it, the
      // same rule the text tool follows. The record says what the tool was set to; the artwork
      // itself is re-read from the archive entry it names, because neither record stores shapes.
      const bakedSvg = selectedBakedPart
        ? findBakedAuthoredPart(selectedBakedPart.objectId, selectedBakedPart.partIndex)
        : null
      const addedSvg = selectedAddedPartKey ? findAddedSvgPart(selectedAddedPartKey) : null
      const record = bakedSvg?.part.svgPart ?? addedSvg?.part.svgPart ?? null
      const hostId = bakedSvg?.hostId ?? addedSvg?.hostId ?? null
      if (record && hostId != null) {
        // NO history checkpoint here: opening the tool to look at a saved part's settings changes
        // nothing, and taking one made every edit cost two undo steps, the first of which appeared
        // to do nothing. The commit records its own, exactly as the text tool defers its promotion.
        void reopenSvgArtwork(record, hostId, canonicalThreeMfPartSubtype(
          bakedSvg?.part.subtype ?? addedSvg?.part.subtype ?? null
        ))
        setGizmoMode(mode)
        return
      }
      reeditSvgRef.current = null
      setReeditSvgCount(0)
    }
    if (mode === 'text') {
      // One checkpoint per session, so the whole edit is a single undo rather than one per keystroke
      // of the live rebuild.
      recordHistoryRef.current?.()
      // RE-EDIT an existing text part rather than starting a second one on top of it. Text carries
      // everything it was made from in its `textInfo`, which is exactly why that record is written,
      // and BambuStudio reopens its own gizmo the same way (`load_init_text`, `m_reedit_text`).
      // Without this, opening the tool on a text part you had selected silently created a NEW part
      // over the old one and left the original uneditable.
      // A standalone text OBJECT reopens the same way a text part does.
      const selectedInstance = selectedKey
        ? activePlateRef.current?.instances.find((entry) => entry.key === selectedKey)
        : null
      if (selectedInstance?.textInfo) {
        const loaded = textToolValueFromInfo(selectedInstance.textInfo, 'normal_part', textTool)
        setTextTool(loaded)
        setEditingTextPartKey(null)
        setEditingTextHost(null)
        editingTextSurfaceRef.current = null
        setEditingTextObject(selectedInstance.key)
        textApplyLoadedRef.current = loaded
        setGizmoMode(mode)
        return
      }
      // A part a PREVIOUS session saved. Its record reopens the panel exactly as a session-added
      // one does; what differs is that the geometry is a baked `<component>`, so the part is
      // REPLACED rather than mutated -- deferred to the first apply (see `reeditBakedPartRef`) so
      // merely opening the tool to look at a saved part does not dirty the project.
      const baked = selectedBakedPart
        ? findBakedAuthoredPart(selectedBakedPart.objectId, selectedBakedPart.partIndex)
        : null
      if (baked?.part.textInfo) {
        // A baked part's subtype is the file's RAW string (and absent for a normal part), so it has
        // to be canonicalized before it can name one of Studio's Join / Cut / Modifier operations.
        const loaded = textToolValueFromInfo(
          baked.part.textInfo, canonicalThreeMfPartSubtype(baked.part.subtype), textTool
        )
        setTextTool(loaded)
        textApplyLoadedRef.current = loaded
        setEditingTextPartKey(null)
        setEditingTextHost(baked.instance.key)
        editingTextSurfaceRef.current = null
        reeditBakedPartRef.current = {
          hostId: baked.hostId,
          partIndex: baked.partIndex,
          // Kept so the replacement can land EXACTLY where the original sat. Re-deriving it from the
          // anchor is close but not equal: the anchor is the part's CENTRE, and the placement seats
          // text ON a surface, so a retype lifted it by half its thickness -- 1mm at the default 2mm,
          // every edit, compounding.
          transform: [...baked.part.transform]
        }
        setEditingTextObject(null)
        setGizmoMode(mode)
        return
      }
      const existing = selectedAddedPartKey ? findAddedTextPart(selectedAddedPartKey) : null
      if (existing) {
        const loaded = textToolValueFromInfo(existing.part.textInfo!, existing.part.subtype, textTool)
        setTextTool(loaded)
        textApplyLoadedRef.current = loaded
        setEditingTextPartKey(selectedAddedPartKey)
        setEditingTextHost(existing.hostInstanceKey)
        // The face is unknown until the user points again: `textInfo` records the ORIGINAL hit, and
        // the part may have been moved, the host rotated, or the file round-tripped through Studio
        // since. Re-deriving it from a stale hit would move text the user only meant to retype.
        editingTextSurfaceRef.current = null
      } else {
        setEditingTextPartKey(null)
        // A NEW session starts from the default word, not whatever the last one said: the tool is
        // create-then-edit, so it needs something on the model to look at, and inheriting the
        // previous text silently re-adds it. Everything else (font, size, mode) stays remembered,
        // which is a setting rather than content.
        setTextTool((current) => ({ ...current, text: DEFAULT_TEXT }))
        // Cleared so this session picks up whatever is selected NOW; pinned again once created.
        setEditingTextHost(null)
        editingTextSurfaceRef.current = null
      }
      setEditingTextObject(null)
    }
    setGizmoMode(mode)
    // The refs and setters are stable, but listing them is free and stops the rule from hiding a
    // genuinely missing dependency behind noise it has been trained to ignore.
  }, [selectedKey, openLayerHeightFor, selectedAddedPartKey, findAddedTextPart, textTool,
    recordHistoryRef, setEditingTextHost, setEditingTextObject,
    selectedBakedPart, findBakedAuthoredPart, findAddedSvgPart, reopenSvgArtwork])

  /**
   * Highlight the text being edited, so it reads as the thing you can grab.
   *
   * The tool has no gizmo, so without this nothing on screen says the text is draggable. Done as a
   * MATERIAL SWAP on the part's own mesh rather than an overlay object: adding and destroying a
   * scene object on every hover and press is the mesh churn that has broken this tool twice, once by
   * detaching the gizmo mid-drag and once by orphaning the mesh a drag was updating.
   */
  useEffect(() => {
    // Read the map ONCE into a local: the cleanup below runs later, and reaching through the ref
    // then would consult a map that has since been rebuilt.
    const groups = groupByKeyRef.current
    const hostKey = editingTextHostKeyRef.current ?? selectedKey
    const group = hostKey ? groups.get(hostKey) : null
    const active = gizmoMode === 'text' && editingTextPartKey != null
    const found: THREE.Mesh[] = []
    if (group) {
      rotorOf(group).traverse((node) => {
        if (node.userData.addedPartKey === editingTextPartKey) found.push(node as THREE.Mesh)
      })
    }
    // Standalone text is deliberately NOT highlighted: it is an ordinary object and behaves like
    // one, with the usual selection box and Move gizmo. The highlight belongs to text that is a PART
    // of a host, where it is dragged over a surface and needs to read as the grabbable thing.
    const meshes = active ? found : []
    textMeshRef.current = meshes[0] ?? null
    if (meshes.length === 0) return
    // Dragging shows the text as it will PRINT: see the type's own note.
    const tint = textInteraction === 'drag' ? 0x000000 : TEXT_HIGHLIGHT_COLORS[textInteraction]
    const materials = meshes.map((entry) => entry.material as THREE.MeshStandardMaterial)
    for (const material of materials) {
      material.emissive.setHex(tint)
      material.needsUpdate = true
    }
    return () => {
      // Leaving the tool must not leave the text glowing: the mesh keeps this material afterwards.
      for (const material of materials) {
        material.emissive.setHex(0x000000)
        material.needsUpdate = true
      }
    }
  }, [gizmoMode, editingTextPartKey, selectedKey, textInteraction, addedPartMeshVersion])

  /**
   * Delete whatever this session created, for the panel's Remove button.
   *
   * Two shapes, because text is two things: a PART of a host, or its own OBJECT when nothing was
   * selected. Handling only the part meant Remove silently did nothing on standalone text.
   */
  const removeTextPart = useCallback(() => {
    // A pending settle would re-run `applyTextPart` after the part is gone and, finding no
    // `editingTextPartKey`, CREATE a fresh one -- the text the user just deleted coming back.
    window.clearTimeout(reseatSettleRef.current)
    const objectKey = editingTextObjectKeyRef.current
    if (objectKey) {
      recordHistoryRef.current?.()
      updatePlates((plates) => plates.map((entry) => entry.index !== activePlateIndex ? entry : {
        ...entry,
        instances: entry.instances.filter((item) => item.key !== objectKey)
      }))
      setEditingTextObject(null)
      setSelectedKey(null)
      regenerateActiveThumbnailRef.current?.()
      return
    }
    const state = stateRef.current
    if (!state?.addedParts || !editingTextPartKey) return
    for (const [hostId, parts] of Object.entries(state.addedParts)) {
      const next = parts.filter((part) => part.key !== editingTextPartKey)
      if (next.length !== parts.length) state.addedParts[Number(hostId)] = next
    }
    setEditingTextPartKey(null)
    setGizmoPart(null)
    refreshAddedPartMeshes()
    regenerateActiveThumbnailRef.current?.()
  }, [editingTextPartKey, refreshAddedPartMeshes, updatePlates, activePlateIndex, recordHistoryRef,
    setEditingTextObject])



  /**
   * The face the current form names, with its font parsed, or null when there is nothing to build.
   *
   * The ONE place the tool resolves a face, so hosted text and standalone text cannot end up in
   * different typefaces from identical settings: both paths need it, and when each resolved its own
   * the bold/italic fallback and the user-face lookup were four statements duplicated verbatim.
   */
  const resolveTextFace = useCallback(async () => {
    const userFace = textUserFaces.find((face) => face.family === textTool.family)
    const face = userFace ?? bundledFace(textTool.family, textTool.bold, textTool.italic)
    if (!face || textTool.text.trim().length === 0) return null
    return { face, font: parsedFont(face.id) ?? await loadBundledFont(face) }
  }, [textTool, textUserFaces])

  /**
   * Build the text and decide where it sits, optionally around a caller-supplied anchor.
   *
   * With no anchor this lands the text on the host by itself, which is what creating it does. With
   * one -- what DRAGGING supplies, the part's own world position -- the text is rebuilt around that
   * point instead, so it re-seats on whatever surface the user has pulled it onto. That is the whole
   * mechanism behind text reshaping as it moves: the anchor is the only input that changes.
   */
  const buildTextPlacement = useCallback(async (
    group: THREE.Object3D,
    anchorWorld?: THREE.Vector3 | null,
    pointedNormal?: THREE.Vector3 | null
  ) => {
    const resolved = await resolveTextFace()
    if (!resolved) return null
    const { face, font } = resolved
    const geometryOptions = {
      text: textTool.text,
      fontSize: textTool.fontSize,
      thickness: textTool.thickness,
      textGap: textTool.textGap,
      rotateAngle: textTool.rotateAngle
    }
    const soup = buildTextSoup(font, geometryOptions)
    if (soup.length === 0) return null
    const rotor = rotorOf(group)
    rotor.updateWorldMatrix(true, false)
    // Land on real geometry. The bounding box's top is only a surface if the model HAS one at its
    // XY centre; an open box or any concave shape has nothing there, and text placed on the box
    // alone floats in mid air. So drop a ray from above the centre and take the first face it hits,
    // falling back to the box only when the ray misses everything (which a closed model cannot do).
    const box = printableMeshBox(group)
    const centre = box.isEmpty()
      ? new THREE.Vector3()
      : new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.max.z)
    const targets: THREE.Mesh[] = []
    group.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || isViewportAidMesh(mesh)) return
      // ADDED parts are not landing surfaces, and the text's OWN mesh is the one that matters: a
      // rebuild would otherwise drop the ray onto the text placed by the previous rebuild and stack
      // the new one on top of it, climbing by a thickness per keystroke until it floated clear of
      // the model. That is what "floating over the middle of a bowl" was.
      if (isAddedPartMesh(mesh)) return
      targets.push(mesh)
    })
    // SAMPLE the footprint rather than betting on one ray. A single ray down the exact centre is
    // what left text floating: measured on a divided storage box it returned NO hit at all, because
    // the centre line passes through a gap between dividers, so the code fell back to the bounding
    // box top -- which on any open or concave model is thin air above the rim.
    //
    // The highest hit wins, so the text lands on the uppermost real surface near the middle rather
    // than dropping into a well beside it.
    const spanX = (box.max.x - box.min.x) / 4
    const spanY = (box.max.y - box.min.y) / 4
    const above = box.max.z + Math.max(box.max.z - box.min.z, 1)
    let landing: THREE.Intersection | undefined
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]
    ]
    if (!anchorWorld) {
      for (const [dx, dy] of offsets) {
        const ray = new THREE.Raycaster(
          new THREE.Vector3(centre.x + dx * spanX, centre.y + dy * spanY, above),
          new THREE.Vector3(0, 0, -1)
        )
        const hit = ray.intersectObjects(targets, false)[0]
        if (hit && (!landing || hit.point.z > landing.point.z)) landing = hit
      }
    }
    // TEXT LIVES ON A SURFACE. Both of these end at a point the model actually has geometry at,
    // because everything downstream -- the normal, the flat-versus-wrap decision, the cut contour --
    // is meaningless for a point floating in space. Measured on this project's hole insert, the
    // earlier "centre XY at the landing's height" gave a point 47mm from ANY surface, because the
    // centre column passes through a slot: the ray that found the height landed somewhere else
    // entirely, and combining one ray's XY with another's Z lands on nothing.
    //
    // Creating uses where the sampling ray actually hit. Dragging snaps to the nearest surface, so
    // pulling the text off the edge of the model keeps it on the model rather than stranding it.
    // The anchor is ALWAYS resolved onto the surface, even when the pointer named the face.
    //
    // A drag adds the grab offset in world space, which is exact on a plane and drifts on anything
    // curved -- the seat walks off the surface a little further with every move. Once it is off, the
    // cut there is degenerate and the whole run collapses onto a single point: text that behaved for
    // the first few moves and then tangled into a knot. Snapping the point back costs one lookup and
    // makes the drift unaccumulatable.
    //
    // The NORMAL still comes from the pointer when there is one: the cursor named the face, and that
    // is more trustworthy than re-deriving it from a snapped point near an edge.
    const snapped = anchorWorld ? nearestSurfaceAt(anchorWorld, targets, box) : null
    const dragged = pointedNormal && anchorWorld
      ? { point: snapped?.point.clone() ?? anchorWorld.clone(), normal: pointedNormal.clone() }
      : snapped
    const worldPoint = anchorWorld
      ? (dragged?.point.clone() ?? anchorWorld.clone())
      : (landing?.point.clone() ?? new THREE.Vector3(centre.x, centre.y, centre.z))
    const nearby = dragged

    // Everything below is decided in WORLD space and converted ONCE, by inverting the host's world
    // matrix. That matrix carries rotation, scale and any reflection, so a flipped or laid-flat host
    // is handled by construction. Patching a rotation onto a position computed some other way was
    // tried and could not work: the pieces were in different frames.
    //
    // Two things this buys. The text stays upright on the PLATE however the model is oriented, which
    // is what Studio does and what the identity rotation could not give. And the depth offset -- the
    // soup is extruded symmetrically about its own centre, so a Cut left on the surface would remove
    // only half its depth -- is applied along world UP rather than the host's local Z, which on a
    // flipped part pointed into the model instead of out of it.
    const depth = textTool.operation === 'negative_part'
      ? -(textTool.thickness / 2)
      : textTool.thickness / 2 - textTool.embeddedDepth
    /** One flat block on the surface: the mode's own answer, and every surface path's fallback. */
    const flatPlacement = () => {
      const desiredWorld = new THREE.Matrix4().makeTranslation(
        worldPoint.x, worldPoint.y, worldPoint.z + depth
      )
      const local = new THREE.Matrix4().copy(rotor.matrixWorld).invert().multiply(desiredWorld)
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      local.decompose(position, quaternion, scale)
      return {
        face,
        soup,
        position,
        rotation: new THREE.Euler().setFromQuaternion(quaternion),
        scale,
        rotor
      }
    }
    // SURFACE modes do not place a flat block at all: the text is built already lying on the
    // surface, so the geometry carries the placement and the part sits at the host's own origin.
    // This is BambuStudio's model -- a position and normal per character along a cut contour --
    // and it is why text in a bore wraps around it instead of hovering above the rim.
    // A surface mode only means something on a surface that CURVES away from the text. On a flat
    // top face the baseline plane cuts the object's whole silhouette at that height, so the run
    // would wrap around the entire perimeter instead of sitting where the user is looking.
    // BambuStudio's surface text likewise reads as flat on a flat face, so the flat path IS the
    // right answer here rather than a fallback.
    const landedNormal = nearby?.normal
      ?? (landing?.face
        ? landing.face.normal.clone().transformDirection(landing.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 0, 1))
    // No flat-face gate: with the cut plane taken from the surface's own up direction, a flat face
    // yields a straight contour by construction, exactly as it does in Studio. The gate that used to
    // sit here was papering over the world-Z plane below it.
    if (textTool.surfaceMode !== 'horizontal') {
      // Built from the raycast TARGETS, not the whole group: `collectWorldTriangles` keeps a Join
      // text mesh (it is printed geometry, not a viewport aid), so slicing the group would cut the
      // previous rebuild's letterforms along with the host and `loopNearest` could pick a letter's
      // own contour -- the text wrapping around itself. `targets` already excludes added parts.
      //
      // Deliberately NOT cached across the editing session. It looks like the obvious candidate --
      // it walks every triangle of the host, on every keystroke -- and a session cache was built and
      // then removed, because the measurement did not support it: mean main-thread blocking per
      // rebuild went 1368ms -> 1297ms, inside the noise. A CPU profile of the same keystrokes says
      // why. The top twenty self-time entries are ALL React and Joy/emotion (`useSlot`,
      // `useThemeProps`, `handleInterpolation`, `jsxDEV`); not one text-geometry function appears.
      // The per-keystroke cost is the editor's tree re-rendering, not this walk. Cache it only with
      // a profile that actually names it.
      const hostSoup = worldTrianglesOf(targets)
      // The baseline plane sits at the anchor's own height. `depth` does NOT belong here: it is a
      // distance INTO the surface, and on a vertical wall shifting the plane by it just slides the
      // ring up and down the wall. It is applied along each glyph's own normal below instead.
      // BambuStudio's frame (`generate_text_tran_in_world`): z is the surface normal, y is
      // `suggest_up` of it, x is y x z -- and the CUT PLANE's normal is y, the text's own up
      // (`GLGizmoText.cpp:3180`). Slicing with a fixed world-Z plane, as this did, is right only by
      // coincidence on a vertical wall: on a flat face a horizontal cut returns that face's
      // OUTLINE, so the text could only fan around a circle. Studio carries no flat-face special
      // case because its plane is vertical there, and a vertical cut of a flat face is a line.
      const seat = { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z }
      const surfaceZ = { x: landedNormal.x, y: landedNormal.y, z: landedNormal.z }
      // `surfaceHorizontal` forces up to WORLD up (Studio's SURFACE_HORIZONAL, `GLGizmoText.cpp:1429`),
      // which makes the cut plane horizontal whatever the surface is doing. That is the whole
      // difference between the two modes: plain `surface` takes its plane from the surface, so on a
      // tilted or domed face the contour rises and falls and the letters ride it -- correct, but it
      // reads as a ragged baseline. Horizontal cuts at constant height, so the baseline is level.
      const baseUp = textTool.surfaceMode === 'surfaceHorizontal' && Math.abs(surfaceZ.z) < 0.999
        ? { x: 0, y: 0, z: 1 }
        : suggestUp(surfaceZ)
      // Angle rotates the FRAME about the surface normal, as Studio's `generate_text_tran_in_world`
      // composes `rotate_trans` into the text transform. Rotating the frame turns the cut plane with
      // it, so the contour, the reading direction and every glyph follow -- rotating the glyphs
      // alone would tilt the letters off a baseline that had not moved.
      const surfaceUp = textTool.rotateAngle === 0
        ? baseUp
        : (() => {
          const rotated = new THREE.Vector3(baseUp.x, baseUp.y, baseUp.z)
            .applyAxisAngle(landedNormal.clone().normalize(), THREE.MathUtils.degToRad(textTool.rotateAngle))
          return { x: rotated.x, y: rotated.y, z: rotated.z }
        })()
      // The contour the POINTED point sits on, not the longest in the cut: a cut through a real part
      // yields several (outer silhouette, recess wall, every bore) and the longest is almost always
      // the silhouette, which is what made the text wrap "something invisible".
      const loop = loopNearest(sliceSegments(hostSoup, seat, surfaceUp), seat)
      // Orient the loop before anything is measured along it. Which way `chainLongestLoop` walked is
      // an accident of its seed triangle, and that direction becomes the text's reading direction --
      // walked the wrong way the glyph basis inverts (`yAxis = zAxis x xAxis`), so the letters come
      // out mirrored AND laid down back to front. Both symptoms, one sign.
      //
      // `landedNormal` is the reference for which way is OUT, because it comes from the raycast's
      // own face normal -- the value three.js RENDERS with -- rather than from a cross product,
      // which is winding dependent and silently inverts on a mesh wound inconsistently.
      const reference = nearestFrame(loop, worldPoint)
      let reading = loop
      if (reference) {
        const facing = dotVec(reference.normal, landedNormal) < 0 ? -1 : 1
        const outward = new THREE.Vector3(reference.normal.x, reference.normal.y, reference.normal.z)
          .multiplyScalar(facing)
        // Upright text reads along up x out. Degenerate on a floor or ceiling, where "upright" means
        // nothing and the loop's own direction is as good an answer as any.
        const desired = new THREE.Vector3(surfaceUp.x, surfaceUp.y, surfaceUp.z).cross(outward)
        if (desired.lengthSq() > 0.01) {
          desired.normalize()
          const tangent = new THREE.Vector3(
            reference.tangent.x, reference.tangent.y, reference.tangent.z
          )
          if (tangent.dot(desired) < 0) reading = reverseLoop(loop)
        }
      }
      const advances = glyphAdvances(font, geometryOptions)
      // Centred on the point the text was placed at, NOT on the loop's start. The loop begins at
      // whichever triangle the chainer seeded from, so seating from zero wrapped the text properly
      // and then put it on the far side of the model from the pointer.
      const runLength = advances.reduce((sum, advance) => sum + advance, 0)
      // Keep the WHOLE run on the contour by sliding it, rather than letting the ends fall off:
      // `seatGlyphs` drops any glyph running past the end of an OPEN contour, which loses letters
      // from text placed near one. A closed contour is exempt -- a bore wraps, so there is no end to
      // slide from, and clamping would drag the text off the point the user placed it at.
      let start = arcOffsetNearest(reading, worldPoint) - runLength / 2
      const first = reading[0]
      const last = reading[reading.length - 1]
      const closed = first != null && last != null
        && Math.hypot(last.b.x - first.a.x, last.b.y - first.a.y, last.b.z - first.a.z) < 1e-3
      const spanLength = loopLength(reading)
      if (!closed && spanLength > runLength) {
        start = Math.min(Math.max(start, 0), spanLength - runLength)
      }
      // A contour SHORTER than the run cannot hold it: a closed one wraps the text over itself and
      // a knot of overlapping letters is what reaches the user. Falling through to flat placement is
      // the honest answer -- text that is visibly not wrapped beats text tangled into a ball.
      if (spanLength < runLength) return flatPlacement()
      const frames = seatGlyphs(reading, advances, start)
      if (frames.some(Boolean)) {
        // Same outward reference as the loop orientation above, for the same reason.
        const facing = reference && dotVec(reference.normal, landedNormal) < 0 ? -1 : 1
        // Stand each glyph off along the surface it sits on. The soup is extruded symmetrically
        // about its own centre, so a glyph left exactly on the contour is half inside the wall --
        // which on a Cut removes only half the depth asked for, and on a Join buries half the
        // letterform. Along the NORMAL, not world up, because that is the only direction that means
        // "out of the surface" for a wall as well as a floor.
        const seated = frames.map((frame) => {
          if (!frame) return null
          const normal = {
            x: frame.normal.x * facing, y: frame.normal.y * facing, z: frame.normal.z * facing
          }
          return {
            ...frame,
            normal,
            position: {
              x: frame.position.x + normal.x * depth,
              y: frame.position.y + normal.y * depth,
              z: frame.position.z + normal.z * depth
            }
          }
        })
        const worldSoup = buildSurfaceTextSoup(font, geometryOptions, seated)
        if (worldSoup.length > 0) {
          // Into the host's frame, since a part's geometry is stored object-local.
          const toLocal = new THREE.Matrix4().copy(rotor.matrixWorld).invert()
          // Wrapped geometry is built in place, so it would naturally sit at the host's origin with
          // the placement baked into the vertices. It is re-centred on the anchor instead, and the
          // anchor handed back as the part's position, so the part's TRANSFORM still says where the
          // text is. Dragging depends on that: the gizmo reports the mesh's world position, and if
          // every wrap sat at the origin, that reading would be the host's origin no matter where
          // the letters actually were, and the next re-projection would snap them back to it.
          const localAnchor = worldPoint.clone().applyMatrix4(toLocal)
          const point = new THREE.Vector3()
          for (let i = 0; i < worldSoup.length; i += 3) {
            point.set(worldSoup[i]!, worldSoup[i + 1]!, worldSoup[i + 2]!).applyMatrix4(toLocal)
            worldSoup[i] = point.x - localAnchor.x
            worldSoup[i + 1] = point.y - localAnchor.y
            worldSoup[i + 2] = point.z - localAnchor.z
          }
          return {
            face,
            soup: worldSoup,
            position: localAnchor,
            rotation: new THREE.Euler(),
            scale: new THREE.Vector3(1, 1, 1),
            rotor
          }
        }
      }
      // No contour at that height (the plane missed, or the text is longer than an open arc):
      // fall through to flat placement rather than silently adding nothing.
    }

    return flatPlacement()

  }, [resolveTextFace, textTool])

  /**
   * Rebuild the dragged text around its new position, live.
   *
   * BambuStudio's text re-shapes to the model as it is dragged, and this is that: every drag frame
   * re-runs the placement with the part's own world position as the anchor, so pulling the text into
   * a bore wraps it around the bore and pulling it back out flattens it again.
   *
   * **The MESH is kept and only its geometry replaced.** Rebuilding the part's mesh mid-drag is what
   * `refreshAddedPartMeshes` would do, and it detaches the gizmo the drag is running on -- three.js
   * `TransformControls` requires its attached object to stay in the scene graph, and losing it
   * stranded the gizmo at the plate origin, moving opposite the pointer. So state and geometry are
   * updated in place here, and the staging that a save needs waits for the drag to finish.
   *
   * Drops frames rather than queueing them: a stale rebuild landing after a newer one would wrap the
   * text around a position the user has already left.
   */
  const reseatBusyRef = useRef(false)
  const reseatDraggedText = useCallback((mesh: THREE.Object3D) => {
    if (gizmoModeRef.current !== 'text' || textTool.surfaceMode === 'horizontal') return
    if (mesh.userData.addedPartKey !== editingTextPartKeyRef.current) return
    if (reseatBusyRef.current) return
    const key = editingTextHostKeyRef.current ?? selectedKeyRef.current
    const group = key ? groupByKeyRef.current.get(key) : null
    const partMesh = mesh as THREE.Mesh
    if (!group || !partMesh.isMesh) return
    reseatBusyRef.current = true
    const anchor = mesh.getWorldPosition(new THREE.Vector3())
    void buildTextPlacement(group, anchor)
      .then((placement) => {
        if (!placement || mesh.userData.addedPartKey !== editingTextPartKeyRef.current) return
        const state = stateRef.current
        for (const parts of Object.values(state?.addedParts ?? {})) {
          const part = parts.find((entry) => entry.key === mesh.userData.addedPartKey)
          if (!part) continue
          part.soup = placement.soup
          // The placement's own position IS the anchor it was handed, so the mesh is already
          // there; copying it back would be a no-op that risks fighting the in-flight drag.
          break
        }
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(placement.soup.slice(), 3))
        geometry.computeVertexNormals()
        partMesh.geometry.dispose()
        partMesh.geometry = geometry
      })
      .catch((error) => { console.warn('[editor] text re-seat failed', error) })
      .finally(() => {
        reseatBusyRef.current = false
        // Settle after the drag stops. The live pass above updates state and the visible mesh but
        // stages no mesh, and it is the staged import a SAVE writes -- so without this the file
        // would keep the geometry the text had before it was ever dragged.
        window.clearTimeout(reseatSettleRef.current)
        reseatSettleRef.current = window.setTimeout(() => { void applyTextPartRef.current?.() }, 300)
      })
  }, [buildTextPlacement, textTool.surfaceMode])
  reseatDraggedTextRef.current = reseatDraggedText

  /**
   * Place the text where the pointer is on the model, live.
   *
   * The counterpart of `useEditorScene`'s text pointer drag: it supplies a point on a face and that
   * face's normal, and this rebuilds the text there. Same in-place geometry swap as
   * {@link reseatDraggedText}, and for the same reason -- a rebuilt mesh detaches the gizmo -- and
   * the same trailing settle so a save gets a staged mesh.
   */
  const placeTextAt = useCallback((
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
    phase: 'start' | 'move'
  ) => {
    if (gizmoModeRef.current !== 'text') return
    const partKey = editingTextPartKeyRef.current
    if (!partKey) return
    // Any new placement invalidates a pending settle. Left armed, it fires MID-DRAG and runs
    // `applyTextPart`, whose `refreshAddedPartMeshes` replaces the part's mesh -- after which every
    // geometry swap below lands on an orphaned mesh that is no longer in the scene, and the drag
    // looks frozen while the work goes on happening somewhere invisible.
    window.clearTimeout(reseatSettleRef.current)
    if (reseatBusyRef.current) {
      pendingTextPlacementRef.current = { point: worldPoint.clone(), normal: worldNormal.clone() }
      return
    }
    const key = editingTextHostKeyRef.current ?? selectedKeyRef.current
    const group = key ? groupByKeyRef.current.get(key) : null
    if (!group) return
    // Collected rather than assigned in the callback: TypeScript does not track writes made inside
    // a traverse, and narrows the variable to `never` at every use below.
    const found: THREE.Mesh[] = []
    rotorOf(group).traverse((node) => {
      if (node.userData.addedPartKey === partKey) found.push(node as THREE.Mesh)
    })
    const mesh = found[0]
    if (!mesh?.isMesh) return
    // Pressing only GRABS: it records where the text sits relative to the grab point and moves
    // nothing. Placing on press is what made the text jump to centre itself under the cursor.
    if (phase === 'start') {
      textGrabOffsetRef.current = mesh.getWorldPosition(new THREE.Vector3()).sub(worldPoint)
      return
    }
    const grab = textGrabOffsetRef.current
    const seatPoint = grab ? worldPoint.clone().add(grab) : worldPoint
    reseatBusyRef.current = true
    editingTextSurfaceRef.current = { point: seatPoint.clone(), normal: worldNormal.clone() }
    void buildTextPlacement(group, seatPoint, worldNormal)
      .then((placement) => {
        if (!placement || editingTextPartKeyRef.current !== partKey) return
        for (const parts of Object.values(stateRef.current?.addedParts ?? {})) {
          const part = parts.find((entry) => entry.key === partKey)
          if (!part) continue
          part.soup = placement.soup
          part.position.copy(placement.position)
          part.rotation.copy(placement.rotation)
          part.scale.copy(placement.scale)
          break
        }
        // The transform moves too, unlike a gizmo drag, because the POINTER decides where the text
        // goes: the mesh has to follow the cursor rather than the other way round.
        mesh.position.copy(placement.position)
        mesh.rotation.copy(placement.rotation)
        mesh.scale.copy(placement.scale)
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(placement.soup.slice(), 3))
        geometry.computeVertexNormals()
        mesh.geometry.dispose()
        mesh.geometry = geometry
      })
      .catch((error) => { console.warn('[editor] text placement failed', error) })
      .finally(() => {
        reseatBusyRef.current = false
        const pending = pendingTextPlacementRef.current
        if (pending) {
          pendingTextPlacementRef.current = null
          placeTextAtRef.current(pending.point, pending.normal, 'move')
          return
        }
        window.clearTimeout(reseatSettleRef.current)
        reseatSettleRef.current = window.setTimeout(() => { void applyTextPartRef.current?.() }, 300)
      })
  }, [buildTextPlacement])
  placeTextAtRef.current = placeTextAt

  /**
   * Write the current form into the text part, creating it on first call.
   *
   * One function for create and update, because BambuStudio's tool has no separate "add" step: the
   * text exists from the moment the tool opens and every edit rewrites it. Editing REPLACES the
   * geometry rather than transforming it, since every parameter changes the letterforms; the part's
   * placement survives because only its mesh and text record are swapped.
   */
  const applyTextPart = useCallback(async () => {
    const state = stateRef.current
    // The HOST is fixed when the text is created, not re-read from the selection on every pass.
    // Whether this text belongs to a model or stands on its own is decided once, and the two are
    // different things -- a part of a model versus a separate object. Re-deciding it per keystroke
    // let a stray click on empty space drop the selection and quietly spawn a second, standalone
    // copy of the text on the plate while the first was still being edited.
    const key = editingTextHostKeyRef.current ?? selectedKeyRef.current
    const plate = state?.plates.find((entry) => entry.index === activePlateIndex)
    const instance = plate?.instances.find((entry) => entry.key === key)
    const group = key ? groupByKeyRef.current.get(key) : null

    // Nothing selected: the text is its own model, not a part of something. BambuStudio does the
    // same, and it is the only way to letter a plate that has no host to attach to.
    //
    // Standalone-vs-hosted is decided ONCE per session and pinned, like the host key. Re-deciding it
    // per pass is what made typing another letter add the text as a CHILD of the object it had just
    // created: creating a standalone object selects it, so the next pass saw a valid host -- itself.
    if (!state || editingTextObjectKeyRef.current != null || !instance || !group) {
      if (!state || !plate) return
      const resolved = await resolveTextFace()
      if (!resolved) return
      const soup = buildTextSoup(resolved.font, {
        text: textTool.text,
        fontSize: textTool.fontSize,
        thickness: textTool.thickness,
        textGap: textTool.textGap,
        rotateAngle: textTool.rotateAngle
      })
      if (soup.length === 0) return
      // The same record a text PART carries, so the tool can reopen this object and edit it. It
      // names the face that was RESOLVED, not the one the form asked for, exactly as the hosted
      // path does: those differ whenever the family has no matching cut and `bundledFace` falls
      // back, and recording the request would reopen the text in a typeface it was never built in.
      const standaloneTextInfo: TextInfo = {
        ...defaultTextInfo(textTool.text, resolved.face.family),
        fontSize: textTool.fontSize,
        thickness: textTool.thickness,
        textGap: textTool.textGap,
        rotateAngle: textTool.rotateAngle,
        embeddedDepth: textTool.embeddedDepth,
        surfaceType: 'horizontal',
        bold: textTool.bold,
        italic: textTool.italic,
        fontIndex: Math.max(0, BUNDLED_FONTS.findIndex((entry) => entry.id === resolved.face.id))
      }
      // Stood UP on the bed: a standalone object rests on the plate, unlike a part, which is placed
      // by its centre inside a host.
      const standing = soup.slice()
      let minZ = Infinity
      for (let i = 2; i < standing.length; i += 3) minZ = Math.min(minZ, standing[i]!)
      for (let i = 2; i < standing.length; i += 3) standing[i] = standing[i]! - minZ
      const staged = await importStore.stageFile(
        new File([triangleSoupToBinaryStl(standing)], `${textTool.text.slice(0, 40) || 'Text'}.stl`,
          { type: 'application/octet-stream' }),
        'object'
      )
      // Created ONCE, then edited in place, exactly like text on a host. Adding an object and
      // closing the tool on the first debounce meant a standalone text could never be edited at all:
      // the tool shut itself the moment you typed, having committed whatever you had got to.
      const existingKey = editingTextObjectKeyRef.current
      const existing = existingKey ? plate.instances.find((entry) => entry.key === existingKey) : null
      if (existing) {
        const replacement = replaceInstanceGeometry(
          existing, staged, undefined, importStore.meshUrl,
          worldFootprintCenterForRef.current?.(existing.key) ?? null
        )
        replacement.textInfo = standaloneTextInfo
        // Keep the name in step with the text, unless the user has renamed it themselves: the
        // object is created named after its text, so leaving it behind makes "tests" sit in the
        // list next to text that now reads "testsa".
        if (!existing.nameOverridden) replacement.name = textTool.text.slice(0, 40) || 'Text'
        replacement.nameOverridden = existing.nameOverridden
        setEditingTextObject(replacement.key)
        // NOT deselected: clearing the selection here is indistinguishable from the user clicking
        // empty space, and the deselect rule would close the tool on the second keystroke.
        setSelectedKey(replacement.key)
        previousSelectedKeyRef.current = replacement.key
        updatePlates((plates) => plates.map((entry) => entry.index !== activePlateIndex ? entry : {
          ...entry,
          instances: entry.instances.map((item) => item.key === existing.key ? replacement : item)
        }))
        return
      }
      recordHistoryRef.current?.()
      const created = instanceFromStagedImport(staged, importStore.meshUrl)
      created.textInfo = standaloneTextInfo
      setEditingTextObject(created.key)
      addInstanceToActivePlate(created, stagedFootprint(staged))
      return
    }
    const hostId = addedPartHostId(instance)
    if (hostId == null) { toast.error('This model cannot take text yet.'); return }

    // An edit re-seats the text where it currently IS, not where it first landed. Rebuilding from
    // the host's centre every keystroke would drag the text back off whatever surface the user had
    // moved it onto, one character at a time.
    // Rebuild against the POINTED face, never a fresh inference: this runs on every keystroke and
    // after every drag, so re-deriving the surface here would undo what the pointer chose.
    const pointed = editingTextSurfaceRef.current
    let anchor: THREE.Vector3 | null = pointed?.point.clone() ?? null
    if (!pointed && editingTextPartKey) {
      rotorOf(group).traverse((node) => {
        if (node.userData.addedPartKey === editingTextPartKey) {
          anchor = node.getWorldPosition(new THREE.Vector3())
        }
      })
    }
    // Re-editing a part a previous session SAVED: it is a baked `<component>`, so it has no
    // `addedPartKey` for the lookup above to match and the anchor would stay null. That is not a
    // cosmetic miss: with no anchor and no pointed face, `buildTextPlacement` raycasts straight down
    // the model's XY centre and returns its TOP surface, so text sitting on a side wall teleported
    // to the top of the model on the first keystroke, and the baked original was removed in the same
    // commit. Anchored on where the part actually sits, which is the one thing its own group knows.
    const promotingFrom = reeditBakedPartRef.current
    const promotingTransform = promotingFrom?.transform ?? null
    if (!pointed && !anchor && promotingFrom) {
      rotorOf(group).traverse((node) => {
        const ref = node.userData.partRef as { partIndex: number } | undefined
        if (ref?.partIndex === promotingFrom.partIndex) {
          anchor = node.getWorldPosition(new THREE.Vector3())
        }
      })
    }
    const placement = await buildTextPlacement(group, anchor, pointed?.normal ?? null)
    if (!placement) return
    const parts = ((state.addedParts ??= {})[hostId] ??= [])
    const existing = editingTextPartKey ? parts.find((part) => part.key === editingTextPartKey) : null
    // Staging serializes the soup to a binary STL and round-trips it through the import worker for
    // the sole purpose of getting an `importId` back -- the soup it returns is the one handed in. So
    // skip it outright when the geometry is unchanged and reuse the id already on the part. That is
    // the whole of a flat-mode drag, where the letterforms never change and only the transform
    // moves; without this, every pointer move staged a byte-identical mesh and orphaned the last one.
    const unchanged = existing?.importId != null && existing.soup != null
      && triangleSoupsEqual(existing.soup, placement.soup)
    const staged = unchanged
      ? { importId: existing.importId }
      : await stageAddedPartGeometry(
        importStore, { kind: 'soup', soup: placement.soup, name: textTool.text.slice(0, 40) }, 0
      )
    const textInfo: TextInfo = {
      ...defaultTextInfo(textTool.text, placement.face.family),
      fontSize: textTool.fontSize,
      thickness: textTool.thickness,
      textGap: textTool.textGap,
      rotateAngle: textTool.rotateAngle,
      embeddedDepth: textTool.embeddedDepth,
      surfaceType: textTool.surfaceMode,
      bold: textTool.bold,
      italic: textTool.italic,
      fontIndex: Math.max(0, BUNDLED_FONTS.findIndex((entry) => entry.id === placement.face.id)),
      // The raycast that placed this text. BambuStudio reads these into `TextInfo::m_rr`
      // (`bbs_3mf.cpp:4914`) and its gizmo re-derives placement from them, so leaving them at the
      // defaults makes our file reopen in Studio pointing at the origin instead of at the surface
      // the user chose. Absent only until the text has been pointed at something.
      ...(pointed ? {
        hitPosition: [pointed.point.x, pointed.point.y, pointed.point.z] as [number, number, number],
        hitNormal: [pointed.normal.x, pointed.normal.y, pointed.normal.z] as [number, number, number]
      } : {})
    }
    if (existing) {
      existing.importId = staged.importId
      existing.soup = placement.soup
      existing.subtype = textTool.operation
      existing.name = textTool.text.slice(0, 40)
      existing.textInfo = textInfo
      // The transform is taken from the SAME placement as the soup whenever a pointed face is in
      // play. They are two halves of one answer, and letting the soup update while the transform
      // kept an older value is how the text jumped the moment a drag was released.
      if (pointed) {
        existing.position.copy(placement.position)
        existing.rotation.copy(placement.rotation)
        existing.scale.copy(placement.scale)
      }
    } else {
      const partKey = nextInstanceKey()
      // Promoting a saved part with no pointed face: keep the placement it ALREADY had, rather than
      // the one just computed. The two are close but not equal, and the difference is systematic --
      // the anchor is the part's centre while the placement seats text ON a surface, so a plain
      // retype lifted the text by half its thickness and did it again on every subsequent edit.
      // Measured on a real save: z 6.25 -> 7.25 at the default 2mm thickness.
      const keptPlacement = !pointed && promotingTransform
        ? new THREE.Matrix4().fromArray([
          promotingTransform[0]!, promotingTransform[1]!, promotingTransform[2]!, 0,
          promotingTransform[3]!, promotingTransform[4]!, promotingTransform[5]!, 0,
          promotingTransform[6]!, promotingTransform[7]!, promotingTransform[8]!, 0,
          promotingTransform[9]!, promotingTransform[10]!, promotingTransform[11]!, 1
        ])
        : null
      const kept = keptPlacement
        ? {
          position: new THREE.Vector3(),
          rotation: new THREE.Euler(),
          scale: new THREE.Vector3()
        }
        : null
      if (keptPlacement && kept) {
        const q = new THREE.Quaternion()
        keptPlacement.decompose(kept.position, q, kept.scale)
        kept.rotation.setFromQuaternion(q)
      }
      parts.push({
        key: partKey,
        importId: staged.importId,
        subtype: textTool.operation,
        name: textTool.text.slice(0, 40),
        ...(threeMfPartSubtypeCarriesFilament(textTool.operation) ? { filamentId: instance.filamentId } : {}),
        position: kept?.position ?? placement.position,
        rotation: kept?.rotation ?? placement.rotation,
        // Counters the host's scale, so 10mm text is 10mm on the plate rather than 10mm times
        // whatever the model was scaled to.
        scale: kept?.scale ?? placement.scale,
        soup: placement.soup,
        textInfo
      })
      setEditingTextPartKey(partKey)
      setEditingTextHost(instance.key)
      // Selected immediately: the text IS the selection while the tool is open, which is what makes
      // it draggable without leaving the panel.
      const textHostId = addedPartHostId(instance)
      if (textHostId != null) setGizmoPart({ objectId: textHostId, member: { kind: 'added', key: partKey } })
      // Re-editing a part a previous session SAVED: the new volume above replaces it, so the baked
      // one goes in the same commit. Deferred to here rather than done at open, so a look at a saved
      // part's settings costs nothing; cleared either way, since the promotion happens exactly once
      // and every later keystroke edits the added part through the branch above.
      const promoting = reeditBakedPartRef.current
      reeditBakedPartRef.current = null
      if (promoting && textHostId === promoting.hostId) {
        // Decided HERE, off the live state, never from inside the updater: `withRemovedParts`
        // refuses when nothing printed would survive, and a refusal has to change what happens next
        // rather than being absorbed. `?? current` swallowed it, leaving the ORIGINAL text and its
        // replacement both in the object with nothing said -- and when the replacement is a Cut, a
        // negative volume carving into the very text it was meant to replace. The removal's own
        // default counts the added parts (the new one included, it is already pushed), so no count
        // is passed: duplicating a default reads as a rule and drifts from it.
        const removed = withRemovedParts(
          stateRef.current!, promoting.hostId, new Set([promoting.partIndex])
        )
        if (removed) {
          setState((current) => (current
            ? withRemovedParts(current, promoting.hostId, new Set([promoting.partIndex])) ?? current
            : current))
        } else {
          // Roll the replacement back out rather than leaving two volumes for one part. The refusal
          // is correct (an object must keep something printed), so the honest outcome is that the
          // edit did not happen, said plainly.
          const at = parts.findIndex((part) => part.key === partKey)
          if (at >= 0) parts.splice(at, 1)
          setEditingTextPartKey(null)
          // The selection was pointed at the volume just spliced out, so it has to go with it: a
          // gizmo attached to a key nothing owns any more leaves the panel acting on nothing.
          setGizmoPart(null)
          toast.error('This object would have nothing left to print. Change the operation back to Join, or add another part first.')
        }
      }
    }
    refreshAddedPartMeshes()
    regenerateActiveThumbnailRef.current?.()
  }, [activePlateIndex, addInstanceToActivePlate, buildTextPlacement, editingTextPartKey,
    importStore, resolveTextFace, textTool, updatePlates,
    recordHistoryRef, refreshAddedPartMeshes, setEditingTextHost, setEditingTextObject])
  applyTextPartRef.current = applyTextPart

  /**
   * Keep the live part in step with the form, debounced because each pass rebuilds the letterforms
   * and stages a mesh.
   */
  useEffect(() => {
    if (gizmoMode !== 'text') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled) return
      // Loading a saved part into the panel is not an edit; anything the user then changes is.
      const loaded = textApplyLoadedRef.current
      textApplyLoadedRef.current = null
      if (loaded && textToolValuesEqual(loaded, textTool)) return
      void applyTextPart().catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Unable to update the text.')
      })
    }, 200)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [gizmoMode, applyTextPart, textTool])

  /** Register a font the user picked from disk and select it. */
  const loadTextFontFile = useCallback(async (file: File) => {
    try {
      const face = await loadUserFont(file)
      setTextUserFaces((current) => [...current.filter((entry) => entry.id !== face.id), face])
      setTextTool((current) => ({ ...current, family: face.family, bold: false, italic: false }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That file could not be read as a font.')
    }
  }, [])

  // Clearing the selection drops any mode that cannot function without one. An empty-viewport click,
  // Escape, or a plate switch would otherwise leave the editor in (say) Cut or Paint with no panel
  // and no gizmo: the rail shows the tool lit but disabled, and the only way out is to click an
  // object. Deliberately keyed on the selection rather than folded into the deselect handlers, of
  // which there are several (viewport click, Escape, plate select, add/remove plate) and which would
  // each have had to remember.
  useEffect(() => {
    if (!selectedKey && isSelectionOnlyGizmoMode(gizmoMode)) setGizmoMode(RESTING_GIZMO_MODE)
    // Text is exempt from the check above because it works with nothing selected, so it needs its
    // own rule: a DESELECT closes it, but merely having nothing selected does not. Only the
    // transition tells those apart -- opening the tool on an empty plate looks identical to
    // deselecting while it is open if you only look at the current selection.
    if (gizmoMode === 'text' && previousSelectedKeyRef.current != null && selectedKey == null) {
      setGizmoMode(RESTING_GIZMO_MODE)
    }
    previousSelectedKeyRef.current = selectedKey
  }, [selectedKey, gizmoMode])

  // The panel IS the `layerHeight` mode, so leaving the mode by any route (a toolbar tool, the M/R/S
  // shortcuts, Escape) closes it. Without this the panel outlives its mode and the move gizmo comes
  // back underneath it, which is the conflict the mode exists to prevent.
  useEffect(() => {
    if (gizmoMode !== 'layerHeight' && editingLayerHeight) {
      setEditingLayerHeight(null)
      setLayerHeightBrush(null)
    }
  }, [gizmoMode, editingLayerHeight])

  // Text gets the same treatment, for the same reason. Its teardown used to live ONLY on the
  // panel's Done button, so every other way out of the mode (a toolbar tool, the M/R/S shortcuts,
  // Escape, clicking while a tool that acts on what it is pointed at is active) left the session
  // half-open: `editingTextPartKey` and `editingTextHostKey` still set, and a reseat timer still
  // pending. That timer then fired `applyTextPart` after the user had already left the tool, editing
  // text nobody was editing any more. It self-healed on re-entry, which is why it read as a rare
  // glitch rather than a missing teardown.
  // Leaving the SVG tool forgets the artwork, so reopening starts from a fresh file rather than
  // offering to re-add whatever was loaded last session.
  useEffect(() => {
    if (gizmoMode === 'svg' || (svgArtwork == null && svgFileName == null && svgEmptyReason == null)) return
    setSvgArtwork(null)
    setSvgFileName(null)
    setSvgEmptyReason(null)
    // The COMMITTED bytes are not dropped with the panel's copy: they live on `state.svgSources`,
    // keyed by entry path, because the save needs them long after the tool has closed.
    setSvgMarkup(null)
    // A re-edit target must not outlive its session either, or the next fresh import would commit
    // as a replacement of whatever was open last time.
    reeditSvgRef.current = null
    setReeditSvgCount(0)
  }, [gizmoMode, svgArtwork, svgFileName, svgEmptyReason])

  useEffect(() => {
    if (gizmoMode === 'text') return
    if (editingTextPartKey == null && editingTextHostKey == null) return
    window.clearTimeout(reseatSettleRef.current)
    setEditingTextPartKey(null)
    setEditingTextHost(null)
  }, [gizmoMode, editingTextPartKey, editingTextHostKey, setEditingTextHost])

  // Teardown is its OWN effect, keyed only on which object is being edited. Folding it into the
  // sync above would tear every overlay down and rebuild it on each brush sample and each profile
  // edit, which is the per-vertex cost the cached-height design exists to avoid.
  useEffect(() => {
    const key = editingLayerHeight?.key
    if (!key) return
    // The REF is captured, never `.current`: teardown wants the group as it stands THEN, because a
    // plate rebuild replaces the map and disposes the old group, and stripping visuals off a
    // disposed group would leave the live one still wearing them. Capturing the ref object rather
    // than its value keeps that and satisfies the exhaustive-deps rule, which cannot tell the two
    // apart on its own.
    const groups = groupByKeyRef
    return () => {
      const group = groups.current.get(key)
      if (group) removeLayerHeightVisuals(group)
    }
  }, [editingLayerHeight?.key])

  /**
   * Read the plate's packing constraints out of the LIVE scene: which zones bar which nozzle, and
   * where the prime tower currently stands (its size depends on the plate's filament count and
   * tallest object, so it is measured off the rendered object rather than the plate record).
   *
   * `demandingInstances` are the objects whose nozzle reach must be honoured: every instance for
   * Auto-arrange, which moves them all, but only the copied object for Fill bed, since nothing
   * already placed moves and a neighbour's reach is therefore not this operation's problem.
   */
  const plateObstaclesFor = useCallback((plate: EditorPlate, demandingInstances: ReadonlyArray<EditorInstance>) => {
    const tower = primeTowerObjRef.current
    const towerCenter = tower ? tower.getWorldPosition(new THREE.Vector3()) : null
    return computePlateObstacles({
      bed: plate.bed,
      zones: plate.bed.excludeAreas.map((zone) => ({
        polygon: zone.polygon,
        requiredNozzle: zoneRequiredNozzle(zone.label)
      })),
      nozzleDemands: demandingInstances.map((instance) => instanceNozzlesRef.current(instance)),
      primeTower: tower && towerCenter
        ? {
            centerX: towerCenter.x,
            centerY: towerCenter.y,
            width: typeof tower.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0,
            depth: typeof tower.userData.towerDepth === 'number' ? tower.userData.towerDepth : 0
          }
        : null,
      rasterizePolygon: rasterizePolygonCells
    })
  }, [])

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
    // A locked plate keeps its layout. Mirrors BambuStudio, whose arrange skips every object on a
    // locked plate (`PartPlate.cpp:6046`). The toolbar button is disabled too, so this guard is
    // belt-and-braces rather than the only stop: it keeps the rule with the operation, where a
    // future caller (a shortcut, a context-menu item, a batch action) will find it.
    if (plate.locked) return
    const items: Array<{ key: string; cells: number[] }> = []
    for (const instance of plate.instances) {
      const group = groupByKeyRef.current.get(instance.key)
      if (!group) continue
      const cells = computeFootprintCells(group)
      if (cells.size === 0) continue
      items.push({ key: instance.key, cells: [...cells] })
    }
    if (items.length === 0) return

    // Every object on the plate moves, so every object's nozzle reach constrains the usable area.
    const obstacles = plateObstaclesFor(plate, plate.instances)
    const result = arrangePlateItems(items, {
      bed: obstacles.safeArea,
      blockedCells: obstacles.blockedCells,
      spacingMm: PLATE_PACKING_GAP_MM
    })
    if (result.moves.size === 0) {
      toast.error('No room to arrange the objects on this plate.')
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
    }), 'transform')
    if (result.unplaced.length > 0) {
      toast.error(`${result.unplaced.length} model${result.unplaced.length === 1 ? '' : 's'} did not fit and stayed in place.`)
    }
  }, [activePlateIndex, updatePlates, plateObstaclesFor])

  /**
   * BambuStudio's "Fill bed with copies" (`FillBedJob`): fill the plate's remaining space with
   * copies of the selected object, packing centre-out around whatever is already there. Nothing
   * already placed moves: this ADDS to a layout rather than redoing it, which is what separates
   * it from Auto-arrange.
   *
   * We deliberately diverge from Studio on ONE point: its `ap.setter` calls `Model::add_object`,
   * so every copy is a whole new object and each one carries its own duplicate of the source's
   * per-object process overrides; edit the original afterwards and the copies do not follow.
   * Ours adds linked INSTANCES against the same `objectId` (the `Duplicate` path), so all copies
   * share one object's parts, materials, paint and overrides, and the sidebar's `xN` badge makes
   * the linkage visible. That is issue #89's "add instances" note, and it is also why the copies
   * cost nothing extra in the saved 3MF: they are extra build items, not extra meshes.
   */
  const handleFillBedWithCopies = useCallback((key: string) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const template = plate?.instances.find((entry) => entry.key === key)
    if (!plate || !template) return
    // A locked plate keeps its layout, and that has to mean every AUTOMATIC placement, not just
    // Auto-arrange: filling the bed drops new copies onto it, which is the same promise broken.
    if (plate.locked) {
      toast.error('This plate is locked. Unlock it in plate settings to fill it with copies.')
      return
    }
    const templateGroup = groupByKeyRef.current.get(template.key)
    const templateFootprint = templateGroup ? computeFootprintCells(templateGroup) : null
    if (!templateFootprint || templateFootprint.size === 0) {
      toast.error('That model has no printable footprint to copy.')
      return
    }

    // Everything on the plate holds its ground, so every footprint is an obstacle: the template's
    // own instance included, or the first copy would be planned on top of it.
    const occupiedFootprints: number[][] = []
    for (const instance of plate.instances) {
      const group = groupByKeyRef.current.get(instance.key)
      if (!group) continue
      const cells = computeFootprintCells(group)
      if (cells.size > 0) occupiedFootprints.push([...cells])
    }

    // Only the copied object's reach constrains the area: the objects already down are staying put
    // whatever their materials need.
    const obstacles = plateObstaclesFor(plate, [template])
    const offsets = planFillBedCopies({
      bed: obstacles.safeArea,
      blockedCells: obstacles.blockedCells,
      spacingMm: PLATE_PACKING_GAP_MM,
      templateFootprint: [...templateFootprint],
      occupiedFootprints
    })
    if (offsets.length === 0) {
      toast.error('No room on this plate for another copy.')
      return
    }

    updatePlates((plates) => plates.map((entry) => {
      if (entry.index !== activePlateIndex) return entry
      const source = entry.instances.find((instance) => instance.key === template.key)
      if (!source) return entry
      const copies = offsets.map((offset) => {
        const clone = duplicateInstance(source)
        // `duplicateInstance` nudges its copy clear of the source; the planner already decided
        // where this one goes, so place it outright rather than composing with that nudge.
        // Through `placeInstanceAt`, because a copy KEEPS a sheared object's exact matrix (that
        // matrix is what renders and saves, so dropping it would reshape the copy) and the matrix
        // carries the translation `position` only mirrors.
        placeInstanceAt(clone, source.position.x + offset.dx, source.position.y + offset.dy)
        return clone
      })
      return { ...entry, instances: [...entry.instances, ...copies] }
      // A 'structure' edit (the default): the copies are NEW instances with no live group yet, so
      // they need the full rebuild. The cheaper 'transform' sync only writes placements onto groups
      // that already exist, which would leave every copy invisible until some later rebuild.
    }))
    toast.success(`Added ${offsets.length} cop${offsets.length === 1 ? 'y' : 'ies'} to fill the plate.`)
  }, [activePlateIndex, updatePlates, plateObstaclesFor])

  const handleDropToBed = useCallback(() => {
    if (!selectedKey) return
    const group = groupByKeyRef.current.get(selectedKey)
    if (!group) return
    // Measured with `printableMeshBox`, like every other resting path (the gizmo drop, lay-flat,
    // align, `mutateSelectedGroup`), NOT a raw `Box3.setFromObject`: that counted the viewport aids.
    // A brim-ear marker sits at world z=0, so its box floor was already 0 and Drop to bed did
    // nothing at all on any object carrying an ear; a helper volume hanging below the body made it
    // LIFT the object off the plate instead.
    if (printableMeshBox(group).isEmpty()) return
    recordHistory()
    bakeExactMatrix(group)
    restObjectOnBed(group)
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
    // BambuStudio refuses this on a locked plate with a notification of its own
    // (`OrientJob.cpp:113-117`), and so must we: the lock's copy promises the plate's models stay
    // where they are, and a lock that stops one of three automatic placement tools is worse than
    // none, because the user has been told otherwise.
    const activePlate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (activePlate?.locked) {
      toast.error('This plate is locked. Unlock it in plate settings to auto-orient.')
      return
    }
    const group = groupByKeyRef.current.get(selectedKey)
    if (!group) return
    const normal = largestHullFaceNormal(group)
    if (!normal) return
    mutateSelectedGroup((target) => {
      rotorOf(target).quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(normal, DOWN_VECTOR))
    })
  }, [activePlateIndex, selectedKey, mutateSelectedGroup])

  /**
   * Apply a mutation to EVERY selected object as ONE undo step.
   *
   * The multi-selection sibling of {@link mutateSelectedGroup}, which reads `selectedKeyRef` alone
   * and so silently ignores the rest of a multi-selection. Resting on the bed is the CALLER's
   * choice here rather than automatic: an action that moves a body in Z deliberately (Align top,
   * Align front-back centre) would be undone on the spot by a re-floor, which is exactly what
   * routing such an action through `mutateSelectedGroup` does.
   *
   * `mutate` receives each group already baked to an exact matrix, and runs in selection order with
   * the primary first. It must not add or remove instances: structural edits belong in
   * `updatePlates`, which records its own history.
   */
  const mutateSelection = useCallback((
    mutate: (group: THREE.Group, key: string) => void,
    options: { restOnBed?: boolean } = {}
  ) => {
    const keys = allSelectedKeysRef.current()
    if (keys.length === 0) return
    recordHistory()
    for (const key of keys) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      bakeExactMatrix(group)
      mutate(group, key)
      if (options.restOnBed) restObjectOnBed(group)
      writeBackGroupTransform(group)
    }
    const primary = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
    if (primary) syncSelectedTransform(primary)
    regenerateActivePlateThumbnail()
  }, [recordHistory, bakeExactMatrix, writeBackGroupTransform, syncSelectedTransform, regenerateActivePlateThumbnail])

  /**
   * BambuStudio's "Convert from inch" / "Convert from meter" (`ModelObject::convert_units`,
   * `Model.cpp:1868`): a CAD export whose author worked in another unit arrives 25.4x or 1000x too
   * small, which is not an error anywhere, just a model the user has to notice. Applied to every
   * selected object, as Studio's does (it iterates the whole selection's object indexes).
   *
   * TWO DELIBERATE DIVERGENCES.
   *
   * We scale the instance's TRANSFORM where Studio rewrites the mesh's vertices
   * (`scale_geometry_after_creation`). The rendered result and the baked file agree either way, and
   * a transform edit is undoable and keeps paint on the facets it was painted on; rewriting the
   * geometry would have to stage a replacement import and lose them.
   *
   * We also grow each object IN PLACE rather than multiplying its offset by the same factor as
   * Studio does. Studio can afford to fling the object away because `convert_unit` immediately
   * removes and re-loads it through `load_model_objects`, which places it again; we have no such
   * reload, so the equivalent behaviour is to keep it where the user can see it.
   *
   * Studio's inverse items ("Restore to inch"/"Restore to meter") are deliberately not offered: it
   * gates them on each volume's `source.is_converted_from_inches`, a provenance flag we do not
   * carry, and an always-available inverse would let a user shrink an unconverted model 25.4x with
   * nothing to warn them. Undo is our exact inverse.
   */
  const handleConvertUnits = useCallback((unit: ConvertibleModelUnit) => {
    const factor = MODEL_UNIT_MILLIMETRES[unit]
    if (!factor || factor === 1) return
    mutateSelection((group) => { scaleGroupAboutPoint(group, factor) })
  }, [mutateSelection])

  /**
   * BambuStudio's Align/Distribute (`GLGizmoAlignment.cpp`), applied to the object selection.
   *
   * The arithmetic lives in `lib/alignDistribute.ts`; this only measures each member and applies
   * what comes back. Measurement is the world PRINTABLE box, the same one resting and the
   * placement warnings use, so an object lines up by the geometry that actually prints rather than
   * by its local origin (which is wherever the file's exporter left it) or by a helper volume
   * hanging off its side.
   *
   * Deliberately NOT routed through `mutateSelectedGroup`: that one is single-selection and
   * re-rests every object on the bed, which would silently undo Align top and Align top-bottom
   * centre the instant they ran. Z alignment lifts bodies off the plate on purpose here, exactly
   * as Studio's does; `Drop to bed` is how a user puts them back.
   */
  const applyAlignDistribute = useCallback((operation: AlignDistributeOperation) => {
    const keys = allSelectedKeysRef.current()
    const members: AlignMember[] = []
    for (const key of keys) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      const box = printableMeshBox(group)
      if (box.isEmpty()) continue
      members.push({ key, min: box.min[operation.axis], max: box.max[operation.axis] })
    }
    if (members.length < minimumMembersFor(operation)) return
    const offsets = operation.mode ? alignOffsets(members, operation.mode) : distributeOffsets(members)
    if (offsets.size === 0) return
    mutateSelection((group, key) => {
      const delta = offsets.get(key)
      if (delta) group.position[operation.axis] += delta
    })
  }, [mutateSelection])

  /**
   * BambuStudio's "Scale to print volume" (`Selection::scale_to_fit_print_volume`,
   * `Selection.cpp:1576`): grow or shrink the selection by ONE uniform factor so it fits the
   * machine, then land it on the plate.
   *
   * The factor is Studio's: `min(sx, sy, sz)` over the print volume divided by the selection's
   * combined box, with its 0.02mm pad on X and Y only (`:1659-1667`). HEIGHT IS PART OF IT --
   * dropping `sz` is what makes a "scale to print volume" that produces a model taller than the
   * printer, which is why the bed's `maxZ` had to be plumbed through the scene before this could
   * be written honestly. A bed that states no height REFUSES rather than fitting XY and calling it
   * done: the answer would be wrong in exactly the direction the user cannot see.
   *
   * Applied about the plate centre, matching Studio's re-centre after the scale, and every member
   * moves by the same factor about that one point so a multi-selection keeps its relative layout.
   */
  const handleScaleToPrintVolume = useCallback(() => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    if (plate.bed.maxZ == null) {
      toast.error('This project does not say how tall the printer is, so it cannot be scaled to the print volume.')
      return
    }
    const keys = allSelectedKeysRef.current()
    const box = new THREE.Box3()
    for (const key of keys) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      const groupBox = printableMeshBox(group)
      if (!groupBox.isEmpty()) box.union(groupBox)
    }
    if (box.isEmpty()) return

    const size = box.getSize(new THREE.Vector3())
    // Studio's pad, and its axes: 1/100th of a mm on both XY sides, nothing on Z.
    const factor = Math.min(
      (plate.bed.maxX - plate.bed.minX) / (size.x + 0.02),
      (plate.bed.maxY - plate.bed.minY) / (size.y + 0.02),
      plate.bed.maxZ / size.z
    )
    // Studio aborts on `s <= 0.0 || s == 1.0` rather than writing a no-op transform.
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return

    // Studio scales the selection JOINTLY about its own centre and then translates the whole thing
    // onto the print volume's centre. So each member's new centre is the plate centre plus its own
    // offset from the selection centre, scaled: pinning every member to one point instead would
    // stack a multi-selection into a single pile.
    const selectionCentre = box.getCenter(new THREE.Vector3())
    const plateCentre = { x: (plate.bed.minX + plate.bed.maxX) / 2, y: (plate.bed.minY + plate.bed.maxY) / 2 }
    mutateSelection((group) => {
      const centre = printableMeshBox(group).getCenter(new THREE.Vector3())
      scaleGroupAboutPoint(group, factor, {
        x: plateCentre.x + (centre.x - selectionCentre.x) * factor,
        y: plateCentre.y + (centre.y - selectionCentre.y) * factor
      })
    })
  }, [activePlateIndex, mutateSelection])

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

  /**
   * Centre the selection on the active plate: BambuStudio's "Center" (`Selection::center`), which
   * moves the WHOLE selection by one delta computed from its combined bounding box, so the objects
   * keep their relative layout. Centring each object on its own would stack them all on one spot,
   * which is why this is a selection-level action rather than a per-object one repeated N times.
   *
   * The delta is measured from the rendered FOOTPRINT, never by assigning the plate centre to
   * `position`: that field is the transform's translation (the object's local origin) and a Bambu
   * mesh routinely carries plate coordinates in its vertices, so assigning there displaces the
   * model by its whole origin-to-centroid offset, the same trap the single-object 3MF export hit.
   * Z is untouched: centring is a bed-plane operation, and resting is `Drop to bed`'s job.
   */
  const centerSelectionOnPlate = useCallback(() => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    const box = new THREE.Box3()
    for (const key of allSelectedKeysRef.current()) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      const groupBox = printableMeshBox(group)
      if (!groupBox.isEmpty()) box.union(groupBox)
    }
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    nudgeSelection(
      (plate.bed.minX + plate.bed.maxX) / 2 - center.x,
      (plate.bed.minY + plate.bed.maxY) / 2 - center.y
    )
  }, [activePlateIndex, nudgeSelection])

  /** The scene object of the part currently holding the gizmo (added mesh or baked part group). */
  const selectedPartObject = useCallback((): THREE.Object3D | null => {
    const key = selectedKeyRef.current
    const group = key ? groupByKeyRef.current.get(key) : null
    if (!group) return null
    const gizmo = gizmoPartRef.current
    if (!gizmo) return null
    const member = gizmo.member
    // The body is the object's own geometry, so its "part placement" IS the object's.
    if (member.kind === 'body') return group
    let found: THREE.Object3D | null = null
    group.traverse((node) => {
      if (found) return
      if (member.kind === 'added') {
        if (node.userData.addedPartKey === member.key) found = node
        return
      }
      const ref = partGroupRef(node)
      if (ref && ref.partIndex === member.partIndex) found = node
    })
    return found
  }, [])

  /**
   * Apply a manual-input edit to the selected PART's object-local placement (BambuStudio's
   * "Volume Operations" panel semantics): decompose the effective placement, let the
   * mutator adjust it, then persist, an added part carries TRS directly, a baked part
   * gets the recomposed delta on its part group (which writeBackBakedPart then bakes into
   * state and mirrors onto the other instances). Returns false when no part is selected.
   */
  const mutateSelectedPart = useCallback((mutate: (trs: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }) => void): boolean => {
    // The BODY has no placement of its own -- the instance's placement IS where its geometry sits --
    // so it is not handled here, and saying so lets the caller fall through to the OBJECT path,
    // which is the correct write-back for it and is what the gizmo already does. Reporting "handled"
    // instead (which is what the missing-mesh guard below did, since an instance group's only child
    // is the rotor) blocked that fallback: the manual position/rotation/scale inputs, the arrow-key
    // nudge and `[`/`]` all did nothing on a selected body, each attempt still burning an undo entry.
    if (gizmoPartRef.current?.member.kind === 'body') return false
    const part = selectedPartObject()
    if (!part) return false
    recordHistory()
    if (typeof part.userData.addedPartKey === 'string') {
      mutate({ position: part.position, rotation: part.rotation as THREE.Euler, scale: part.scale })
      writeBackAddedPart(part)
    } else {
      const mesh = part.children.find((child) => (child as THREE.Mesh).isMesh === true)
      if (!mesh) return true
      part.updateMatrix()
      mesh.updateMatrix()
      const effective = new THREE.Matrix4().multiplyMatrices(part.matrix, mesh.matrix)
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      effective.decompose(position, quaternion, scale)
      const rotation = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ')
      mutate({ position, rotation, scale })
      const desired = new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), scale)
      const delta = desired.multiply(mesh.matrix.clone().invert())
      delta.decompose(part.position, part.quaternion, part.scale)
      writeBackBakedPart(part)
    }
    syncSelectedTransform(part)
    regenerateActivePlateThumbnail()
    return true
  }, [selectedPartObject, recordHistory, writeBackAddedPart, writeBackBakedPart, syncSelectedTransform, regenerateActivePlateThumbnail])

  const applyManualPosition = useCallback((axis: 'x' | 'y' | 'z', value: number) => {
    if (!Number.isFinite(value)) return
    if (mutateSelectedPart(({ position }) => { position[axis] = value })) return
    mutateSelectedGroup((group) => { group.position[axis] = value })
  }, [mutateSelectedPart, mutateSelectedGroup])

  const applyManualRotation = useCallback((axis: 'x' | 'y' | 'z', degrees: number) => {
    if (!Number.isFinite(degrees)) return
    if (mutateSelectedPart(({ rotation }) => { rotation[axis] = THREE.MathUtils.degToRad(degrees) })) return
    mutateSelectedGroup((group) => { rotorOf(group).rotation[axis] = THREE.MathUtils.degToRad(degrees) })
  }, [mutateSelectedPart, mutateSelectedGroup])

  const applyManualScale = useCallback((axis: 'x' | 'y' | 'z', percent: number) => {
    if (!Number.isFinite(percent) || percent <= 0) return
    const factor = percent / 100
    const scaleAxes = (scale: THREE.Vector3) => {
      if (uniformScale) scale.set(factor, factor, factor)
      else scale[axis] = factor
    }
    if (mutateSelectedPart(({ scale }) => scaleAxes(scale))) return
    mutateSelectedGroup((group) => scaleAxes(group.scale))
  }, [mutateSelectedPart, mutateSelectedGroup, uniformScale])

  // ---- Keyboard transforms ---------------------------------------------------
  // Arrow keys nudge X/Y on the bed (Shift = coarse, Ctrl/Cmd = fine) and [ / ] rotate about Z.
  // ONLY the transform keys: undo/redo, delete, copy/paste and the rest belong to
  // `useEditorKeyboardShortcuts`, which owns the editor's one shortcut listener. Handling a key
  // here as well does not shadow that one, both listeners run, so a duplicate silently performs
  // the action TWICE (Ctrl+Z used to undo two steps). Add new shortcuts to the hook, not here.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        return
      }

      const key = selectedKeyRef.current
      if (!key) return

      const step = event.shiftKey ? KEY_MOVE_STEP_LARGE : (event.ctrlKey || event.metaKey) ? KEY_MOVE_STEP_FINE : KEY_MOVE_STEP
      // With a part on the gizmo, arrows/rotate act on the PART (BambuStudio moves the
      // selected volume); otherwise on the object selection.
      const nudge = (dx: number, dy: number) => {
        // Arrow keys move along the PLATE axes. A part's position is OBJECT-LOCAL, so the world
        // delta has to be rotated (and unscaled) into the object's frame first, otherwise a
        // rotated object sends its part the opposite way (press right, the part goes left) and a
        // scaled one moves it by the wrong distance. Objects below take the delta as-is.
        const part = selectedPartObject()
        if (part) {
          const rotor = part.parent
          rotor?.updateWorldMatrix(true, false)
          const local = rotor
            ? plateDeltaToPartLocal(rotor.matrixWorld, dx, dy)
            : new THREE.Vector3(dx, dy, 0)
          if (mutateSelectedPart(({ position }) => { position.add(local) })) return
        }
        nudgeSelection(dx, dy)
      }
      const rotateZ = (radians: number) => {
        if (mutateSelectedPart(({ rotation }) => { rotation.z += radians })) return
        mutateSelectedGroup((group) => { rotorOf(group).rotation.z += radians })
      }
      switch (event.key) {
        case 'ArrowLeft':
          nudge(-step, 0); break
        case 'ArrowRight':
          nudge(step, 0); break
        case 'ArrowUp':
          nudge(0, step); break
        case 'ArrowDown':
          nudge(0, -step); break
        case '[':
          rotateZ(KEY_ROTATE_STEP); break
        case ']':
          rotateZ(-KEY_ROTATE_STEP); break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mutateSelectedGroup, mutateSelectedPart, selectedPartObject, nudgeSelection])

  const handleAddPlate = useCallback(() => {
    // Compute the new (contiguous) index and mint the identity from current state, NOT inside the
    // setState updater: React runs the updater later (and may run it twice), so reading a var it
    // mutates would select the wrong plate, and minting inside would burn ids per invocation.
    const newIndex = (stateRef.current?.plates.length ?? 0) + 1
    const plateId = mintPlateId()
    updatePlates((plates) => {
      const template = plates[plates.length - 1]
      const bed = template ? { ...template.bed } : { minX: -128, maxX: 128, minY: -128, maxY: 128, maxZ: null, excludeAreas: [] }
      // The BED is copied from the last plate (every plate in a project shares one printer bed), but
      // its SETTINGS are not: a new plate inherits the project's, as BambuStudio's does. Copying the
      // template's overrides would silently spread one plate's bed type across the project.
      return reindexPlates([
        ...plates,
        { index: plates.length + 1, plateId, sourcePlateIndex: null, name: null, ...INHERITED_PLATE_SETTINGS, bed, instances: [], primeTower: null }
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
    if (!plate) return
    // Start from the label the strip shows, an unnamed plate reads as "Plate N", so that is the
    // name the user is editing, and the prompt pre-selects it for overtyping.
    const name = await promptText({
      title: `Rename plate ${index}`,
      label: 'Plate name',
      placeholder: defaultPlateName(index),
      initialValue: plateDisplayName(plate.name, index),
      confirmLabel: 'Rename'
    })
    if (name === null) return
    const nextName = resolvePlateRename(name, index)
    if (nextName === (plate.name?.trim() || null)) return
    // Plate name shows only in the plate strip (React), not the 3D viewport ('inert').
    updatePlates((plates) => plates.map((entry) => entry.index === index ? { ...entry, name: nextName } : entry), 'inert')
  }, [promptText, updatePlates])

  /**
   * Apply the per-plate settings dialog's draft.
   *
   * 'inert' like the rename: none of these move geometry, so the viewport has nothing to rebuild.
   * The bed type does change what the plate PRINTS on rather than how it looks here, which is why
   * it still takes a history checkpoint.
   */
  const handleApplyPlateSettings = useCallback((plateId: number, settings: PlateSettingsDraft) => {
    updatePlates(
      (plates) => plates.map((entry) => entry.plateId === plateId ? { ...entry, ...settings } : entry),
      'inert'
    )
    setPlateSettingsId(null)
  }, [updatePlates])

  /**
   * Move a plate into an insertion gap (0-based, 0 = before the first plate): the strip's
   * between-tile drop zones. Thumbnail caches need no remapping here: they key on the plates'
   * session identity (`plateId`), so any renumbering path is covered by construction.
   */
  const handleReorderPlate = useCallback((fromIndex: number, insertAt: number) => {
    // Compute the landing position from current state (not inside the updater: see
    // handleAddPlate) so a no-op drop skips the history checkpoint and scene rebuild entirely.
    const plates = stateRef.current?.plates ?? []
    const from = plates.findIndex((plate) => plate.index === fromIndex)
    if (from < 0) return
    const gap = Math.max(0, Math.min(plates.length, insertAt))
    const target = gap > from ? gap - 1 : gap
    if (target === from) return
    updatePlates((current) => movePlate(current, fromIndex, insertAt))
    // Keep viewing the plate that was dragged (it now sits at the drop position).
    setActivePlateIndex(target + 1)
  }, [updatePlates])

  /**
   * Drag-reorder an OBJECT in the sidebar (BambuStudio's ObjectList drag).
   *
   * A real edit, not a view preference: the bake writes build items in this order and BambuStudio
   * builds its object list by walking them, so the order set here is the order the file shows
   * everywhere. It records undo history and marks the project dirty like any other change.
   *
   * It moves an OBJECT, carrying every linked copy on every plate, and it goes through the whole
   * STATE rather than the active plate, because the file has ONE object order: the bake flattens
   * every plate into one build section. Addressed by object identity, not position, since the
   * sidebar lists only the instances that have finished rendering (see `listedInstances`).
   *
   * Like {@link handleReorderPart} it sets state directly instead of going through `updatePlates`:
   * no geometry moves, so there is no rebuild to schedule, and `activeInstanceKeys` is a signature
   * of the instance SET so the build effect does not fire either.
   */
  const handleReorderObject = useCallback((hostId: number, beforeHostId: number | null) => {
    const current = stateRef.current
    if (!current) return
    const next = moveObjectBefore(current, hostId, beforeHostId)
    if (next === current) return
    recordHistory()
    setState(next)
  }, [recordHistory, stateRef])

  /**
   * Drag-reorder a PART inside its object (BambuStudio's volume drag).
   *
   * Applies to every copy of the object on every plate, because part order is geometry-level like
   * every other part seam, so this goes through the whole state rather than the active plate. It
   * needs no rebuild token: the parts keep their transforms, so nothing in the viewport moves and
   * only the sidebar's order changes.
   */
  const handleReorderPart = useCallback((hostId: number, partIndex: number, beforePartIndex: number | null) => {
    const current = stateRef.current
    if (!current) return
    const next = movePartBefore(current, hostId, partIndex, beforePartIndex)
    if (next === current) return
    recordHistory()
    setState(next)
  }, [recordHistory, stateRef])

  // Bake the controller's desired filament list (Bambu-style add/remove of materials) and its
  // chosen plate type into every SceneEdit the editor emits, so both save and slice carry them.
  // The Settings tab's selector is the project-global plate type (BambuStudio's `curr_bed_type`),
  // so it rides at the TOP LEVEL and each plate carries only its own override. It is also what
  // tells the bake this client distinguishes the two at all; stamping it onto every plate, as this
  // did before per-plate bed types, would save the global as N overrides that then outlive it.
  const buildSceneEditOut = useCallback((current: EditorState, options?: { thumbnails?: Array<{ plateIndex: number; png: string }> }): SceneEdit => {
    const base = buildSceneEdit(current)
    const plateType = sliceConfig?.plateType.trim()
    // ALWAYS carries the key, null when there is no global to state: its PRESENCE is what tells the
    // bake this client authors per-plate bed types. Spreading it only when truthy meant an unseeded
    // machine target produced an edit that read as pre-per-plate, which deletes every plate's own
    // bed type and promotes the first plate's override to the project-wide value.
    const withPlateType = { ...base, plateType: plateType || null }
    // Annotated, not inferred: the literal above narrows `plateType` to `string | null`, and under
    // `exactOptionalPropertyTypes` the rebase's `SceneEdit` return then will not assign back into it.
    let withFilaments: SceneEdit = sliceConfig?.desiredFilaments ? { ...withPlateType, filaments: sliceConfig.desiredFilaments } : withPlateType
    // The desired list bakes as slots 1..N, so a session that removed/reordered materials
    // renumbers every filament id: translate the edit's SESSION ids to match, or the bake writes
    // stale ids into the file (a part `extruder="2"` in a 1-filament project). No-op (null remap)
    // while the session ids already equal their positions, the common case.
    if (sliceConfig?.desiredFilaments && sliceConfig.projectFilaments.length > 0) {
      const remap = buildSessionFilamentIdRemap(sliceConfig.projectFilaments.map((filament) => filament.projectFilamentId))
      if (remap) withFilaments = rebaseSceneEditFilamentIds(withFilaments, remap)
    }
    // Attach freshly-captured plate previews (when provided) so the saved 3MF / sliced output's
    // thumbnail reflects the edited layout: the slicer CLI and the 3MF rewriter both reuse the
    // embedded PNG rather than regenerating it. Callers capture via captureAllPlateThumbnails().
    const thumbnails = options?.thumbnails
    return thumbnails && thumbnails.length > 0 ? { ...withFilaments, plateThumbnails: thumbnails } : withFilaments
  }, [sliceConfig])

  /**
   * The rendered XY footprint centre of an instance in PLATE coordinates, helper volumes excluded
   * (`printableMeshBox`'s rule, and BambuStudio's: `instance_bounding_box` is "without
   * modifiers"). Null when the instance has no group in the live scene, e.g. it sits on a
   * non-active plate. Only this component can answer it, so the save hook takes it as a callback.
   */
  const worldFootprintCenterFor = useCallback((key: string): { x: number; y: number } | null => {
    const group = groupByKeyRef.current.get(key)
    if (!group) return null
    const box = printableMeshBox(group)
    if (box.isEmpty()) return null
    const center = box.getCenter(new THREE.Vector3())
    return { x: center.x, y: center.y }
  }, [])
  worldFootprintCenterForRef.current = worldFootprintCenterFor

  // The save baked the session's filament ids renumbered to 1..N; move the live state onto the
  // saved ids so mesh colours keep resolving and the next save starts from a consistent space.
  // Plain setState on purpose: an id-space migration is a representation change, not a user edit:
  // updatePlates would record it as an undoable history step. The sync-token bump recolours the
  // already-rendered meshes from their translated ids.
  const handleFilamentsRenumbered = useCallback((remap: Map<number, number>) => {
    setState((current) => (current ? rebaseEditorStateFilamentIds(current, remap) : current))
    // Deliberately NOT recolouring yet. The state moves into the SAVED id space here, but
    // `materials.options` still describes the pre-save SESSION space until the controller finishes
    // its own rebase, and `resolveColorFilamentId` reads a part whose id is absent from those
    // options as a reference to a DELETED material, resolving it to material 1. That rule is right;
    // it just cannot tell "deleted" from "renumbered a moment ago", so recolouring in this gap
    // repainted the whole model in material 1's colour. Which is the "model reverts to its original
    // colour on Save" report: display-only, since the saved file and the state are both correct.
    // Record what to wait for instead; the effect below recolours once the options catch up.
    pendingRenumberIdsRef.current = [...new Set(remap.values())]
  }, [])

  // Second half of the renumber: recolour only once `materials.options` actually contains the saved
  // ids, so the resolve above agrees with the state. Waiting risks nothing, until it fires the
  // meshes keep their pre-save colours, which are the RIGHT colours; the bug was painting early.
  useEffect(() => {
    const pending = pendingRenumberIdsRef.current
    if (!pending) return
    const available = new Set(materials.options.map((option) => option.id))
    if (!pending.every((id) => available.has(id))) return
    pendingRenumberIdsRef.current = null
    setMaterialSyncToken((token) => token + 1)
  }, [materials])

  // Resolve each slot's preset in the BROWSER and attach it to the edit: the editor authors what
  // it emits. A slot the "missing material settings" repair already resolved this session wins:
  // that repair is an undoable edit whose whole content is those configs, so re-resolving here
  // could quietly emit something other than what the user accepted (and repeats work already done).
  // Shared by the SAVE and SLICE paths on purpose: a slice's bake takes the same material-change
  // drop path as a save's (`applyFilamentList`), so a slice that omitted the configs handed the
  // slicer a project stripped of its filament physics and leaned on the settings-repair export,
  // which cannot run when the slice loads a machine preset without a process preset (exit 239).
  const authorFilamentConfigs = useCallback(async (edit: SceneEdit) => {
    // The edit's filaments are the session slots in list order, so slot i+1 of the bake is
    // projectFilaments[i], but the controller and the physics repair key their records by SESSION
    // id, which drifts from position after a mid-session remove or reorder. Re-key both records
    // into the baked slot space here, at the one boundary that knows the current order; passing
    // them through raw is what once resolved one slot's preset from another slot's pick.
    const controller = sliceConfigRef.current
    const orderedSessionIds = (controller?.projectFilaments ?? []).map((filament) => filament.projectFilamentId)
    const profileIdBySessionId = Object.fromEntries(Object.entries(controller?.filamentMaterialOptionIds ?? {}).map(
      ([filamentId, optionId]) => [filamentId, controller?.materialOptions.find((option) => option.id === optionId)?.profileId ?? undefined]
    ))
    return attachResolvedFilamentConfigs(
      applyRepairedFilamentConfigs(edit, rekeyByBakedSlot(stateRef.current?.repairedFilamentConfigs, orderedSessionIds)),
      resolveFilamentConfig,
      {
        targetId: controller?.selectedSlicerTargetId ?? null,
        sourceFileId: baseFileId ?? null,
        profileIdByFilamentId: rekeyByBakedSlot(profileIdBySessionId, orderedSessionIds)
      }
    )
  }, [resolveFilamentConfig, stateRef, sliceConfigRef, baseFileId])

  const {
    savedFile,
    contentBase,
    stageSnapshotFor,
    saving,
    saveAsOpen,
    setSaveAsOpen,
    handleApply,
    handleCloseRequest,
    handleSaveVersion,
    handleSaveAs,
    handleExportObjectAs3mf,
    handleExportObjectAs3mfDownload
  } = useEditorSave({
    stateRef,
    sliceConfigRef,
    dirtyRef,
    markSaved,
    buildSceneEditOut,
    authorFilamentConfigs,
    captureAllPlateThumbnails,
    worldFootprintCenterFor,
    // Only meaningful for a session on the file's HEAD: editing an archived version means the head
    // has already moved, so a "changed since you opened it" warning would fire every time.
    openedVersionNumber: baseVersionId ? null : baseFileQuery.data?.file.currentVersionNumber ?? null,
    baseFileId,
    baseVersionId,
    saveAsBridgeId,
    editorBorn: isNewProject,
    onApply,
    onSaved,
    onSavedAs,
    onClose,
    confirm,
    saveTarget: effectiveSaveTarget,
    // The material gate reads the slice controller by default, which a host without one does not
    // have; answer from the materials seam instead or every local save is rejected.
    hasMaterials: () => materials.options.length > 0,
    onFilamentsRenumbered: handleFilamentsRenumbered,
    onFilamentSourcesRemapped: (sourceRemap) => rebaseHistoryFilamentSourcesRef.current(sourceRemap)
  })
  /**
   * Slice the given plate (0 = all plates).
   *
   * Owns the Slice button's busy state for the window the HOST cannot see: capturing every plate's
   * thumbnail and building the SceneEdit are seconds of main-thread work that run BEFORE `onSlice`
   * is called, and the host's `slicing` flag only turns on after that. Without this the button sat
   * inert long enough that users clicked it again. Stays true until the host takes over (its
   * `slicing` prop arrives), so there is no gap between the two spinners.
   */
  const [preparingSlice, setPreparingSlice] = useState(false)
  const slicing = slicingProp || preparingSlice
  useEffect(() => {
    if (slicingProp) setPreparingSlice(false)
  }, [slicingProp])
  const startSlice = useCallback((plate: number) => {
    const current = stateRef.current
    if (!current || !onSlice) return
    setPreparingSlice(true)
    void (async () => {
      try {
        await afterNextPaint()
        const thumbnails = await captureAllPlateThumbnails(current)
        const sceneEdit = await authorFilamentConfigs(buildSceneEditOut(current, { thumbnails }))
        // Baked and staged HERE rather than server-side from the edit: the browser holds the bytes
        // this session opened, so the base cannot be resolved wrongly. Hidden and content-deduped,
        // so the user's project gains no version and nothing appears in their library.
        const stagedFileId = await stageSnapshotFor(sceneEdit)
        onSlice({ plate, sceneEdit, contentBase, stagedFileId })
      } catch (error) {
        // Rethrowing here would only become an unhandled rejection: the console sees it but the
        // /api/logs buffer (which captures console.*) does not, and the user is left staring at a
        // spinner that never resolves because `onSlice` was never reached.
        setPreparingSlice(false)
        console.error('[editor] preparing the slice failed', error)
        toast.error(extractErrorMessage(error, 'Could not prepare the slice.'))
      }
    })()
  }, [onSlice, captureAllPlateThumbnails, buildSceneEditOut, authorFilamentConfigs, stateRef, contentBase, stageSnapshotFor])

  // Once an editor-born project has been saved it is a real library file, so it stops presenting
  // as "New Project" and gains the ordinary Save-version path, without the editor re-mounting.
  const savedAsProject = savedFile !== null
  const showAsNewProject = isNewProject && !savedAsProject
  /** In-flight / failed state for the "missing material settings" repair below. */
  const [repairingPhysics, setRepairingPhysics] = useState(false)
  const [physicsRepairError, setPhysicsRepairError] = useState<string | null>(null)
  /**
   * The repair error describes the LAST attempt against the state it ran on. Any later change to
   * the session, an edit, an undo, a redo, invalidates that context, and a lingering
   * "couldn't repair" over a state it no longer describes reads as a fresh failure (observed: an
   * undo of a mixed repair left the error title up over a state whose staged half was gone). The
   * ordering keeps the message alive through its own attempt: a mixed attempt's staging setState
   * commits (this clears nothing: the error isn't set yet) before the async physics miss sets it.
   */
  useEffect(() => {
    setPhysicsRepairError(null)
  }, [state])
  /**
   * A repair belongs to the PROJECT it was run against. This editor is not remounted when the host
   * opens a different file (the public editor's close-and-choose flow reuses it), so without this the
   * pin, and the banner suppression that reads it, carried into the next project: a still-defective
   * file opened showing no warning, which read as "the repair worked". It is also how a save that
   * silently restored nothing looked like a success.
   */
  useEffect(() => {
    setPhysicsRepairError(null)
    setState((prev) => (prev?.repairedFilamentConfigs || prev?.settingsRepairStaged
      ? { ...prev, repairedFilamentConfigs: undefined, settingsRepairStaged: undefined }
      : prev))
  }, [projectSource, baseFileId])
  /**
   * Recover the project's dropped filament physics as an UNDOABLE EDIT.
   *
   * Resolves every slot's preset now and pins the results in `EditorState.repairedFilamentConfigs`,
   * which the next save bakes into the file. Deliberately NOT a save of its own: writing the user's
   * file from a notice is surprising (on a local project it prompts for a destination), and an edit
   * that lights up Save is what every other change in this editor does.
   *
   * ALL SLOTS OR NONE. The arrays this feeds are positional, so a partial resolve cannot be written
   * without inventing values for the rest, which is what produced a 3-material project that
   * reopened with 6 (see `repairs/restore-filament-physics.ts`). An unresolvable slot is reported
   * instead, naming the slots, because the user can fix that by picking those materials explicitly.
   */
  /**
   * The project's embedded presets, minus the ones removed this session.
   *
   * Filtered HERE rather than re-reading the archive: the removal is a session edit that undo can
   * take back, and the archive still contains the entry until the next save writes without it.
   */
  const embeddedPresets = useMemo(
    () => {
      const all = embeddedPresetsQuery.data ?? []
      const removed = new Set(state?.removedEmbeddedPresets ?? [])
      return removed.size === 0 ? all : all.filter((preset) => !removed.has(preset.entryPath))
    },
    [embeddedPresetsQuery.data, state?.removedEmbeddedPresets]
  )

  // Machine + stored purge values for the flushing dialog. Null while the settings are still
  // loading, for a project that carries none (a from-scratch scaffold), or for a host whose source
  // cannot read them, in each case the Materials section simply shows no button.
  const projectFlushContext = useMemo(
    () => readProjectFlushContext(projectSettingsQuery.data ?? null),
    [projectSettingsQuery.data]
  )
  const flushDatasets = useFlushDatasets(sliceConfig?.selectedSlicerTargetId, flushDataPath)
  // Does the engine agree with our port? A diagnostic, cached per target, it only decides how
  // confidently the dialog's footnote can speak. See `flushDatasets.ts`.
  const flushCalibration = useFlushCalibration(sliceConfig?.selectedSlicerTargetId, flushDatasets, flushCalibrationPath)

  /**
   * Record the session's purge volumes. Checkpointed like every other scene edit, so it is
   * undoable and marks the project dirty; the stored file is untouched until the user saves.
   */
  const handleFlushVolumesChange = useCallback((next: SceneEditFlushVolumes) => {
    recordHistoryRef.current?.()
    setState((prev) => prev ? { ...prev, flushVolumes: next } : prev)
  }, [recordHistoryRef])

  /**
   * Remove one embedded preset. Checkpointed like every other scene edit, so it is undoable and
   * marks the project dirty; nothing touches the stored file until the user saves.
   */
  const handleRemoveEmbeddedPreset = useCallback((entryPath: string) => {
    recordHistoryRef.current?.()
    setState((prev) => prev
      ? { ...prev, removedEmbeddedPresets: [...(prev.removedEmbeddedPresets ?? []), entryPath] }
      : prev)
  }, [recordHistoryRef])

  const handleRepairFilamentPhysics = useCallback(async (otherRepairsStaged = false) => {
    const controller = sliceConfigRef.current
    if (!resolveFilamentConfig || !controller) return
    setRepairingPhysics(true)
    setPhysicsRepairError(null)
    try {
      const resolved: Record<number, RepairedFilamentPreset> = {}
      const unresolved: number[] = []
      for (const slot of controller.projectFilaments) {
        const optionId = controller.filamentMaterialOptionIds[slot.projectFilamentId]
        const profileId = controller.materialOptions.find((option) => option.id === optionId)?.profileId
        if (!profileId) {
          unresolved.push(slot.projectFilamentId)
          continue
        }
        try {
          const response = await resolveFilamentConfig({
            filamentProfileId: profileId,
            targetId: controller.selectedSlicerTargetId || null,
            sourceFileId: baseFileId ?? null,
            projectFilamentId: slot.projectFilamentId
          })
          // A config OBJECT is not the same as a config with VALUES. A slot whose preset resolves to
          // the project's own (physics-dropped) slot comes back as `{}`: truthy, so it used to count
          // as resolved: the repair reported success, the banner cleared, and the save then wrote
          // nothing because no slot defined any key. The user got a "repaired" file that was
          // untouched. Require at least one real filament setting before believing the slot.
          const physicsKeys = response.config
            ? Object.keys(response.config).filter((key) => FILAMENT_SETTING_KEYS.has(key) && !isFilamentIdentitySettingKey(key))
            : []
          if (physicsKeys.length > 0) {
            resolved[slot.projectFilamentId] = {
              config: response.config!,
              // Pinned with the values, because it is half of the same fact: a slot backed by a
              // USER preset needs its parent named in the saved project or BambuStudio reopens it
              // as a `(<project>.3mf)` copy. Absent when the parent did not resolve.
              ...(response.presetInherits === undefined
                ? {}
                : { inherits: response.presetInherits, changedKeys: response.presetChangedKeys ?? [] })
            }
          } else unresolved.push(slot.projectFilamentId)
        } catch {
          // A preset kind this host cannot resolve (the public editor throws on any provenance its
          // local resolver does not implement) counts as unresolved like any other miss.
          unresolved.push(slot.projectFilamentId)
        }
      }
      if (unresolved.length > 0 || Object.keys(resolved).length === 0) {
        // The MATERIAL is the subject, not the app. "We couldn't match ..." casts the software as
        // someone acting on the user's behalf, which it is not, and it puts the apology before the
        // fact. Naming the material first also puts the thing they have to go and fix at the front.
        const one = unresolved.length === 1
        const slots = one ? `Material ${unresolved[0]}` : `Materials ${unresolved.join(', ')}`
        // When the byte-level settings repairs staged in the same click, "nothing was changed"
        // would be a lie: say which half missed and that the staged half survives a save.
        const stagedNote = otherRepairsStaged ? ' The other repairs are staged; save to keep them.' : ''
        setPhysicsRepairError(
          unresolved.length > 0
            ? `${slots} didn’t match a known preset, so ${one ? 'its' : 'their'} settings weren’t restored. Pick ${one ? 'it' : 'them'} again, then repair.${stagedNote}`
            : `No materials matched a known preset, so their settings weren’t restored.${stagedNote}`
        )
        return
      }
      // Checkpoint BEFORE the change, like every other scene edit, this is also what marks the
      // project dirty, so Save lights up.
      recordHistoryRef.current?.()
      setState((prev) => (prev ? { ...prev, repairedFilamentConfigs: resolved } : prev))
    } finally {
      setRepairingPhysics(false)
    }
  }, [resolveFilamentConfig, sliceConfigRef, baseFileId, recordHistoryRef])

  /**
   * Stage the byte-level settings repairs (flush matrix, variant index, filament ids,
   * inherits_group, object extruders) as an UNDOABLE EDIT: the in-editor twin of the API repair
   * route, for hosts with no stored file to POST to (the public editor). Marking is the whole
   * client-side action: the pin rides the edit as `SceneEdit.repairSettings` and the bake applies
   * the shared repair implementations while saving, so a repaired file cannot differ by which
   * surface repaired it.
   */
  const handleStageSettingsRepair = useCallback(() => {
    recordHistoryRef.current?.()
    setState((prev) => (prev ? { ...prev, settingsRepairStaged: true } : prev))
  }, [recordHistoryRef])

  /**
   * The one in-editor Repair action the notice offers: stages whichever repairs the flagged
   * reasons call for. The physics restore resolves presets and reports its own miss (staging the
   * byte repairs first keeps a physics failure from discarding them: the error then honestly
   * describes the HALF that failed).
   *
   * Byte-level repairs stage synchronously, but "cannot fail" would overstate it. Each one DECLINES
   * where it cannot derive the value with certainty, which is the contract in `repairs/index.ts`,
   * and a declined repair is indistinguishable from a successful one here: the reasons come from the
   * cached index and carry no repairability, so the button is offered either way and the banner
   * returns after the save. One shape is known to reach it, an `inherits_group` of fewer than two
   * entries, where the process and machine slots cannot be told apart. It needs a hand-edited or
   * foreign file, so this is tracked rather than fixed: surfacing repairability means widening the
   * wire contract and bumping `THREE_MF_INDEX_PARSER_VERSION`, which invalidates every cached index
   * on every bridge. Tracked as issue #101.
   */
  const handleRepairInEditor = useCallback(async () => {
    // "Try again" after a physics miss must not re-stage (and burn another undo step) when the
    // byte repairs are already pinned from the first attempt.
    const stagedSettings = !stateRef.current?.settingsRepairStaged
      && settingsRepairReasons.some((reason) => reason !== 'filamentPhysics')
    if (stagedSettings) handleStageSettingsRepair()
    if (settingsRepairReasons.includes('filamentPhysics')) await handleRepairFilamentPhysics(stagedSettings)
  }, [settingsRepairReasons, handleStageSettingsRepair, handleRepairFilamentPhysics, stateRef])

  /**
   * The settings panel's controller, as ONE stable object.
   *
   * `SliceSettingsPanel` is memoised and is the largest thing in the sidebar after the object list,
   * so this must not be rebuilt per render. It was a spread literal wrapping a second literal in
   * JSX, which threw away the memoisation `sliceConfigForPanel` already had and re-rendered the
   * whole panel for every unrelated edit.
   */
  const sliceSettingsFlushVolumes = useMemo(() => (projectFlushContext
    ? {
        context: projectFlushContext,
        datasets: flushDatasets,
        calibration: flushCalibration,
        value: state?.flushVolumes ?? null,
        onChange: handleFlushVolumesChange,
        // Same staged repair the banner offers, reachable from where the defect is actually visible.
        onRepair: settingsRepairReasons.includes('flushMatrix') ? handleRepairInEditor : undefined
      }
    : null),
  [projectFlushContext, flushDatasets, flushCalibration, state?.flushVolumes,
    handleFlushVolumesChange, settingsRepairReasons, handleRepairInEditor])

  const sliceSettingsController = useMemo(() => (sliceConfigForPanel
    // Flush volumes are injected HERE rather than by either host's controller: the purge volumes
    // are project-file content read from the archive the editor holds and edited as session state
    // it owns, so this is the one place both hosts already share. The edit records its own history
    // checkpoint, so it does not go through the controller wrapper the slice-config setters use.
    ? { ...sliceConfigForPanel, flushVolumes: sliceSettingsFlushVolumes }
    : null),
  [sliceConfigForPanel, sliceSettingsFlushVolumes])

  /**
   * Whether "Save" has somewhere to land WITHOUT asking the user for a destination, an opened
   * library file, an opened local file, or a scaffold already saved once this session. Shared by the
   * footer's Save button and the repair notice's Repair, so the notice cannot offer a save the
   * footer would have refused.
   */
  const canSaveOverOpenProject = savesToLocalFile || savedAsProject || (baseFileId !== null && !isNewProject)

  // ---- Render ----------------------------------------------------------------
  const loading = !hasNoBaseFile && (
    platesQuery.isLoading || initialSceneQuery.isLoading || (!state && plateIndices.length > 0)
  )
  // Disable scene-manipulation controls until the plate has finished (re)building: acting on a
  // half-loaded scene (e.g. auto-arrange before the models are in) is undefined.
  const controlsBusy = loading || viewportBuilding || !sceneReady
  // The in-viewport loading overlay shows while models build AND during the brief pre-build window
  // after the viewport mounts but before the scene/canvas is ready, otherwise the first open shows
  // an empty bed with no sign of loading until the models suddenly appear. Pre-build is treated as
  // incremental (the plate starts empty), so it gets the top bar + centred message rather than the
  // same-plate dimming rebuild.
  const showBuildOverlay = viewportBuilding || !sceneReady
  const buildOverlayIncremental = buildIncremental || !sceneReady
  // Null, not 0, while the part count is unknown or a single part: the bar and spinner are then
  // indeterminate, and a 0 would size their moving segment to nothing (see `ProgressBar`).
  const buildProgressPercent = buildProgress && buildProgress.total > 1
    ? Math.round((buildProgress.done / buildProgress.total) * 100)
    : null
  const loadError = platesQuery.error instanceof Error
    ? platesQuery.error.message
    : initialSceneQuery.error instanceof Error
      ? initialSceneQuery.error.message
      : restScenesQuery.error instanceof Error
        ? restScenesQuery.error.message
        : null
  // Re-run only the reads that actually failed: the project source's archive memo is cleared on
  // rejection, so an errored query's refetch re-downloads, while a healthy query's data stays put.
  const retryProjectLoad = () => {
    if (platesQuery.isError) void platesQuery.refetch()
    if (initialSceneQuery.isError) void initialSceneQuery.refetch()
    if (restScenesQuery.isError) void restScenesQuery.refetch()
  }
  const dialogMode = dialogPresentationProps(presentation)

  return (
    <>
    <Modal
      open
      onClose={(event, reason) => {
        if (reason !== 'escapeKeyDown') {
          // The X and browser Back both arrive as `closeClick`, which is right for deciding what to
          // do and useless in the duplicate-close warning below, whose whole job is to name the two
          // gestures that raced. `isBackGestureClose` reads the marker the wrapper puts on Back's
          // synthetic event so the log can still tell them apart.
          void handleCloseRequest(`dialog:${isBackGestureClose(event) ? 'back' : reason}`)
          return
        }
        // This is the ONLY place Escape is observable in the editor -- the Modal swallows it before
        // any window listener sees it (see `editorEscapeAction`), so the whole key is handled here
        // rather than in `useEditorKeyboardShortcuts` with the other shortcuts.
        // The synthetic Escape we dispatch to dismiss other Joy menus on right-click is not a user
        // press at all, so it backs out of nothing.
        if (suppressEditorEscapeRef.current) return
        // An open right-click/kebab menu is the innermost thing on screen and goes first. It used to
        // be closed by a window listener that, for the same reason, never ran: with a menu open
        // Escape did nothing whatsoever, which the kebab made easy to reach without a mouse.
        if (contextMenuOpenRef.current) {
          setContextMenu(null)
          return
        }
        // A measurement in progress is peeled one pick at a time before the tool itself closes,
        // which is Studio's own staging (`GLGizmosManager.cpp:1135`: second selection, then first,
        // then the gizmo). Measuring is the one tool where the work IS the selection, so dropping
        // both picks to leave the tool would throw away the thing Escape was meant to correct.
        if (gizmoMode === 'measure' && measurePoints.length > 0) {
          setMeasurePoints((current) => current.slice(0, -1))
          return
        }
        // Every selection shape, not just the object one: the bulk part path nulls `selectedKey`
        // deliberately, so asking it alone reported "nothing selected" while a part was highlighted,
        // and Escape closed the editor instead of clearing it.
        const action = editorEscapeAction(gizmoMode, hasEditorSelection({
          objectKey: selectedKey,
          partSelection,
          gizmoPart,
        }))
        if (action === 'reset-tool') {
          // Through the rail's own handler, not a bare setState: leaving a tool has bookkeeping
          // (the text tool's pending edit, most of all) that only this path runs.
          handleGizmoModeChange(RESTING_GIZMO_MODE)
          return
        }
        if (action === 'clear-selection') {
          // One call clears all of it. While a session-added volume was a shape of its own it
          // survived this and had to be cleared by hand alongside, which is exactly the kind of
          // omission that made Escape a key that did nothing.
          selectExclusive(null)
          return
        }
        void handleCloseRequest('escape')
      }}
    >
      <ModalDialog
        variant="outlined"
        // Size comes from the shared dialog modes: maximized over a page (a thin gutter, so the page
        // behind still reads as present) and edge-to-edge once the user asks for full screen or the
        // host IS the page. Both have to escape the theme's app-wide viewport clamp, which is
        // exactly what `dialogPresentationProps` carries: see `lib/dialogPresentation.ts`.
        {...dialogMode}
        sx={[
          dialogMode.sx,
          {
            // Full screen drops the dialog's own padding too: with no chrome left to inset, that
            // padding is just a border of nothing around the model.
            // Tight on a phone: the maximized mode now reaches the screen edges there, so this
            // padding is the only inset left, and at 1.5 it was spending 24px of ~412 on a margin
            // around a 3D viewport.
            p: showEditorChrome ? { xs: 0.75, sm: 2 } : 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            gap: 0
          }
        ]}
      >
        {/* Both are chrome, and the close X sits exactly where the viewport toolbar moves to once
            the dialog padding goes, leaving it would put an editor-closing button under the
            cursor aiming for "exit full view".
            NO `onClick`: Joy already routes this button through the Modal's own `onClose` (as
            `'closeClick'`, which lands on `handleCloseRequest` above), and calls any `onClick`
            AFTERWARDS. Wiring one here ran the close twice per click, and the second confirm was
            queued rather than dropped -- so the X asked "Discard unsaved changes?" a second time
            once the user had answered the first. Pinned by `BackAwareModal.test.ts`. */}
        {showEditorChrome && <ModalClose sx={{ top: 12, right: 12 }} />}
        {showEditorChrome && (
          <DialogFileTitle
            title={showAsNewProject ? 'New Project' : 'Edit Project'}
            fileName={savedFile
              ? formatLibraryFileName(savedFile.name)
              : (!isNewProject && baseFileQuery.data ? formatLibraryFileName(baseFileQuery.data.file.name) : null)}
            sx={{ mb: 1 }}
          />
        )}

        {/*
          The opened project's saved settings contradict its own machine topology, which kills a
          library slice inside BambuStudio with an opaque exit 139. Surfaced here (rather than
          repaired behind the user's back) so they can stage the repair with one click and save;
          the editor's own save/slice bake already rewrites the settings correctly either way.
        */}
        {showEditorChrome && settingsRepairReasons.length > 0 && (
          <RepairProjectSettingsAlert
            reasons={settingsRepairReasons}
            unrepairableReasons={unrepairableRepairReasonsResolved}
            // Repairing an archived version means restoring it first, a knowing decision, so it
            // gets the advisory with restore-first wording instead of a Repair button that would
            // mint a new head from old bytes.
            archivedVersion={openedArchivedVersion}
            // `filamentPhysics` is repaired by the save path, not the route, and Save is greyed out
            // on a project with no unsaved edits, so without this the notice named a remedy the user
            // could not reach.
            //
            // Available on EVERY host, including a project opened from disk: this no longer saves
            // anything, it stages an undoable edit, so there is no file write to be surprised by.
            // Offered wherever a resolver exists AND the preset catalogue has settled. Whether every
            // slot CAN resolve is not knowable without asking, a slot can hold a preset id whose kind
            // this host's resolver does not implement, so the attempt reports the miss rather than a
            // pre-flight predicting it. The catalogue, though, IS knowable: pressed before it loads,
            // every slot resolves to no preset id and the repair fails with "couldn't match materials
            // 1, 2" on a project whose materials are perfectly fine. Reproduced by clicking the moment
            // the button appears, which is exactly what an eager user does.
            // The resolver/catalogue gate applies only when the PHYSICS restore is among the
            // flagged reasons: the byte-level repairs stage synchronously from the shared
            // implementations and need neither.
            onRepairInEditor={settingsRepairReasons.includes('filamentPhysics')
              ? (resolveFilamentConfig && sliceConfig?.slicerStatus.slicerDataReady ? handleRepairInEditor : undefined)
              : handleRepairInEditor}
            repairingInEditor={repairingPhysics}
            repairInEditorError={physicsRepairError}
            sx={{ mb: 1 }}
          />
        )}
        {/* Same wide-banner spot: the settings sidebar is too narrow for the warning + its
            "slice it anyway" acknowledgement, and the disabled Slice button's tooltip alone
            gives the user no way forward. */}
        {showEditorChrome && sliceConfig?.projectVersionWarning && (
          <ProjectVersionWarningAlert {...sliceConfig.projectVersionWarning} sx={{ mb: 1 }} />
        )}

        {loadError ? (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState
              icon={<OpenWithRoundedIcon />}
              title="Unable to load this project"
              description={loadError}
              action={(
                <Button size="sm" startDecorator={<ReplayRoundedIcon />} onClick={retryProjectLoad}>
                  Try again
                </Button>
              )}
            />
          </Box>
        ) : !state || !activePlate ? (
          // Only the genuine first load (no plates/scene yet) shows the full overlay. Once the
          // editor has content, plate switches and background refetches keep the viewport mounted
          // and lean on the in-viewport "Loading models…" overlay: flipping the whole content out
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
                onEditPlateSettings={(index) => {
                  const plate = stateRef.current?.plates.find((entry) => entry.index === index)
                  if (plate) setPlateSettingsId(plate.plateId)
                }}
                onReorderPlate={handleReorderPlate}
                // Phones stack, so the rail only ever applies to the desktop grid.
                orientation={isMobile ? 'horizontal' : plateStripOrientation}
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
                  resets it to "" (auto) on pointerup, and has no pointercancel handler, so a
                  scroll-hijacked touch leaves it "none", the next touch starts "none" (works), its
                  clean pointerup resets to "" again, and the touch after that gets scroll-hijacked
                  (pointercancel), interrupting every other drag/rotate on mobile. A CSS rule wins
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
                    <ProgressBar
                      value={buildProgressPercent}
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
                      <ProgressSpinner size="md" value={buildProgressPercent} />
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
                        <ProgressSpinner size="md" value={buildProgressPercent} />
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
                  ref={setChromeStripElement}
                  sx={{
                    position: 'absolute',
                    // Phones keep the wrapping strip across the top; from sm up the tools move
                    // into the vertical left rail, so this row only carries undo/redo + help
                    // and hugs the right edge, leaving the top-centre free for the transform.
                    top: 8,
                    left: { xs: 8, sm: 'auto' },
                    right: 8,
                    zIndex: EDITOR_CHROME_Z_INDEX,
                    display: 'flex',
                    gap: 1,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: { xs: 'center', sm: 'flex-end' },
                    // Don't block clicks/drags on the 3D scene showing through the
                    // full-width centering strip; the controls re-enable themselves.
                    pointerEvents: 'none',
                    '& > *': { pointerEvents: 'auto' }
                  }}
                >
                  {isMobile && (
                    // The tools SCROLL on a phone rather than wrapping. `flexWrap` can only break
                    // BETWEEN the two groups, and the first is fifteen buttons -- about 450px of
                    // unbreakable flex item against ~370px of dialog -- so the overflow used to be
                    // clipped by the viewport's `overflow: hidden` and those tools were simply
                    // unreachable. Horizontal scrolling is the app's existing answer to a row that
                    // does not fit (the mobile tab bar, `SectionNav`), so it is the one used here.
                    // The fade goes to the group's own soft fill because this strip floats over the
                    // 3D canvas and has no backdrop of its own to blend into.
                    <HorizontalOverflowScroller
                      fadeColor="var(--joy-palette-neutral-softBg)"
                      fadeWidth={16}
                      sx={{ flex: 1, minWidth: 0 }}
                      scrollerSx={{ display: 'flex', gap: 1, alignItems: 'center' }}
                    >
                      <GizmoToolbar
                        mode={gizmoMode}
                        disabled={!selectedKey || controlsBusy}
                        busy={controlsBusy}
                        arrangeDisabled={controlsBusy || (activePlate?.instances.length ?? 0) === 0 || (activePlate?.locked ?? false)}
                        onChange={handleGizmoModeChange}
                        onDropToBed={handleDropToBed}
                        onAutoOrient={handleAutoOrient}
                        onArrangeAll={handleArrangeAll}
                      />
                    </HorizontalOverflowScroller>
                  )}
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
                  {/* Hiding the sidebar is meaningless while the viewport already fills the
                      dialog, and on phones the sidebar is a TAB rather than a column. */}
                  {!isMobile && showEditorChrome && (
                    <Tooltip title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
                      <IconButton
                        size="sm"
                        variant="soft"
                        color="neutral"
                        aria-pressed={sidebarCollapsed}
                        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
                      >
                        <ViewSidebarRoundedIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  <FullScreenDialogButton
                    active={fullScreen}
                    onToggle={setFullScreen}
                    contentLabel="3D only"
                    variant="soft"
                  />
                  {showEditorChrome && perObject && (
                    <Tooltip title="Parameter table">
                      <IconButton
                        size="sm"
                        variant="soft"
                        color="neutral"
                        onClick={() => setParameterTableOpen(true)}
                        aria-label="Parameter table"
                      >
                        <TableRowsRoundedIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  {showEditorChrome && (
                    <Tooltip title="Editor settings">
                      <IconButton
                        size="sm"
                        variant="soft"
                        color="neutral"
                        onClick={() => setEditorSettingsOpen(true)}
                        aria-label="Editor settings"
                      >
                        <TuneRoundedIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  {showEditorChrome && <KeyboardHelpButton />}
                </Box>
                {/* Photo-editor tool rail (sm+): the modal tools run down the left edge, which
                    frees the top edge for the transform readout. Phones keep the top strip above. */}
                {!isMobile && (
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 8,
                      left: 8,
                      zIndex: EDITOR_CHROME_Z_INDEX,
                      // Hovering (or tabbing into) the rail expands every button's label at once.
                      ...RAIL_HOVER_LABEL_SX
                    }}
                  >
                    <GizmoToolbar
                      mode={gizmoMode}
                      disabled={!selectedKey || controlsBusy}
                      busy={controlsBusy}
                      arrangeDisabled={controlsBusy || (activePlate?.instances.length ?? 0) === 0 || (activePlate?.locked ?? false)}
                      onChange={handleGizmoModeChange}
                      onDropToBed={handleDropToBed}
                      onAutoOrient={handleAutoOrient}
                      onArrangeAll={handleArrangeAll}
                      orientation="vertical"
                    />
                  </Box>
                )}
                {/* Transform readout, top-centre (sm+). On phones it stays docked in the objects
                    panel/bottom sheet, where there is no room to float it. */}
                {!isMobile && selectedTransform && isTransformGizmoMode(gizmoMode) && (
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 8,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      zIndex: TOOL_PANEL_Z_INDEX,
                      // Sized for the ONE axis group the active tool shows (three fields), and
                      // always clearing the tool rail (left) and undo/redo + help (right).
                      width: 'min(320px, calc(100% - 260px))'
                    }}
                  >
                    <LiveTransformPanel
                      floating
                      mode={gizmoMode}
                      initial={selectedTransform}
                      setterRef={transformReadoutSetterRef}
                      // With a part on the gizmo the values are the PART's placement inside
                      // its object (and edits apply to every copy): say so.
                      heading={placementPanelHeading}
                      uniformScale={uniformScale}
                      onToggleUniformScale={setUniformScale}
                      onPosition={applyManualPosition}
                      onRotation={applyManualRotation}
                      onScale={applyManualScale}
                    />
                  </Box>
                )}
                {gizmoMode === 'cut' && selectedKey && cutRange && (
                  <CutToolPanel
                    cutMode={cutMode}
                    setCutMode={setCutMode}
                    groove={groove}
                    setGroove={setGroove}
                    grooveSizeLimits={grooveSizeLimits}
                    connectorSettings={connectorSettings}
                    setConnectorSettings={applyConnectorSettings}
                    connectorCount={cutConnectors.length}
                    connectorMode={placingConnectors}
                    setConnectorMode={setCutConnectorMode}
                    connectorFace={cutConnectorFace}
                    setConnectorFace={setCutConnectorFace}
                    clearConnectors={clearCutConnectors}
                    connectorWarning={connectorProblemSummary(activeProblems)}
                    connectorSizeLimits={connectorSizeLimits}
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
                    cutOrientLower={cutOrientLower}
                    setCutOrientLower={setCutOrientLower}
                    cutOrientUpper={cutOrientUpper}
                    setCutOrientUpper={setCutOrientUpper}
                    cutting={cutting}
                    onCut={handlePerformCut}
                    onCancel={() => setGizmoMode(RESTING_GIZMO_MODE)}
                  />
                )}
                {gizmoMode === 'meshBoolean' && (
                  <MeshBooleanPanel
                    operation={meshBoolean.operation}
                    onOperationChange={meshBoolean.setOperation}
                    targetMode={meshBoolean.targetMode}
                    lists={meshBoolean.lists}
                    nameFor={meshBoolean.nameFor}
                    onAssign={meshBoolean.assignList}
                    keepOriginals={meshBoolean.keepOriginals}
                    onKeepOriginalsChange={meshBoolean.setKeepOriginals}
                    helperVolumeCount={meshBoolean.helperVolumeCount}
                    solidPartsOnly={meshBoolean.solidPartsOnly}
                    onSolidPartsOnlyChange={meshBoolean.setSolidPartsOnly}
                    warning={meshBoolean.warning}
                    busy={meshBoolean.busy}
                    onApply={meshBoolean.apply}
                    onClose={() => setGizmoMode(RESTING_GIZMO_MODE)}
                  />
                )}
                {gizmoMode === 'measure' && (
                  <MeasurePanel
                    picks={measurePoints}
                    result={measureResult}
                    onResetSlot={(slot) => setMeasurePoints((current) => (
                      // Dropping the FIRST promotes the second into it, matching what clicking that
                      // feature again does -- a measurement with an empty first slot and a full
                      // second is a state the click path can never produce.
                      slot === 0 ? current.slice(1) : current.slice(0, 1)
                    ))}
                    onClear={() => setMeasurePoints([])}
                    onDone={() => setGizmoMode(RESTING_GIZMO_MODE)}
                  />
                )}
                {activePaintChannel !== null && selectedKey && (
                  <PaintToolPanel
                    paint={paint}
                    paintTargetIsObject={paintTargetIsObject}
                    filamentOptions={filamentOptions}
                    onDone={() => setGizmoMode(RESTING_GIZMO_MODE)}
                  />
                )}
                {gizmoMode === 'brimEars' && selectedKey && (
                  <BrimEarsPanel
                    paintTargetIsObject={paintTargetIsObject}
                    brimEarDiameter={brimEarDiameter}
                    setBrimEarDiameter={setBrimEarDiameter}
                    onClear={() => editSelectedBrimEars({ kind: 'clear' })}
                    onDone={() => setGizmoMode(RESTING_GIZMO_MODE)}
                  />
                )}
            {gizmoMode === 'svg' && (
              <SvgToolPanel
                value={svgTool}
                onChange={setSvgTool}
                fileName={svgFileName}
                heightMm={svgArtwork ? svgHeightMm(svgArtwork, svgTool.widthMm) : 0}
                hasArtwork={svgArtwork != null}
                emptyReason={svgEmptyReason}
                busy={importing}
                hasHost={selectedKey != null}
                hasBackground={svgArtwork != null && detectSvgBackgroundPiece(svgArtwork) != null}
                onChooseFile={handleChooseSvgFile}
                onAdd={() => { void handleAddSvg() }}
                onClose={() => setGizmoMode(RESTING_GIZMO_MODE)}
                replacingParts={reeditSvgCount}
              />
            )}
            {gizmoMode === 'text' && (
              <TextToolPanel
                value={textTool}
                hasHost={textHasHost}
                families={BUNDLED_FAMILIES}
                userFaces={textUserFaces}
                busy={importing}
                onChange={setTextTool}
                onLoadFontFile={(file) => { void loadTextFontFile(file) }}
                onRemove={() => {
                  removeTextPart()
                  setGizmoMode(RESTING_GIZMO_MODE)
                }}
                // Just leave the mode: the teardown is keyed on the mode now, so Done runs exactly
                // the same path as the rail, the shortcuts and Escape rather than its own copy.
                onClose={() => setGizmoMode(RESTING_GIZMO_MODE)}
              />
            )}
            {editingLayerHeight && (() => {
              const instance = stateRef.current?.plates
                .flatMap((plate) => plate.instances).find((entry) => entry.key === editingLayerHeight.key)
              const group = groupByKeyRef.current.get(editingLayerHeight.key)
              if (!instance || !group) return null
              const box = printableMeshBox(group)
              const objectHeight = box ? box.max.z - box.min.z : 0
              if (!(objectHeight > 0)) return null
              const profile = effectiveLayerHeightProfile(stateRef.current, instance)
              // `checkpoint` false = mid-stroke: no undo entry, so one drag is one undo step.
              const commit = (next: number[] | null, checkpoint = true) => {
                if (next) setObjectLayerHeightProfile(editingLayerHeight.objectId, next, checkpoint)
              }
              // OBJECT-space triangles: the profile's own frame, so the soup is rebased off the model's
              // underside rather than handed over in world coordinates.
              const objectSoup = () => {
                const soup = collectWorldTriangles(group)
                const minZ = box ? box.min.z : 0
                for (let i = 2; i < soup.length; i += 3) soup[i] = soup[i]! - minZ
                return soup
              }
              return (
                <LayerHeightPanel
                  objectName={instance.name}
                  objectHeight={objectHeight}
                  profile={profile}
                  bounds={layerHeightBounds}
                  nominalHeight={defaultLayerHeightMm}
                  hasHeightRanges={effectiveHeightRanges(stateRef.current, instance).length > 0}
                  onHover={(z, bandWidth) => setLayerHeightBrush(z == null ? null : { z, bandWidth })}
                  onPaint={(z, action, bandWidth, firstOfStroke) => commit(paintLayerHeightProfile(
                    profile.length > 0 ? profile : flatLayerHeightProfile(objectHeight, defaultLayerHeightMm, firstLayerHeightMm),
                    z, action,
                    { objectHeight, bounds: layerHeightBounds, nominalHeight: defaultLayerHeightMm, bandWidth, strength: 0.02, firstLayerHeight: firstLayerHeightMm }
                  ), firstOfStroke)}
                  onAdaptive={(quality) => {
                    const next = adaptiveLayerHeightProfile(objectSoup(), {
                      objectHeight, bounds: layerHeightBounds, nominalHeight: defaultLayerHeightMm, quality,
                      firstLayerHeight: firstLayerHeightMm
                    })
                    if (!next) { toast.error('That model has no surface to derive layer heights from.'); return }
                    commit(next)
                  }}
                  onSmooth={(radius, keepMin) => {
                    if (profile.length === 0) { toast.error('Nothing to smooth yet: run Adaptive or paint first.'); return }
                    commit(smoothLayerHeightProfile(profile, objectHeight,
                      { bounds: layerHeightBounds, radius, keepMin, firstLayerHeight: firstLayerHeightMm }))
                  }}
                  onReset={() => setObjectLayerHeightProfile(editingLayerHeight.objectId, [])}
                  onClose={() => { setEditingLayerHeight(null); setLayerHeightBrush(null); setGizmoMode(RESTING_GIZMO_MODE) }}
                />
              )
            })()}
                {rotationReadout !== null && (
                  <Chip
                    variant="solid"
                    color="primary"
                    size="sm"
                    // Bottom CENTRE, not the top-right corner it used to share with the undo/redo
                    // strip at the same z-index (on a phone that strip carries the whole tool row,
                    // so the degrees landed on the buttons). The bottom centre is the one edge no
                    // other viewport surface claims: the cube owns bottom-left, placement warnings
                    // bottom-right, and the transform readout the top centre.
                    sx={{
                      position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
                      zIndex: VIEWPORT_AID_Z_INDEX
                    }}
                  >
                    {`${Math.round(rotationReadout)}°`}
                  </Chip>
                )}
                <Box
                  sx={{
                    position: 'absolute',
                    left: VIEW_CUBE_EDGE_INSET,
                    bottom: VIEW_CUBE_EDGE_INSET,
                    zIndex: VIEWPORT_AID_Z_INDEX
                  }}
                >
                  {/* The gestures are invisible on a cube, so the hint is the only thing that
                      surfaces the edges, the double-click and the Shift modifier. */}
                  <Tooltip title={VIEW_CUBE_HINT} placement="right" enterDelay={600}>
                    <Box
                      ref={setViewCubeContainer}
                      aria-label="Editor orientation cube"
                      sx={{ width: VIEW_CUBE_SIZE, height: VIEW_CUBE_SIZE, '& canvas': { display: 'block' } }}
                    />
                  </Tooltip>
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
            // `fill` stretches the object list to the container's height with its own scrollbar
            // (the mobile bottom-sheet and the no-slice-config sidebar, both fixed-height); the
            // merged settings sidebar passes false so the list takes its natural height and the
            // whole panel scrolls as one column.
            const renderObjectsContent = (options: { fill: boolean }) => (
              <>
                <StickySectionHeader justifyContent="space-between">
                  <Typography level="title-sm">Objects on plate {activePlateIndex}</Typography>
                  <AddObjectMenu
                    importing={importing}
                    disabled={sliceConfig != null && !hasMaterials}
                    disabledReason="Add a material before adding objects."
                    onAddFromLibrary={canImportFromLibrary ? () => { setModelRequest(null); setLibraryPickerOpen(true) } : undefined}
                    onImportFile={() => { setModelRequest(null); fileInputRef.current?.click() }}
                    onAddPrimitive={(kind) => void handleAddPrimitive(kind)}
                  />
                </StickySectionHeader>
                {isMobile && selectedTransform && isTransformGizmoMode(gizmoMode) && (
                  <LiveTransformPanel
                    mode={gizmoMode}
                    initial={selectedTransform}
                    setterRef={transformReadoutSetterRef}
                    // With a part on the gizmo the values are the PART's placement inside
                    // its object (and edits apply to every copy): say so.
                    heading={placementPanelHeading}
                    uniformScale={uniformScale}
                    onToggleUniformScale={setUniformScale}
                    onPosition={applyManualPosition}
                    onRotation={applyManualRotation}
                    onScale={applyManualScale}
                  />
                )}
                <Sheet variant="outlined" sx={{ ...(options.fill ? { flex: 1 } : {}), minHeight: 120, borderRadius: 'sm', overflow: 'auto' }}>
                  {activePlate.instances.length === 0 ? (
                    <Box sx={{ p: 1.5 }}>
                      <Typography level="body-sm" textColor="text.tertiary">
                        No objects on this plate. Use “Add”.
                      </Typography>
                    </Box>
                  ) : (
                    <ObjectList
                      instances={listedInstances}
                      selectedKey={selectedKey}
                      extraSelectedKeys={extraSelectedKeys}
                      partSelection={partSelection}
                      gizmoPart={gizmoPart}
                      onSelect={handleSelect}
                      onSelectPart={handleSelectPart}
                      linkedCopyCountFor={linkedCopyCountFor}
                      onObjectContextMenu={handleObjectRowContextMenu}
                      onPartContextMenu={handlePartRowContextMenu}
                      filamentColors={filamentColors}
                      filamentOptions={filamentOptions}
                      onReassignFilament={filamentOptions.length > 0 ? reassignFilament : undefined}
                      onReassignInstanceFilament={filamentOptions.length > 0 ? reassignOneInstanceFilament : undefined}
                      resolveFilamentId={resolveColorFilamentId}
                      onTogglePrintable={handleTogglePrintable}
                      onChangePartType={handleChangeOnePartType}
                      addedPartsFor={addedPartsFor}
                      bodySubtypeFor={bodySubtypeFor}
                      onSelectAddedPart={handleSelectAddedPartRow}
                      onChangeAddedPartType={handleChangeAddedPartTypes}
                      onChangeAddedPartFilament={handleChangeAddedPartFilaments}
                      onEditAddedPartSettings={perObject ? handleEditAddedPartSettings : undefined}
                      onAddedPartContextMenu={handleAddedPartContextMenu}
                      perObject={objectListPerObject}
                      onReorderObject={handleReorderObject}
                      onReorderPart={handleReorderPart}
                    />
                  )}
                </Sheet>
              </>
            )
            // Per-plate layer G-code sections (filament changes + pauses), each on its
            // own full-width row. They render after the object list, closing out the
            // sidebar's materials → objects → per-plate G-code column. Deliberately NOT
            // wrapped in a Stack of their own: their headers stick, and a wrapper would
            // become the containing block that evicts them (see StickySectionHeader).
            const plateGcodeSections = activePlate ? (
              <>
                {filamentOptions.length > 1 && (
                  <PlateFilamentChangesSection
                    changes={effectiveFilamentChanges(activePlate)}
                    filamentOptions={filamentOptions}
                    onChange={setActivePlateFilamentChanges}
                  />
                )}
                <PlatePausesSection
                  pauses={effectivePauses(activePlate)}
                  onChange={setActivePlatePauses}
                />
              </>
            ) : null
            const settingsPanel = sliceSettingsController
              ? <SliceSettingsPanel
                  controller={sliceSettingsController}
                  mode="editor"
                  activePlateIndex={activePlateIndex}
                  onManagePresets={presetManager ? openSlicingPresets : undefined}
                  // Same signal as the manager: a host that supplies one has a workspace, so its
                  // stored presets can be read and written. The public editor has neither.
                  canEditPrinterPreset={Boolean(presetManager)}
                  presetSourceStatus={presetSourceStatus}
                  embeddedPresets={embeddedPresets}
                  onRemoveEmbeddedPreset={handleRemoveEmbeddedPreset}
                />
              : null

            // The sidebar's contents, shared by the desktop panel column and the mobile tab, so the
            // object list cannot go missing from one of them: slicer/printer/process/materials,
            // then the object list directly below, then the per-plate filament-change/pause rows.
            // One scroller for the lot: the object list takes its natural height and the column
            // scrolls as a whole, rather than each section scrolling inside its own box.
            const sidebarContent = sliceConfig ? (
              <Sheet
                variant="outlined"
                sx={{ flex: 1, minHeight: 0, borderRadius: 'sm', overflow: 'auto', bgcolor: 'background.level1' }}
              >
                {/* This scroller paints level1, unlike the prepare-print dialog's surface,
                    the sticky headers must match it or they show as bars when unpinned. */}
                <StickySectionScope background="background.level1">
                  <Stack spacing={1.25} sx={{ p: 1.25 }}>
                    {settingsPanel}
                    {renderObjectsContent({ fill: false })}
                    {plateGcodeSections}
                  </Stack>
                </StickySectionScope>
              </Sheet>
            ) : (
              <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1, overflow: 'auto' }}>
                {renderObjectsContent({ fill: true })}
                {plateGcodeSections}
              </Box>
            )

            if (isMobile) {
              return (
                <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {showEditorChrome && (
                    <Tabs
                      value={mobileView}
                      onChange={(_event, value) => setMobileView(value === 'settings' ? 'settings' : 'view')}
                      sx={{ bgcolor: 'transparent', flexShrink: 0 }}
                    >
                      <TabList>
                        <Tab value="view" sx={{ flex: 1 }}>3D view</Tab>
                        {/* The second tab is the desktop sidebar, whole. With no slice config there
                            is nothing in it but the object list, so name it for what it holds. */}
                        <Tab value="settings" sx={{ flex: 1 }}>{sliceConfig ? 'Settings' : 'Objects'}</Tab>
                      </TabList>
                    </Tabs>
                  )}
                  {/* The 3D view stays mounted (canvas preserved) but hides while the sidebar shows. */}
                  <Box sx={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 1, display: (showEditorChrome && mobileView === 'settings') ? 'none' : 'flex' }}>
                    {showEditorChrome && plateStrip}
                    {viewport}
                  </Box>
                  {showEditorChrome && mobileView === 'settings' && sidebarContent}
                </Box>
              )
            }

            return (
              <Box
                ref={setBodyNode}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  display: 'grid',
                  gap: showEditorChrome ? `${EDITOR_GRID_GAP_PX}px` : 0,
                  // The panel column flips side with the preference and disappears with the toggles;
                  // the viewport column stays flexible either way. See `buildEditorGridLayout`:
                  // hiding a region has to change the TEMPLATE, or its track stays as a gap.
                  ...buildEditorGridLayout({ sidebarSide, sidebarWidth, showPlates: showEditorChrome, showPanel: showSidebar, stripOrientation: plateStripOrientation })
                }}
              >
                {showEditorChrome && <Box sx={{ gridArea: 'plates', minWidth: 0, minHeight: 0 }}>{plateStrip}</Box>}
                {viewport}
                {showSidebar && (
                <Box sx={{ gridArea: 'panel', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
                  {/* Desktop-only grab strip straddling the grid gap on the panel's INNER edge,
                      the one facing the viewport, so it flips with the panel's side; drag to
                      resize the sidebar, double-click to reset (useSidebarResize). */}
                  <Box
                    aria-hidden
                    onPointerDown={resizeHandleProps.onPointerDown}
                    onDoubleClick={resizeHandleProps.onDoubleClick}
                    sx={{
                      display: { xs: 'none', sm: 'block' },
                      position: 'absolute',
                      ...(sidebarSide === 'left' ? { right: -9 } : { left: -9 }),
                      top: 0,
                      bottom: 0,
                      width: 10,
                      cursor: 'col-resize',
                      touchAction: 'none',
                      zIndex: 2,
                      '&::after': { content: '""', position: 'absolute', left: 4, top: 0, bottom: 0, width: '2px', borderRadius: '1px', bgcolor: 'transparent', transition: 'background-color 120ms' },
                      '&:hover::after, &:active::after': { bgcolor: 'primary.solidBg' }
                    }}
                  />
                  {sidebarContent}
                </Box>
                )}
              </Box>
            )
          })()
        )}

        {showEditorChrome && (
          <DialogActions sx={{ pt: 1 }}>
            {/* Wrapped rather than passed directly: the handler's first argument names the close
                SOURCE, and passing it as a click handler would hand it the MouseEvent. */}
            <Button type="button" variant="plain" onClick={() => { void handleCloseRequest('close-button') }} disabled={saving}>Close</Button>
            {/* Save and Slice stay separate buttons on every width (matching desktop). Each is an
                `ActionMenuButton`, not a split button: neither label is one action on its own, and
                as split buttons each had a wide half that quietly picked a route for the user. */}
            {/* Save/Slice gate on loaded state only, not the 3D viewport's ready/build state, which
                can be false while a settings tab is shown and would wrongly disable slicing. */}
            {/* Save is the primary action and sits rightmost (solid); Slice/Apply pair to its left. */}
            {onSlice ? (
              <SliceMenuButton
                slicing={slicing}
                disabled={!state || !canSlice || slicing || saving}
                disabledReason={!state ? 'Preparing the model…' : (slicing || saving) ? undefined : sliceDisabledReason}
                plateCount={state?.plates.length ?? 1}
                onSliceAll={() => startSlice(0)}
                onSlicePlate={() => startSlice(activePlateIndex)}
              />
            ) : onApply ? (
              <Button type="button" variant="soft" color="primary" loading={saving} disabled={!state || saving} onClick={handleApply}>Use this layout</Button>
            ) : null}
            <SaveMenuButton
              saving={saving}
              disabled={!state || (sliceConfig != null && !hasMaterials)}
              dirty={hasUnsavedChanges}
              canSaveVersion={canSaveOverOpenProject}
              onSaveVersion={handleSaveVersion}
              onSaveAs={() => {
                // Local: hand the name straight to the target, whose picker IS the destination
                // prompt. Opening the library dialog here is what made a local project offer to save
                // into a bridge it has nothing to do with.
                // Empty name is fine: the local target falls back to the opened file's name as the
                // picker's suggestion, which is a better default than anything derivable here.
                if (savesToLocalFile) handleSaveAs(saveAsSuggestedName, null)
                else setSaveAsOpen(true)
              }}
            />
          </DialogActions>
        )}

        {/* Hidden picker for "Import file…". Narrowed to what THIS host's store can stage, so the
            picker never offers a format the import then refuses. */}
        {/* Artwork gets its OWN picker rather than joining `modelRequest`: every kind there can also
            be answered from the library, and the library holds models, not SVGs. Sharing the input
            would mean offering a library browse that can never return anything. */}
        <input
          ref={svgInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void handleSvgFileChosen(file)
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={importAccept}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            const request = modelRequest
            setModelRequest(null)
            if (request?.kind === 'replace') void handleReplaceFromFile(request.key, file)
            else if (request?.kind === 'addPart') void handleAddPartVolume(request.key, request.subtype, { kind: 'file', file })
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
            onDuplicateIndependent={(key) => handleDuplicate(key, true)}
            onCloneWithCount={(key) => { void handleCloneWithCount(key) }}
            onFillBedWithCopies={handleFillBedWithCopies}
            onAlignDistribute={applyAlignDistribute}
            onMakeIndependent={linkedCopyCountFor(contextMenu.key) > 1 ? handleMakeIndependent : undefined}
            onRename={(key) => { void handleRenameObject(key) }}
            onSplitToObjects={(key) => { void handleSplitToObjects(key) }}
            onSplitToParts={(key) => { void handleSplitToParts(key) }}
            canAssemble={extraSelectedKeys.length > 0 && (selectedKey === contextMenu.key || extraSelectedKeys.includes(contextMenu.key))}
            assembleCount={extraSelectedKeys.length + 1}
            onAssemble={() => { void handleAssembleSelection() }}
            onReplaceFromLibrary={canImportFromLibrary ? (key) => { setModelRequest({ kind: 'replace', key }); setLibraryPickerOpen(true) } : undefined}
            onReplaceFromFile={(key) => { setModelRequest({ kind: 'replace', key }); fileInputRef.current?.click() }}
            onExportDownload={canExportDownload ? (key) => handleExportMergedDownload([key]) : undefined}
            onExportToLibrary={canExportToLibrary ? (key) => setExportRequest({ kind: 'object', key }) : undefined}
            onExportProjectDownload={canExportDownload ? (key) => {
              // Immediate download named after the object (matching the STL download items).
              const name = activePlate?.instances.find((entry) => entry.key === key)?.name ?? ''
              handleExportObjectAs3mfDownload(key, `${stlExportBaseName(name)}.3mf`)
            } : undefined}
            onExportProjectToLibrary={canExportToLibrary ? (key) => setExportRequest({ kind: 'project', key }) : undefined}
            onExportMergedDownload={canExportDownload ? () => handleExportMergedDownload(selectionFor(contextMenu.key)) : undefined}
            onExportMergedToLibrary={canExportToLibrary ? () => setExportRequest({ kind: 'merged', keys: selectionFor(contextMenu.key) }) : undefined}
            onExportSeparateDownload={canExportDownload ? () => handleExportSeparateDownload(selectionFor(contextMenu.key)) : undefined}
            onExportSeparateToLibrary={canExportToLibrary ? () => setExportRequest({ kind: 'separate', keys: selectionFor(contextMenu.key) }) : undefined}
            // One handler for both the single and multi menus: a generic 3MF holds however many
            // objects the selection has, so there is no merged/separate choice to make.
            onExportGenericThreeMfDownload={canExportDownload ? () => handleExportGenericThreeMfDownload(selectionFor(contextMenu.key)) : undefined}
            onExportGenericThreeMfToLibrary={canExportToLibrary ? () => setExportRequest({ kind: 'generic3mf', keys: selectionFor(contextMenu.key) }) : undefined}
            canRepair={(() => {
              const instance = activePlate?.instances.find((entry) => entry.key === contextMenu.key)
              return Boolean(instance && addedPartHostId(instance) != null)
            })()}
            onRepairMesh={handleRepairMesh}
            isRepairMarked={(() => {
              const instance = activePlate?.instances.find((entry) => entry.key === contextMenu.key)
              const state = stateRef.current
              const markId = instance ? addedPartHostId(instance) : null
              return Boolean(state && markId != null && isObjectMarkedForRepair(state, markId))
            })()}
            onAddPartVolume={(key, subtype, shape) => { void handleAddPartVolume(key, subtype, { kind: 'primitive', shape }) }}
            onAddPartFromFile={(key, subtype) => { setModelRequest({ kind: 'addPart', key, subtype }); fileInputRef.current?.click() }}
            onAddPartFromLibrary={canImportFromLibrary ? (key, subtype) => { setModelRequest({ kind: 'addPart', key, subtype }); setLibraryPickerOpen(true) } : undefined}
            filamentOptions={filamentOptions}
            onChangeMaterial={(filamentId) => reassignSelectionFilament(contextMenu.key, filamentId)}
            onSetPrintable={(printable) => handleSetPrintableSelection(selectionFor(contextMenu.key), printable)}
            // The clicked instance's own state, so the single-object menu offers the one action
            // that applies. Undefined for an instance the active plate no longer holds, which hides
            // the item rather than labelling it from a guess.
            printable={activePlate?.instances.find((instance) => instance.key === contextMenu.key)?.printable ?? null}
            onEditObjectSettings={perObject ? () => openObjectSettingsFor(contextMenu.key) : undefined}
            onEditLayerHeight={openLayerHeightFor}
            onEditHeightRanges={(key) => {
              const instance = stateRef.current?.plates
                .flatMap((plate) => plate.instances).find((entry) => entry.key === key)
              const hostId = instance ? addedPartHostId(instance) : null
              if (!instance || hostId == null) return
              setEditingHeightRanges({ key, objectId: hostId, name: instance.name })
            }}
            onCenterOnPlate={centerSelectionOnPlate}
            onDropToBed={handleDropToBed}
            onResetRotation={() => mutateSelectedGroup((group) => { rotorOf(group).rotation.set(0, 0, 0) })}
            onResetScale={() => mutateSelectedGroup((group) => { group.scale.set(1, 1, 1) })}
            onMirror={(axis) => mutateSelectedGroup((group) => { group.scale[axis] *= -1 })}
            onConvertUnits={handleConvertUnits}
            onScaleToPrintVolume={activePlate?.bed.maxZ != null ? handleScaleToPrintVolume : undefined}
            otherPlates={(state?.plates ?? []).filter((plate) => plate.index !== activePlateIndex)}
            onMoveToPlate={handleMoveToPlate}
            onDelete={handleDelete}
          />
        )}
        {/* ONE menu for every part of an object, whichever kind: a part is a part, whether it came
            out of the file or was added this session. Volumes used to have a menu of their own that
            had already drifted (it acted on one row even when several were selected), and export
            works for both because it world-bakes triangles out of the render group and needs no
            baked mesh entry. */}
        {contextMenu?.kind === 'parts' && (
          <EditorPartContextMenu
            contextMenu={contextMenu}
            count={contextMenu.members.length}
            listboxRef={contextMenuListboxRef}
            onClose={() => setContextMenu(null)}
            onChangeType={(subtype) => handleChangeMemberTypes(contextMenu.objectId, contextMenu.members, subtype)}
            filamentOptions={filamentOptions}
            materialAssignable={partsAcceptFilament(contextMenu.objectId, contextMenu.members)}
            onChangeMaterial={(filamentId) => handleChangeMemberFilament(contextMenu.objectId, contextMenu.members, filamentId)}
            onExportDownload={canExportDownload ? () => handleExportPartsDownload(contextMenu.objectId, contextMenu.members) : undefined}
            onExportToLibrary={canExportToLibrary ? () => setExportRequest({ kind: 'parts', ownerId: contextMenu.objectId, members: contextMenu.members }) : undefined}
            onEditSettings={perObject ? openPartSettingsForSelection : undefined}
            onDelete={partSelectionRemovable(contextMenu.objectId, contextMenu.members)
              ? () => handleRemoveParts(contextMenu.objectId, contextMenu.members)
              : undefined}
          />
        )}
      </ModalDialog>
    </Modal>

    <EditorSettingsDialog
      open={editorSettingsOpen}
      onClose={() => setEditorSettingsOpen(false)}
    />

    {presetManager?.({ open: slicingPresetsOpen, onClose: closeSlicingPresets })}

    {libraryPickerOpen && (
      <LibraryFilePickerDialog
        title={LIBRARY_PICKER_COPY[modelRequest?.kind ?? 'import'].title}
        description={LIBRARY_PICKER_COPY[modelRequest?.kind ?? 'import'].description}
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
          const request = modelRequest
          if (request?.kind === 'replace') void handleReplaceFromLibrary(request.key, file.id)
          else if (request?.kind === 'addPart') {
            setLibraryPickerOpen(false)
            setModelRequest(null)
            void handleAddPartVolume(request.key, request.subtype, { kind: 'library', libraryFileId: file.id })
          } else void handleImportFromLibrary(file.id)
        }}
        onClose={() => { setLibraryPickerOpen(false); setModelRequest(null) }}
      />
    )}

    {saveAsOpen && !savesToLocalFile && (
      <LibraryDestinationDialog
        title="Save as new file"
        description="Choose where to save the new file, then confirm the file name. Saving with an existing file's name replaces it."
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

    {exportRequest && (() => {
      // Suggested file name per request shape; null = no name field ('separate' names
      // each file after its object).
      const suggestedName = (() => {
        if (exportRequest.kind === 'separate') return null
        if (exportRequest.kind === 'parts') {
          const instance = activePlate?.instances.find((entry) => addedPartHostId(entry) === exportRequest.ownerId)
          // A session-added volume carries its own name (the text's string, "Cube", the solid's
          // label), which `partsExportName` uses in place of the ordinal a baked part is named by.
          return instance
            ? partsExportName(instance, exportRequest.members, effectiveAddedParts(state, instance))
            : ''
        }
        const key = exportRequest.kind === 'object' || exportRequest.kind === 'project' ? exportRequest.key : exportRequest.keys[0]
        return activePlate?.instances.find((entry) => entry.key === key)?.name ?? ''
      })()
      return (
        <LibraryDestinationDialog
          title={exportRequest.kind === 'project' ? 'Export object as 3MF'
            : exportRequest.kind === 'generic3mf' ? 'Export as generic 3MF'
            : exportRequest.kind === 'parts' ? 'Export parts as STL'
            : exportRequest.kind === 'separate' ? 'Export objects as STLs'
            : exportRequest.kind === 'merged' ? 'Export objects as one STL'
            : 'Export object as STL'}
          description={exportRequest.kind === 'project'
            ? "Choose where to save the new project, then confirm the file name. The object keeps its parts, materials, and paint. Saving with an existing file's name replaces it."
            : exportRequest.kind === 'generic3mf'
              ? "Choose where to save the exported 3MF, then confirm the file name. It holds geometry only, for opening in other slicers: materials, painting, and per-object settings are not included. Saving with an existing file's name replaces it."
              : exportRequest.kind === 'separate'
                ? 'Choose where to save the exported STLs, each selected object becomes its own file, named after the object. Existing files with the same names are replaced.'
                : "Choose where to save the exported STL, then confirm the file name. Saving with an existing file's name replaces it."}
          showFiles
          fileNameField={suggestedName === null ? undefined : {
            label: 'File name',
            initialValue: exportBaseName(suggestedName, exportRequest.kind === 'object' || exportRequest.kind === 'merged' || exportRequest.kind === 'parts' ? '.stl' : '.3mf'),
            extension: exportRequest.kind === 'project' || exportRequest.kind === 'generic3mf' ? '.3mf' : '.stl'
          }}
          initialFolderId={saveAsInitialFolderId}
          folders={editorFoldersQuery.data?.folders ?? []}
          bridgeId={saveAsBridgeId}
          bridgeName={null}
          showRoot
          dialogWidth={720}
          submitting={false}
          error={null}
          confirmActionLabel={({ outputFolderId, rootDestinationLabel }) => outputFolderId ? 'Export here' : `Export to ${rootDestinationLabel}`}
          onClose={() => setExportRequest(null)}
          onSubmit={({ outputFileName, outputFolderId }) => {
            if (exportRequest.kind === 'project') {
              // Server-side bake through the save pipeline (defined after this callback's
              // sibling handlers by the save hook, so it is dispatched here, not in
              // handleExportToLibrarySubmit).
              setExportRequest(null)
              if (outputFileName) handleExportObjectAs3mf(exportRequest.key, outputFileName, outputFolderId)
              return
            }
            handleExportToLibrarySubmit(outputFileName ?? null, outputFolderId)
          }}
        />
      )
    })()}

    {editingHeightRanges && (() => {
      const instance = stateRef.current?.plates
        .flatMap((plate) => plate.instances).find((entry) => entry.key === editingHeightRanges.key)
      if (!instance) return null
      const ranges = effectiveHeightRanges(stateRef.current, instance)
      // Bands are measured from the object's underside, so the bound is the model's own height,
      // not the plate's. Null when the group is not built yet: the dialog then leaves the top open.
      const group = groupByKeyRef.current.get(editingHeightRanges.key)
      const box = group ? printableMeshBox(group) : null
      const objectHeightMm = box ? box.max.z - box.min.z : null
      return (
        <HeightRangesDialog
          objectName={instance.name}
          ranges={ranges}
          objectHeightMm={objectHeightMm}
          defaultLayerHeightMm={defaultLayerHeightMm}
          hasLayerHeightProfile={effectiveLayerHeightProfile(stateRef.current, instance).length > 0}
          extraSettingCount={(range) => Object.keys(range.settings)
            .filter((key) => key !== 'layer_height' && key !== 'extruder').length}
          onChange={(next) => setObjectHeightRanges(editingHeightRanges.objectId, next)}
          onEditSettings={setEditingHeightRangeIndex}
          onClose={() => { setEditingHeightRanges(null); setEditingHeightRangeIndex(null) }}
        />
      )
    })()}
    {plateSettingsId != null && (() => {
      const plate = stateRef.current?.plates.find((entry) => entry.plateId === plateSettingsId)
      if (!plate) return null
      return (
        <PlateSettingsDialog
          plateLabel={plateDisplayName(plate.name, plate.index)}
          settings={{
            plateTypeOverride: plate.plateTypeOverride,
            printSequence: plate.printSequence,
            spiralMode: plate.spiralMode,
            locked: plate.locked
          }}
          // The same list the project-global selector offers: the TARGET PRINTER's supported bed
          // types, so a plate cannot be pinned to a surface the machine does not have.
          plateTypeOptions={sliceConfig?.plateTypeOptions ?? []}
          globalPlateType={sliceConfig?.plateType.trim() || null}
          // For the by-object skirt-collision warning. Null (no process context yet) means no
          // warning rather than a guessed one; the same shape the parameter table takes.
          processContext={perObject ? {
            slicerTargetId: perObject.slicerTargetId,
            processProfileId: perObject.processProfileId,
            sourceFileId: perObject.sourceFileId,
            resolveConfig: resolveProcessConfig
          } : null}
          globalProcessOverrides={perObject?.globalOverrides ?? EMPTY_OBJECT_OVERRIDES}
          onApply={(settings) => handleApplyPlateSettings(plate.plateId, settings)}
          onClose={() => setPlateSettingsId(null)}
        />
      )
    })()}
    {editingHeightRanges && editingHeightRangeIndex != null && perObject && (() => {
      const instance = stateRef.current?.plates
        .flatMap((plate) => plate.instances).find((entry) => entry.key === editingHeightRanges.key)
      if (!instance) return null
      const ranges = effectiveHeightRanges(stateRef.current, instance)
      const band = ranges[editingHeightRangeIndex]
      if (!band) return null
      const objectOverrides = perObject.value[String(editingHeightRanges.objectId)] ?? {}
      // `layer_height` is edited inline in the ranges dialog (every band must carry one), so it is
      // kept out of this catalog rather than offered twice with two sources of truth.
      const { layer_height: _inline, extruder: _material, ...tunable } = band.settings
      return (
        <ProcessSettingsDialog
          open
          applyScope="project"
          onClose={() => setEditingHeightRangeIndex(null)}
          slicerTargetId={perObject.slicerTargetId}
          processProfileId={perObject.processProfileId}
          processProfileName={`${instance.name} · ${band.minZ.toFixed(1)}-${band.maxZ.toFixed(1)} mm`}
          sourceFileId={perObject.sourceFileId}
          initialOverrides={tunable}
          visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}
          allowedKeys={HEIGHT_RANGE_TUNABLE_KEYS}
          baseOverlay={{ ...perObject.globalOverrides, ...objectOverrides }}
          resolveConfig={resolveProcessConfig}
          titlePrefix="Range settings"
          onApply={(overrides) => {
            const serialized: Record<string, string> = {}
            for (const [key, value] of Object.entries(overrides)) {
              serialized[key] = Array.isArray(value) ? value.join(';') : value
            }
            const next = ranges.map((range, index) => index === editingHeightRangeIndex
              ? {
                  ...range,
                  // The inline pair is authoritative and survives whatever the catalog returns.
                  settings: {
                    ...serialized,
                    layer_height: range.settings.layer_height ?? String(defaultLayerHeightMm),
                    extruder: range.settings.extruder ?? '0'
                  }
                }
              : range)
            setObjectHeightRanges(editingHeightRanges.objectId, next)
            setEditingHeightRangeIndex(null)
          }}
        />
      )
    })()}
    {parameterTableOpen && perObject && state && (
      <ParameterTableDialog
        open
        onClose={handleCloseParameterTable}
        state={state}
        objectOverrides={perObject.value}
        globalOverrides={perObject.globalOverrides}
        processContext={{
          slicerTargetId: perObject.slicerTargetId,
          processProfileId: perObject.processProfileId,
          sourceFileId: perObject.sourceFileId,
          resolveConfig: resolveProcessConfig
        }}
        onEditObject={handleEditObjectFromTable}
        onEditPart={handleEditPartFromTable}
        onSelectObject={handleSelectObjectFromTable}
      />
    )}
    {editingObject && perObject && (
      <ProcessSettingsDialog
        open
        applyScope="project"
        onClose={() => setEditingObject(null)}
        slicerTargetId={perObject.slicerTargetId}
        processProfileId={perObject.processProfileId}
        processProfileName={editingObject.name}
        sourceFileId={perObject.sourceFileId}
        initialOverrides={editingObjectMemberOverrides?.[0] ?? EMPTY_OBJECT_OVERRIDES}
        initialOverridesByMember={editingObjectMemberOverrides ?? undefined}
        visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}
        allowedKeys={PER_OBJECT_PROCESS_KEYS}
        baseOverlay={perObject.globalOverrides}
        resolveConfig={resolveProcessConfig}
        titlePrefix="Object settings"
        onApply={(overrides, { clearedKeys }) => {
          // Snapshot for undo (overrides live in the borrowed slice config, captured by the
          // slice-config history); recording also flags the project dirty so Save lights up / close warns.
          recordSliceConfigHistory()
          const next = { ...perObject.value }
          // Bulk apply (context menu on a multi-selection) MERGES the dialog result onto each
          // member: uniform values land on every selected object, reset keys are cleared
          // everywhere, and untouched "Mixed" keys keep each object's own value.
          for (const id of editingObject.ids) {
            // A cleared object keeps an EXPLICIT empty entry rather than being deleted. Absence
            // must never mean "delete this object's saved overrides": the map only ever holds the
            // objects currently in scope, so a deleted entry is indistinguishable from one the
            // user never opened, and the save used to strip both. See collectObjectProcessOverrides.
            next[String(id)] = applyBulkOverridesToMember(perObject.value[String(id)], overrides, clearedKeys)
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
      // parts selected (bulk), the dialog seeds from ALL of them: disagreements render as "Mixed"
      // and, untouched, each part keeps its own value on apply.
      // The two kinds keep their overrides in DIFFERENT homes, and that is the only thing this
      // dialog has to know about them: a baked part's live in `state.partProcessOverrides` keyed by
      // slot, a session-added volume's on the volume itself. Both are read here and written back
      // there, so a mixed selection edits in one pass and each member keeps its own values.
      const owner = stateRef.current?.plates.flatMap((plate) => plate.instances)
        .find((instance) => addedPartHostId(instance) === editingPart.objectId)
      const volumesByKey = new Map(
        (owner ? effectiveAddedParts(stateRef.current, owner) : []).map((part) => [part.key, part])
      )
      const overridesFor = (member: PartMember): Record<string, string | string[]> => (member.kind === 'baked'
        ? stateRef.current?.partProcessOverrides?.[partSlotKey(editingPart.objectId, member.partIndex)]
        : member.kind === 'added'
          ? volumesByKey.get(member.key)?.settings
          // The BODY's slot, which is the ordinal the bake promotes it into: the same map, the same
          // key shape, so its settings survive a save without being re-homed.
          : stateRef.current?.partProcessOverrides?.[partSlotKey(editingPart.objectId, BODY_PART_INDEX)]
        ) ?? EMPTY_OBJECT_OVERRIDES
      const objectOverrides = perObject.value[String(editingPart.objectId)] ?? {}
      const memberOverrides = editingPart.members.map(overridesFor)
      return (
        <ProcessSettingsDialog
          open
          applyScope="project"
          onClose={() => setEditingPart(null)}
          slicerTargetId={perObject.slicerTargetId}
          processProfileId={perObject.processProfileId}
          processProfileName={editingPart.name}
          sourceFileId={perObject.sourceFileId}
          initialOverrides={memberOverrides[0] ?? EMPTY_OBJECT_OVERRIDES}
          initialOverridesByMember={memberOverrides}
          visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}
          allowedKeys={PER_OBJECT_PROCESS_KEYS}
          baseOverlay={{ ...perObject.globalOverrides, ...objectOverrides }}
          resolveConfig={resolveProcessConfig}
          titlePrefix="Part settings"
          onApply={(overrides, { clearedKeys }) => {
            recordHistory()
            const serialized: Record<string, string> = {}
            // `;` for both kinds. The volume-only dialog this replaced joined on `,`, which was a
            // straightforward inconsistency rather than a rule about volumes: the two write the same
            // catalog into the same per-part `model_settings` block, so they cannot disagree about
            // how a vector is spelled.
            for (const [key, value] of Object.entries(overrides)) serialized[key] = Array.isArray(value) ? value.join(';') : value
            setState((current) => {
              if (!current) return current
              const map = { ...(current.partProcessOverrides ?? {}) }
              // Merge per member (uniform values + cleared keys; untouched "Mixed" keys survive).
              // A cleared baked part keeps an EXPLICIT empty entry. Its source `<part>` still has
              // the old metadata until save, so deleting the session entry makes the collector
              // read "nothing changed" and the old value returns on reopen. Added volumes have no
              // source metadata to clear and can continue to omit an empty settings object.
              for (const member of editingPart.members) {
                if (member.kind === 'baked') {
                  const slot = partSlotKey(editingPart.objectId, member.partIndex)
                  const merged = applyBulkOverridesToMember(map[slot], serialized, clearedKeys)
                  map[slot] = merged
                  continue
                }
                if (member.kind === 'body') {
                  const slot = partSlotKey(editingPart.objectId, BODY_PART_INDEX)
                  const merged = applyBulkOverridesToMember(map[slot], serialized, clearedKeys)
                  map[slot] = merged
                  continue
                }
                // A volume owns its settings, so this writes through the same in-place mutation the
                // rest of the added-part seams use; the state identity below is what re-renders it.
                const volume = volumesByKey.get(member.key)
                if (!volume) continue
                const merged = applyBulkOverridesToMember(volume.settings, serialized, clearedKeys)
                if (Object.keys(merged).length === 0) delete volume.settings
                else volume.settings = merged
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

// The filament-option shape moved to the core PlateGcodeSections module (the prepare-print
// dialog shares it); re-exported here so the plugin's many type-importers keep one path.
export type { FilamentOption } from '../../components/library/PlateGcodeSections'

/**
 * Re-render the editor ONLY when its own data changes, never on a parent re-render driven by live
 * printer-status WS pushes. The host (LibraryView/SliceFileModal) re-renders ~once a second while a
 * printer is connected (status updates); it rebuilds the borrowed `sliceConfig` and the editor
 * callbacks by identity each time, which, without this gate, re-rendered the whole editor and
 * interrupted camera orbit / object drags every second. Once the editor is open it doesn't care about
 * printer status; the only host-driven thing that legitimately changes is the loaded-materials list,
 * which lives in `sliceConfig` and is caught by the content compare below.
 *
 * Callback identity (onApply/onClose/onSlice/onSaved) is intentionally ignored:
 * they're rebuilt every parent render, but the editor invokes them only on real user interactions,
 * which always follow a data change (so a fresh closure has already been delivered). Internal editor
 * state changes still re-render normally: React.memo only gates parent-prop-driven re-renders.
 */
const EDITOR_DATA_PROP_KEYS = [
  'baseFileId', 'isNewProject', 'baseVersionId', 'currentEdit', 'initialPlateIndex', 'targetPrinterModel',
  'folderId', 'bridgeId', 'canSlice', 'sliceDisabledReason', 'slicing'
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
