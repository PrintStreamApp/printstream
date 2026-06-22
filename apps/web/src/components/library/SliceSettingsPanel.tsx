/**
 * Shared slice-settings surface extracted from `pages/LibraryView.tsx`.
 *
 * Owns the `SliceSettingsPanel` (the slicer/printer/plate/process/materials
 * controls) plus the `SliceSettingsController` and `SliceMaterialsSnapshot`
 * contracts that bridge `SliceFileModal`'s state into it, so the SAME panel
 * renders both in the slim slice dialog (`mode='simple'`) and inside the model
 * studio's 3D editor (`mode='editor'`). The autocompletes/color picker it relies
 * on stay file-local. State stays owned by the caller; only values/setters flow
 * through the controller.
 */
import type React from 'react'
import { useEffect, useState } from 'react'
import {
  Alert, Autocomplete, AutocompleteOption, Box, Button, ButtonGroup, Chip, CircularProgress, DialogActions, FormControl, FormHelperText, FormLabel, IconButton, Input, Link,
  ListItemContent, ModalDialog, Option, Select, Sheet, Stack, Tooltip, Typography
} from '@mui/joy'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
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
import { COMMON_FILAMENT_COLOR_SWATCHES, commonFilamentColorName, filamentTextColor, resolveFilamentColorSwatches } from '../../lib/filamentColor'
import { prioritizeLoadedMaterialOptionsForFilament } from '../../lib/sliceLoadedMaterialOptions'
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
import { ColorSwatchPicker } from '../ColorSwatchPicker'
import { LibraryPlateCardPicker } from '../LibraryPlateSelect'
import { BackAwareModal as Modal } from '../BackAwareModal'
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
  legacyMachineSwitchWarning: string | null
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
  objectOverrideCount: number
  setPerObjectDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  selectedSliceObjectIds: Set<number>
  plateObjects: Array<{ id: number; name: string }>
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
}

/**
 * Shared slice-settings surface. `mode='simple'` renders the full set (incl. the
 * all/single-plate selector and the per-object overrides row) for the slim
 * slicing dialog; `mode='editor'` omits the plate-scope selector (the 3D editor
 * has its own plate strip) and the per-object row (the editor surfaces that in
 * its Objects tab). Both modes share one `controller` instance, so edits in
 * either surface update the same state.
 */
export function SliceSettingsPanel({ controller, mode }: { controller: SliceSettingsController; mode: 'simple' | 'editor'; activePlateIndex?: number }) {
  const {
    file, resourceBasePath, flow, requiresSinglePlate, canOpenThreeDimensionalPreview,
    tenantSlug, navigate, onClose,
    slicerTargets, selectedSlicerTargetId, setSelectedSlicerTargetId, legacyMachineSwitchWarning, slicerStatus,
    printers, selectedPrinter, lockedPreferredPrinter, targetMode, setTargetMode, setPrinterId,
    selectedPrinterModel, manualPrinterModelTouchedRef, setManualPrinterModel, printerModelOptions,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, nozzleFlow, setNozzleFlow,
    plateType, setPlateType, plateTypeOptions,
    plateMode, setPlateMode, sceneEdit, setSceneEdit, plateNumber, setPlateNumber, slicePlateOptions, setPreviewFileId,
    compatibleProcessProfiles, selectedProcessProfile, processProfileModified, setProcessProfileId, setProcessSettingOverrides,
    processProfileSelectionTouchedRef, selectedSlicerTargetIdForGuards, processSettingOverrides, setProcessSettingsDialogOpen,
    hasPlateObjects, objectOverrideCount, setPerObjectDialogOpen, selectedSliceObjectIds, plateObjects,
    projectFilaments, materialOptions, loadedMaterialOptions, materialToolheadOptions,
    filamentMaterialOptionIds, filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentToolheadIds, setFilamentToolheadIds, filamentColors, setFilamentColors,
    setPrinterMaterialPickerFilamentId, handleMaterialOptionChange,
    onAddFilament, onRemoveFilament, filamentInUse, filamentSupportOnly
  } = controller
  const showPlateSection = mode === 'simple'
  const showPerObjectRow = mode === 'simple'
  // Add/remove materials is an editing affordance (Bambu-style) — only in the editor.
  const showMaterialEditing = mode === 'editor'
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
          {legacyMachineSwitchWarning && (
            <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
              {legacyMachineSwitchWarning}
            </Alert>
          )}
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
              <Autocomplete
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
                  modified={processProfileModified}
                  onChange={(profile) => {
                    processProfileSelectionTouchedRef.current = true
                    setProcessProfileId(profile?.id ?? '')
                    setProcessSettingOverrides({})
                  }}
                />
              </Box>
              <Tooltip title={selectedProcessProfile ? 'Edit process settings' : 'Choose a quality profile first'}>
                <span>
                  <Button
                    variant="outlined"
                    color="neutral"
                    startDecorator={<EditRoundedIcon />}
                    disabled={!selectedProcessProfile || !selectedSlicerTargetIdForGuards}
                    onClick={() => setProcessSettingsDialogOpen(true)}
                  >
                    Edit
                    {Object.keys(processSettingOverrides).length > 0 && (
                      <Chip size="sm" variant="solid" color="primary" sx={{ ml: 0.75 }}>
                        {Object.keys(processSettingOverrides).length}
                      </Chip>
                    )}
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </FormControl>
          {showPerObjectRow && hasPlateObjects && (
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
                <FormLabel sx={{ m: 0 }}>Per-object overrides</FormLabel>
                <Button
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  disabled={!selectedProcessProfile || !selectedSlicerTargetIdForGuards}
                  onClick={() => setPerObjectDialogOpen(true)}
                >
                  Edit per-object
                  {objectOverrideCount > 0 && (
                    <Chip size="sm" variant="solid" color="primary" sx={{ ml: 0.75 }}>{objectOverrideCount}</Chip>
                  )}
                </Button>
              </Stack>
              {selectedSliceObjectIds.size < plateObjects.length && (
                <FormHelperText sx={selectedSliceObjectIds.size === 0 ? { color: 'danger.500' } : undefined}>
                  {selectedSliceObjectIds.size === 0
                    ? `Select at least one object to ${flow === 'print' ? 'print' : 'slice'}.`
                    : `${selectedSliceObjectIds.size} of ${plateObjects.length} objects will ${flow === 'print' ? 'print' : 'be sliced'}.`}
                </FormHelperText>
              )}
            </Stack>
          )}
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
          {projectFilaments.length === 0 && showMaterialEditing && (
            <Typography level="body-sm" textColor="text.tertiary">No materials yet. Add one to choose a material.</Typography>
          )}
          {projectFilaments.map((filament, filamentIndex) => {
            const selectedOption = materialOptions.find((option) => option.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
            const typeFilter = filamentMaterialTypeFilters[filament.projectFilamentId] ?? selectedOption?.materialType ?? ''
            const typeOptions = resolveMaterialTypeOptions(materialOptions)
            const narrowedMaterialOptions = narrowMaterialOptions(materialOptions, typeFilter, selectedOption?.id)
            const loadedOptionsForFilament = prioritizeLoadedMaterialOptionsForFilament(loadedMaterialOptions, filament.nozzleId ?? null)
            const selectedToolheadId = filamentToolheadIds[filament.projectFilamentId] ?? ''
            const useToolheadButtonSet = materialToolheadOptions.length === 2
            return (
            <Sheet key={filament.projectFilamentId} variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
              <Stack spacing={0.75}>
              <Stack direction="row" alignItems="center" sx={{ flexWrap: 'wrap', columnGap: 1, rowGap: 0.5 }}>
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap', rowGap: 0.25 }}>
                  <Typography level="title-sm">Material {filamentIndex + 1}</Typography>
                </Stack>
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ ml: 'auto' }}>
                  {targetMode === 'realPrinter' && (
                    <Button type="button" size="sm" variant="plain" disabled={loadedOptionsForFilament.length === 0} onClick={() => setPrinterMaterialPickerFilamentId(filament.projectFilamentId)}>
                      Choose from printer
                    </Button>
                  )}
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
              </Stack>
              <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ flexWrap: 'wrap' }}>
                <FormControl sx={{ flex: '1 1 150px', minWidth: 0 }}>
                  <FormLabel>Type</FormLabel>
                  <Select<string>
                    value={typeFilter}
                    slotProps={{
                      listbox: {
                        sx: {
                          maxHeight: { xs: 'min(50vh, 18rem)', sm: 360 },
                          overflowY: 'auto',
                          overscrollBehavior: 'contain'
                        }
                      }
                    }}
                    onChange={(_event, value) => setFilamentMaterialTypeFilters((current) => ({ ...current, [filament.projectFilamentId]: value ?? '' }))}
                  >
                    <Option value="">All material types</Option>
                    {typeOptions.map((option) => <Option key={option} value={option}>{option}</Option>)}
                  </Select>
                </FormControl>
                <FormControl sx={{ flex: '1 1 150px', minWidth: 0 }}>
                  <FormLabel>Preset</FormLabel>
                  <SliceMaterialAutocomplete
                    options={narrowedMaterialOptions}
                    value={selectedOption}
                    placeholder="Choose a material profile"
                    onChange={(option) => handleMaterialOptionChange(filament.projectFilamentId, option)}
                  />
                </FormControl>
                <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ flex: '1 1 100%', minWidth: 0, width: '100%' }}>
                  <FormControl sx={{ flex: '1 1 0', minWidth: 0 }}>
                    <FormLabel>Color</FormLabel>
                    <Box sx={{ display: 'flex', alignItems: 'center', height: 'var(--Input-minHeight, 2.25rem)', width: '100%' }}>
                      <SliceFilamentColorPicker
                        color={normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color)}
                        material={(selectedOption?.materialType ?? typeFilter) || filament.label}
                        brand={selectedOption?.brand ?? ''}
                        fullWidth
                        onChange={(color) => setFilamentColors((current) => ({ ...current, [filament.projectFilamentId]: normalizeSliceFilamentColor(color) }))}
                      />
                    </Box>
                  </FormControl>
                  {materialToolheadOptions.length > 0 && (useToolheadButtonSet ? (
                    <FormControl sx={{ flex: '1 1 0', minWidth: 0 }} required>
                      <FormLabel>Nozzle</FormLabel>
                      <ButtonGroup size="md" variant="outlined" sx={{ '--ButtonGroup-radius': 'var(--joy-radius-sm)', width: '100%', '& > *': { minWidth: 0, px: 1.25, flex: 1 } }}>
                        {[...materialToolheadOptions].sort((left, right) => {
                          const rank = (position: 'left' | 'right' | 'single' | null | undefined) => position === 'left' ? 0 : position === 'right' ? 1 : 2
                          return rank(left.position) - rank(right.position)
                        }).map((toolhead) => {
                          const buttonLabel = toolhead.position === 'left'
                            ? 'Left'
                            : toolhead.position === 'right'
                              ? 'Right'
                              : toolhead.label
                          const selected = selectedToolheadId === toolhead.id
                          return (
                            <Button
                              key={toolhead.id}
                              type="button"
                              variant={selected ? 'solid' : 'outlined'}
                              color={selected ? 'primary' : 'neutral'}
                              aria-pressed={selected}
                              onClick={() => setFilamentToolheadIds((current) => ({ ...current, [filament.projectFilamentId]: toolhead.id }))}
                              title={toolhead.label}
                            >
                              {buttonLabel}
                            </Button>
                          )
                        })}
                      </ButtonGroup>
                    </FormControl>
                  ) : (
                    <FormControl sx={{ flex: '1 1 0', minWidth: 0 }} required>
                      <FormLabel>Nozzle</FormLabel>
                      <Select<string>
                        value={selectedToolheadId}
                        placeholder="Choose"
                        onChange={(_event, value) => setFilamentToolheadIds((current) => ({ ...current, [filament.projectFilamentId]: value ?? '' }))}
                      >
                        {materialToolheadOptions.map((toolhead) => (
                          <Option key={toolhead.id} value={toolhead.id}>{toolhead.label}</Option>
                        ))}
                      </Select>
                    </FormControl>
                  ))}
                </Stack>
              </Stack>
              </Stack>
            </Sheet>
          )})}
        </Stack>
      )}
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
    <Autocomplete
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

function SliceMaterialAutocomplete({
  options,
  value,
  placeholder,
  onChange
}: {
  options: SliceMaterialOption[]
  value: SliceMaterialOption | null
  placeholder: string
  onChange: (option: SliceMaterialOption | null) => void
}) {
  const [inputValue, setInputValue] = useState(value?.label ?? '')

  useEffect(() => {
    setInputValue(value?.label ?? '')
  }, [value?.id, value?.label])

  return (
    <Autocomplete
      options={options}
      value={value}
      inputValue={inputValue}
      onChange={(_event, option) => onChange(option)}
      onInputChange={(_event, nextValue, reason) => {
        if (reason === 'reset') return
        setInputValue(nextValue)
      }}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      groupBy={(option) => option.group}
      placeholder={placeholder}
      selectOnFocus
      handleHomeEndKeys
      openOnFocus
      slotProps={{ listbox: { sx: { maxHeight: 360 } } }}
      renderOption={(props, option) => (
        <AutocompleteOption {...props} key={option.id}>
          <ListItemContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Box sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: option.color ?? 'neutral.500', border: '1px solid', borderColor: 'divider', flexShrink: 0 }} />
              <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                <Typography level="body-sm" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{option.label}</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  {[option.brand, option.metadata].filter(Boolean).join(' · ')}
                </Typography>
              </Stack>
            </Stack>
          </ListItemContent>
        </AutocompleteOption>
      )}
    />
  )
}

function SliceFilamentColorPicker({
  color,
  material,
  brand,
  fullWidth = false,
  onChange
}: {
  color: string
  material: string
  brand: string
  fullWidth?: boolean
  onChange: (color: string) => void
}) {
  const [colorDialogOpen, setColorDialogOpen] = useState(false)
  const [customColorOpen, setCustomColorOpen] = useState(false)
  const [draftColor, setDraftColor] = useState(() => normalizeSliceFilamentColor(color).toUpperCase())
  const normalizedColor = normalizeSliceFilamentColor(color).toUpperCase()
  const presetBrand = brand === 'Bambu' ? 'Bambu' : brand || null
  const { swatches, usesCommonFallback } = resolveFilamentColorSwatches(material, { presetBrand })
  const colorSwatches = brand === 'Bambu' && !usesCommonFallback ? swatches : COMMON_FILAMENT_COLOR_SWATCHES
  const colorName = brand === 'Bambu' && !usesCommonFallback
    ? swatches.find((swatch) => swatch.hex.toUpperCase() === normalizedColor)?.name ?? commonFilamentColorName(normalizedColor)
    : commonFilamentColorName(normalizedColor) ?? swatches.find((swatch) => swatch.hex.toUpperCase() === normalizedColor)?.name
  const normalizedDraftColor = normalizeSliceFilamentColor(draftColor).toUpperCase()
  const draftColorName = brand === 'Bambu' && !usesCommonFallback
    ? swatches.find((swatch) => swatch.hex.toUpperCase() === normalizedDraftColor)?.name ?? commonFilamentColorName(normalizedDraftColor)
    : commonFilamentColorName(normalizedDraftColor) ?? swatches.find((swatch) => swatch.hex.toUpperCase() === normalizedDraftColor)?.name
  const openColorDialog = () => {
    setDraftColor(normalizedColor)
    setCustomColorOpen(false)
    setColorDialogOpen(true)
  }
  const applyCustomColor = () => {
    onChange(draftColor)
    setColorDialogOpen(false)
  }
  return (
    <>
      <Box
        component="button"
        type="button"
        onClick={openColorDialog}
        title={`Color: ${colorName ?? normalizedColor}`}
        aria-label={`Color ${colorName ?? normalizedColor}`}
        sx={{
          appearance: 'none',
          width: fullWidth ? '100%' : 36,
          height: 'var(--Input-minHeight, 2.25rem)',
          px: fullWidth ? 1 : 0,
          py: 0,
          borderRadius: 'sm',
          border: (theme) => `1px solid ${theme.vars.palette.divider}`,
          background: normalizedColor,
          color: filamentTextColor(null, normalizedColor),
          cursor: 'pointer',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: fullWidth ? 'flex-start' : 'center',
          overflow: 'hidden',
          transition: 'transform 80ms ease, border-color 80ms ease',
          '&:hover': { transform: 'scale(1.04)', borderColor: 'primary.outlinedBorder' },
          '&:focus-visible': {
            outline: (theme) => `2px solid ${theme.vars.palette.focusVisible}`,
            outlineOffset: 2
          }
        }}
      >
        {fullWidth && (
          <Typography level="body-xs" fontWeight="md" noWrap sx={{ color: 'inherit' }}>
            {colorName ?? normalizedColor}
          </Typography>
        )}
      </Box>
      <Modal open={colorDialogOpen} onClose={() => setColorDialogOpen(false)}>
        <ModalDialog sx={{ maxWidth: 520, width: '100%' }}>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Box sx={{ width: 56, height: 56, borderRadius: 'sm', background: normalizedDraftColor, border: '1px solid', borderColor: 'divider', flexShrink: 0 }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography level="h4">{draftColorName ?? normalizedDraftColor}</Typography>
              <Typography level="body-sm" textColor="text.tertiary">{[brand, material].filter(Boolean).join(' ') || 'Filament color'}</Typography>
            </Box>
          </Stack>
          <Stack spacing={1.25}>
            <ColorSwatchPicker
              title={brand === 'Bambu' && !usesCommonFallback ? `Bambu ${material} colors` : 'Common filament colors'}
              swatches={colorSwatches}
              selectedHex={normalizedDraftColor}
              onPick={(nextColor) => setDraftColor(normalizeSliceFilamentColor(nextColor).toUpperCase())}
              onCustomPick={() => setCustomColorOpen(true)}
            />
            {customColorOpen && (
              <Sheet variant="soft" sx={{ p: 1, borderRadius: 'sm' }}>
                <Stack spacing={1}>
                  <Typography level="title-sm">Custom color</Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    <FormControl sx={{ flex: 0 }}>
                      <FormLabel>Color</FormLabel>
                      <Input
                        type="color"
                        value={normalizeSliceFilamentColor(draftColor)}
                        onChange={(event) => setDraftColor(normalizeSliceFilamentColor(event.target.value).toUpperCase())}
                        slotProps={{ input: { 'aria-label': 'Color' } }}
                        sx={{ width: 72, p: 0.5 }}
                      />
                    </FormControl>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Hex</FormLabel>
                      <Input
                        value={draftColor}
                        onChange={(event) => setDraftColor(normalizeSliceFilamentColor(event.target.value).toUpperCase())}
                        placeholder="#RRGGBB"
                      />
                    </FormControl>
                  </Stack>
                </Stack>
              </Sheet>
            )}
          </Stack>
          <DialogActions sx={{ pt: 1 }}>
            <Button type="button" variant="plain" onClick={() => setColorDialogOpen(false)}>Cancel</Button>
            <Button type="button" onClick={applyCustomColor}>Apply</Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  )
}
