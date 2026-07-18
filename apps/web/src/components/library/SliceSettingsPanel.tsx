/**
 * Shared slice-settings surface extracted from `pages/LibraryView.tsx`.
 *
 * Owns the `SliceSettingsPanel` (the slicer/printer/plate/process/materials
 * controls) plus the `SliceSettingsController` and `SliceMaterialsSnapshot`
 * contracts that bridge `SliceFileModal`'s state into it, so the SAME panel
 * renders both in the slim slice dialog (`mode='simple'`) and inside the model
 * studio's 3D editor (`mode='editor'`). Each material renders as one compact
 * swatch row (number + preset/colour name, plus the nozzle picker); the expanded
 * type/preset/color inputs live in `MaterialEditDialog`, opened by clicking the
 * swatch. State stays owned by the caller; only values/setters flow through the
 * controller.
 */
import type React from 'react'
import { useEffect, useState } from 'react'
import {
  Alert, AutocompleteOption, Badge, Box, Button, ButtonGroup, Chip, CircularProgress, FormControl, FormLabel, IconButton, Input, Link,
  List, ListItem, ListItemContent, Option, Select, Sheet, Stack, Switch, Tooltip, Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
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
  SlicingProfileSummary,
  ThreeMfIndex
} from '@printstream/shared'
import { formatNozzleDiameterLabel } from '@printstream/shared'
import { useNavigate } from 'react-router-dom'
import { DeferredKeyboardAutocomplete } from '../DeferredKeyboardAutocomplete'
import { prioritizeLoadedMaterialOptionsForFilament } from '../../lib/sliceLoadedMaterialOptions'
import { filamentTextColor, resolveProjectFilamentColorName } from '../../lib/filamentColor'
import { formatSlicingProfileDisplayName } from '../../lib/slicingProfileSelection'
import {
  buildSliceDialogProjectFilaments,
  buildSliceDialogToolheads,
  formatPlateTypeLabel,
  formatPrinterModelLabel,
  isProjectSlicingProfile,
  narrowMaterialOptions,
  normalizeSliceFilamentColor,
  resolveMaterialTypeOptions,
  type SliceMaterialOption
} from '../../lib/sliceProfileMatching'
import { MaterialEditDialog } from './MaterialEditDialog'
import { PlateFilamentChangesSection, PlatePausesSection, type FilamentOption } from './PlateGcodeSections'
import { useFilamentChangedCount, useProcessChangedCount } from './useBakedPresetChanges'
import { LibraryPlateCardPicker } from '../LibraryPlateSelect'
import { buildTenantWorkspacePath } from '../../lib/workspaceRoute'

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
  tenantSlug: string | undefined
  navigate: ReturnType<typeof useNavigate>
  onClose: () => void
  // Slicer
  slicerTargets: SlicingCapabilities['targets']
  selectedSlicerTargetId: string
  setSelectedSlicerTargetId: React.Dispatch<React.SetStateAction<string>>
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
  setTargetMode: React.Dispatch<React.SetStateAction<'realPrinter' | 'manualProfile'>>
  setPrinterId: React.Dispatch<React.SetStateAction<string>>
  selectedPrinterModel: string
  manualPrinterModelTouchedRef: React.MutableRefObject<boolean>
  setManualPrinterModel: React.Dispatch<React.SetStateAction<string>>
  printerModelOptions: string[]
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
  compatibleProcessProfiles: SlicingProfileSummary[]
  selectedProcessProfile: SlicingProfileSummary | null
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
  /** Project-filament ids used by a given plate (for the "not on this plate" hint). */
  usedFilamentIdsForPlate: (plateIndex: number) => Set<number>
  materialOptions: SliceMaterialOption[]
  loadedMaterialOptions: SliceMaterialOption[]
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
  setPrinterMaterialPickerFilamentId: React.Dispatch<React.SetStateAction<number | null>>
  handleMaterialOptionChange: (projectFilamentId: number, option: SliceMaterialOption | null) => void
  /**
   * Add/remove materials (Bambu-style). `desiredFilaments` is the full ordered filament
   * list to bake into the saved/sliced 3MF, or null when the user has not changed the
   * count (so unchanged projects don't rewrite project_settings.config). `onAddFilament`
   * appends a slot cloned from the first material; `onRemoveFilament` drops one (the UI
   * disables removing the last). Only surfaced in the editor ('editor' mode).
   */
  desiredFilaments: SceneEditFilament[] | null
  /**
   * Manual-profile target for the currently-selected machine when it is cross-model with the
   * project's source (so saving should retarget the 3MF to it, Bambu "switch printer + save").
   * Null when the selection matches the source model (no machine switch needed on save).
   */
  retargetTarget: SlicingManualProfileTarget | null
  onAddFilament: () => void
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
   * Point-in-time snapshot of the material-edit state + a restore fn, so the editor's
   * undo/redo can revert add/remove of materials alongside the scene (the material state
   * lives here, in the slice controller, not in the editor's scene state).
   */
  materialsSnapshot: SliceMaterialsSnapshot
  restoreMaterials: (snapshot: SliceMaterialsSnapshot) => void
  /**
   * Mutable listener the full editor sets to its `markDirty`, invoked whenever a material
   * is changed through this controller's own picker Modal (which the editor renders behind
   * itself). Lets picker-driven edits flip the editor's unsaved-changes flag even though they
   * bypass the markDirty-wrapped controller the editor hands to the settings panel.
   */
  materialEditListenerRef: React.MutableRefObject<(() => void) | null>
  /**
   * Notification from the editor's save flow that the project was just persisted with the
   * CURRENT material list (add/remove overlays baked into the file as slots 1..N). The
   * controller uses it to rebase its session overlay onto the refreshed file — without it,
   * an added material appears twice after Save (once from the refetched base, once from the
   * still-pending overlay) until the editor is reopened.
   */
  onProjectSaved: () => void
  /**
   * Sibling of {@link materialEditListenerRef} for GLOBAL process-setting edits (the process
   * profile selection and the overrides applied by the process-settings dialog). The full editor
   * sets it to a snapshot-then-dirty handler; call it BEFORE mutating `processProfileId` /
   * `processSettingOverrides` so the pre-edit values are captured for undo. Null (no-op) outside
   * the editor. Global process edits otherwise bypass the editor's dirty/undo like material picks do.
   */
  processEditListenerRef: React.MutableRefObject<(() => void) | null>
}

export interface SliceMaterialsSnapshot {
  removedFilamentIds: number[]
  profileEditedFilamentIds: number[]
  addedFilaments: Array<{ projectFilamentId: number; label: string; color: string | null; nozzleId: number | null; usedOnSelectedPlate: boolean }>
  addedFilamentSourceIndex: Record<number, number>
  filamentColors: Record<number, string>
  filamentMaterialOptionIds: Record<number, string>
  filamentToolheadIds: Record<number, string>
  filamentMaterialTypeFilters: Record<number, string>
  /** Per-object process overrides, so the editor's undo/redo can revert a gear edit. */
  objectProcessOverrides: Record<string, Record<string, string | string[]>>
  /** Selected process profile id, so undo can revert a profile switch alongside its overrides. */
  processProfileId: string
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
export function SliceSettingsPanel({ controller, mode }: {
  controller: SliceSettingsController
  mode: 'simple' | 'editor'
  activePlateIndex?: number
}) {
  const {
    file, resourceBasePath, flow, requiresSinglePlate, canOpenThreeDimensionalPreview,
    tenantSlug, navigate, onClose,
    slicerTargets, selectedSlicerTargetId, setSelectedSlicerTargetId, slicerStatus,
    printers, selectedPrinter, lockedPreferredPrinter, targetMode, setTargetMode, setPrinterId,
    selectedPrinterModel, manualPrinterModelTouchedRef, setManualPrinterModel, printerModelOptions,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, nozzleFlow, setNozzleFlow,
    plateType, setPlateType, plateTypeOptions,
    plateMode, setPlateMode, sceneEdit, setSceneEdit, plateNumber, setPlateNumber, slicePlateOptions, setPreviewFileId,
    compatibleProcessProfiles, selectedProcessProfile, processProfileModified, setProcessProfileId, setProcessSettingOverrides,
    processProfileSelectionTouchedRef, selectedSlicerTargetIdForGuards, processSettingOverrides, setProcessSettingsDialogOpen, processEditListenerRef,
    hasPlateObjects, selectedSliceObjectIds, plateObjects, onToggleSliceObject, openSliceObjectSettings, plateGcode, perObjectSettings,
    projectFilaments, materialOptions, loadedMaterialOptions, materialToolheadOptions,
    filamentMaterialOptionIds, filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentToolheadIds, setFilamentToolheadIds, filamentColors, setFilamentColors,
    filamentSettingOverridesById, openFilamentSettings,
    setPrinterMaterialPickerFilamentId, handleMaterialOptionChange,
    onAddFilament, onRemoveFilament, filamentInUse, filamentSupportOnly
  } = controller
  const showPlateSection = mode === 'simple'
  // The inline Objects + per-plate G-code sections are simple-mode only: the 3D editor
  // renders its own object list and G-code sections after this panel.
  const showInlineObjects = mode === 'simple'
  // Add/remove materials is an editing affordance (Bambu-style) — only in the editor.
  const showMaterialEditing = mode === 'editor'
  // Which material's expanded type/preset/color dialog is open (opened by clicking the
  // compact swatch row). Panel-local: both surfaces render their own panel instance.
  const [materialDialogFilamentId, setMaterialDialogFilamentId] = useState<number | null>(null)
  // Pre-open "changed values" badge for the process row: how far the FINAL sliced values
  // (embedded project config + session overrides) differ from the external preset.
  const processChangedCount = useProcessChangedCount({
    slicerTargetId: selectedSlicerTargetIdForGuards,
    processProfileId: selectedProcessProfile?.id ?? null,
    sourceFileId: file.id,
    overrides: processSettingOverrides
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
      <Typography level="title-sm">Slicer</Typography>
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
      <Typography level="title-sm">Printer</Typography>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Box
          sx={{
            // The settings now live in a narrow sidebar, so keep at most two inputs
            // per line everywhere (the layout reads well at desktop and phone widths).
            display: 'grid',
            gap: 1,
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateAreas: '"printer printer" "model plateType" "nozzleDiameter nozzleFlow"'
          }}
        >
            <FormControl sx={{ gridArea: 'printer', minWidth: 0 }}>
              <FormLabel>Printer</FormLabel>
              <DeferredKeyboardAutocomplete
                options={printers}
                value={selectedPrinter}
                placeholder={lockedPreferredPrinter ? undefined : 'Optional'}
                clearOnEscape
                disableClearable={Boolean(lockedPreferredPrinter)}
                disabled={Boolean(lockedPreferredPrinter)}
                getOptionLabel={(printer) => printer.name}
                isOptionEqualToValue={(option, selected) => option.id === selected.id}
                onChange={(_event, value) => {
                  setPrinterId(value?.id ?? '')
                  setTargetMode(value ? 'realPrinter' : 'manualProfile')
                }}
                renderOption={(props, printer) => (
                  <AutocompleteOption {...props} key={printer.id}>
                    <ListItemContent>{printer.name}</ListItemContent>
                  </AutocompleteOption>
                )}
              />
            </FormControl>
            <FormControl sx={{ gridArea: 'model', minWidth: 0 }}>
              <FormLabel>Model</FormLabel>
              <Select<string>
                value={selectedPrinterModel}
                disabled={targetMode === 'realPrinter' || Boolean(lockedPreferredPrinter)}
                onChange={(_event, value) => {
                  if (targetMode === 'realPrinter') return
                  manualPrinterModelTouchedRef.current = true
                  setManualPrinterModel(value ?? printerModelOptions[0] ?? 'unknown')
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
      </Sheet>
      {showPlateSection && (<>
      <Typography level="title-sm">Plate</Typography>
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
      <Typography level="title-sm">Process</Typography>
      <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
        <Stack spacing={1}>
          <FormControl sx={{ flex: 1 }}>
            <FormLabel>Global</FormLabel>
            <Stack direction="row" spacing={1} alignItems="center">
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <SlicingProfileAutocomplete
                  profiles={compatibleProcessProfiles}
                  value={selectedProcessProfile}
                  placeholder="Choose a quality profile"
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
          {tenantSlug && (
            <Link
              level="body-xs"
              component="button"
              type="button"
              onClick={() => {
                onClose()
                navigate(buildTenantWorkspacePath(tenantSlug, '/settings/slicing'))
              }}
              sx={{ alignSelf: 'flex-start' }}
            >
              Manage custom presets
            </Link>
          )}
        </Stack>
      </Sheet>
      {(projectFilaments.length > 0 || showMaterialEditing) && (
        <Stack spacing={1}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography level="title-sm">Materials</Typography>
            {showMaterialEditing && (
              <Button type="button" size="sm" variant="soft" startDecorator={<AddRoundedIcon />} sx={{ ml: 'auto' }} onClick={onAddFilament}>
                Add material
              </Button>
            )}
          </Stack>
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
                return (
                  <Stack key={filament.projectFilamentId} direction="row" alignItems="center" sx={{ flexWrap: 'wrap', columnGap: 0.75, rowGap: 0.5 }}>
                    <Box
                      component="button"
                      type="button"
                      onClick={() => setMaterialDialogFilamentId(filament.projectFilamentId)}
                      title={presetUnmatched
                        ? 'No preset matches this filament — click to pick one'
                        : `${presetName} · ${colorName} — edit material`}
                      aria-label={`Edit material ${filamentIndex + 1}: ${presetName}, ${colorName}`}
                      sx={{
                        appearance: 'none',
                        flex: '1 1 140px',
                        minWidth: 0,
                        height: 'var(--Input-minHeight, 2.25rem)',
                        px: 1,
                        py: 0,
                        borderRadius: 'sm',
                        border: (theme) => `1px solid ${theme.vars.palette.divider}`,
                        background: normalizedColor,
                        color: filamentTextColor(null, normalizedColor),
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                        overflow: 'hidden',
                        transition: 'transform 80ms ease, border-color 80ms ease',
                        '&:hover': { transform: 'scale(1.02)', borderColor: 'primary.outlinedBorder' },
                        '&:focus-visible': {
                          outline: (theme) => `2px solid ${theme.vars.palette.focusVisible}`,
                          outlineOffset: 2
                        }
                      }}
                    >
                      <Typography level="body-xs" sx={{ fontWeight: 700, lineHeight: 1, color: 'inherit', flexShrink: 0 }}>
                        {filamentIndex + 1}
                      </Typography>
                      <Typography level="body-xs" fontWeight="md" noWrap sx={{ color: 'inherit' }}>
                        {presetName} · {colorName}
                      </Typography>
                      {presetUnmatched && <WarningAmberRoundedIcon fontSize="small" sx={{ ml: 'auto', flexShrink: 0 }} />}
                    </Box>
                    {materialToolheadOptions.length > 0 && (useToolheadButtonSet ? (
                      <ButtonGroup
                        size="sm"
                        // Soft group with a solid selected button (the GizmoToolbar pattern):
                        // soft and solid are both borderless, so toggling the selection never
                        // changes the buttons' dimensions — outlined buttons carry a 1px border
                        // that solid drops, which made unselected groups 2px wider.
                        variant="soft"
                        aria-label={`Nozzle for material ${filamentIndex + 1}`}
                        sx={{ '--ButtonGroup-radius': 'var(--joy-radius-sm)', flexShrink: 0, '& > *': { minWidth: 0, px: 1 } }}
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
                      overrides={filamentSettingOverridesById[filament.projectFilamentId] ?? {}}
                      onOpen={() => openFilamentSettings(filament.projectFilamentId)}
                    />
                    {showMaterialEditing && (() => {
                      const inUse = filamentInUse?.(filament.projectFilamentId) ?? false
                      const supportOnly = filamentSupportOnly?.(filament.projectFilamentId) ?? false
                      const removeDisabled = projectFilaments.length <= 1 || inUse
                      const removeTitle = projectFilaments.length <= 1
                        ? 'A project needs at least one material'
                        : inUse
                          ? (supportOnly
                              ? 'This material is used for supports — change the support filament before removing'
                              : 'This material is used by an object — reassign it before removing')
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
        </Stack>
      )}
      {showInlineObjects && hasPlateObjects && (
        <Stack spacing={1}>
          <Typography level="title-sm">Objects</Typography>
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
                      <Tooltip title={selectedProcessProfile ? 'Per-object settings' : 'Choose a quality profile first'}>
                        <span>
                          <IconButton
                            size="sm"
                            variant={overrideCount > 0 ? 'soft' : 'plain'}
                            color={overrideCount > 0 ? 'primary' : 'neutral'}
                            disabled={!selectedProcessProfile || !selectedSlicerTargetIdForGuards}
                            onClick={() => openSliceObjectSettings(object.id, object.name)}
                            aria-label={`Per-object settings for ${object.name}`}
                          >
                            <TuneRoundedIcon fontSize="small" />
                            {overrideCount > 0 && (
                              <Chip size="sm" variant="solid" color="primary" sx={{ ml: 0.5 }}>{overrideCount}</Chip>
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
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
        </Stack>
      )}
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
        // Deriving here (not stored) keeps the dialog live: a "Choose from printer" pick
        // that lands while it is open updates type/preset/color in place. A filament
        // removed out from under it (editor undo) simply renders nothing.
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
            chooseFromPrinter={targetMode === 'realPrinter'
              ? {
                  disabled: prioritizeLoadedMaterialOptionsForFilament(loadedMaterialOptions, filament.nozzleId ?? null).length === 0,
                  onOpen: () => setPrinterMaterialPickerFilamentId(filament.projectFilamentId)
                }
              : null}
            onClose={() => setMaterialDialogFilamentId(null)}
          />
        )
      })()}
      </>)}
    </>
  )
}

function SlicingProfileAutocomplete({
  profiles,
  value,
  placeholder,
  ariaLabel,
  modified,
  onChange
}: {
  profiles: SlicingProfileSummary[]
  value: SlicingProfileSummary | null
  placeholder: string
  ariaLabel?: string
  /** When true, prefixes the selected name with `*` (Bambu's "modified" marker). */
  modified?: boolean
  onChange: (profile: SlicingProfileSummary | null) => void
}) {
  const valueDisplayName = value ? `${modified ? '* ' : ''}${formatSlicingProfileDisplayName(value)}` : ''
  const [inputValue, setInputValue] = useState(valueDisplayName)

  useEffect(() => {
    setInputValue(valueDisplayName)
  }, [valueDisplayName])

  return (
    <DeferredKeyboardAutocomplete
      options={profiles}
      value={value}
      inputValue={inputValue}
      onChange={(_event, profile) => onChange(profile)}
      onInputChange={(_event, nextValue, reason) => {
        if (reason === 'reset') return
        setInputValue(nextValue)
      }}
      getOptionLabel={formatSlicingProfileDisplayName}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      groupBy={(profile) => isProjectSlicingProfile(profile) ? '3MF project profiles' : profile.source === 'custom' ? 'Workspace profiles' : 'Built-in profiles'}
      placeholder={placeholder}
      selectOnFocus
      handleHomeEndKeys
      openOnFocus
      slotProps={{
        input: ariaLabel ? { 'aria-label': ariaLabel } : undefined,
        listbox: { sx: { maxHeight: 360 } }
      }}
      renderOption={(props, profile) => (
        <AutocompleteOption {...props} key={profile.id}>
          <ListItemContent>
            <Typography level="body-sm" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatSlicingProfileDisplayName(profile)}</Typography>
          </ListItemContent>
        </AutocompleteOption>
      )}
    />
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
  overrides: Record<string, string | string[]>
  onOpen: () => void
}): JSX.Element {
  const { filamentIndex, projectFilamentId, selectedOption, slicerTargetId, sourceFileId, overrides, onOpen } = props
  // The tune dialog needs a resolvable filament profile id: the option's own profileId
  // (builtin/custom), or the underlying id for a project-embedded profile (option id =
  // `profile:<profileId>`). A loaded material with no matched preset has neither, so editing is
  // disabled until one is picked.
  const filamentProfileId = selectedOption?.profileId
    ?? (selectedOption?.id.startsWith('profile:') ? selectedOption.id.slice('profile:'.length) : null)
  const changedCount = useFilamentChangedCount({ slicerTargetId, filamentProfileId, sourceFileId, projectFilamentId, overrides })
  return (
    <Tooltip title={filamentProfileId
      ? (changedCount > 0 ? `Edit filament settings — ${changedCount} changed vs preset` : 'Edit filament settings')
      : 'Choose a material profile first'}
    >
      <span>
        {/* Corner badge (not an inline chip) so the button width — and the whole material
            row's column alignment — stays constant whether or not there are changes. */}
        <Badge badgeContent={changedCount} size="sm" color="primary" badgeInset="15%">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            disabled={!filamentProfileId || !slicerTargetId}
            onClick={onOpen}
            aria-label={`Edit filament settings for material ${filamentIndex + 1}`}
          >
            <TuneRoundedIcon fontSize="small" />
          </IconButton>
        </Badge>
      </span>
    </Tooltip>
  )
}
