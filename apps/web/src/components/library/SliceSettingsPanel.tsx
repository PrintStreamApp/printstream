/**
 * Shared slice-settings surface extracted from `pages/LibraryView.tsx`.
 *
 * Owns the `SliceSettingsPanel` (the slicer/printer/plate/process/materials
 * controls) plus the `SliceSettingsController` and `SliceConfigSnapshot`
 * contracts that bridge `SliceFileModal`'s state into it, so the SAME panel
 * renders both in the slim slice dialog (`mode='simple'`) and inside the model
 * studio's 3D editor (`mode='editor'`). Each material renders as one compact
 * swatch row (number + preset/colour name, plus the nozzle picker) whose click is
 * owned by `MaterialSwatchButton`: the printer's loaded materials when one is
 * targeted, otherwise the expanded type/preset/color inputs in
 * `MaterialEditDialog`. State stays owned by the caller; only values/setters flow
 * through the controller.
 */
import type React from 'react'
import { useState } from 'react'
import {
  Alert, Box, Button, ButtonGroup, Chip, CircularProgress, Dropdown, FormControl, FormLabel, IconButton, Input,
  List, ListItem, Menu, MenuButton, Option, Select, Sheet, Stack, Switch, Tooltip, Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import InventoryRoundedIcon from '@mui/icons-material/Inventory2Rounded'
import { Printer3dRoundedIcon } from '../Printer3dRoundedIcon'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import RestoreRoundedIcon from '@mui/icons-material/RestoreRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import type {
  LibraryFile,
  PrinterNozzleFlow,
  Printer,
  SceneEdit,
  SceneEditFilament,
  SlicingCapabilities,
  SlicingManualProfileTarget,
  SlicingPresetSummary,
  ThreeMfIndex
} from '@printstream/shared'
import { formatNozzleDiameterLabel } from '@printstream/shared'
import { useNavigate } from 'react-router-dom'
import { prioritizeLoadedMaterialOptionsForFilament } from '../../lib/sliceLoadedMaterialOptions'
import type { PrinterTrayOption } from '../../lib/libraryViewHelpers'
import { resolveProjectFilamentColorName } from '../../lib/filamentColor'
import {
  buildSliceDialogProjectFilaments,
  buildSliceDialogToolheads,
  formatPlateTypeLabel,
  formatPrinterModelLabel,
  groupSliceMaterialOptionsByGroup,
  narrowMaterialOptions,
  normalizeSliceFilamentColor,
  resolveMaterialTypeOptions,
  type SliceMaterialOption
} from '../../lib/slicingPresetMatching'
import type { MachineTargetConflict, MachineTargetIntent } from '../../lib/machineTargetResolution'
import { AddMaterialDialog } from './AddMaterialDialog'
import { PrinterPickerDialog } from '../PrinterPickerDialog'
import type { AddedMaterialChoice, SessionFilamentSlot } from './useMaterialSlots'
import { machineTargetConflictWarnings } from '../../lib/machineSwitchWarnings'
import { MaterialEditDialog } from './MaterialEditDialog'
import { MaterialSwatchButton } from './MaterialSwatchButton'
import { LoadedMaterialMenuItems } from './LoadedMaterialMenuItems'
import { SlicingPresetAutocomplete } from './SlicingPresetAutocomplete'
import { SettingsTuneButton } from '../SettingsTuneButton'
import { PlateFilamentChangesSection, PlatePausesSection, type FilamentOption } from './PlateGcodeSections'
import { StickySectionHeader } from './StickySectionHeader'
import type { EmbeddedProjectPreset } from '@printstream/shared/three-mf'
import { ProjectPresetsDialog } from './ProjectPresetsDialog'
import { useFilamentChangedCount, useProcessChangedCount } from './useBakedPresetChanges'
import type { ProcessConfigResolver } from '../ProcessSettingsDialog'
import type { FilamentConfigResolver } from './FilamentSettingsDialog'
import { LibraryPlateCardPicker } from '../LibraryPlateSelect'
import { useEffectiveSlicerDeveloperMode } from '../../lib/slicerDeveloperMode'

/**
 * Stateful bridge from `SliceFileModal` to the shared `SliceSettingsPanel`.
 *
 * The slice form's state stays owned by `SliceFileModal` (single source of
 * truth); this object exposes the values/setters/derived lists the settings UI
 * reads so the SAME panel can render both in the slim slicing dialog and inside
 * the 3D editor's "Settings" tab without duplicating controls. Module-scope
 * helpers/autocompletes used by the panel stay referenced directly (the panel
 * lives in this module), so only stateful values flow through here.
 */
export interface SliceSettingsController {
  file: LibraryFile
  resourceBasePath: string
  flow: 'library' | 'print'
  requiresSinglePlate: boolean
  canOpenThreeDimensionalPreview: boolean
  isMobileViewport: boolean
  workspaceSlug: string | undefined
  navigate: ReturnType<typeof useNavigate>
  onClose: () => void
  // Slicer
  slicerTargets: SlicingCapabilities['targets']
  selectedSlicerTargetId: string
  setSelectedSlicerTargetId: React.Dispatch<React.SetStateAction<string>>
  /**
   * Set when the project was saved by a NEWER Bambu Studio than the selected engine — which
   * BambuStudio refuses to open outright (exit 232). NOT rendered by this panel: the sidebar is
   * too narrow for the warning + "slice it anyway" acknowledgement, so each host places it wide —
   * the plain slice dialog in its body, the editor as a banner under its title (the same spot as
   * the settings-repair notice). It rides the controller so the editor can reach it at all;
   * without that the editor showed only the disabled-reason tooltip, a dead end.
   */
  projectVersionWarning: {
    projectVersion: string | null
    engineVersion: string | null
    acknowledged: boolean
    onAcknowledgedChange: (next: boolean) => void
  } | null
  /** Slicer availability/loading state, surfaced as notices in the settings panel. */
  slicerStatus: {
    capabilitiesLoading: boolean
    hasCapabilities: boolean
    capabilitiesError: string | null
    configured: boolean
    /** Slicer is installed but not currently healthy (e.g. restarting) — show a wait, not an error. */
    slicerRestarting: boolean
    slicerDataReady: boolean
    profilesError: string | null
  }
  // Printer
  printers: Printer[]
  selectedPrinter: Printer | null
  lockedPreferredPrinter: Printer | null
  targetMode: 'realPrinter' | 'manualProfile'
  /**
   * Pick (or clear) the real printer to target. ONE action rather than the underlying
   * `printerId` + `targetMode` setters so a single user gesture stays a single undoable
   * step in the editor — two wrapped setters would push two history frames and take two
   * Ctrl+Z to reverse. Same reason {@link selectPrinterModel} exists.
   */
  selectPrinter: (printer: Printer | null) => void
  selectedPrinterModel: string
  /**
   * Pick the manual printer model. Records it as the user's INTENT, which is what stops the
   * derived target from steering it back — part of the same gesture, so it must not be a
   * separate call the editor's undo wrapper cannot see.
   */
  selectPrinterModel: (model: string) => void
  printerModelOptions: string[]
  /**
   * Picks the current target cannot represent (e.g. a plate this machine does not offer). Rendered
   * as a notice rather than applied silently: the pick is still recorded, so it comes back if the
   * user switches to a machine that offers it. See `lib/machineTargetResolution.ts`.
   */
  targetConflicts?: MachineTargetConflict[]
  /**
   * The resolved machine preset behind the current target. Exposed so consumers can read its
   * declared limits (e.g. the layer-height envelope a machine switch warns against) rather than
   * re-resolving the catalogue themselves.
   */
  selectedMachineProfile: SlicingPresetSummary | null
  nozzleDiameter: string
  setNozzleDiameter: React.Dispatch<React.SetStateAction<string>>
  nozzleDiameterOptions: string[]
  nozzleFlow: PrinterNozzleFlow
  setNozzleFlow: React.Dispatch<React.SetStateAction<PrinterNozzleFlow>>
  plateType: string
  setPlateType: React.Dispatch<React.SetStateAction<string>>
  plateTypeOptions: string[]
  // Plate (slim mode only)
  plateMode: 'all' | 'single'
  setPlateMode: React.Dispatch<React.SetStateAction<'all' | 'single'>>
  sceneEdit: SceneEdit | null
  setSceneEdit: React.Dispatch<React.SetStateAction<SceneEdit | null>>
  plateNumber: string
  setPlateNumber: React.Dispatch<React.SetStateAction<string>>
  slicePlateOptions: ThreeMfIndex['plates']
  setPreviewFileId: React.Dispatch<React.SetStateAction<string | null>>
  // Process
  /**
   * Re-take the host's snapshot of the slicer catalogue. The editor renders from a snapshot taken
   * at open (ambient refetches must not redraw it), so a preset the user edits in the manager only
   * reaches it because the editor calls this afterwards.
   */
  refreshSlicingPresets?: () => void
  /**
   * Re-take the host's snapshot of the parsed 3MF index. Called after a Repair, which rewrites the
   * project's settings from inside the editor; ordinary library invalidations must NOT call it.
   */
  refreshProjectIndex?: () => void
  compatibleProcessProfiles: SlicingPresetSummary[]
  selectedProcessProfile: SlicingPresetSummary | null
  processProfileModified: boolean
  setProcessProfileId: React.Dispatch<React.SetStateAction<string>>
  setProcessSettingOverrides: React.Dispatch<React.SetStateAction<Record<string, string | string[]>>>
  processProfileSelectionTouchedRef: React.MutableRefObject<boolean>
  selectedSlicerTargetIdForGuards: string
  processSettingOverrides: Record<string, string | string[]>
  setProcessSettingsDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  hasPlateObjects: boolean
  selectedSliceObjectIds: Set<number>
  plateObjects: Array<{ id: number; name: string }>
  /** Toggle whether a plate object is included in the slice/print (independent of a process profile). */
  onToggleSliceObject: (objectId: number) => void
  /** Open the restricted per-object process-settings dialog for one plate object (simple mode). */
  openSliceObjectSettings: (objectId: number, name: string) => void
  /**
   * Per-plate layer G-code editing for the targeted plate (simple mode): effective filament
   * changes + pauses (session edit over the file's baked entries) and their setters. Null when
   * no single plate is targeted (all-plates mode has no one plate to edit) or the file has none.
   */
  plateGcode: {
    filamentChanges: Array<{ z: number; filamentId: number }>
    pauses: Array<{ z: number }>
    onFilamentChangesChange: (changes: Array<{ z: number; filamentId: number }>) => void
    onPausesChange: (pauses: Array<{ z: number }>) => void
    filamentOptions: FilamentOption[]
  } | null
  /**
   * Everything the editor sidebar needs to render per-object print toggles and
   * process overrides inline (no separate dialog). Null when no process profile is
   * selected yet. `value`/`globalOverrides` use the raw override-map shape.
   */
  perObjectSettings: {
    slicerTargetId: string
    processProfileId: string
    sourceFileId: string | null
    globalOverrides: Record<string, string | string[]>
    visibilityContext: { printerModel: string }
    value: Record<string, Record<string, string | string[]>>
    onChange: (next: Record<string, Record<string, string | string[]>>) => void
    printSelection: Set<number>
    onTogglePrint: (objectId: number) => void
  } | null
  // Materials
  projectFilaments: ReturnType<typeof buildSliceDialogProjectFilaments>
  materialOptions: SliceMaterialOption[]
  loadedMaterialOptions: SliceMaterialOption[]
  /**
   * Live trays of the targeted printer keyed by mapping value, so a loaded-material row can
   * show how much that tray has left. Empty when no real printer is targeted.
   */
  printerTrayMap: Map<number, PrinterTrayOption>
  materialToolheadOptions: ReturnType<typeof buildSliceDialogToolheads>
  filamentMaterialOptionIds: Record<number, string>
  filamentMaterialTypeFilters: Record<number, string>
  setFilamentMaterialTypeFilters: React.Dispatch<React.SetStateAction<Record<number, string>>>
  filamentToolheadIds: Record<number, string>
  setFilamentToolheadIds: React.Dispatch<React.SetStateAction<Record<number, string>>>
  filamentColors: Record<number, string>
  setFilamentColors: React.Dispatch<React.SetStateAction<Record<number, string>>>
  /** Per-material filament setting overrides keyed by projectFilamentId (material "tune" dialog). */
  filamentSettingOverridesById: Record<number, Record<string, string | string[]>>
  /** Open the material settings dialog for a given filament slot. */
  openFilamentSettings: React.Dispatch<React.SetStateAction<number | null>>
  handleMaterialOptionChange: (projectFilamentId: number, option: SliceMaterialOption | null) => void
  /**
   * Add/remove materials (Bambu-style). `desiredFilaments` is the full ordered filament
   * list to bake into the saved/sliced 3MF, or null when the user has not changed the
   * count (so unchanged projects don't rewrite project_settings.config). `onAddFilament`
   * appends a slot from a material the user confirmed in the add dialog — nothing is created
   * until then; `onRemoveFilament` drops one (the UI disables removing the last). Only
   * surfaced in the editor ('editor' mode).
   */
  desiredFilaments: SceneEditFilament[] | null
  /**
   * Manual-profile target for the currently-selected machine when it is cross-model with the
   * project's source (so saving should retarget the 3MF to it, Bambu "switch printer + save").
   * Null when the selection matches the source model (no machine switch needed on save).
   */
  retargetTarget: SlicingManualProfileTarget | null
  onAddFilament: (choice: AddedMaterialChoice) => void
  onRemoveFilament: (projectFilamentId: number) => void
  /**
   * Whether a material is assigned to any object/part (the 3D editor supplies live usage).
   * When it returns true the material can't be removed — BambuStudio parity. Absent → not gated.
   */
  filamentInUse?: (projectFilamentId: number) => boolean
  /**
   * Whether a material flagged by {@link filamentInUse} is used ONLY for supports (no object/
   * part/layer/paint reference). Lets the remove-blocked tooltip/toast say "used for supports"
   * instead of "used by an object". Absent → treated as object usage.
   */
  filamentSupportOnly?: (projectFilamentId: number) => boolean
  /**
   * Point-in-time snapshot of the whole slice configuration + a restore fn, so the editor's
   * undo/redo can revert a printer/material/process edit alongside the scene (this state
   * lives here, in the slice controller, not in the editor's scene state).
   */
  configSnapshot: SliceConfigSnapshot
  restoreConfig: (snapshot: SliceConfigSnapshot) => void
  /**
   * Mutable listener the full editor sets to its `markDirty`, invoked whenever a material is
   * changed through one of this controller's OWN dialogs (the filament-settings dialog, which
   * the editor renders behind itself). Lets those edits flip the editor's unsaved-changes flag
   * even though they bypass the markDirty-wrapped controller the editor hands to this panel.
   */
  materialEditListenerRef: React.MutableRefObject<(() => void) | null>
  /**
   * Notification from the editor's save flow that the project was just persisted with the
   * CURRENT material list (add/remove overlays baked into the file as slots 1..N). The
   * controller uses it to rebase its session overlay onto the refreshed file — without it,
   * an added material appears twice after Save (once from the refetched base, once from the
   * still-pending overlay) until the editor is reopened.
   */
  /**
   * Returns the OLD→NEW base-index map for anything still holding pre-save `sourceIndex` values
   * (the editor's undo frames); null when the session never diverged from the file.
   */
  onProjectSaved: () => Map<number, number> | null
  /**
   * Sibling of {@link materialEditListenerRef} for GLOBAL process-setting edits (the process
   * profile selection and the overrides applied by the process-settings dialog). The full editor
   * sets it to a snapshot-then-dirty handler; call it BEFORE mutating `processProfileId` /
   * `processSettingOverrides` so the pre-edit values are captured for undo. Null (no-op) outside
   * the editor. Global process edits otherwise bypass the editor's dirty/undo like material picks do.
   */
  processEditListenerRef: React.MutableRefObject<(() => void) | null>
  /**
   * Anonymous process-config resolver (public 3MF editor only). When set, the process tune dialog
   * and the "changed vs preset" badge resolve baselines through it instead of the workspace route, so
   * they work with no workspace. Absent for the library host, which uses the workspace route.
   */
  resolveConfig?: ProcessConfigResolver
  /**
   * How this host resolves a filament preset's config — the filament counterpart of `resolveConfig`.
   * The library host passes `resolveWorkspaceFilamentConfig`, the public 3MF editor its anonymous one,
   * and either may pass `undefined` while its catalogue is still loading.
   *
   * REQUIRED (though nullable) on purpose. It was optional, and the library host simply never set
   * it — which type-checked perfectly while disabling the editor's save-time preset resolution, so
   * every library save silently kept dropping the material physics it was meant to restore. Being
   * required turns forgetting it into a compile error; passing `undefined` is still allowed, but
   * only deliberately.
   */
  resolveFilamentConfig: FilamentConfigResolver | undefined
}

/**
 * Everything the editor's undo/redo must be able to put back when a slice-settings edit is
 * reversed. It covers the WHOLE configuration, not just materials: the printer target and
 * nozzle/plate choices sit here too, because changing the printer model re-resolves the
 * process and filament presets, so reverting only the materials would leave the project on
 * the new machine with the old machine's presets.
 *
 * The fields are interdependent (a machine profile is only valid for some models, a nozzle
 * diameter only for some machine profiles), which is why the snapshot is restored WHOLESALE:
 * `SliceFileModal`'s reconciliation effects re-derive an invalid combination, and putting the
 * values back one at a time would trip them mid-restore. Restoring a set that was valid when
 * captured leaves every one of those effects a no-op.
 */
export interface SliceConfigSnapshot {
  // Printer target. Just the user's PICKS: printer, model, nozzle, flow, plate. Everything else
  // about the target (machine profile, option lists, compatibility) re-derives from them, so it
  // cannot be restored into an inconsistent combination — which is why the pre-S2 snapshot had to
  // carry "touched" flags alongside the values to put the defaulting effects back in the right mode.
  selectedSlicerTargetId: string
  machineTargetIntent: MachineTargetIntent
  // Materials
  /**
   * The session's own material list, or null while it still follows the file. Captured as a LIST
   * (not a delta over the file) so restoring it is exact even after a save rewrote the file's
   * slots — that is what lets undo put a removed material back. See `SessionFilamentSlot`.
   */
  sessionSlots: SessionFilamentSlot[] | null
  // Process
  /** Per-object process overrides, so the editor's undo/redo can revert a gear edit. */
  objectProcessOverrides: Record<string, Record<string, string | string[]>>
  /** Selected process profile id, so undo can revert a profile switch alongside its overrides. */
  processProfileId: string
  processProfileSelectionTouched: boolean
  /** Global process-setting overrides, so the editor's undo/redo can revert a global process edit. */
  processSettingOverrides: Record<string, string | string[]>
}

/**
 * Shared slice-settings surface. `mode='simple'` renders the full set for the slim
 * prepare-print dialog — incl. the all/single-plate selector plus, below Materials
 * (mirroring the editor sidebar's order), the inline Objects list (print toggles +
 * per-object settings) and the per-plate filament-change/pause sections.
 * `mode='editor'` omits those: the 3D editor has its own plate strip and renders
 * its own object list and G-code sections after this panel. Both modes share one
 * `controller` instance, so edits in either surface update the same state.
 */
export function SliceSettingsPanel({ controller, mode, onManagePresets, embeddedPresets, onRemoveEmbeddedPreset }: {
  controller: SliceSettingsController
  mode: 'simple' | 'editor'
  activePlateIndex?: number
  /**
   * Open the host's slicing-preset manager. Optional because only a host that HAS one passes it:
   * the workspace editor opens `SlicingPresetsDialog`, while the public editor (no workspace, no
   * stored presets) and the slim prepare-print dialog render no button at all.
   */
  onManagePresets?: () => void
  /**
   * Presets the project carries inside itself, with a remover.
   *
   * A COMPONENT prop rather than a controller field, deliberately: this is project-FILE state the
   * editor owns in `EditorState` (removals are undoable and apply on save), not slicing config, and
   * the ~90-field controller is the wrong home for something only one host can act on. Un-defaulted
   * like `onManagePresets` — the prepare-print dialog can see a project's presets but cannot save,
   * so it passes nothing and the section does not render.
   */
  embeddedPresets?: readonly EmbeddedProjectPreset[]
  onRemoveEmbeddedPreset?: (entryPath: string) => void
}) {
  const {
    file, resourceBasePath, flow, requiresSinglePlate, canOpenThreeDimensionalPreview,
    slicerTargets, selectedSlicerTargetId, setSelectedSlicerTargetId, slicerStatus,
    printers, selectedPrinter, lockedPreferredPrinter, targetMode, selectPrinter,
    selectedPrinterModel, selectPrinterModel, printerModelOptions, targetConflicts,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, nozzleFlow, setNozzleFlow,
    plateType, setPlateType, plateTypeOptions,
    plateMode, setPlateMode, sceneEdit, setSceneEdit, plateNumber, setPlateNumber, slicePlateOptions, setPreviewFileId,
    compatibleProcessProfiles, selectedProcessProfile, processProfileModified, setProcessProfileId, setProcessSettingOverrides,
    processProfileSelectionTouchedRef, selectedSlicerTargetIdForGuards, processSettingOverrides, setProcessSettingsDialogOpen, processEditListenerRef, resolveConfig, resolveFilamentConfig,
    hasPlateObjects, selectedSliceObjectIds, plateObjects, onToggleSliceObject, openSliceObjectSettings, plateGcode, perObjectSettings,
    projectFilaments, materialOptions, loadedMaterialOptions, printerTrayMap, materialToolheadOptions,
    filamentMaterialOptionIds, filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentToolheadIds, setFilamentToolheadIds, filamentColors, setFilamentColors,
    filamentSettingOverridesById, openFilamentSettings,
    handleMaterialOptionChange,
    onAddFilament, onRemoveFilament, filamentInUse, filamentSupportOnly
  } = controller
  const showPlateSection = mode === 'simple'
  // The inline Objects + per-plate G-code sections are simple-mode only: the 3D editor
  // renders its own object list and G-code sections after this panel.
  const showInlineObjects = mode === 'simple'
  // Add/remove materials is an editing affordance (Bambu-style) — only in the editor.
  const showMaterialEditing = mode === 'editor'
  // What the printer has loaded, for the Add button's menu. Unlike a material ROW there is no slot
  // to prioritize by nozzle yet, so the list is the plain grouped one; empty for a manual-profile
  // target, which is exactly when Add falls back to opening the dialog directly.
  const loadedMaterialsForAdd = targetMode === 'realPrinter' ? loadedMaterialOptions : []
  /**
   * A loaded material as a new slot's identity. Same three fields the add dialog produces (see
   * `AddMaterialDialog`), so both paths create identical slots, plus the tray's toolhead — picking
   * from the printer says which nozzle the material is on, which a manual pick does not.
   */
  const addedChoiceFromOption = (option: SliceMaterialOption): AddedMaterialChoice => ({
    optionId: option.id,
    // A tray always reports a colour; `normalizeSliceFilamentColor` covers the malformed case, and
    // `handleAddFilament` normalizes again on the way into the slot.
    color: normalizeSliceFilamentColor(option.color),
    label: option.materialType || option.material || 'PLA',
    ...(option.toolheadId ? { toolheadId: option.toolheadId } : {})
  })
  // No printers means nothing to pick: an empty "Printer" autocomplete is noise in a workspace that
  // has not added one yet, and on a host that cannot have them at all (the public editor, where a
  // browser cannot reach a printer) it would be a control that can never do anything. Targeting a
  // printer MODEL is separate and stays — it is what decides process compatibility.
  const showPrinterPicker = printers.length > 0
  // The target model is unresolved until the project's index says what it is (or, for a project
  // that names none, until the catalogue arrives and a default is chosen). Nothing guesses in the
  // meantime, so the control waits instead of offering a value nobody picked.
  const modelResolved = selectedPrinterModel !== 'unknown'
  // Which material's expanded type/preset/color dialog is open (opened by clicking the
  // compact swatch row). Panel-local: both surfaces render their own panel instance.
  const [materialDialogFilamentId, setMaterialDialogFilamentId] = useState<number | null>(null)
  const [addingMaterial, setAddingMaterial] = useState(false)
  const [projectPresetsOpen, setProjectPresetsOpen] = useState(false)
  // Whether the Materials header carries the project-presets action, which decides where the
  // `ml: 'auto'` push lives: with two actions it belongs on the FIRST of them, or both claim it and
  // the pair splits across the header.
  const hasProjectPresets = Boolean(embeddedPresets && onRemoveEmbeddedPreset && embeddedPresets.length > 0)
  const [printerPickerOpen, setPrinterPickerOpen] = useState(false)
  // Pre-open "changed values" badge for the process row: how far the FINAL sliced values
  // (embedded project config + session overrides) differ from the external preset.
  // Same source as the dialog's own tiering, so both agree on which options exist at all.
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
  // The visibility inputs mirror what this panel hands the dialog, so the badge counts exactly the
  // rows the dialog will show (a conditionally-hidden modified setting inflated the badge before).
  const processChangedCount = useProcessChangedCount({
    slicerTargetId: selectedSlicerTargetIdForGuards,
    processProfileId: selectedProcessProfile?.id ?? null,
    sourceFileId: file.id,
    overrides: processSettingOverrides,
    resolveConfig,
    visibilityContext: { printerModel: selectedPrinterModel },
    developerMode: showDeveloperOptions
  })
  return (
    <>
      {slicerStatus.capabilitiesLoading && !slicerStatus.hasCapabilities && (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="text.secondary">Checking slicer availability…</Typography>
        </Stack>
      )}
      {!slicerStatus.capabilitiesLoading && slicerStatus.capabilitiesError && (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{slicerStatus.capabilitiesError}</Alert>
      )}
      {/* Slicer is installed but starting/restarting — keep the user waiting (the
          capabilities query polls and recovers) rather than showing a dead-end error. */}
      {!slicerStatus.capabilitiesLoading && !slicerStatus.capabilitiesError && slicerStatus.slicerRestarting && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }}>
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="text.secondary">Waiting for the slicer to start…</Typography>
        </Stack>
      )}
      {!slicerStatus.capabilitiesLoading && !slicerStatus.capabilitiesError && !slicerStatus.slicerRestarting && !slicerStatus.configured && (
        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
          The slicer service is not reachable or no slicer versions are installed.
        </Alert>
      )}
      {slicerStatus.configured && !slicerStatus.capabilitiesError && !slicerStatus.slicerDataReady && !slicerStatus.profilesError && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }}>
          <CircularProgress size="sm" />
          <Typography level="body-sm" textColor="text.secondary">Loading slicer data…</Typography>
        </Stack>
      )}
      {/* When the slicer is restarting, the profile-load failure is transient — show the
          wait above instead of the "reopen the editor" error. */}
      {slicerStatus.profilesError && !slicerStatus.slicerRestarting && (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{slicerStatus.profilesError}</Alert>
      )}
      {slicerStatus.slicerDataReady && (<>
      {/* Every section header below is a DIRECT child of the scrolling column and its body the
          next sibling: that is what lets each pinned header be covered by the next rather than
          shoved off the top. Do not wrap a section in its own <Stack>. See StickySectionHeader. */}
      <StickySectionHeader><Typography level="title-sm">Slicer</Typography></StickySectionHeader>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          <FormControl>
            <Select<string>
              value={selectedSlicerTargetId || null}
              placeholder="Choose a slicer version"
              disabled={slicerTargets.length === 0}
              slotProps={{ button: { 'aria-label': 'Version' } }}
              onChange={(_event, value) => setSelectedSlicerTargetId(value ?? '')}
            >
              {slicerTargets.map((target) => (
                <Option key={target.id} value={target.id}>{target.label}</Option>
              ))}
            </Select>
          </FormControl>
        </Stack>
      </Sheet>
      <StickySectionHeader spacing={1}>
        <Typography level="title-sm">Printer</Typography>
        {/* The selection moved out of the card below: a narrow sidebar gave a fleet one cramped
            line with no way to scan by model. The button reads as the section's action, matching
            the Materials header. Hidden exactly when the inline picker was. */}
        {showPrinterPicker && (
          <Button
            type="button"
            size="sm"
            variant="soft"
            startDecorator={<Printer3dRoundedIcon />}
            sx={{ ml: 'auto', maxWidth: '60%' }}
            disabled={Boolean(lockedPreferredPrinter)}
            onClick={() => setPrinterPickerOpen(true)}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedPrinter ? selectedPrinter.name : 'Choose printer'}
            </Box>
          </Button>
        )}
      </StickySectionHeader>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Box
          sx={{
            // The settings now live in a narrow sidebar, so keep at most two inputs
            // per line everywhere (the layout reads well at desktop and phone widths).
            display: 'grid',
            gap: 1,
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateAreas: '"model plateType" "nozzleDiameter nozzleFlow"'
          }}
        >
            <FormControl sx={{ gridArea: 'model', minWidth: 0 }}>
              <FormLabel>Model</FormLabel>
              <Select<string>
                // 'unknown' means the project has not said yet and nothing is guessing. Show that
                // as waiting rather than rendering the literal word, which reads like a real answer.
                value={modelResolved ? selectedPrinterModel : null}
                placeholder="Loading…"
                disabled={!modelResolved || targetMode === 'realPrinter' || Boolean(lockedPreferredPrinter)}
                onChange={(_event, value) => {
                  if (targetMode === 'realPrinter') return
                  selectPrinterModel(value ?? printerModelOptions[0] ?? 'unknown')
                }}
              >
                {printerModelOptions.map((model) => (
                  <Option key={model} value={model}>{formatPrinterModelLabel(model)}</Option>
                ))}
              </Select>
            </FormControl>
            <FormControl sx={{ gridArea: 'nozzleDiameter', minWidth: 0 }}>
              <FormLabel>Nozzle diameter</FormLabel>
              <Select<string> value={nozzleDiameter} disabled={Boolean(lockedPreferredPrinter)} onChange={(_event, value) => setNozzleDiameter(value ?? '')}>
                {nozzleDiameterOptions.map((option) => (
                  <Option key={option} value={option}>{formatNozzleDiameterLabel(option) ?? `${option} mm`}</Option>
                ))}
              </Select>
            </FormControl>
            <FormControl sx={{ gridArea: 'nozzleFlow', minWidth: 0 }}>
              <FormLabel>Nozzle flow</FormLabel>
              <Select<PrinterNozzleFlow> value={nozzleFlow} disabled={Boolean(lockedPreferredPrinter)} onChange={(_event, value) => setNozzleFlow(value ?? 'standard')}>
                <Option value="standard">Standard flow</Option>
                <Option value="high">High flow</Option>
                <Option value="tpu-high">TPU high flow</Option>
              </Select>
            </FormControl>
            <FormControl sx={{ gridArea: 'plateType', minWidth: 0 }}>
              <FormLabel>Plate type</FormLabel>
              <Select<string> value={plateType} disabled={Boolean(lockedPreferredPrinter)} onChange={(_event, value) => setPlateType(value ?? '')}>
                {plateTypeOptions.map((option) => (
                  <Option key={option} value={option}>{formatPlateTypeLabel(option)}</Option>
                ))}
              </Select>
            </FormControl>
        </Box>
        {/* A pick this target cannot represent. Sits with the controls it is about, and stays
            visible while the conflict lasts — a toast would vanish while the wrong value remains
            on screen. The pick itself is kept, so switching back restores it. */}
        {targetConflicts && targetConflicts.length > 0 && (
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {machineTargetConflictWarnings(targetConflicts).map((warning) => (
              <Alert key={warning.key} size="sm" color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                {warning.message}
              </Alert>
            ))}
          </Stack>
        )}
      </Sheet>
      {showPlateSection && (<>
      <StickySectionHeader><Typography level="title-sm">Plate</Typography></StickySectionHeader>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          {!requiresSinglePlate && (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
            >
              <ButtonGroup size="md" variant="outlined" sx={{ '--ButtonGroup-radius': 'var(--joy-radius-sm)', width: { xs: '100%', sm: 'auto' }, '& > *': { flex: { xs: 1, sm: 'initial' } } }}>
                <Button
                  type="button"
                  variant={plateMode === 'all' ? 'solid' : 'outlined'}
                  color={plateMode === 'all' ? 'primary' : 'neutral'}
                  onClick={() => setPlateMode('all')}
                >
                  All plates
                </Button>
                <Button
                  type="button"
                  variant={plateMode === 'single' ? 'solid' : 'outlined'}
                  color={plateMode === 'single' ? 'primary' : 'neutral'}
                  onClick={() => setPlateMode('single')}
                >
                  Specific plate
                </Button>
              </ButtonGroup>
              {canOpenThreeDimensionalPreview && (
                <Button
                  type="button"
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  startDecorator={<VisibilityRoundedIcon />}
                  onClick={() => setPreviewFileId(file.id)}
                  sx={{ width: { xs: '100%', sm: 'auto' } }}
                >
                  Preview
                </Button>
              )}
            </Stack>
          )}
          {sceneEdit && (
            <Chip
              variant="soft"
              color="primary"
              size="md"
              endDecorator={
                <Tooltip title="Reset to original layout">
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="primary"
                    onClick={() => setSceneEdit(null)}
                    aria-label="Reset custom layout"
                  >
                    <RestoreRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
              sx={{ alignSelf: 'flex-start' }}
            >
              Custom layout: {sceneEdit.instances.length} {sceneEdit.instances.length === 1 ? 'model' : 'models'} on {sceneEdit.plates.length} {sceneEdit.plates.length === 1 ? 'plate' : 'plates'}
            </Chip>
          )}
          {(requiresSinglePlate || plateMode === 'single') && (
            slicePlateOptions.length > 0 ? (
              <LibraryPlateCardPicker
                fileId={file.id}
                resourceBasePath={resourceBasePath}
                thumbnailVersion={file.uploadedAt}
                plates={slicePlateOptions}
                value={Number.parseInt(plateNumber, 10)}
                onChange={(value) => setPlateNumber(String(value))}
                label={flow === 'print' ? 'Choose a plate to print' : 'Choose a plate to slice'}
                onPreview={canOpenThreeDimensionalPreview ? () => setPreviewFileId(file.id) : undefined}
              />
            ) : (
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Plate number</FormLabel>
                <Input type="number" slotProps={{ input: { min: 1, step: 1 } }} value={plateNumber} onChange={(event) => setPlateNumber(event.target.value)} />
              </FormControl>
            )
          )}
        </Stack>
      </Sheet>
      </>)}
      <StickySectionHeader spacing={1}>
        <Typography level="title-sm">Process</Typography>
        {/* Mirrors the Materials header's action so the two sections read the same way. */}
        {onManagePresets && (
          <Button type="button" size="sm" variant="soft" startDecorator={<TuneRoundedIcon />} sx={{ ml: 'auto' }} onClick={onManagePresets}>
            Manage
          </Button>
        )}
      </StickySectionHeader>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          <FormControl sx={{ flex: 1 }}>
            <FormLabel>Global</FormLabel>
            <Stack direction="row" spacing={1} alignItems="center">
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <SlicingPresetAutocomplete
                  profiles={compatibleProcessProfiles}
                  value={selectedProcessProfile}
                  placeholder="Choose a process preset"
                  ariaLabel="Preset"
                  modified={processProfileModified || processChangedCount > 0}
                  onChange={(profile) => {
                    // Snapshot the pre-switch profile+overrides for undo/dirty (no-op outside the editor).
                    processEditListenerRef.current?.()
                    processProfileSelectionTouchedRef.current = true
                    setProcessProfileId(profile?.id ?? '')
                    setProcessSettingOverrides({})
                  }}
                />
              </Box>
              <Tooltip title={selectedProcessProfile
                ? (processChangedCount > 0 ? `Edit process settings — ${processChangedCount} changed vs preset` : 'Edit process settings')
                : 'Choose a quality profile first'}
              >
                <span>
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="neutral"
                    disabled={!selectedProcessProfile || !selectedSlicerTargetIdForGuards}
                    onClick={() => setProcessSettingsDialogOpen(true)}
                    aria-label="Edit process settings"
                  >
                    <TuneRoundedIcon fontSize="small" />
                    {processChangedCount > 0 && (
                      <Chip size="sm" variant="solid" color="primary" sx={{ ml: 0.5 }}>{processChangedCount}</Chip>
                    )}
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </FormControl>
        </Stack>
      </Sheet>
      {(projectFilaments.length > 0 || showMaterialEditing) && (<>
          <StickySectionHeader spacing={1}>
            <Typography level="title-sm">Materials</Typography>
            {/* Opens the picker; the slot is created only once a material is confirmed. */}
            {/* Beside Add material, not as a section of its own: this is an occasional housekeeping
                trip into the project file, not something to keep on screen while choosing materials.
                Hidden when the project carries none — most do — so it is never a dead affordance,
                and the count makes its presence the information. */}
            {embeddedPresets && onRemoveEmbeddedPreset && embeddedPresets.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="plain"
                color="neutral"
                startDecorator={<InventoryRoundedIcon />}
                sx={{ ml: 'auto' }}
                onClick={() => setProjectPresetsOpen(true)}
              >
                Project presets ({embeddedPresets.length})
              </Button>
            )}
            {showMaterialEditing && (loadedMaterialsForAdd.length > 0 ? (
              // Same two choices the row swatch offers, for the same reason: a material the printer
              // is already holding should not have to be named by hand.
              <Dropdown>
                {/* `color` is explicit: Joy's Button defaults to primary but MenuButton to neutral,
                    so without it the same button changed tone the moment a printer was selected. */}
                <MenuButton size="sm" variant="soft" color="primary" startDecorator={<AddRoundedIcon />} sx={{ ml: hasProjectPresets ? 0 : 'auto' }}>
                  Add material
                </MenuButton>
                <Menu
                  placement="bottom-end"
                  sx={{ zIndex: (theme) => theme.zIndex.tooltip, minWidth: 280, maxWidth: 'calc(100vw - 32px)', maxHeight: '60vh', overflowY: 'auto' }}
                >
                  <LoadedMaterialMenuItems
                    loaded={{
                      groups: groupSliceMaterialOptionsByGroup(loadedMaterialsForAdd),
                      trayMap: printerTrayMap,
                      onSelect: (option) => onAddFilament(addedChoiceFromOption(option))
                    }}
                    manualLabel="Choose manually…"
                    onChooseManually={() => setAddingMaterial(true)}
                  />
                </Menu>
              </Dropdown>
            ) : (
              <Button type="button" size="sm" variant="soft" startDecorator={<AddRoundedIcon />} sx={{ ml: hasProjectPresets ? 0 : 'auto' }} onClick={() => setAddingMaterial(true)}>
                Add material
              </Button>
            ))}
          </StickySectionHeader>
          <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
            <Stack spacing={0.75}>
              {projectFilaments.length === 0 && showMaterialEditing && (
                <Typography level="body-sm" textColor="text.tertiary">No materials yet. Add one to choose a material.</Typography>
              )}
              {projectFilaments.map((filament, filamentIndex) => {
                const selectedOption = materialOptions.find((option) => option.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
                const typeFilter = filamentMaterialTypeFilters[filament.projectFilamentId] ?? selectedOption?.materialType ?? ''
                const selectedToolheadId = filamentToolheadIds[filament.projectFilamentId] ?? ''
                const useToolheadButtonSet = materialToolheadOptions.length === 2
                const normalizedColor = normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color)
                // Same family derivation as the color picker, so the swatch's colour NAME
                // matches what the expanded dialog will show.
                const colorName = resolveProjectFilamentColorName({
                  color: normalizedColor,
                  filamentName: [selectedOption?.brand, (selectedOption?.material ?? selectedOption?.materialType ?? typeFilter) || filament.label].filter(Boolean).join(' ') || null,
                  filamentType: (selectedOption?.materialType ?? typeFilter) || filament.label
                }) ?? normalizedColor.toUpperCase()
                const presetName = selectedOption ? (selectedOption.presetLabel ?? selectedOption.label) : filament.label
                const presetUnmatched = Boolean(selectedOption && selectedOption.source !== 'manual' && !selectedOption.profileId)
                // What the printer currently has loaded for this slot, in the priority order the
                // pickers use. Empty for a manual-profile target, which is exactly when the swatch
                // has nothing to list and falls back to opening the dialog on click.
                const loadedMaterialsForFilament = targetMode === 'realPrinter'
                  ? prioritizeLoadedMaterialOptionsForFilament(loadedMaterialOptions, filament.nozzleId ?? null)
                  : []
                return (
                  <Stack key={filament.projectFilamentId} direction="row" alignItems="center" sx={{ flexWrap: 'wrap', columnGap: 0.75, rowGap: 0.5 }}>
                    <MaterialSwatchButton
                      filamentIndex={filamentIndex}
                      presetName={presetName}
                      fullPresetName={selectedOption?.profileId ? selectedOption.material : null}
                      colorName={colorName}
                      color={normalizedColor}
                      presetUnmatched={presetUnmatched}
                      selectedMaterialOptionId={selectedOption?.id ?? null}
                      loadedMaterials={loadedMaterialsForFilament.length > 0
                        ? {
                            groups: groupSliceMaterialOptionsByGroup(loadedMaterialsForFilament),
                            trayMap: printerTrayMap,
                            // Through the controller (not the picker Modal) so the editor's dirty
                            // flag and undo see the pick without the materialEditListenerRef detour.
                            onSelect: (option) => handleMaterialOptionChange(filament.projectFilamentId, option)
                          }
                        : null}
                      onOpenMaterialDialog={() => setMaterialDialogFilamentId(filament.projectFilamentId)}
                    />
                    {materialToolheadOptions.length > 0 && (useToolheadButtonSet ? (
                      <ButtonGroup
                        size="sm"
                        // Soft group with a solid selected button (the GizmoToolbar pattern).
                        variant="soft"
                        aria-label={`Nozzle for material ${filamentIndex + 1}`}
                        sx={{
                          '--ButtonGroup-radius': 'var(--joy-radius-sm)',
                          flexShrink: 0,
                          // Padding is pinned on the BUTTONS, not through `& > *`: at that
                          // specificity Joy's own per-variant padding still won for the soft
                          // children (12px) while the solid one took the 8px, so choosing a nozzle
                          // shrank the group by ~9px and the row jumped. Measured, not guessed —
                          // the earlier note here blamed borders, which account for under 1.5px.
                          '& .MuiButton-root': { minWidth: 0, paddingInline: '8px' }
                        }}
                      >
                        {[...materialToolheadOptions].sort((left, right) => {
                          const rank = (position: 'left' | 'right' | 'single' | null | undefined) => position === 'left' ? 0 : position === 'right' ? 1 : 2
                          return rank(left.position) - rank(right.position)
                        }).map((toolhead) => {
                          // Single-letter labels keep the row compact; the full label rides the tooltip.
                          const buttonLabel = toolhead.position === 'left'
                            ? 'L'
                            : toolhead.position === 'right'
                              ? 'R'
                              : toolhead.label
                          const selected = selectedToolheadId === toolhead.id
                          return (
                            <Button
                              key={toolhead.id}
                              type="button"
                              variant={selected ? 'solid' : 'soft'}
                              color={selected ? 'primary' : 'neutral'}
                              aria-pressed={selected}
                              aria-label={toolhead.label}
                              onClick={() => setFilamentToolheadIds((current) => ({ ...current, [filament.projectFilamentId]: toolhead.id }))}
                              title={toolhead.label}
                            >
                              {buttonLabel}
                            </Button>
                          )
                        })}
                      </ButtonGroup>
                    ) : (
                      <Select<string>
                        size="sm"
                        value={selectedToolheadId || null}
                        placeholder="Nozzle"
                        slotProps={{ button: { 'aria-label': `Nozzle for material ${filamentIndex + 1}` } }}
                        sx={{ flexShrink: 0, minWidth: 96 }}
                        onChange={(_event, value) => setFilamentToolheadIds((current) => ({ ...current, [filament.projectFilamentId]: value ?? '' }))}
                      >
                        {materialToolheadOptions.map((toolhead) => (
                          <Option key={toolhead.id} value={toolhead.id}>{toolhead.label}</Option>
                        ))}
                      </Select>
                    ))}
                    <FilamentTuneButton
                      filamentIndex={filamentIndex}
                      projectFilamentId={filament.projectFilamentId}
                      selectedOption={selectedOption}
                      slicerTargetId={selectedSlicerTargetIdForGuards}
                      sourceFileId={file.id}
                      resolveConfig={resolveFilamentConfig}
                      overrides={filamentSettingOverridesById[filament.projectFilamentId] ?? {}}
                      onOpen={() => openFilamentSettings(filament.projectFilamentId)}
                    />
                    {showMaterialEditing && (() => {
                      const inUse = filamentInUse?.(filament.projectFilamentId) ?? false
                      const supportOnly = filamentSupportOnly?.(filament.projectFilamentId) ?? false
                      const removeDisabled = projectFilaments.length <= 1 || inUse
                      // `inUse` covers OBJECT references only. A material used just by a process
                      // setting stays removable — the setting falls back to "Default" — so say so
                      // rather than leaving the user to guess what happens to their supports.
                      const removeTitle = projectFilaments.length <= 1
                        ? 'A project needs at least one material'
                        : inUse
                          ? 'This material is used by an object — reassign it before removing'
                          : supportOnly
                            ? 'Remove material — supports using it fall back to the default material'
                            : 'Remove material'
                      return (
                        <Tooltip title={removeTitle}>
                          <span>
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="danger"
                              disabled={removeDisabled}
                              onClick={() => onRemoveFilament(filament.projectFilamentId)}
                              aria-label={`Remove material ${filamentIndex + 1}`}
                            >
                              <DeleteRoundedIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      )
                    })()}
                  </Stack>
                )
              })}
            </Stack>
          </Sheet>
      </>)}
      {showInlineObjects && hasPlateObjects && (<>
          <StickySectionHeader><Typography level="title-sm">Objects</Typography></StickySectionHeader>
          <Sheet variant="outlined" sx={{ p: 0.5, borderRadius: 'sm' }}>
            <List size="sm" sx={{ '--ListItem-minHeight': '2.25rem' }}>
              {plateObjects.map((object) => {
                const printing = selectedSliceObjectIds.has(object.id)
                const overrideCount = Object.keys(perObjectSettings?.value[String(object.id)] ?? {}).length
                return (
                  <ListItem key={object.id}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
                      <Tooltip title={printing ? `Will ${flow === 'print' ? 'print' : 'slice'} — toggle to skip` : 'Skipped — toggle to include'} variant="soft">
                        <Switch
                          size="sm"
                          checked={printing}
                          onChange={() => onToggleSliceObject(object.id)}
                          slotProps={{ input: { 'aria-label': `Include ${object.name}` } }}
                          sx={{ flexShrink: 0 }}
                        />
                      </Tooltip>
                      <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0, opacity: printing ? 1 : 0.5 }}>
                        {object.name}
                      </Typography>
                      <SettingsTuneButton
                        changedCount={overrideCount}
                        title={selectedProcessProfile ? 'Per-object settings' : 'Choose a quality profile first'}
                        ariaLabel={`Per-object settings for ${object.name}`}
                        disabled={!selectedProcessProfile || !selectedSlicerTargetIdForGuards}
                        onClick={() => openSliceObjectSettings(object.id, object.name)}
                      />
                    </Stack>
                  </ListItem>
                )
              })}
            </List>
          </Sheet>
          {selectedSliceObjectIds.size < plateObjects.length && (
            <Typography level="body-xs" sx={{ color: selectedSliceObjectIds.size === 0 ? 'danger.500' : 'text.tertiary' }}>
              {selectedSliceObjectIds.size === 0
                ? `Select at least one object to ${flow === 'print' ? 'print' : 'slice'}.`
                : `${selectedSliceObjectIds.size} of ${plateObjects.length} objects will ${flow === 'print' ? 'print' : 'be sliced'}.`}
            </Typography>
          )}
      </>)}
      {showInlineObjects && plateGcode && (
        <>
          {/* A single material has nothing to change to; pauses apply regardless. */}
          {plateGcode.filamentOptions.length > 1 && (
            <PlateFilamentChangesSection
              changes={plateGcode.filamentChanges}
              filamentOptions={plateGcode.filamentOptions}
              onChange={plateGcode.onFilamentChangesChange}
            />
          )}
          <PlatePausesSection pauses={plateGcode.pauses} onChange={plateGcode.onPausesChange} />
        </>
      )}
      {materialDialogFilamentId != null && (() => {
        // Deriving here (not stored) keeps the dialog live against the controller: an edit that
        // lands while it is open updates type/preset/color in place, and a filament removed out
        // from under it (editor undo) simply renders nothing.
        const filamentIndex = projectFilaments.findIndex((entry) => entry.projectFilamentId === materialDialogFilamentId)
        const filament = filamentIndex >= 0 ? projectFilaments[filamentIndex] : null
        if (!filament) return null
        const selectedOption = materialOptions.find((option) => option.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
        const typeFilter = filamentMaterialTypeFilters[filament.projectFilamentId] ?? selectedOption?.materialType ?? ''
        return (
          <MaterialEditDialog
            filamentIndex={filamentIndex}
            filamentLabel={filament.label}
            typeFilter={typeFilter}
            typeOptions={resolveMaterialTypeOptions(materialOptions)}
            onTypeFilterChange={(value) => setFilamentMaterialTypeFilters((current) => ({ ...current, [filament.projectFilamentId]: value }))}
            materialOptions={narrowMaterialOptions(materialOptions, typeFilter, selectedOption?.id)}
            selectedOption={selectedOption}
            onMaterialOptionChange={(option) => handleMaterialOptionChange(filament.projectFilamentId, option)}
            color={normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color)}
            onColorChange={(color) => setFilamentColors((current) => ({ ...current, [filament.projectFilamentId]: normalizeSliceFilamentColor(color) }))}
            onClose={() => setMaterialDialogFilamentId(null)}
          />
        )
      })()}
      {printerPickerOpen && (
        <PrinterPickerDialog
          open
          entries={printers.map((printer) => ({ printer }))}
          selectedPrinterId={selectedPrinter?.id ?? null}
          onSelect={selectPrinter}
          onClose={() => setPrinterPickerOpen(false)}
          anyOption={{ label: 'Any printer', description: 'Slice for the selected model instead' }}
        />
      )}
      {hasProjectPresets && (
        <ProjectPresetsDialog
          open={projectPresetsOpen}
          onClose={() => setProjectPresetsOpen(false)}
          presets={embeddedPresets ?? []}
          onRemove={onRemoveEmbeddedPreset!}
        />
      )}
      {addingMaterial && (
        <AddMaterialDialog
          filamentIndex={projectFilaments.length}
          materialOptions={materialOptions}
          onAdd={(choice) => { onAddFilament(choice); setAddingMaterial(false) }}
          onCancel={() => setAddingMaterial(false)}
        />
      )}
      </>)}
    </>
  )
}

/**
 * Material "tune" button + pre-open changed-values badge. Its own component (rather than inline in
 * the material row map) so the per-material resolve hook is legal; the badge counts how far the
 * material's FINAL sliced values (embedded config + session overrides) differ from the external
 * preset — same math as the FilamentSettingsDialog, so badge and dialog always agree.
 */
function FilamentTuneButton(props: {
  filamentIndex: number
  projectFilamentId: number
  selectedOption: SliceMaterialOption | null
  slicerTargetId: string
  sourceFileId: string
  /** Anonymous resolver (public editor); when set the badge resolves without a workspace/server file. */
  resolveConfig?: FilamentConfigResolver
  overrides: Record<string, string | string[]>
  onOpen: () => void
}): JSX.Element {
  const { filamentIndex, projectFilamentId, selectedOption, slicerTargetId, sourceFileId, resolveConfig, overrides, onOpen } = props
  // The tune dialog needs a resolvable filament profile id: the option's own profileId
  // (builtin/custom), or the underlying id for a project-embedded profile (option id =
  // `profile:<profileId>`). A loaded material with no matched preset has neither, so editing is
  // disabled until one is picked.
  const filamentProfileId = selectedOption?.profileId
    ?? (selectedOption?.id.startsWith('profile:') ? selectedOption.id.slice('profile:'.length) : null)
  const changedCount = useFilamentChangedCount({ slicerTargetId, filamentProfileId, sourceFileId, projectFilamentId, overrides, resolveConfig })
  return (
    <SettingsTuneButton
      changedCount={changedCount}
      title={filamentProfileId
        ? (changedCount > 0 ? `Edit filament settings — ${changedCount} changed vs preset` : 'Edit filament settings')
        : 'Choose a material profile first'}
      ariaLabel={`Edit filament settings for material ${filamentIndex + 1}`}
      disabled={!filamentProfileId || !slicerTargetId}
      onClick={onOpen}
    />
  )
}
