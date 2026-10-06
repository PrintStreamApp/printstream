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
  Chip,
  CircularProgress,
  DialogActions,
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
import * as THREE from 'three'
import { OrbitControls, TransformControls } from 'three-stdlib'
import type { OrbitPivotBounds } from './lib/viewportCamera'
import type {
  SceneEdit,
  SceneEditFlushVolumes,
  SceneEditPartSubtype,
  StagedImport
} from '@printstream/shared'
import {
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_UPLOAD_PERMISSION,
  readProjectFlushContext,
  type ThreeMfSettingsRepairReason
} from '@printstream/shared'
import {
  TEXT_INFO_DEFAULTS,
  TEXT_INFO_DEFAULT_SURFACE_TYPE,
} from '@printstream/shared/three-mf'
import { useFlushCalibration, useFlushDatasets } from './lib/flushDatasets'
import { buildEditorSceneEdit } from './lib/editorSceneEditOutput'
import { commitEditorObjectAssembly } from './lib/editorObjectAssembly'
import { performEditorDeleteShortcut } from './lib/editorDeleteShortcut'
import { discardedHelperVolumeNotice } from './lib/editorGeometryActionMessages'
import { changeEditorMemberTypes } from './lib/editorMemberChanges'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { toast } from '../../lib/toast'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { DialogFileTitle } from '../../components/DialogFileTitle'
import { EmptyState } from '../../components/EmptyState'
import { RepairProjectSettingsAlert } from '../../components/library/RepairProjectSettingsAlert'
import { ProjectVersionWarningAlert } from '../../components/library/ProjectVersionWarningAlert'
import { LibraryFilePickerDialog } from '../../components/LibraryFilePickerDialog'
import { LibraryDestinationDialog } from '../../components/LibraryDestinationDialog'
import { formatLibraryFileName, splitLibraryFileNameForRename } from '../../lib/libraryDisplay'
import { useBedAppearance } from './useBedAppearance'
import { EditorSettingsDialog } from '../../components/library/EditorSettingsDialog'
import { SliceSettingsPanel, type SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { EditorPreparationDialog } from './EditorPreparationDialog'
import { useEditorPreparation } from './useEditorPreparation'
import { useEditorProjectSession } from './useEditorProjectSession'
import { useEditorMaterialUsage } from './useEditorMaterialUsage'
import { useEditorSettingsRepair } from './useEditorSettingsRepair'
import type { FilamentConfigResolver } from '../../components/library/FilamentSettingsDialog'
import { StickySectionHeader, StickySectionScope } from '../../components/library/StickySectionHeader'
import { useEditorLayerHeightEditing } from './useEditorLayerHeightEditing'
import { TextToolPanel } from './TextToolPanel'
import { DEFAULT_TEXT, type TextToolValue } from './lib/textToolValue'
import { changeEditorToolMode } from './lib/editorToolModeChange'
import {
  findEditorAddedSvgPart,
  findEditorAddedTextPart,
  findEditorBakedAuthoredPart
} from './lib/editorAuthoredPartLookup'
import { buildTextPlacement as placeTextOnHost } from './lib/textPlacement'
import { removeEditorText } from './lib/editorTextRemoval'
import { useEditorTextLivePlacement } from './useEditorTextLivePlacement'
import { useEditorTextHighlight } from './useEditorTextHighlight'
import { useEditorTextCommit } from './useEditorTextCommit'
import { useEditorToolModeLifecycle } from './useEditorToolModeLifecycle'
import { useEditorPlateBandUniforms } from './useEditorPlateBandUniforms'
import { useEditorRotationSnap } from './useEditorRotationSnap'
import { useEditorPlaceOnFaceOverlay } from './useEditorPlaceOnFaceOverlay'
import {
  BUNDLED_FAMILIES,
  bundledFace,
  loadBundledFont,
  parsedFont,
  type TextFontFace
} from './lib/textFonts'
import { moveEditorPrimeTower } from './lib/primeTowerReach'
import type { AddedPartSource } from './lib/addedParts'
import { commitEditorPartVolume } from './lib/editorPartVolumeCommit'
import { useEditorInstanceInsertion } from './useEditorInstanceInsertion'
import { useEditorObjectListProcessSettings } from './useEditorObjectListProcessSettings'
import { attachEditorPaintOverlay, effectiveEditorPaintCodes } from './lib/editorPaintOverlay'
import {
  VIEW_CUBE_EDGE_INSET,
  VIEW_CUBE_HINT,
  VIEW_CUBE_SIZE,
  type ViewPreset
} from './lib/viewCube'
import { useInitialLibraryImport } from './useInitialLibraryImport'
import { useEditorPlatePacking } from './useEditorPlatePacking'
import { useEditorPlateManagement } from './useEditorPlateManagement'
import type { PlacementFootprintCache } from './lib/editorPlacementWarnings'
import { resolveImportFileSelection, takeSelectedImportFiles } from './lib/importFileSelection'
import {
  addedPartHostId,
  bodyPartSubtype,
  effectiveAddedParts,
  effectiveFilamentChanges,
  effectivePauses,
  nextInstanceKey,
  type EditorBrimEar,
  type EditorInstance,
  type EditorPlate,
  type EditorState,
  isObjectMarkedForRepair,
  locateObjectForReveal
} from './lib/editorModel'
import { collectEditorHelperVolumes } from './lib/editorHelperVolumeCollection'
import { LazyDialogBoundary } from '../../components/LazyDialogBoundary'
import { dialogPresentationProps } from '../../lib/dialogPresentation'
import { useShowBedModel } from './lib/useShowBedModel'
import { buildEditorGridLayout, EDITOR_GRID_GAP_PX } from './lib/editorChromeLayout'
import { useEditorChromeLayout } from './useEditorChromeLayout'
import { prepareEditorObjectTransform, writeBackEditorObjectTransform } from './lib/editorObjectTransformWriteback'
import { useMirroredRef } from '../../hooks/useMirroredRef'
import {
  createApiImportStore
} from './lib/editorImports'
import { importFileAccept, type EditorImportStore } from './lib/editorImportStore'
import type { EditorProjectSource } from './lib/editorProjectSource'
import type { EditorSaveTarget } from './lib/editorSaveTarget'
import { connectorProblemSummary } from './lib/cutConnectors'
import { stlExportBaseName } from './lib/objectExport'
import { useEditorObjectExport, type EditorExportRequest } from './useEditorObjectExport'
import { useEditorInstanceSelectionActions } from './useEditorInstanceSelectionActions'
import { createEditorIndependentCopyImports } from './lib/editorIndependentCopyImports'
import { useEditorObjectDuplication } from './useEditorObjectDuplication'
import { useEditorPartRemoval } from './useEditorPartRemoval'
import { createEditorInstanceGroupBuilder } from './lib/editorInstanceGroup'
import {
  type TextInteraction,
  TRIANGLE_PAINT_CHANNELS,
  RESTING_GIZMO_MODE,
  isTransformGizmoMode,
  printableMeshBox,
  rotorOf,
  setObjectPrintedStyle,
  type GeometryCache,
  type GizmoMode,
  type ImportGeometryCache,
  type PlacementWarning,
  type SelectedTransform
} from './editorGeometry'
import { useEditorKeyboardShortcuts } from './useEditorKeyboardShortcuts'
import { useEditorManualTransforms } from './useEditorManualTransforms'
import { useEditorObjectPlacement } from './useEditorObjectPlacement'
import {
  AddObjectMenu,
  isImportableLibraryFile,
  ObjectList,
  PlateThumbnailStrip,
  SaveMenuButton,
  SliceMenuButton,
  LiveTransformPanel
} from './editorPanels'
import { PlateFilamentChangesSection, PlatePausesSection } from '../../components/library/PlateGcodeSections'
import { editorMaterialsFromSliceConfig, type EditorMaterials } from './lib/editorMaterials'
import { BrimEarsPanel } from './BrimEarsPanel'
import { CutToolPanel } from './CutToolPanel'
import { EditorHeightRangesDialog } from './EditorHeightRangesDialog'
import { EditorPlateSettingsDialog } from './EditorPlateSettingsDialog'
import { ProjectAuxiliariesDialog } from './ProjectAuxiliariesDialog'
import { EditorLayerHeightToolPanel } from './EditorLayerHeightToolPanel'
import { SvgToolPanel } from './SvgToolPanel'
import { detectSvgBackgroundPiece, svgHeightMm } from './lib/svgGeometry'
import { useEditorSvgArtwork } from './useEditorSvgArtwork'
import { commitEditorSvgArtwork } from './lib/editorSvgCommit'
import { commitEditorCut } from './lib/editorCutAction'
import { EditorContextMenu } from './EditorContextMenu'
import { EditorPartContextMenu } from './EditorPartContextMenu'
import { useEditorContextMenuSession } from './useEditorContextMenuSession'
import { useEditorSelectionSession } from './useEditorSelectionSession'
import { defaultEditorLayerHeightMm, firstEditorLayerHeightMm } from './lib/editorLayerHeightSettings'
import { editorFilamentNozzleMap, editorInstanceNozzles } from './lib/editorNozzleReach'
import { EditorPlacementWarnings } from './EditorPlacementWarnings'
import { useEditorSidebarSelectionActions } from './useEditorSidebarSelectionActions'
import { useEditorFilamentSaveAuthoring } from './useEditorFilamentSaveAuthoring'
import { computeEditorSelectedTransform as computeSelectedTransform } from './lib/editorSelectedTransform'
import { renameEditorObjectInstances } from './lib/editorObjectRename'
import { editorObjectProcessSettingsTarget } from './lib/editorObjectProcessSettings'
import { editorPartProcessSettingsTarget } from './lib/editorPartProcessSettings'
import { useEditorProcessOverrideHydration } from './useEditorProcessOverrideHydration'
import { useEditorSourceSceneHydration } from './useEditorSourceSceneHydration'
import { useEditorPlateSceneQueries } from './useEditorPlateSceneQueries'
import { useEditorLibraryFileMetadata } from './useEditorLibraryFileMetadata'
import { EditorPartProcessSettingsDialog } from './EditorPartProcessSettingsDialog'
import { EditorObjectProcessSettingsDialog } from './EditorObjectProcessSettingsDialog'
import { EditorHeightRangeProcessSettingsDialog } from './EditorHeightRangeProcessSettingsDialog'
import { EditorExportDestinationDialog } from './EditorExportDestinationDialog'
import { TOOL_PANEL_Z_INDEX, VIEWPORT_AID_Z_INDEX } from './editorLayers'
import { EditorViewportControls } from './EditorViewportControls'
import { attachEditorGizmo } from './lib/editorGizmoAttachment'
import { ownerPartMembers } from './lib/editorPartSelectionAction'
import { useEditorPlateThumbnails } from './useEditorPlateThumbnails'
import { useEditorPlateEdits } from './useEditorPlateEdits'
import { useEditorObjectOrdering } from './useEditorObjectOrdering'
import { useEditorActivePlateBuild } from './useEditorActivePlateBuild'
import { useEditorMaterialSceneSync } from './useEditorMaterialSceneSync'
import { useEditorPrimeTowerSync } from './useEditorPrimeTowerSync'
import { useEditorTransformSceneSync } from './useEditorTransformSceneSync'
import type { EditorSliceRequest } from './lib/editorSlicePreparation'
import { writeBackEditorPartTransform } from './lib/editorPartTransformWriteBack'
import {
  selectionHasMember,
  type PartMember,
  type PartRef
} from './lib/selectionModel'
import { MeasurePanel } from './MeasurePanel'
import { routeEditorModalClose } from './lib/editorModalClose'
import { MeshBooleanPanel } from './MeshBooleanPanel'
import { useEditorMeshBoolean } from './useEditorMeshBoolean'
import { SimplifyPanel } from './SimplifyPanel'
import { useEditorSimplify } from './useEditorSimplify'
import { PaintToolPanel } from './PaintToolPanel'
import { SourceColorImportDialog } from './SourceColorImportDialog'
import { supportsSourceColorGamma } from './lib/sourceColorImport'
import { useEditorSourceColorImport } from './useEditorSourceColorImport'
import { useEditorModelImportActions } from './useEditorModelImportActions'
import { useEditorShellSplit } from './useEditorShellSplit'
import { useEditorPartTypeChanges } from './useEditorPartTypeChanges'
import { useEditorMaterialAssignments } from './useEditorMaterialAssignments'
import { useEditorBrimEarActions } from './useEditorBrimEarActions'
import { useEditorMeasurementOverlay } from './useEditorMeasurementOverlay'
import { useEditorCutConnectorOverlay } from './useEditorCutConnectorOverlay'
import { useEditorCutPlanePreview } from './useEditorCutPlanePreview'
import { useEditorCutConnectorSession } from './useEditorCutConnectorSession'
import { replaceEditorGeometry, type SourceColorPaintCommit } from './lib/editorGeometryReplacement'
import { useEditorHistory } from './useEditorHistory'
import { useEditorPaint } from './useEditorPaint'
import { useEditorSave } from './useEditorSave'
import type { EditorContentBasePin } from './lib/contentBasePin'
import { useEditorScene } from './useEditorScene'
import { useEditorMeasurement } from './useEditorMeasurement'
import { useEditorCutConfiguration } from './useEditorCutConfiguration'
import { useEditorGeometryLoaders } from './useEditorGeometryLoaders'
import { useEditorAddedPartMeshes } from './useEditorAddedPartMeshes'
import { useEditorMachineSwitchWarnings } from './useEditorMachineSwitchWarnings'

import type { ProcessConfigResolver } from '../../components/ProcessSettingsDialog'
import { ViewportBuildOverlay } from './ViewportBuildOverlay'
import { EditorOpeningStatus } from './EditorOpeningStatus'
// Same treatment: it pulls in the whole grid and is opened rarely, so it must not ride the
// editor's own chunk.
const ParameterTableDialogImpl = lazy(() => import('./ParameterTableDialog'))

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
  /** Library model to import once into a newly created project after its scene is ready. */
  initialImportFileId?: string
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
  /** Notify the host that a retained slice result no longer represents the editor. */
  onSliceInputChanged?: () => void
  /**
   * Slice a single 1-based plate without persisting a project; the host opens a results dialog that
   * can save/print.
   *
   * `contentBase` is the session's pinned base (`contentBasePin.ts`) and the host MUST forward it:
   * the `sceneEdit` is a diff against those bytes, so a slice that resolved the file's CURRENT
   * content would re-apply an edit an earlier save already baked in. See `EditorSave.contentBase`.
   */
  onSlice?: (opts: EditorSliceRequest) => void | Promise<void>
}

/** Stable empty per-object overrides so the override editor doesn't re-fetch each render. */

/**
 * Shared empty list for the repair reasons.
 *
 * A `?? []` fallback mints a new array on every render, and the no-defect case is the common one,
 * so the reasons -- and everything memoised on them, up to the settings panel's whole controller
 * object -- would have been unstable exactly when there was nothing to report.
 */

/**
 * Trailing delay before a filament-swatch edit is mirrored into the plate-strip thumbnail. The
 * colour picker commits on every drag tick and a snapshot is a full offscreen render plus a
 * synchronous `toDataURL` readback, so only the settled colour is worth rendering.
 */

/**
 * What the next picked model file is for. The library picker and the hidden file input are shared
 * by three flows (add a model to the plate, replace a model's geometry, add a part inside a model),
 * so the pending request decides where the staged import lands. Absent = add to the plate.
 */
type ModelSourceRequest =
  | { kind: 'replace'; key: string }
  | { kind: 'addPart'; key: string; subtype: SceneEditPartSubtype }

/** Library-picker copy per {@link ModelSourceRequest} kind ('import' = no pending request). */
const LIBRARY_PICKER_COPY: Record<'import' | ModelSourceRequest['kind'], { title: string; description: string }> = {
  import: {
    title: 'Add from library',
    description: 'Choose an STL, STEP, 3MF, OBJ, glTF, AMF, or FBX file to add to this project.'
  },
  replace: {
    title: 'Replace from library',
    description: 'Choose an importable model to swap in for the selected object, its position and settings are kept.'
  },
  addPart: {
    title: 'Add part from library',
    description: 'Choose an importable model to add as a part inside the selected object.'
  }
}

function EditorView({
  baseFileId,
  isNewProject: isNewProjectScaffold = false,
  baseVersionId = null,
  initialPlateIndex,
  initialImportFileId,
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
  onSliceInputChanged,
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
  const { confirm, promptText } = usePromptDialog()
  const [viewerContainer, setViewerContainer] = useState<HTMLDivElement | null>(null)
  const [viewCubeContainer, setViewCubeContainer] = useState<HTMLDivElement | null>(null)
  const [state, setState] = useState<EditorState | null>(null)
  const [projectAuxiliariesOpen, setProjectAuxiliariesOpen] = useState(false)
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
  const {
    projectOpenPhase,
    projectDownloadProgress,
    projectSource,
    projectSourceRef,
    projectNameRef,
    effectiveSaveTarget,
    savesToLocalFile,
    platesQuery,
    embeddedPresetsQuery,
    projectSettingsQuery,
    projectAuxiliariesQuery
  } = useEditorProjectSession({
    baseFileId,
    baseVersionId,
    resourceBase,
    hasNoBaseFile,
    projectAuxiliariesOpen,
    projectSourceProp,
    importStore,
    saveTarget
  })
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
      const codes = effectiveEditorPaintCodes(mesh, paintKey, channel, stateRef.current)
      attachEditorPaintOverlay(mesh, channel, codes, {
        activeChannel: activePaintChannelRef.current,
        selected: instanceKey === selectedKeyRef.current,
        colorForState: colorPaintStateColor
      })
    }
    // The two refs are declared LATER in this component (they come out of the paint hook), so they
    // cannot be listed here even though the body reads them. That is sound: a ref's identity never
    // changes, and this body only runs during an async plate build, long after both exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorPaintStateColor])

  const filamentOptions = materials.options
  // Live geometry, paint and process usage determines whether deletion needs a replacement.
  // Stable keys keep the memoized settings controller unchanged during unrelated scene drags.
  // Settings-only usage remains distinct for the materials summary, but also requires confirmation.
  const {
    usedFilamentIds,
    supportOnlyFilamentIds,
    unverifiedFilamentIds,
    paintCommittedRef,
    setSourceScenesReadyFor
  } = useEditorMaterialUsage({ state, sliceConfig, platesQuery, projectSource, hasNoBaseFile })
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
  const { geometry: bedModelGeometry, texture: bedTexture } = useBedAppearance({
    enabled: showBedModel,
    printerModel: targetPrinterModel,
    slicerTargetId: sliceConfig?.selectedSlicerTargetId ?? null,
    machineProfileId: sliceConfig?.selectedMachineProfile?.id ?? null,
    updatedAt: sliceConfig?.selectedMachineProfile?.updatedAt,
    basePath: bedModelPath
  })
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false)
  // The preset manager is its own dialog, supplied by the host and reached from the sidebar's
  // "Manage" action; the gear opens editor settings. Deliberately no path from one to the other:
  // see EditorSettingsDialog.
  const [slicingPresetsOpen, setSlicingPresetsOpen] = useState(false)
  const openSlicingPresets = useCallback(() => setSlicingPresetsOpen(true), [])
  const {
    cutAxis, setCutAxis, cutOffset, setCutOffset, cutRange, setCutRange,
    cutKeepUpper, setCutKeepUpper, cutKeepLower, setCutKeepLower,
    cutOrientUpper, setCutOrientUpper, cutOrientLower, setCutOrientLower,
    cutting, setCutting, cutMode, setCutMode, groove, setGroove,
    setCutObjectSize, grooveSizedForRef, clampedCutOffset,
    grooveSizeLimits, connectorSizeLimits
  } = useEditorCutConfiguration()
  const {
    measurePoints,
    setMeasurePoints,
    measurePointsRef,
    addMeasurePointRef,
    measureCentreTargetsRef,
    measureResult,
    resetSlot: resetMeasureSlot,
    clear: clearMeasurement
  } = useEditorMeasurement(gizmoMode, activePlateIndex)
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
  useEditorMachineSwitchWarnings({
    targetPrinterModel,
    placementWarnings,
    sceneReady,
    viewportBuilding,
    layerHeight: sliceConfig?.selectedProcessProfile?.layerHeight ?? null,
    machineProfile: sliceConfig?.selectedMachineProfile ?? null
  })
  // Forces an immediate placement-warning recompute, bypassing the rAF poll's per-frame gate.
  // The poll (in useEditorScene) only refreshes warnings ~4x/sec and is skipped while a drag
  // flag is set; the plate-build effect calls this right after a rebuild so undo/redo/delete/
  // duplicate reflect in the warning panel instantly instead of lagging (or, if a drag flag is
  // ever left stuck, never catching up). Assigned by useEditorScene.
  const recomputeWarningsRef = useRef<() => void>(() => undefined)
  // Cached XY footprints shift on a move and re-rasterize on rotor changes or scene rebuilds.
  const footprintCacheRef = useRef<PlacementFootprintCache>(new Map())
  const [importing, setImporting] = useState(false)
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
  const replaceWithStagedRef = useRef<(
    key: string,
    staged: StagedImport,
    sourceColorPaint?: SourceColorPaintCommit,
    options?: { recordHistory?: boolean }
  ) => boolean>(() => false)
  // What the next picked library file / uploaded local file is FOR. The library picker and the
  // hidden file input are shared by three flows, so the pending request, not a boolean each,
  // decides where the staged import lands. Null means "add it to the plate as a new model".
  const [modelRequest, setModelRequest] = useState<ModelSourceRequest | null>(null)
  // Pending export-to-library request (destination dialog open). 'object'/'merged'/'parts'
  // save one named STL; 'separate' saves one STL per selected object (no name field,
  // each file is named after its object). Downloads never set this; they run immediately.
  const [exportRequest, setExportRequest] = useState<EditorExportRequest | null>(null)
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
    return defaultEditorLayerHeightMm(perObject?.globalOverrides)
  }, [perObject])
  /**
   * The machine's first-layer height. Every layer-height profile must START with exactly this or
   * BambuStudio discards the whole curve and silently reverts the object to uniform layers
   * (`PrintObject.cpp:3341` compares it with `!=`), so it is threaded into every generator.
   */
  const firstLayerHeightMm = useMemo(() => {
    return firstEditorLayerHeightMm(perObject?.globalOverrides, defaultLayerHeightMm)
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
  const {
    sidebarSide, sidebarWidth, resizeHandleProps, isMobile,
    sidebarCollapsed, setSidebarCollapsed, presentation, fullScreen,
    setFullScreen, showEditorChrome, showSidebar, setBodyNode,
    plateStripOrientation, mobileView, setMobileView
  } = useEditorChromeLayout({ hosting })
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
    revision: historyRevision,
    canUndo,
    canRedo,
    undo,
    redo,
    undoRef,
    redoRef,
    recordHistory,
    recordHistoryRef,
    recordCombinedHistory,
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
    unverifiedFilamentIds,
    supportOnlyFilamentIds,
    // A scaffold has no machine of its own, so its SEEDED target is unsaved work from the start
    // (no baseline is captured until the first save): see the retarget-signature block.
    editorBorn: isNewProject
  })
  useEffect(() => {
    onSliceInputChanged?.()
  }, [activePlateIndex, historyRevision, onSliceInputChanged])
  // Read through a ref so the save handler stays stable (it is built far below, and the history
  // action is re-created per render), the same shape as recordHistoryRef/undoRef.
  const rebaseHistoryFilamentSourcesRef = useRef(rebaseHistoryFilamentSources)
  rebaseHistoryFilamentSourcesRef.current = rebaseHistoryFilamentSources

  const {
    baseFileQuery,
    saveAsBridgeId,
    saveAsInitialFolderId,
    saveAsSuggestedName,
    projectName,
    openedArchivedVersion,
    settingsRepairReasons,
    unrepairableRepairReasonsResolved,
    editorFoldersQuery
  } = useEditorLibraryFileMetadata({
    baseFileId,
    baseVersionId,
    isNewProject,
    bridgeId,
    folderId,
    sourceIndex: platesQuery.data,
    repairReasons,
    unrepairableRepairReasons,
    state
  })
  projectNameRef.current = projectName

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

  const {
    plateIndices,
    preferredPlateIndex,
    initialSceneQuery,
    initialSceneSettled,
    restPlateIndices,
    restScenesQuery,
    scenesByPlate
  } = useEditorPlateSceneQueries({
    sourceIndex: platesQuery.data,
    initialPlateIndex,
    baseFileId,
    baseVersionId,
    targetPrinterModel,
    hasNoBaseFile,
    projectSource
  })

  const pendingScenePlatesRef = useEditorSourceSceneHydration({
    hasNoBaseFile,
    sourceIndex: platesQuery.data,
    initialSceneSettled,
    scenesByPlate,
    preferredSourceIndex: preferredPlateIndex,
    stateRef,
    setState,
    setActivePlateIndex,
    setRebuildToken
  })

  useEditorProcessOverrideHydration({ scenesByPlate, sliceConfigRef, stateRef, setState })

  // The first plate seeds before the others arrive. Keep source materials guarded until all
  // scenes have been merged, including their object and part assignments and process overrides.
  useEffect(() => {
    if (!initialSceneQuery.isSuccess) return
    if (restPlateIndices.length > 0 && !restScenesQuery.isSuccess) return
    if (pendingScenePlatesRef.current.size > 0) return
    setSourceScenesReadyFor(projectSource)
  }, [initialSceneQuery.isSuccess, restPlateIndices.length, restScenesQuery.isSuccess,
    scenesByPlate, pendingScenePlatesRef, projectSource, setSourceScenesReadyFor])

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
  filamentNozzleRef.current = editorFilamentNozzleMap(activePlate, platesQuery.data?.plates)
  // The set of nozzles an instance uses (across its parts), via the filament map.
  const instanceNozzlesRef = useRef<(instance: EditorInstance) => Set<number>>(() => new Set())
  instanceNozzlesRef.current = (instance: EditorInstance) =>
    editorInstanceNozzles(instance, filamentNozzleRef.current)

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
  // Live printable footprint used by the shared overview/detail orbit-pivot policy.
  const bedBoundsRef = useRef<OrbitPivotBounds | null>(null)
  const {
    selectedKeyRef,
    extraSelectedKeys,
    setExtraSelectedKeys,
    extraSelectedKeysRef,
    partSelection,
    setPartSelection,
    partSelectionRef,
    objectAnchorKeyRef,
    partAnchorRef,
    selectExclusive,
    selectExclusiveRef,
    toggleAdditiveSelection,
    toggleAdditiveSelectionRef,
    allSelectedKeys,
    allSelectedKeysRef
  } = useEditorSelectionSession({
    activePlateIndex,
    state,
    stateRef,
    selectedKey,
    setSelectedKey,
    setGizmoPart
  })
  partSelectedRef.current = partSelection != null || gizmoPart != null
  // Latest gizmo mode for non-React pointer/keyboard handlers.
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
  const reattachGizmoRef = useRef<() => void>(() => undefined)
  // Commits a dragged prime-tower position back into state (rebound below).
  const movePrimeTowerRef = useRef<((x: number, y: number) => void) | null>(null)

  const {
    contextMenu,
    setContextMenu,
    openContextMenuRef,
    contextMenuListboxRef,
    contextMenuOpenRef,
    suppressEditorEscapeRef
  } = useEditorContextMenuSession({ allSelectedKeysRef, selectExclusiveRef })

  // Latest panel-sync + rotation-readout callbacks for non-React handlers.
  const syncSelectedTransformRef = useRef<((object: THREE.Object3D) => void) | null>(null)
  const setRotationReadoutRef = useRef<((angleDeg: number | null) => void) | null>(null)
  // Setter published by the isolated LiveTransformPanel so drag-frequency readout updates bypass
  // EditorView's render (and the many-part sidebar). Null while no transform readout is mounted.
  const transformReadoutSetterRef = useRef<((value: SelectedTransform | null) => void) | null>(null)
  setRotationReadoutRef.current = setRotationReadout
  const regenerateActiveThumbnailRef = useRef<(() => void) | null>(null)

  const { fetchGeometry, fetchImportGeometry } = useEditorGeometryLoaders(
    projectSource,
    importStore,
    geometryCacheRef,
    importGeometryCacheRef
  )

  const layerBandUniformsRef = useEditorPlateBandUniforms({
    activePlate,
    state,
    filamentColors,
    resolveColorFilamentId
  })

  // The group builder reads this stable ref after async geometry loads complete. The hook also
  // owns the version signal that tells the sidebar and gizmo about in-place part changes.
  const {
    addedPartMeshVersion,
    setAddedPartMeshVersion,
    setGroupAddedPartMeshesRef,
    refreshAddedPartMeshes,
    refreshAddedPartMeshesRef
  } = useEditorAddedPartMeshes({
    stateRef,
    groupsRef: groupByKeyRef,
    activePlateRef,
    resolveColorFilamentIdRef,
    filamentColorsRef,
    layerBandUniformsRef,
    seedPaintOverlays
  })

  // Rebinds below (defined after buildInstanceGroup); a ref so the builder can
  // attach brim-ear markers without a circular declaration.
  const setGroupBrimEarMarkersRef = useRef<((group: THREE.Group, ears: EditorBrimEar[]) => void) | null>(null)

  // Keep the builder's identity stable across swatch and state edits. Its getters read the
  // current refs when each async mesh load completes; geometry loaders and paint seeding are
  // the only changing inputs that can replace the builder itself.
  const buildInstanceGroup = useMemo(() => createEditorInstanceGroupBuilder({
    getState: () => stateRef.current,
    resolveColorFilamentId: (id) => resolveColorFilamentIdRef.current(id),
    getFilamentColors: () => filamentColorsRef.current,
    getLayerBandUniforms: () => layerBandUniformsRef.current,
    fetchGeometry,
    fetchImportGeometry,
    seedPaintOverlays,
    addBrimEarMarkers: (group, ears) => setGroupBrimEarMarkersRef.current?.(group, ears),
    addSessionPartMeshes: (group, instance) => setGroupAddedPartMeshesRef.current?.(group, instance)
  }), [seedPaintOverlays, fetchGeometry, fetchImportGeometry, layerBandUniformsRef,
    setGroupAddedPartMeshesRef])

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
  const reseatSettleRef = useRef<number | undefined>(undefined)
  const {
    svgTool, setSvgTool, svgArtwork, svgFileName, svgMarkup, svgEmptyReason,
    reeditSvgRef, reeditSvgCount, archiveEntriesRef, svgInputRef,
    chooseFile: handleChooseSvgFile,
    fileChosen: handleSvgFileChosen,
    reopenArtwork: reopenSvgArtwork,
    clearReedit: clearSvgReedit
  } = useEditorSvgArtwork({
    active: gizmoMode === 'svg', projectSourceRef, stateRef, setImporting
  })
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
  const applyTextPartRef = useRef<(() => Promise<void>) | null>(null)

  /** Persist an added part or baked part after its gizmo drag. */
  const writeBackPartMesh = useCallback((mesh: THREE.Object3D) => {
    writeBackEditorPartTransform(mesh, {
      state: stateRef.current,
      selectedPart: gizmoPartRef.current,
      activePlate: activePlateRef.current,
      groupByKey: groupByKeyRef.current,
      reseatDraggedText: reseatDraggedTextRef.current
    })
  }, [])
  const writeBackPartMeshRef = useRef(writeBackPartMesh)
  writeBackPartMeshRef.current = writeBackPartMesh

  const {
    cutConnectors,
    setCutConnectorMode,
    cutConnectorFace,
    setCutConnectorFace,
    connectorSettings,
    cutSoup,
    setCutSoup,
    placingConnectors,
    activeConnectors,
    activeProblems,
    cutConnectorModeRef,
    cutConnectorTargetsRef,
    cutPlaneMeshRef,
    connectorGhostRef,
    editCutConnectorsRef,
    hoverCutConnectorRef,
    applyConnectorSettings,
    clearCutConnectors
  } = useEditorCutConnectorSession({
    gizmoMode,
    selectedKey,
    cutMode,
    cutAxis,
    clampedCutOffset,
    setCutAxis
  })

  useEditorCutConnectorOverlay({
    sceneRef,
    groupByKeyRef,
    selectedKey,
    gizmoMode,
    cutSoup,
    placingConnectors,
    cutAxis,
    clampedCutOffset,
    cutConnectorFace,
    cutConnectors,
    connectorSettings,
    activeProblems,
    cutConnectorTargetsRef,
    cutPlaneMeshRef,
    connectorGhostRef
  })

  const { setGroupBrimEarMarkers, refreshBrimEarMarkers, editSelectedBrimEars } = useEditorBrimEarActions({
    stateRef,
    activePlateRef,
    groupByKeyRef,
    selectedKeyRef,
    brimEarDiameterRef,
    recordHistoryRef,
    regenerateThumbnailRef: regenerateActiveThumbnailRef
  })
  setGroupBrimEarMarkersRef.current = setGroupBrimEarMarkers
  const refreshBrimEarMarkersRef = useRef(refreshBrimEarMarkers)
  refreshBrimEarMarkersRef.current = refreshBrimEarMarkers
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
  }, [state, filamentColors, refreshPaintOverlaysRef, refreshAddedPartMeshesRef])

  const writeBackGroupTransform = useCallback((group: THREE.Object3D) => {
    writeBackEditorObjectTransform(stateRef.current, group)
  }, [])
  const bakeExactMatrix = useCallback((group: THREE.Object3D) => {
    prepareEditorObjectTransform(stateRef.current, group)
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
    bedBoundsRef,
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

  // High-frequency path (drag / gizmo): push live values straight into the isolated LiveTransformPanel
  // via its setter ref, so a drag never re-renders EditorView (and the many-part sidebar). Selection
  // changes seed the panel through `selectedTransform` state instead (the low-frequency effect below).
  const syncSelectedTransform = useCallback((object: THREE.Object3D) => {
    const value = computeSelectedTransform(object)
    if (value) transformReadoutSetterRef.current?.(value)
  }, [])
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

  useEditorActivePlateBuild({
    activePlate,
    activePlateIndex,
    activeInstanceKeys,
    sceneReady,
    rebuildToken,
    showBedModel,
    bedModelGeometry,
    bedTexture,
    buildInstanceGroup,
    fetchGeometry,
    fetchImportGeometry,
    sceneRef,
    plateRootRef,
    bedCenterRef,
    bedBoundsRef,
    viewDistanceRef,
    prevBuiltPlateIndexRef,
    framedViewKeyRef,
    frameDefaultViewRef,
    pendingScenePlatesRef,
    transformRef,
    groupByKeyRef,
    primeTowerObjRef,
    isInstancePrintedRef,
    towerRequiredRef,
    computePrimeTowerHeightRef,
    projectFilamentCountRef,
    reattachGizmoRef,
    recomputeWarningsRef,
    regenerateActiveThumbnailRef,
    setViewerError,
    setViewportBuilding,
    setBuildIncremental,
    setBuildProgress,
    setRenderedInstanceKeys,
    setMaterialSyncToken
  })

  const reattachGizmo = useCallback(() => {
    attachEditorGizmo({
      transform: transformRef.current,
      selectedKey,
      groups: groupByKeyRef.current,
      part: gizmoPart,
      mode: gizmoMode,
      pivotProxy: multiPivotRef.current,
      allSelectedKeys: () => allSelectedKeysRef.current(),
      setSelectionHighlight: (group) => { setSelectionHighlightRef.current?.(group) },
      computeSelectedTransform,
      setSelectedTransform
    })
    // `extraSelectedKeys` triggers a pivot refresh even though the controller reads live refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, gizmoMode, gizmoPart, extraSelectedKeys,
    computeSelectedTransform, addedPartMeshVersion])

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

  useEditorPlaceOnFaceOverlay({
    mode: gizmoMode,
    selectedKey,
    groupsRef: groupByKeyRef,
    faceHullRef,
    rebuildToken,
    faceHullToken
  })

  useEditorCutPlanePreview({
    gizmoMode,
    selectedKey,
    cutAxis,
    clampedCutOffset,
    rebuildToken,
    sceneRef,
    groupByKeyRef,
    cutConnectorTargetsRef,
    cutPlaneMeshRef,
    grooveSizedForRef,
    setCutRange,
    setCutOffset,
    setCutObjectSize,
    setGroove,
    setCutSoup
  })

  useEditorMeasurementOverlay({
    sceneRef,
    gizmoMode,
    measurePoints,
    measureResult,
    measureCentreTargetsRef,
    sceneReady,
    rebuildToken
  })

  useEditorRotationSnap(gizmoMode, transformRef)

  const { regenerateActivePlateThumbnail, captureAllPlateThumbnails } = useEditorPlateThumbnails({
    state,
    stateRef,
    activePlateIndex,
    filamentColors,
    buildInstanceGroup,
    sceneRef,
    plateRootRef,
    pendingScenePlatesRef,
    plateThumbnailsRef,
    setPlateThumbnails,
    staleEmbeddedPlates,
    setStaleEmbeddedPlates,
    regenerateActiveThumbnailRef
  })

  // ---- State mutations -------------------------------------------------------
  // Default the colour brush to the second material (painting with the first is a
  // no-op visually) once options are known or when the chosen one disappears.
  useEffect(() => {
    if (paintColorFilamentId != null && filamentOptions.some((option) => option.id === paintColorFilamentId)) return
    setPaintColorFilamentId(filamentOptions[1]?.id ?? filamentOptions[0]?.id ?? null)
  }, [filamentOptions, paintColorFilamentId, setPaintColorFilamentId])

  const {
    updatePlates,
    setActivePlateFilamentChanges,
    setActivePlatePauses
  } = useEditorPlateEdits({
    activePlateIndex,
    recordHistory,
    setState,
    setRebuildToken,
    setTransformSyncToken,
    setMaterialSyncToken
  })

  useEditorTransformSceneSync({
    transformSyncToken,
    stateRef,
    groupByKeyRef,
    setRebuildToken,
    recomputeWarningsRef,
    regenerateActiveThumbnailRef
  })

  useEditorMaterialSceneSync({
    materialSyncToken,
    stateRef,
    groupByKeyRef,
    resolveColorFilamentIdRef,
    filamentColorsRef,
    refreshPaintOverlaysRef,
    regenerateActiveThumbnailRef
  })

  useEditorPrimeTowerSync({
    state,
    stateRef,
    activePlateIndex,
    projectFilamentCount: sliceConfig?.projectFilaments.length ?? platesQuery.data?.projectFilaments.length ?? 0,
    bakedPlates: platesQuery.data?.plates,
    sceneReady,
    rebuildToken,
    plateRootRef,
    groupByKeyRef,
    primeTowerObjRef,
    towerRequiredRef,
    projectFilamentCountRef,
    computePrimeTowerHeightRef
  })

  const {
    handleSelect,
    handleSelectPart,
    handleObjectRowContextMenu,
    handlePartRowContextMenu,
    handleAddedPartContextMenu
  } = useEditorSidebarSelectionActions({
    activePlateRef,
    stateRef,
    selectedKeyRef,
    objectAnchorKeyRef,
    partAnchorRef,
    partSelectionRef,
    gizmoPartRef,
    gizmoModeRef,
    allSelectedKeysRef,
    selectExclusive,
    toggleAdditiveSelection,
    setSelectedKey,
    setExtraSelectedKeys,
    setPartSelection,
    setGizmoPart,
    setGizmoMode,
    setContextMenu
  })

  const {
    handleChangeAddedPartFilaments,
    reassignFilament,
    reassignInstanceFilament,
    partsAcceptFilament,
    handleChangeMemberFilament
  } = useEditorMaterialAssignments({
    stateRef,
    activePlateRef,
    setState,
    updatePlates,
    recordHistory,
    recordHistoryRef,
    refreshAddedPartMeshes,
    regenerateThumbnailRef: regenerateActiveThumbnailRef
  })

  const { handleChangePartTypes, handleChangeOnePartType, handleChangeAddedPartTypes } = useEditorPartTypeChanges({
    stateRef,
    setState,
    setRebuildToken,
    recordHistory,
    recordHistoryRef,
    refreshAddedPartMeshes,
    regenerateThumbnailRef: regenerateActiveThumbnailRef
  })

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

  const objectListPerObject = useEditorObjectListProcessSettings({
    perObject,
    plateObjects: sliceConfig?.plateObjects,
    activePlate,
    state,
    stateRef,
    setEditingObject,
    setEditingPart
  })

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
    // A rename changes only the object-list label; the 3D viewport shows no names ('inert').
    updatePlates((plates) => renameEditorObjectInstances(plates, target, trimmed), 'inert')
  }, [promptText, updatePlates])

  const { addInstanceToActivePlate, addStagedImport, addPrimitive } = useEditorInstanceInsertion({
    activePlateIndex,
    sliceConfigRef,
    stateRef,
    setState,
    groupsRef: groupByKeyRef,
    updatePlates,
    setSelectedKey,
    importStore,
    setImporting
  })

  // Persist a dragged prime tower's new lower-left corner into the active plate. The drag already
  // moved the live tower object (useEditorScene), so this is an `inert` state write, a full plate
  // rebuild here just flashes the "loading object" overlay for a move that is already on screen.
  const handleMovePrimeTower = useCallback((cornerX: number, cornerY: number) => {
    updatePlates((plates) => plates.map((plate) => {
      if (plate.index !== activePlateIndex) return plate
      const tower = primeTowerObjRef.current
      const width = typeof tower?.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0
      const depth = typeof tower?.userData.towerDepth === 'number' ? tower.userData.towerDepth : 0
      return moveEditorPrimeTower(plate, { x: cornerX, y: cornerY }, { width, depth })
    }), 'inert')
  }, [activePlateIndex, updatePlates])
  movePrimeTowerRef.current = handleMovePrimeTower

  const {
    pending: sourceColorImport,
    canAppend: canAppendSourceColors,
    queueSourceColorMapping,
    applySourceColors: handleApplySourceColors,
    skipSourceColors: handleSkipSourceColors,
    cancelSourceColors
  } = useEditorSourceColorImport({
    importStore,
    filaments: materials.options,
    materialOptionIds: sliceConfig?.filamentMaterialOptionIds ?? null,
    onAddFilament: sliceConfig?.onAddFilament,
    recordCombinedHistory,
    addStagedImport,
    replaceWithStagedRef
  })

  /** Add immediately unless the source-colour mapper takes ownership of the staged import. */
  const addOrMapStagedImport = useCallback(async (staged: StagedImport) => {
    if (await queueSourceColorMapping(staged, { kind: 'add' })) return false
    return addStagedImport(staged)
  }, [addStagedImport, queueSourceColorMapping])

  const clearModelRequest = useCallback(() => setModelRequest(null), [])
  const {
    handleImportFromLibrary,
    handleImportFile,
    handleReplaceFromLibrary,
    handleReplaceFromFile
  } = useEditorModelImportActions({
    importStore,
    setImporting,
    setLibraryPickerOpen,
    clearModelRequest,
    addOrMapStagedImport,
    queueSourceColorMapping,
    replaceWithStagedRef
  })

  /** Bind the current editor state to helper-volume collection for geometry replacement flows. */
  const collectHelperVolumesFor = useCallback(
    (instance: EditorInstance, group: THREE.Group) => collectEditorHelperVolumes(stateRef.current, instance, group),
    [stateRef]
  )

  /** Commit one Cut gesture through its focused staging and state controller. */
  const handlePerformCut = useCallback(async () => {
    await commitEditorCut({
      selectedKey,
      activePlateIndex,
      stateRef,
      groupByKey: groupByKeyRef.current,
      preparation: {
        mode: cutMode,
        axis: cutAxis,
        offset: clampedCutOffset,
        groove,
        keepLower: cutKeepLower,
        keepUpper: cutKeepUpper,
        orientLower: cutOrientLower,
        orientUpper: cutOrientUpper,
        connectorProblem: connectorProblemSummary(activeProblems)
      },
      connectors: activeConnectors,
      importStore,
      collectHelperVolumes: collectHelperVolumesFor,
      recordHistory: () => { recordHistoryRef.current?.() },
      setState,
      invalidateAddedParts: () => setAddedPartMeshVersion((version) => version + 1),
      rebuildScene: () => setRebuildToken((token) => token + 1),
      selectReplacement: setSelectedKey,
      closeCutTool: () => setGizmoMode('translate'),
      setCutting
    })
  }, [selectedKey, activePlateIndex, cutMode, groove, activeConnectors, activeProblems, cutAxis, clampedCutOffset, cutKeepLower, cutKeepUpper, cutOrientLower, cutOrientUpper, collectHelperVolumesFor, recordHistoryRef, importStore, setAddedPartMeshVersion, setCutting])

  const {
    handleExportMergedDownload,
    handleExportSeparateDownload,
    handleExportPartsDownload,
    handleExportGenericThreeMfDownload,
    handleExportToLibrarySubmit
  } = useEditorObjectExport({
    activePlateIndex,
    stateRef,
    groupByKeyRef,
    exportRequest,
    setExportRequest,
    saveAsBridgeId
  })

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

  /** Add one staged part volume to the selected saved object or unsaved import. */
  const handleAddPartVolume = useCallback(async (key: string, subtype: SceneEditPartSubtype, source: AddedPartSource) => {
    await commitEditorPartVolume({
      stateRef,
      activePlateIndex,
      key,
      subtype,
      source,
      groupByKey: groupByKeyRef.current,
      importStore,
      recordHistory: () => { recordHistoryRef.current?.() },
      setImporting,
      refreshAddedPartMeshes,
      selectPart: (hostId, partKey) => setGizmoPart({ objectId: hostId, member: { kind: 'added', key: partKey } }),
      setMoveMode: () => setGizmoMode('translate'),
      regenerateThumbnail: () => { regenerateActiveThumbnailRef.current?.() }
    })
  }, [activePlateIndex, refreshAddedPartMeshes, recordHistoryRef, importStore])

  /** Commit the prepared SVG through its focused staging and mutation controller. */
  const handleAddSvg = useCallback(async () => {
    await commitEditorSvgArtwork({
      artwork: svgArtwork,
      settings: svgTool,
      fileName: svgFileName,
      markup: svgMarkup,
      archiveEntries: archiveEntriesRef.current,
      reedit: reeditSvgRef.current,
      stateRef,
      activePlateIndex,
      selectedKey: selectedKeyRef.current,
      groupByKey: groupByKeyRef.current,
      importStore,
      projectFilamentCount: () => sliceConfigRef.current?.projectFilaments?.length ?? 0,
      recordHistory: () => { recordHistoryRef.current?.() },
      addInstance: addInstanceToActivePlate,
      publishBakedState: (current) => setState({ ...current }),
      refreshAddedPartMeshes,
      regenerateThumbnail: () => { regenerateActiveThumbnailRef.current?.() },
      closeTool: () => setGizmoMode(RESTING_GIZMO_MODE),
      setImporting
    })
  }, [activePlateIndex, addInstanceToActivePlate, archiveEntriesRef, importStore, recordHistoryRef,
    reeditSvgRef, refreshAddedPartMeshes, selectedKeyRef, svgArtwork, svgFileName, svgMarkup, svgTool])


  /** Change the volume type of a whole selected part set in one history step. */
  const handleChangeMemberTypes = useCallback(
    (objectId: number, members: ReadonlyArray<PartMember>, subtype: SceneEditPartSubtype) => {
      changeEditorMemberTypes({
        objectId, members, subtype,
        recordHistory,
        changeBaked: handleChangePartTypes,
        changeAdded: handleChangeAddedPartTypes
      })
    },
    [handleChangePartTypes, handleChangeAddedPartTypes, recordHistory]
  )

  const { partSelectionRemovable, handleRemoveParts } = useEditorPartRemoval({
    stateRef,
    recordHistory,
    setState,
    setGizmoPart,
    setPartSelection,
    setRebuildToken,
    refreshAddedPartMeshes,
    regenerateThumbnailRef: regenerateActiveThumbnailRef
  })

  /** Open per-volume settings from a volume row's own button, through the shared part dialog. */
  const handleEditAddedPartSettings = useCallback((objectId: number, partKey: string) => {
    const owner = stateRef.current?.plates.flatMap((plate) => plate.instances)
      .find((instance) => addedPartHostId(instance) === objectId)
    const name = owner
      ? effectiveAddedParts(stateRef.current, owner).find((part) => part.key === partKey)?.name
      : null
    setEditingPart({ objectId, members: [{ kind: 'added', key: partKey }], name: name ?? 'Part' })
  }, [])

  /** Use the shared part selection gesture so added rows support Ctrl and Shift selection. */
  const handleSelectAddedPartRow = useCallback(
    (objectId: number, partKey: string, modifiers: { additive: boolean; range: boolean }, instanceKey: string) =>
      handleSelectPart(objectId, { kind: 'added', key: partKey }, modifiers, instanceKey),
    [handleSelectPart]
  )

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

  // Simplify is a one-volume, paint-preserving geometry replacement. Its worker preview and commit
  // live in a focused hook beside the Boolean hook rather than adding another state machine here.
  const simplify = useEditorSimplify({
    gizmoMode,
    setGizmoMode,
    selectedKey,
    extraSelectedKeys,
    gizmoPart,
    activePlateIndex,
    stateRef,
    groupByKeyRef,
    setState,
    importStore,
    paint,
    rotorOf,
    nextInstanceKey,
    recordHistoryRef,
    setSelectedKey,
    setPartSelection,
    setGizmoPart,
    setAddedPartMeshVersion,
    setRebuildToken,
    regenerateActiveThumbnailRef,
    rebuildToken,
    addedPartMeshVersion
  })


  /** Assemble selected objects into one import-backed instance with recoverable shells. */
  const handleAssembleSelection = useCallback(async () => {
    const keys = allSelectedKeysRef.current()
    if (keys.length < 2) return
    setImporting(true)
    try {
      const result = await commitEditorObjectAssembly({
        keys,
        plateIndex: activePlateIndex,
        stateRef,
        groups: groupByKeyRef.current,
        importStore,
        countHelperVolumes: (instance, group) => collectHelperVolumesFor(instance, group).length,
        updatePlates
      })
      if (!result) return
      setExtraSelectedKeys([])
      setSelectedKey(result.key)
      setGizmoMode('translate')
      toast.success(`Assembled ${result.count} objects into one.`
        + discardedHelperVolumeNotice(result.discardedHelpers))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to assemble the selected objects.')
    } finally {
      setImporting(false)
    }
  }, [activePlateIndex, updatePlates, importStore, collectHelperVolumesFor,
    allSelectedKeysRef, setExtraSelectedKeys])

  useInitialLibraryImport({
    fileId: isNewProjectScaffold ? initialImportFileId : undefined,
    ready: state !== null && sceneReady && !viewportBuilding
      && (sliceConfig?.projectFilaments.length ?? 0) > 0,
    importFromLibrary: handleImportFromLibrary
  })

  /**
   * Swap an object's geometry for a freshly staged foreign model, BambuStudio "Replace
   * with…" style: every copy of the object is swapped (geometry is shared by an object's
   * instances), each keeping its own placement, plus the object's material, printability,
   * and name (see `lib/editorGeometryReplacement.ts`). For an in-project object the swap retains
   * its identity (`replacedObjectId`) so its per-object process overrides follow the new mesh
   * at slice time. The replacements are import-backed; one undoable step (via `updatePlates`).
   */
  const handleReplaceWithStaged = useCallback((
    key: string,
    staged: StagedImport,
    sourceColorPaint?: SourceColorPaintCommit,
    options: { recordHistory?: boolean } = {}
  ): boolean => replaceEditorGeometry({
    key,
    staged,
    sourceColorPaint,
    history: options,
    stateRef,
    setState,
    updatePlates,
    meshUrl: importStore.meshUrl,
    worldFootprintCenterFor: (instanceKey) => worldFootprintCenterForRef.current?.(instanceKey) ?? null,
    selectReplacement: (replacementKey) => {
      setExtraSelectedKeys([])
      setSelectedKey(replacementKey)
      setGizmoMode('translate')
    }
  }), [updatePlates, importStore, setExtraSelectedKeys])
  replaceWithStagedRef.current = handleReplaceWithStaged

  const { handleSplitToObjects, handleSplitToParts } = useEditorShellSplit({
    activePlateIndex,
    stateRef,
    groupByKeyRef,
    importStore,
    countHelperVolumes: (instance, group) => collectHelperVolumesFor(instance, group).length,
    updatePlates,
    setSelectedKey,
    setImporting,
    replaceWithStagedRef
  })

  /** The whole selection when `key` belongs to it, else just `key`. */
  const selectionFor = useCallback((key: string): string[] => {
    const selection = allSelectedKeysRef.current()
    return selection.includes(key) ? selection : [key]
  }, [allSelectedKeysRef])

  // The plate clone is synchronous. Its imports are re-homed afterward against live state so
  // an undo or deletion during staging cannot attach geometry to an obsolete copy.
  const independentCopyImports = useMemo(() => createEditorIndependentCopyImports({
    stateRef,
    importStore,
    getPerObjectSettings: () => sliceConfigRef.current?.perObjectSettings,
    onImportsChanged: () => setAddedPartMeshVersion((version) => version + 1)
  }), [stateRef, importStore, sliceConfigRef, setAddedPartMeshVersion])

  const { handleDuplicate, handleCloneWithCount, linkedCopyCountFor, handleMakeIndependent } = useEditorObjectDuplication({
    activePlateIndex,
    state,
    stateRef,
    selectionFor,
    updatePlates,
    selectExclusive,
    independentCopyImports,
    promptText,
    recordHistoryRef,
    refreshAddedPartMeshes,
    regenerateThumbnailRef: regenerateActiveThumbnailRef,
    setState
  })

  const {
    handleDelete,
    handleMoveToPlate,
    handleSetPrintableSelection,
    handleTogglePrintable,
    handleSelectAllObjects,
    handlePasteInstances
  } = useEditorInstanceSelectionActions({
    activePlateIndex,
    activePlateRef,
    selectionFor,
    updatePlates,
    selectExclusive,
    setSelectedKey,
    setExtraSelectedKeys,
    setPartSelection,
    setGizmoPart,
    objectAnchorKeyRef
  })

  // The whole selection (primary + multi-select extras), kept in a ref for the keyboard hook.
  const selectionKeysRef = useRef<string[]>([])
  selectionKeysRef.current = selectedKey ? [selectedKey, ...extraSelectedKeys] : []
  // Shortcuts are live once the editable scene has mounted (the typing guard in the hook keeps them
  // out of form fields; the gcode preview is a separate component, so there is no preview mode here).
  const shortcutsEnabledRef = useRef(false)
  shortcutsEnabledRef.current = sceneReady
  const handleDeleteShortcut = useCallback((key: string | null) => {
    performEditorDeleteShortcut({
      key,
      mode: gizmoModeRef.current,
      measurePickCount: measurePointsRef.current.length,
      clearMeasurement,
      bulkSelection: partSelectionRef.current,
      selectedPart: gizmoPartRef.current,
      partSelectionRemovable,
      removeParts: handleRemoveParts,
      clearBulkSelection: () => setPartSelection(null),
      clearSelectedPart: () => setGizmoPart(null),
      deleteObject: handleDelete
    })
  }, [handleDelete, handleRemoveParts, partSelectionRemovable, partSelectionRef, setPartSelection,
    measurePointsRef, clearMeasurement])

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
    const target = editorObjectProcessSettingsTarget(activePlateRef.current?.instances ?? [], selectionFor(key))
    if (target) setEditingObject(target)
  }, [selectionFor])

  /** Open per-part process settings for the current part selection (bulk when several). */
  const openPartSettingsForSelection = useCallback(() => {
    const target = editorPartProcessSettingsTarget(
      stateRef.current,
      partSelectionRef.current,
      gizmoPartRef.current
    )
    if (target) setEditingPart(target)
  }, [partSelectionRef])

  const {
    setObjectHeightRanges,
    setObjectLayerHeightProfile,
    layerHeightBounds,
    openLayerHeightFor
  } = useEditorLayerHeightEditing({
    state,
    stateRef,
    setState,
    activePlateIndex,
    nozzleDiameter: sliceConfig?.nozzleDiameter,
    nominalHeight: defaultLayerHeightMm,
    target: editingLayerHeight,
    setTarget: setEditingLayerHeight,
    brush: layerHeightBrush,
    groupsRef: groupByKeyRef,
    recordHistoryRef,
    setMode: setGizmoMode
  })

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

  /** Route rail changes through the selected tool's session and history policy. */
  const handleGizmoModeChange = useCallback((mode: GizmoMode) => {
    changeEditorToolMode({
      mode,
      selectedKey,
      selectedBakedPart,
      selectedAddedPartKey,
      activePlateRef,
      reeditBakedPartRef,
      editingTextSurfaceRef,
      textApplyLoadedRef,
      textTool,
      openLayerHeightFor,
      findBakedAuthoredPart: (objectId, partIndex) =>
        findEditorBakedAuthoredPart(activePlateRef.current, objectId, partIndex),
      findAddedSvgPart: (partKey) => findEditorAddedSvgPart(stateRef.current, partKey),
      findAddedTextPart: (partKey) =>
        findEditorAddedTextPart(stateRef.current, activePlateRef.current, partKey),
      reopenSvgArtwork,
      clearSvgReedit,
      recordHistory: () => { recordHistoryRef.current?.() },
      setTextTool,
      setEditingTextPartKey,
      setEditingTextHost,
      setEditingTextObject,
      setGizmoMode
    })
  }, [selectedKey, openLayerHeightFor, selectedAddedPartKey, textTool,
    recordHistoryRef, setEditingTextHost, setEditingTextObject,
    selectedBakedPart, reopenSvgArtwork, clearSvgReedit])

  useEditorTextHighlight({
    mode: gizmoMode,
    partKey: editingTextPartKey,
    selectedKey,
    hostKeyRef: editingTextHostKeyRef,
    groupByKeyRef,
    meshRef: textMeshRef,
    interaction: textInteraction,
    meshVersion: addedPartMeshVersion
  })

  /** Remove the session's standalone object or hosted part from the Text panel. */
  const removeTextPart = useCallback(() => {
    removeEditorText({
      objectKey: editingTextObjectKeyRef.current,
      partKey: editingTextPartKey,
      activePlateIndex,
      stateRef,
      settleRef: reseatSettleRef,
      updatePlates,
      setEditingObject: setEditingTextObject,
      setEditingPartKey: setEditingTextPartKey,
      selectObject: setSelectedKey,
      clearSelectedPart: () => setGizmoPart(null),
      refreshAddedPartMeshes,
      regenerateThumbnail: () => { regenerateActiveThumbnailRef.current?.() }
    })
  }, [editingTextPartKey, refreshAddedPartMeshes, updatePlates, activePlateIndex,
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
    return placeTextOnHost(group, textTool, face, font, anchorWorld, pointedNormal)
  }, [resolveTextFace, textTool])

  const { reseatDraggedText, placeTextAt } = useEditorTextLivePlacement({
    modeRef: gizmoModeRef,
    surfaceMode: textTool.surfaceMode,
    partKeyRef: editingTextPartKeyRef,
    hostKeyRef: editingTextHostKeyRef,
    selectedKeyRef,
    groupByKeyRef,
    stateRef,
    pointedRef: editingTextSurfaceRef,
    settleRef: reseatSettleRef,
    commitRef: applyTextPartRef,
    buildPlacement: buildTextPlacement
  })
  reseatDraggedTextRef.current = reseatDraggedText
  placeTextAtRef.current = placeTextAt

  const { applyTextPart, loadTextFontFile } = useEditorTextCommit({
    mode: gizmoMode,
    value: textTool,
    stateRef,
    activePlateIndex,
    hostKeyRef: editingTextHostKeyRef,
    selectedKeyRef,
    editingObjectKeyRef: editingTextObjectKeyRef,
    groupByKeyRef,
    editingPartKey: editingTextPartKey,
    pointedRef: editingTextSurfaceRef,
    promotingRef: reeditBakedPartRef,
    loadedValueRef: textApplyLoadedRef,
    resolveFace: resolveTextFace,
    buildPlacement: buildTextPlacement,
    importStore,
    footprintCenterForRef: worldFootprintCenterForRef,
    setEditingObject: setEditingTextObject,
    selectObject: setSelectedKey,
    previousSelectedKeyRef,
    updatePlates,
    addInstance: addInstanceToActivePlate,
    setEditingPartKey: setEditingTextPartKey,
    setEditingHost: setEditingTextHost,
    setGizmoPart,
    setState,
    refreshAddedPartMeshes,
    regenerateThumbnailRef: regenerateActiveThumbnailRef,
    setUserFaces: setTextUserFaces,
    setValue: setTextTool
  })
  applyTextPartRef.current = applyTextPart

  useEditorToolModeLifecycle({
    mode: gizmoMode,
    setMode: setGizmoMode,
    selectedKey,
    previousSelectedKeyRef,
    layerHeightTarget: editingLayerHeight,
    clearLayerHeight: setEditingLayerHeight,
    clearLayerHeightBrush: setLayerHeightBrush,
    groupByKeyRef,
    textPartKey: editingTextPartKey,
    textHostKey: editingTextHostKey,
    textSettleRef: reseatSettleRef,
    clearTextPart: setEditingTextPartKey,
    clearTextHost: setEditingTextHost
  })

  const { handleArrangeAll, handleFillBedWithCopies } = useEditorPlatePacking({
    activePlateIndex,
    stateRef,
    groupByKeyRef,
    primeTowerObjRef,
    instanceNozzlesRef,
    updatePlates
  })

  const {
    handleDropToBed,
    mutateSelectedGroup,
    handleAutoOrient,
    handleConvertUnits,
    applyAlignDistribute,
    handleScaleToPrintVolume,
    nudgeSelection,
    centerSelectionOnPlate
  } = useEditorObjectPlacement({
    selectedKey,
    selectedKeyRef,
    allSelectedKeysRef,
    activePlateIndex,
    stateRef,
    groupByKeyRef,
    recordHistory,
    bakeExactMatrix,
    writeBackGroupTransform,
    syncSelectedTransform,
    regenerateActivePlateThumbnail
  })

  const {
    applyManualPosition,
    applyManualRotation,
    applyManualScale,
    nudgeTransform,
    rotateTransformZ
  } = useEditorManualTransforms({
    selectedKeyRef,
    groupByKeyRef,
    gizmoPartRef,
    uniformScale,
    recordHistory,
    writeBackPart: writeBackPartMesh,
    syncSelectedTransform,
    regenerateActivePlateThumbnail,
    mutateSelectedGroup,
    nudgeSelection
  })

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
    gizmoModeRef,
    onNudge: nudgeTransform,
    onRotateZ: rotateTransformZ
  })

  const {
    handleAddPlate,
    handleRemovePlate,
    handleRenamePlate,
    handleApplyPlateSettings,
    handleReorderPlate
  } = useEditorPlateManagement({
    stateRef,
    updatePlates,
    setActivePlateIndex,
    setSelectedKey,
    setPlateSettingsId,
    promptText
  })

  const { handleReorderObject, handleReorderPart } = useEditorObjectOrdering({
    stateRef,
    setState,
    recordHistory
  })

  // Both save and slice read one complete edit over the pinned session source.
  const buildSceneEditOut = useCallback((
    current: EditorState,
    options?: { thumbnails?: Array<{ plateIndex: number; png: string }> }
  ): SceneEdit => buildEditorSceneEdit(current, sliceConfig, options), [sliceConfig])

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

  const { handleFilamentsRenumbered, authorFilamentConfigs } = useEditorFilamentSaveAuthoring({
    stateRef,
    setState,
    sliceConfigRef,
    materials,
    setMaterialSyncToken,
    resolveFilamentConfig,
    baseFileId
  })

  const editorSave = useEditorSave({
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
  const {
    savedFile,
    saving,
    saveAsOpen,
    setSaveAsOpen,
    handleApply,
    handleCloseRequest,
    handleExportObjectAs3mf,
    handleExportObjectAs3mfDownload
  } = editorSave
  const {
    slicing,
    dialogProps: preparationDialogProps,
    startSaveVersion,
    startSaveAs,
    startSlice
  } = useEditorPreparation({
    stateRef,
    save: editorSave,
    slicingProp,
    onSlice,
    buildSceneEdit: buildSceneEditOut,
    authorFilamentConfigs
  })

  // Once an editor-born project has been saved it is a real library file, so it stops presenting
  // as "New Project" and gains the ordinary Save-version path, without the editor re-mounting.
  const savedAsProject = savedFile !== null
  const showAsNewProject = isNewProject && !savedAsProject
  const { repairingPhysics, physicsRepairError, handleRepairInEditor } = useEditorSettingsRepair({
    state,
    setState,
    stateRef,
    sliceConfigRef,
    resolveFilamentConfig,
    baseFileId,
    projectSource,
    settingsRepairReasons,
    recordHistoryRef
  })

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
  const loadError = [platesQuery.error, initialSceneQuery.error, restScenesQuery.error]
    .find((error): error is Error => error instanceof Error)?.message ?? null
  let initialLoadLabel = 'Reading plate objects, positions, and settings…'
  if (platesQuery.isLoading) {
    initialLoadLabel = projectOpenPhase === 'reading-project'
      ? 'Unpacking project and reading its plates and settings…'
      : 'Downloading project…'
  }
  // Re-run only the reads that actually failed: the project source's archive memo is cleared on
  // rejection, so an errored query's refetch re-downloads, while a healthy query's data stays put.
  const retryProjectLoad = () => {
    if (platesQuery.isError) void platesQuery.refetch()
    if (initialSceneQuery.isError) void initialSceneQuery.refetch()
    if (restScenesQuery.isError) void restScenesQuery.refetch()
  }
  const dialogMode = dialogPresentationProps(presentation)
  let shownFileName: string | null = null
  if (savedFile) {
    shownFileName = formatLibraryFileName(savedFile.name)
  } else if (!isNewProject && baseFileQuery.data) {
    shownFileName = formatLibraryFileName(baseFileQuery.data.file.name)
  }
  // Byte-only repairs are synchronous; physics repair needs a ready preset catalogue.
  const canRepairInEditor = !settingsRepairReasons.includes('filamentPhysics') || Boolean(
    resolveFilamentConfig && sliceConfig?.slicerStatus.slicerDataReady
  )
  let sliceMenuDisabledReason = sliceDisabledReason
  if (!state) {
    sliceMenuDisabledReason = 'Preparing the model…'
  } else if (slicing || saving) {
    sliceMenuDisabledReason = undefined
  }
  return (
    <>
    <Modal
      open
      onClose={(event, reason) => routeEditorModalClose(event, reason, {
        suppressEscapeRef: suppressEditorEscapeRef,
        contextMenuOpenRef,
        closeContextMenu: () => setContextMenu(null),
        mode: gizmoMode,
        measurePickCount: measurePoints.length,
        removeLastMeasurePick: () => setMeasurePoints((current) => current.slice(0, -1)),
        selectedKey,
        partSelection,
        gizmoPart,
        changeMode: handleGizmoModeChange,
        clearSelection: () => selectExclusive(null),
        requestClose: handleCloseRequest
      })}
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
            fileName={shownFileName}
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
            onRepairInEditor={canRepairInEditor ? handleRepairInEditor : undefined}
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

        {loadError && (
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
        )}
        {!loadError && (!state || !activePlate) && (
          // Only the genuine first load (no plates/scene yet) shows the full overlay. Once the
          // editor has content, plate switches and background refetches keep the viewport mounted
          // and lean on the in-viewport "Loading models…" overlay: flipping the whole content out
          // here would unmount the WebGL canvas and reinitialize the entire scene (a visible
          // "reload" of the dialog on every plate switch).
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EditorOpeningStatus
              label={initialLoadLabel}
              downloadProgress={projectOpenPhase === 'loading-file' ? projectDownloadProgress : null}
            />
          </Box>
        )}
        {!loadError && state && activePlate && (() => {
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
                {showBuildOverlay && (
                  // First/incremental builds leave more of the arriving scene visible; an atomic
                  // rebuild dims the previous plate while its replacement assembles off-screen.
                  <ViewportBuildOverlay
                    progress={buildProgress}
                    incremental={buildOverlayIncremental}
                  />
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
                <EditorViewportControls
                  setStripElement={setChromeStripElement}
                  isMobile={isMobile}
                  showEditorChrome={showEditorChrome}
                  fullScreen={fullScreen}
                  sidebarCollapsed={sidebarCollapsed}
                  onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
                  onToggleFullScreen={setFullScreen}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  controlsBusy={controlsBusy}
                  onUndo={undo}
                  onRedo={redo}
                  hasProcessSettings={perObject != null}
                  hasProject={state != null}
                  onOpenParameterTable={() => setParameterTableOpen(true)}
                  onOpenProjectFiles={() => setProjectAuxiliariesOpen(true)}
                  onOpenEditorSettings={() => setEditorSettingsOpen(true)}
                  mode={gizmoMode}
                  selectedKey={selectedKey}
                  arrangeDisabled={controlsBusy || activePlate.instances.length === 0 || activePlate.locked}
                  onChangeMode={handleGizmoModeChange}
                  onDropToBed={handleDropToBed}
                  onAutoOrient={handleAutoOrient}
                  onArrangeAll={handleArrangeAll}
                />
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
                {gizmoMode === 'simplify' && selectedKey && (
                  <SimplifyPanel
                    name={simplify.name}
                    sourceTriangles={simplify.sourceTriangles}
                    previewTriangles={simplify.previewTriangles}
                    mode={simplify.mode}
                    onModeChange={simplify.setMode}
                    detail={simplify.detail}
                    onDetailChange={simplify.setDetail}
                    ratio={simplify.ratio}
                    onRatioChange={simplify.setRatio}
                    busy={simplify.busy}
                    error={simplify.error}
                    onApply={simplify.apply}
                    onClose={() => setGizmoMode(RESTING_GIZMO_MODE)}
                  />
                )}
                {gizmoMode === 'measure' && (
                  <MeasurePanel
                    picks={measurePoints}
                    result={measureResult}
                    onResetSlot={resetMeasureSlot}
                    onClear={clearMeasurement}
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
            {editingLayerHeight && (
              <EditorLayerHeightToolPanel
                target={editingLayerHeight}
                state={stateRef.current}
                groups={groupByKeyRef.current}
                bounds={layerHeightBounds}
                nominalHeight={defaultLayerHeightMm}
                firstLayerHeight={firstLayerHeightMm}
                onProfileChange={setObjectLayerHeightProfile}
                onBrushChange={setLayerHeightBrush}
                onClose={() => {
                  setEditingLayerHeight(null)
                  setLayerHeightBrush(null)
                  setGizmoMode(RESTING_GIZMO_MODE)
                }}
              />
            )}
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
                      position: 'absolute', bottom: { xs: 50, sm: 8 }, left: '50%', transform: 'translateX(-50%)',
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
                    bottom: { xs: 50, sm: VIEW_CUBE_EDGE_INSET },
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
                    sx={{ position: 'absolute', bottom: { xs: 50, sm: 8 }, left: 8, right: 8, zIndex: 1 }}
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
                  <EditorPlacementWarnings
                    warnings={placementWarnings}
                    onDismiss={() => setDismissedWarningsSig(placementWarningsSig)}
                    onSelect={setSelectedKey}
                  />
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
                    onAddPrimitive={(kind) => void addPrimitive(kind)}
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
          })()}

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
            {onSlice && (
              <SliceMenuButton
                slicing={slicing}
                disabled={!state || !canSlice || slicing || saving}
                disabledReason={sliceMenuDisabledReason}
                plateCount={state?.plates.length ?? 1}
                onSliceAll={() => startSlice(0)}
                onSlicePlate={() => startSlice(activePlateIndex)}
              />
            )}
            {!onSlice && onApply && (
              <Button type="button" variant="soft" color="primary" loading={saving} disabled={!state || saving} onClick={handleApply}>Use this layout</Button>
            )}
            <SaveMenuButton
              saving={saving}
              disabled={!state || (sliceConfig != null && !hasMaterials)}
              dirty={hasUnsavedChanges}
              canSaveVersion={canSaveOverOpenProject}
              onSaveVersion={startSaveVersion}
              onSaveAs={() => {
                // Local: hand the name straight to the target, whose picker IS the destination
                // prompt. Opening the library dialog here is what made a local project offer to save
                // into a bridge it has nothing to do with.
                // Empty name is fine: the local target falls back to the opened file's name as the
                // picker's suggestion, which is a better default than anything derivable here.
                if (savesToLocalFile) startSaveAs(saveAsSuggestedName, null)
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
          accept={`${importAccept},.mtl,.png,.jpg,.jpeg`}
          multiple
          hidden
          onChange={(event) => {
            const files = takeSelectedImportFiles(event.target)
            if (files.length === 0) return
            const request = modelRequest
            setModelRequest(null)
            let selection
            try {
              selection = resolveImportFileSelection(files, importStore.importableFormats)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Unable to use the selected files.')
              return
            }
            const { file, companionFiles } = selection
            if (request?.kind === 'replace') void handleReplaceFromFile(request.key, file, companionFiles)
            else if (request?.kind === 'addPart') {
              void handleAddPartVolume(request.key, request.subtype, { kind: 'file', file, companionFiles })
            } else void handleImportFile(file, companionFiles)
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

    <EditorPreparationDialog {...preparationDialogProps} />

    <EditorSettingsDialog
      open={editorSettingsOpen}
      onClose={() => setEditorSettingsOpen(false)}
    />

    {projectAuxiliariesOpen && state && (
      <ProjectAuxiliariesDialog
        auxiliaries={state.projectAuxiliaries ?? projectAuxiliariesQuery.data}
        loading={projectAuxiliariesQuery.isLoading}
        loadError={projectAuxiliariesQuery.error instanceof Error
          ? projectAuxiliariesQuery.error.message
          : null}
        onRetry={() => void projectAuxiliariesQuery.refetch()}
        onClose={() => setProjectAuxiliariesOpen(false)}
        onApply={(projectAuxiliaries) => {
          recordHistory()
          setState((current) => current ? { ...current, projectAuxiliaries } : current)
        }}
      />
    )}

    {presetManager?.({ open: slicingPresetsOpen, onClose: closeSlicingPresets })}

    {sourceColorImport && (
      <SourceColorImportDialog
        name={sourceColorImport.staged.name}
        sourceColors={sourceColorImport.sourceColors}
        mesh={sourceColorImport.mesh}
        sourceColorMode={sourceColorImport.sourceColorMode}
        gammaCorrectable={supportsSourceColorGamma(
          sourceColorImport.staged.format,
          sourceColorImport.sourceColorMode
        )}
        filaments={materials.options}
        canAppend={canAppendSourceColors}
        onCancel={cancelSourceColors}
        onSkip={handleSkipSourceColors}
        onApply={handleApplySourceColors}
      />
    )}

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
            description="Open another folder or upload a model first."
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
        onSubmit={({ outputFileName, outputFolderId }) => { if (outputFileName) startSaveAs(outputFileName, outputFolderId) }}
      />
    )}

    {exportRequest && (
      <EditorExportDestinationDialog
        request={exportRequest}
        activePlate={activePlate}
        state={state}
        initialFolderId={saveAsInitialFolderId}
        folders={editorFoldersQuery.data?.folders ?? []}
        bridgeId={saveAsBridgeId}
        onClose={() => setExportRequest(null)}
        onSubmitProject={(key, outputFileName, outputFolderId) => {
          // Project 3MF uses the save pipeline so parts, paint, and materials survive.
          setExportRequest(null)
          if (outputFileName) handleExportObjectAs3mf(key, outputFileName, outputFolderId)
        }}
        onSubmitOther={handleExportToLibrarySubmit}
      />
    )}

    {editingHeightRanges && (
      <EditorHeightRangesDialog
        target={editingHeightRanges}
        stateRef={stateRef}
        groupByKeyRef={groupByKeyRef}
        defaultLayerHeightMm={defaultLayerHeightMm}
        onChange={setObjectHeightRanges}
        onEditSettings={setEditingHeightRangeIndex}
        onClose={() => { setEditingHeightRanges(null); setEditingHeightRangeIndex(null) }}
      />
    )}
    {plateSettingsId != null && (
      <EditorPlateSettingsDialog
        plateId={plateSettingsId}
        stateRef={stateRef}
        sliceConfig={sliceConfig}
        perObject={perObject}
        resolveProcessConfig={resolveProcessConfig}
        onApply={handleApplyPlateSettings}
        onClose={() => setPlateSettingsId(null)}
      />
    )}
    {editingHeightRanges && editingHeightRangeIndex != null && perObject && (
      <EditorHeightRangeProcessSettingsDialog
        target={editingHeightRanges}
        rangeIndex={editingHeightRangeIndex}
        perObject={perObject}
        stateRef={stateRef}
        defaultLayerHeightMm={defaultLayerHeightMm}
        setObjectHeightRanges={setObjectHeightRanges}
        resolveConfig={resolveProcessConfig}
        onClose={() => setEditingHeightRangeIndex(null)}
      />
    )}
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
      <EditorObjectProcessSettingsDialog
        target={editingObject}
        perObject={perObject}
        recordSliceConfigHistory={recordSliceConfigHistory}
        resolveConfig={resolveProcessConfig}
        onClose={() => setEditingObject(null)}
      />
    )}
    {editingPart && perObject && (
      <EditorPartProcessSettingsDialog
        target={editingPart}
        perObject={perObject}
        stateRef={stateRef}
        setState={setState}
        recordHistory={recordHistory}
        resolveConfig={resolveProcessConfig}
        onClose={() => setEditingPart(null)}
      />
    )}
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
