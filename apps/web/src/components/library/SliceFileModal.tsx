/**
 * Slice/prepare dialog extracted from `pages/LibraryView.tsx`.
 *
 * Owns `SliceFileModal`: the slim slicing/print-prep dialog (and, for the
 * library flow on 3MF projects, the direct hand-off to the model studio's full
 * 3D editor via the `slicing.editor` plugin slot). It owns the entire slice
 * form state — slicer target, printer/process/filament selection, plate scope,
 * per-object overrides, add/remove materials — and feeds it to the shared
 * `SliceSettingsPanel` through a `SliceSettingsController`. Output naming, save
 * destination, and the loaded-printer material picker live here too. The submit
 * payload shape is the shared `SliceFileSubmitInput`.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box, Button, DialogActions, ModalDialog, Sheet, Stack, Typography
} from '@mui/joy'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import { useQuery } from '@tanstack/react-query'
import type {
  LibraryFile,
  LibraryFolder,
  PrinterNozzleFlow,
  Printer,
  PrinterStatus,
  SceneEdit,
  SceneEditFilament,
  SlicingCapabilities,
  SlicingManualProfileTarget,
  ThreeMfIndex
} from '@printstream/shared'
import { useNavigate, useParams } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { bambuModelKeysAreCompatible } from '../../lib/bambuPrinterModels'
import { resolveFilamentDisplay } from '../../lib/filamentColor'
import { FilamentOptionLabel } from './FilamentOptionLabel'
import { prioritizeLoadedMaterialOptionsForFilament } from '../../lib/sliceLoadedMaterialOptions'
import {
  extractLayerHeightToken,
  formatSlicingProfileDisplayName,
  isProjectProfileAllowedForTarget,
  isSelectableOrProjectFallbackSlicingProfile,
  isSelectableSlicingProfile,
  pickMostSimilarSlicingProfileByName,
  pickProjectFallbackSlicingProfileByName,
  pickSelectableSlicingProfileByName,
  pickSlicingProfileByBakedName,
  pickStandardProcessProfile,
  resolveSliceDisabledReason
} from '../../lib/slicingProfileSelection'
import {
  buildFilamentMappings,
  buildInitialFilamentColorSelection,
  buildInitialFilamentMaterialOptionSelection,
  buildInitialFilamentToolheadSelection,
  buildLoadedPrinterMaterialOptions,
  buildProjectSlicingProfiles,
  buildSliceDialogProjectFilaments,
  buildSliceDialogToolheads,
  buildSliceMaterialOptions,
  dedupeVisibleProcessProfiles,
  ensurePrinterModelOptions,
  groupSliceMaterialOptionsByGroup,
  isFilamentProfileCompatible,
  isMachineProfileCompatible,
  isProcessProfileCompatible,
  isProjectSlicingProfile,
  isVisibleFilamentProfile,
  isVisibleProcessProfile,
  matchesPrinterModel,
  mergeProjectSlicingProfiles,
  normalizeSliceFilamentColor,
  parseSliceToolheadNozzleId,
  pickMachineProfileByName,
  pickMachineProfileForPrinter,
  resolveCompatiblePlateTypes,
  resolveInitialManualPrinterModel,
  resolveInitialNozzleDiameter,
  resolveInitialPlateType,
  resolveSliceDialogNozzleDiameterOptions,
  resolveSliceDialogSourcePrinterModel,
  resolveSliceDialogTargetPrinterModel,
  type LoadedMaterialSource,
  type SliceMaterialOption
} from '../../lib/sliceProfileMatching'
import { useSlotFilamentIdentityLookup } from '../../lib/slotFilamentIdentity'
import { slicingProfilesQueryOptions } from '../../lib/slicingProfilesQuery'
import { estimateRemainGrams } from '../../lib/slotRemaining'
import { useMobileViewport } from '../useMobileViewport'
import { LibraryDestinationDialog } from '../LibraryDestinationDialog'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { PluginSlot } from '../../plugin/PluginSlot'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { useDeepStableValue } from '../../hooks/useDeepStableValue'
import {
  buildLibraryResourceBasePath,
  buildPrinterTrayMap,
  buildSlicedOutputFileName,
  EMPTY_SLICER_TARGETS,
  EMPTY_SLICING_PROFILES,
  type SliceFileSubmitAction,
  type SliceFileSubmitInput
} from '../../lib/libraryViewHelpers'
import { SliceSettingsPanel, type SliceSettingsController, type SliceMaterialsSnapshot } from './SliceSettingsPanel'

const ProcessSettingsDialog = lazy(() => import('../ProcessSettingsDialog'))
const PerObjectSettingsDialog = lazy(() => import('../PerObjectSettingsDialog'))

export function SliceFileModal({
  file,
  versionId = null,
  isNewProject = false,
  folders = [],
  currentFolderId = null,
  bridgeId = null,
  bridgeName = null,
  showRoot = false,
  printers,
  printerStatuses,
  capabilities,
  capabilitiesLoading,
  capabilitiesError,
  submitting,
  submitAction,
  submitError,
  flow = 'library',
  preferredPrinterId,
  defaultPlateNumber,
  flowCopy,
  onBack,
  onClose,
  onSubmit
}: {
  file: LibraryFile
  /** Slice an archived version of `file` instead of its current content. */
  versionId?: string | null
  /** The editor target is a brand-new project (hidden scaffold) → save prompts for name/location. */
  isNewProject?: boolean
  folders?: LibraryFolder[]
  currentFolderId?: string | null
  bridgeId?: string | null
  bridgeName?: string | null
  showRoot?: boolean
  printers: Printer[]
  printerStatuses: Record<string, PrinterStatus>
  capabilities: SlicingCapabilities | null
  capabilitiesLoading: boolean
  capabilitiesError: string | null
  submitting: boolean
  submitAction: SliceFileSubmitAction | null
  submitError: string | null
  flow?: 'library' | 'print'
  preferredPrinterId?: string
  /** Preselect this plate (e.g. an order item's plate) instead of plate 1. */
  defaultPlateNumber?: number
  /** Override the print-flow title/description/continue-button copy (e.g. for "add to queue"). */
  flowCopy?: { title?: string; description?: string | null; continueLabel?: string }
  /**
   * When provided, the dialog shows a "Back" action that returns to the step it was
   * opened from (e.g. the library file picker in the printers flow), which stays
   * mounted underneath. Without it, only Cancel/Close is offered.
   */
  onBack?: () => void
  onClose: () => void
  onSubmit: (input: SliceFileSubmitInput, action: SliceFileSubmitAction, options?: { keepDialogOpen?: boolean }) => void
}) {
  const navigate = useNavigate()
  const { tenantSlug } = useParams<{ tenantSlug: string }>()
  const resourceBasePath = buildLibraryResourceBasePath(file.id, versionId)
  const requiresSinglePlate = flow === 'print'
  const saveActionVisible = flow === 'library'
  const dialogTitle = flowCopy?.title ?? (flow === 'print'
    ? `Prepare ${formatLibraryFileName(file.name)} for print`
    : `Slice ${formatLibraryFileName(file.name)}`)
  const dialogDescription = flowCopy?.description !== undefined
    ? flowCopy.description
    : (flow === 'print' ? 'Review slicing settings before continuing to printer selection.' : null)
  const isMobileViewport = useMobileViewport()
  const printActionLabel = flowCopy?.continueLabel ?? (flow === 'print' ? 'Continue to print' : (isMobileViewport ? 'Print' : 'Print Now'))
  const saveActionLabel = isMobileViewport ? 'Save' : 'Save to Library'
  const lockedPreferredPrinter = useMemo(
    () => flow === 'print' && preferredPrinterId
      ? printers.find((printer) => printer.id === preferredPrinterId) ?? null
      : null,
    [flow, preferredPrinterId, printers]
  )
  const [targetMode, setTargetMode] = useState<'realPrinter' | 'manualProfile'>(() => (lockedPreferredPrinter ? 'realPrinter' : 'manualProfile'))
  const [printerId, setPrinterId] = useState(() => lockedPreferredPrinter?.id ?? '')
  const appliedBakedDefaultsRef = useRef(false)
  // Mirrors appliedBakedDefaultsRef as state so the form can wait for the 3MF defaults to be
  // seeded before becoming interactive (avoids showing values that change once the slicer data
  // loads).
  const [bakedDefaultsApplied, setBakedDefaultsApplied] = useState(false)
  const manualPrinterModelTouchedRef = useRef(false)
  const processProfileSelectionTouchedRef = useRef(false)
  const [previewFileId, setPreviewFileId] = useState<string | null>(null)
  // Edited multi-plate arrangement from the interactive 3D editor. When set, it is
  // authoritative: the slice runs across every plate the edit defines (plate: 0).
  const [sceneEdit, setSceneEdit] = useState<SceneEdit | null>(null)
  // When the full 3D editor hands back a layout it also chooses the plate scope to
  // act on: a 1-based plate index, or 0 for all plates. Drives `plate` in the submit
  // payload so the editor's "print this plate" targets just that plate.
  const [editorPlatePreference, setEditorPlatePreference] = useState<number | null>(null)
  const slicerTargets = capabilities?.targets ?? EMPTY_SLICER_TARGETS
  const configured = Boolean(capabilities?.configured && capabilities?.healthy && slicerTargets.length > 0)
  const [selectedSlicerTargetId, setSelectedSlicerTargetId] = useState(() => capabilities?.defaultTargetId ?? capabilities?.targets[0]?.id ?? '')
  const shouldLoadSlicingProfiles = configured && selectedSlicerTargetId.length > 0
  // Shared definition (key, usability check, retry/staleness) so views can PREFETCH the
  // same cache entry before this dialog opens — see `lib/slicingProfilesQuery.ts`.
  const slicingProfilesQuery = useQuery({
    ...slicingProfilesQueryOptions(selectedSlicerTargetId),
    enabled: shouldLoadSlicingProfiles
  })
  const profiles = slicingProfilesQuery.data?.profiles ?? EMPTY_SLICING_PROFILES
  // "Should have profiles but don't yet" — not merely "the query is actively fetching". The slicer
  // can briefly return an empty list while restarting, so the query throws and retries with backoff;
  // between retries `isLoading` flickers false while `profiles` is still empty. Gating only on
  // `isLoading` let the slice dialog apply — and one-shot lock (`appliedBakedDefaultsRef`) — its
  // filament defaults against an empty profile list during that gap, so a project's actual material
  // matched nothing and fell back to the generic machine default ("Bambu PLA Basic") until the dialog
  // was reopened after the profiles query had cached. Treat the whole load+retry window as waiting;
  // excluding the terminal error state preserves the existing error / empty-defaults handling.
  const waitingForSlicingProfiles = shouldLoadSlicingProfiles && profiles.length === 0 && !slicingProfilesQuery.isError
  // Self-heal the profiles catalogue when the slicer recovers. The profiles query throws + retries
  // (×5) on an empty/restarting response, then settles into an error; previously a slice-progress WS
  // tick (`slicing`) would re-invalidate it and recover once the slicer came back, but that path now
  // only fires on actual profile mutations (`slicing.profiles`) to stop the per-tick refetch spam. So
  // recover here instead: on the slicer's unhealthy→healthy transition, refetch if the catalogue is
  // errored or empty — the editor un-strands itself without the user reopening, and a healthy slicer
  // with profiles already loaded triggers nothing.
  const slicerHealthy = Boolean(capabilities?.healthy)
  const prevSlicerHealthyRef = useRef(slicerHealthy)
  const profilesRefetch = slicingProfilesQuery.refetch
  const profilesIsError = slicingProfilesQuery.isError
  const profilesEmpty = profiles.length === 0
  useEffect(() => {
    const wasHealthy = prevSlicerHealthyRef.current
    prevSlicerHealthyRef.current = slicerHealthy
    if (slicerHealthy && !wasHealthy && (profilesIsError || profilesEmpty)) {
      void profilesRefetch()
    }
  }, [slicerHealthy, profilesIsError, profilesEmpty, profilesRefetch])
  const platesQuery = useQuery({
    queryKey: ['library-plates', file.id, versionId ?? 'current', 'slice-defaults'],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBasePath}/plates`, { signal }),
    // The 3MF index doesn't depend on slicer profiles, so fetch it in PARALLEL with the (slow)
    // profile catalogue instead of after it — the plate/object list and per-object UI become
    // available sooner. Applying baked slice defaults still waits for both (see the
    // `appliedBakedDefaultsRef` effect, which gates on `waitingForSlicingProfiles`).
    staleTime: 60_000
  })
  const bakedIndex = platesQuery.data ?? null
  const slicePlateOptions = useMemo(() => bakedIndex?.plates ?? [], [bakedIndex])
  const canOpenThreeDimensionalPreview = file.kind === '3mf' && slicePlateOptions.length > 0
  const machineProfiles = useMemo(
    () => mergeProjectSlicingProfiles(profiles.filter((profile) => profile.kind === 'machine'), buildProjectSlicingProfiles(bakedIndex, 'machine')),
    [bakedIndex, profiles]
  )
  const processProfiles = useMemo(
    () => mergeProjectSlicingProfiles(profiles.filter((profile) => profile.kind === 'process' && isVisibleProcessProfile(profile)), buildProjectSlicingProfiles(bakedIndex, 'process')),
    [bakedIndex, profiles]
  )
  const filamentProfiles = useMemo(
    () => mergeProjectSlicingProfiles(profiles.filter((profile) => profile.kind === 'filament' && isVisibleFilamentProfile(profile)), buildProjectSlicingProfiles(bakedIndex, 'filament')),
    [bakedIndex, profiles]
  )
  const selectedPrinter = printers.find((printer) => printer.id === printerId) ?? null
  const [manualPrinterModel, setManualPrinterModel] = useState<string>(() => resolveInitialManualPrinterModel(file, machineProfiles, lockedPreferredPrinter?.model ?? printers[0]?.model))
  const [printerProfileId, setPrinterProfileId] = useState(() => pickMachineProfileForPrinter(machineProfiles, lockedPreferredPrinter ?? printers[0])?.id ?? machineProfiles[0]?.id ?? '')
  // Default a fresh selection to the 0.20mm Standard preset rather than whatever is first
  // in the list; an existing file's baked profile still overrides this via the effects below.
  const [processProfileId, setProcessProfileId] = useState(() => pickStandardProcessProfile(processProfiles)?.id ?? processProfiles[0]?.id ?? '')
  const [processSettingOverrides, setProcessSettingOverrides] = useState<Record<string, string | string[]>>({})
  const [processSettingsDialogOpen, setProcessSettingsDialogOpen] = useState(false)
  const [objectProcessOverrides, setObjectProcessOverrides] = useState<Record<string, Record<string, string | string[]>>>({})
  const [perObjectDialogOpen, setPerObjectDialogOpen] = useState(false)
  const [plateMode, setPlateMode] = useState<'all' | 'single'>(() => requiresSinglePlate || defaultPlateNumber != null ? 'single' : 'all')
  const [plateNumber, setPlateNumber] = useState(() => String(defaultPlateNumber ?? 1))
  const [plateType, setPlateType] = useState(resolveInitialPlateType(file, null))
  const [nozzleDiameter, setNozzleDiameter] = useState(() => resolveInitialNozzleDiameter(file, lockedPreferredPrinter ?? printers[0], null, null))
  const [nozzleFlow, setNozzleFlow] = useState<PrinterNozzleFlow>('standard')
  const [filamentMaterialOptionIds, setFilamentMaterialOptionIds] = useState<Record<number, string>>(() => buildInitialFilamentMaterialOptionSelection(file, null, filamentProfiles))
  const [filamentMaterialTypeFilters, setFilamentMaterialTypeFilters] = useState<Record<number, string>>({})
  const [filamentColors, setFilamentColors] = useState<Record<number, string>>(() => buildInitialFilamentColorSelection(file, null))
  const [filamentToolheadIds, setFilamentToolheadIds] = useState<Record<number, string>>(() => buildInitialFilamentToolheadSelection(file, null))
  const [printerMaterialPickerFilamentId, setPrinterMaterialPickerFilamentId] = useState<number | null>(null)
  // The full editor renders this controller's own "Choose material" picker Modal behind itself
  // (the host slice dialog stays mounted), so a pick made there calls THIS controller's
  // `handleMaterialOptionChange` directly — not the markDirty-wrapped copy the editor hands to the
  // settings panel. The editor registers `markDirty` here so picker-driven material edits still
  // light its Save button. Null in the simple slice path.
  const materialEditListenerRef = useRef<(() => void) | null>(null)
  const [saveDestinationOpen, setSaveDestinationOpen] = useState(false)
  // Slice-time object selection (single-plate only). Tracks the kept objects; defaults to all.
  const [selectedSliceObjectIds, setSelectedSliceObjectIds] = useState<Set<number>>(new Set())
  const selectedPrinterModel = targetMode === 'realPrinter' ? selectedPrinter?.model ?? 'unknown' : manualPrinterModel
  const selectedPrinterStatus = printerId ? printerStatuses[printerId] : undefined
  const selectedMachineProfile = machineProfiles.find((profile) => profile.id === printerProfileId) ?? null
  const sourcePrinterModel = useMemo(
    () => resolveSliceDialogSourcePrinterModel(bakedIndex, file.compatiblePrinterModels),
    [bakedIndex, file.compatiblePrinterModels]
  )
  const targetPrinterModel = useMemo(
    () => resolveSliceDialogTargetPrinterModel(selectedPrinterModel, selectedMachineProfile),
    [selectedMachineProfile, selectedPrinterModel]
  )
  // BambuStudio drops the 3MF project's embedded presets when the chosen
  // printer is incompatible with the project's source model and falls back to
  // the target machine's defaults. We mirror that: project profiles stay
  // available for same-family targets (e.g. X1C project -> P1S) but are hidden
  // when the target is cross-family (e.g. X1C project -> H2D).
  const projectProfilesCompatibleWithTarget = useMemo(
    () => bambuModelKeysAreCompatible(sourcePrinterModel, targetPrinterModel),
    [sourcePrinterModel, targetPrinterModel]
  )
  const selectedNozzleDiameters = useMemo(() => {
    const diameter = Number.parseFloat(nozzleDiameter)
    return Number.isFinite(diameter) && diameter > 0 ? [diameter] : []
  }, [nozzleDiameter])
  const modelCompatibleMachineProfiles = useMemo(
    () => machineProfiles.filter((profile) => matchesPrinterModel(profile, selectedPrinterModel)),
    [machineProfiles, selectedPrinterModel]
  )
  const nozzleDiameterOptions = useMemo(
    () => resolveSliceDialogNozzleDiameterOptions(file, selectedPrinter, modelCompatibleMachineProfiles, bakedIndex),
    [bakedIndex, file, modelCompatibleMachineProfiles, selectedPrinter]
  )
  const compatibleMachineProfiles = useMemo(
    () => machineProfiles.filter((profile) => isMachineProfileCompatible(profile, selectedPrinterModel, selectedNozzleDiameters)),
    [machineProfiles, selectedNozzleDiameters, selectedPrinterModel]
  )
  const selectableMachineProfiles = useMemo(
    () => compatibleMachineProfiles.filter(isSelectableSlicingProfile),
    [compatibleMachineProfiles]
  )
  const printerCompatibleProcessProfiles = useMemo(
    () => processProfiles.filter((profile) => isSelectableOrProjectFallbackSlicingProfile(profile, processProfiles, bakedIndex?.processProfileName ?? null) && isProjectProfileAllowedForTarget(profile, projectProfilesCompatibleWithTarget) && isProcessProfileCompatible(profile, selectedMachineProfile, selectedPrinterModel, selectedNozzleDiameters, '')),
    [bakedIndex?.processProfileName, processProfiles, projectProfilesCompatibleWithTarget, selectedMachineProfile, selectedNozzleDiameters, selectedPrinterModel]
  )
  const plateTypeOptions = useMemo(
    () => resolveCompatiblePlateTypes(file, bakedIndex, selectedMachineProfile, printerCompatibleProcessProfiles),
    [bakedIndex, file, printerCompatibleProcessProfiles, selectedMachineProfile]
  )
  const compatibleProcessProfiles = useMemo(
    () => dedupeVisibleProcessProfiles(
      printerCompatibleProcessProfiles.filter((profile) => isProcessProfileCompatible(profile, selectedMachineProfile, selectedPrinterModel, selectedNozzleDiameters, plateType)),
      selectedMachineProfile,
      selectedPrinterModel
    ),
    [plateType, printerCompatibleProcessProfiles, selectedMachineProfile, selectedNozzleDiameters, selectedPrinterModel]
  )
  const selectedAnyProcessProfile = processProfiles.find((profile) => profile.id === processProfileId) ?? null
  const selectedProcessProfile = compatibleProcessProfiles.find((profile) => profile.id === processProfileId) ?? null
  const compatibleFilamentProfiles = useMemo(
    () => filamentProfiles.filter((profile) => isProjectProfileAllowedForTarget(profile, projectProfilesCompatibleWithTarget) && isFilamentProfileCompatible(profile, selectedMachineProfile, selectedProcessProfile, selectedPrinterModel, selectedNozzleDiameters)),
    [filamentProfiles, projectProfilesCompatibleWithTarget, selectedMachineProfile, selectedNozzleDiameters, selectedPrinterModel, selectedProcessProfile]
  )
  const loadedMaterialSource = useMemo<LoadedMaterialSource | null>(
    () => targetMode === 'realPrinter' && selectedPrinterStatus
      ? {
          ams: selectedPrinterStatus.ams,
          externalSpools: selectedPrinterStatus.externalSpools,
          nozzleCount: selectedPrinterStatus.nozzles.length > 0 ? selectedPrinterStatus.nozzles.length : null
        }
      : null,
    [selectedPrinterStatus, targetMode]
  )
  // Keep the source referentially stable across status frames that don't touch
  // loaded-material data, so the material dropdown doesn't lose scroll position
  // or typed input while the printer streams temperature/progress updates.
  const stableLoadedMaterialSource = useDeepStableValue(loadedMaterialSource)
  // Tracked-spool identity (filament-manager registry): loaded-material rows
  // label a tracked custom spool as itself ("Michael's PLA"), not the preset.
  const resolveSlotFilament = useSlotFilamentIdentityLookup()
  const loadedMaterialOptions = useMemo(
    () => buildLoadedPrinterMaterialOptions(stableLoadedMaterialSource, compatibleFilamentProfiles, selectedMachineProfile, selectedPrinterModel, {
      printerId: printerId ?? null,
      resolveSpool: resolveSlotFilament
    }),
    [compatibleFilamentProfiles, printerId, resolveSlotFilament, selectedMachineProfile, selectedPrinterModel, stableLoadedMaterialSource]
  )
  const materialOptions = useMemo(
    () => buildSliceMaterialOptions(compatibleFilamentProfiles, loadedMaterialOptions),
    [compatibleFilamentProfiles, loadedMaterialOptions]
  )
  useEffect(() => {
    if (!lockedPreferredPrinter) return
    if (targetMode !== 'realPrinter') setTargetMode('realPrinter')
    if (printerId !== lockedPreferredPrinter.id) setPrinterId(lockedPreferredPrinter.id)
  }, [lockedPreferredPrinter, printerId, targetMode])
  useEffect(() => {
    const fallbackTargetId = capabilities?.defaultTargetId ?? slicerTargets[0]?.id ?? ''
    if (!fallbackTargetId) {
      if (selectedSlicerTargetId) setSelectedSlicerTargetId('')
      return
    }
    if (slicerTargets.some((target) => target.id === selectedSlicerTargetId)) return
    setSelectedSlicerTargetId(fallbackTargetId)
  }, [capabilities?.defaultTargetId, selectedSlicerTargetId, slicerTargets])
  useEffect(() => {
    appliedBakedDefaultsRef.current = false
    setBakedDefaultsApplied(false)
    manualPrinterModelTouchedRef.current = false
    processProfileSelectionTouchedRef.current = false
  }, [selectedSlicerTargetId])
  useEffect(() => {
    if (targetMode !== 'realPrinter') return
    const matchedProfile = pickMachineProfileForPrinter(selectableMachineProfiles, selectedPrinter)
    if (matchedProfile) setPrinterProfileId(matchedProfile.id)
  }, [selectableMachineProfiles, selectedPrinter, targetMode])
  useEffect(() => {
    const firstProfile = selectableMachineProfiles[0]
    if (printerProfileId && selectableMachineProfiles.some((profile) => profile.id === printerProfileId)) return
    if (!firstProfile) return
    setPrinterProfileId(firstProfile.id)
  }, [printerProfileId, selectableMachineProfiles])
  useEffect(() => {
    const firstProfile = compatibleProcessProfiles[0]
    if (processProfileId && compatibleProcessProfiles.some((profile) => profile.id === processProfileId)) return
    if (!processProfileId && processProfileSelectionTouchedRef.current) return
    const previousName = selectedAnyProcessProfile?.name ?? bakedIndex?.processProfileName ?? null
    // Mirror BambuStudio's machine-switch fallback: prefer the target machine's
    // default_print_profile when it shares the previous profile's layer height,
    // otherwise keep the closest layer-height match by name.
    const machineDefaultProfile = pickSlicingProfileByBakedName(compatibleProcessProfiles, selectedMachineProfile?.defaultProcessProfile)
    const previousLayerHeight = extractLayerHeightToken(previousName)
    if (machineDefaultProfile && (!previousLayerHeight || extractLayerHeightToken(machineDefaultProfile.name) === previousLayerHeight)) {
      setProcessProfileId(machineDefaultProfile.id)
      return
    }
    // Only match a "nearest" preset when there's an actual prior profile to match; for a
    // fresh selection (new project, no baked/previous profile) skip it so we don't latch
    // onto an arbitrary preset.
    const nearestProfile = previousName ? pickMostSimilarSlicingProfileByName(compatibleProcessProfiles, previousName) : null
    if (nearestProfile) {
      setProcessProfileId(nearestProfile.id)
      return
    }
    if (machineDefaultProfile) {
      setProcessProfileId(machineDefaultProfile.id)
      return
    }
    // Prefer the 0.20mm Standard preset over whatever happens to be first in the list.
    const standardProfile = pickStandardProcessProfile(compatibleProcessProfiles)
    if (standardProfile) {
      setProcessProfileId(standardProfile.id)
      return
    }
    if (!firstProfile) return
    setProcessProfileId(firstProfile.id)
  }, [bakedIndex?.processProfileName, compatibleProcessProfiles, processProfileId, selectedAnyProcessProfile?.name, selectedMachineProfile?.defaultProcessProfile])
  useEffect(() => {
    if (plateTypeOptions.includes(plateType)) return
    setPlateType(plateTypeOptions[0] ?? '')
  }, [plateType, plateTypeOptions])
  useEffect(() => {
    if (nozzleDiameterOptions.includes(nozzleDiameter)) return
    setNozzleDiameter(nozzleDiameterOptions[0] ?? '')
  }, [nozzleDiameter, nozzleDiameterOptions])
  useEffect(() => {
    if (manualPrinterModel !== 'unknown' || targetMode !== 'manualProfile') return
    const firstModel = ensurePrinterModelOptions(file.compatiblePrinterModels, selectedPrinter?.model, machineProfiles)[0]
    if (firstModel) setManualPrinterModel(firstModel)
  }, [file.compatiblePrinterModels, machineProfiles, manualPrinterModel, selectedPrinter?.model, targetMode])
  // Seed the target printer model from the project's own index the moment it loads — NOT
  // gated on the (slow) profile catalogue like the full baked-defaults effect below. On a
  // fresh upload `file.compatiblePrinterModels` can still be empty, so the initial model
  // falls back to the user's first printer; that guess must be replaced by accurate project
  // data as soon as it exists, not once profiles finish resolving.
  const [bakedTargetModelSeeded, setBakedTargetModelSeeded] = useState(false)
  useEffect(() => {
    if (!bakedIndex || bakedTargetModelSeeded) return
    if (!manualPrinterModelTouchedRef.current && bakedIndex.compatiblePrinterModels[0]) {
      setManualPrinterModel(bakedIndex.compatiblePrinterModels[0])
    }
    setBakedTargetModelSeeded(true)
  }, [bakedIndex, bakedTargetModelSeeded])
  // The full editor's bed override. The editor must never render a bed from the pre-index
  // fallback guess: until the project's own model has been seeded (or the user explicitly
  // chose a target — a real printer, or a touched model select), pass no override so the
  // editor's scene falls back to the project's embedded settings, which is the accurate
  // bed by definition.
  const editorTargetPrinterModel = targetMode === 'realPrinter' || manualPrinterModelTouchedRef.current || bakedTargetModelSeeded
    ? targetPrinterModel
    : undefined
  useEffect(() => {
    if (!bakedIndex || appliedBakedDefaultsRef.current || waitingForSlicingProfiles) return
    const preserveManualPrinterSelection = targetMode === 'manualProfile' && manualPrinterModelTouchedRef.current
    if (!preserveManualPrinterSelection && bakedIndex.compatiblePrinterModels[0]) setManualPrinterModel(bakedIndex.compatiblePrinterModels[0])
    const bakedPrinterProfile = pickSelectableSlicingProfileByName(machineProfiles, bakedIndex.printerProfileName)
      ?? pickMachineProfileByName(machineProfiles.filter(isSelectableSlicingProfile), bakedIndex.printerProfileName, bakedIndex.compatiblePrinterModels[0] ?? 'unknown')
    if (!preserveManualPrinterSelection && bakedPrinterProfile) setPrinterProfileId(bakedPrinterProfile.id)
    // Prefer the 3MF-embedded process profile over an identically-named installed
    // preset so the project's saved overrides (e.g. wall_loops) survive instead of
    // collapsing to the preset's defaults. Falls back to the installed preset when
    // the project carries no embedded process profile.
    const bakedProcessProfile = pickProjectFallbackSlicingProfileByName(processProfiles, bakedIndex.processProfileName)
      ?? pickSelectableSlicingProfileByName(processProfiles, bakedIndex.processProfileName)
    if (!preserveManualPrinterSelection && bakedProcessProfile) setProcessProfileId(bakedProcessProfile.id)
    setPlateType(resolveInitialPlateType(file, bakedIndex))
    setNozzleDiameter(resolveInitialNozzleDiameter(file, selectedPrinter, bakedPrinterProfile, bakedIndex))
    setFilamentMaterialOptionIds(buildInitialFilamentMaterialOptionSelection(file, bakedIndex, filamentProfiles, selectedMachineProfile))
    setFilamentColors(buildInitialFilamentColorSelection(file, bakedIndex))
    appliedBakedDefaultsRef.current = true
    setBakedDefaultsApplied(true)
  }, [bakedIndex, file, filamentProfiles, machineProfiles, processProfiles, selectedMachineProfile, selectedPrinter, targetMode, waitingForSlicingProfiles])
  useEffect(() => {
    setFilamentMaterialOptionIds((current) => {
      const defaults = buildInitialFilamentMaterialOptionSelection(file, bakedIndex, compatibleFilamentProfiles, selectedMachineProfile)
      const next: Record<number, string> = { ...defaults }
      // Preserve the user's current selection only while it still resolves to a
      // compatible material option; otherwise keep the default so a cross-model
      // machine switch lands on the target machine's default filament.
      for (const [filamentId, optionId] of Object.entries(current)) {
        if (optionId && materialOptions.some((option) => option.id === optionId)) next[Number(filamentId)] = optionId
      }
      return next
    })
  }, [bakedIndex, compatibleFilamentProfiles, file, materialOptions, selectedMachineProfile])
  useEffect(() => {
    setFilamentColors((current) => ({ ...buildInitialFilamentColorSelection(file, bakedIndex), ...current }))
  }, [bakedIndex, file])
  useEffect(() => {
    setFilamentToolheadIds((current) => ({ ...buildInitialFilamentToolheadSelection(file, bakedIndex), ...current }))
  }, [bakedIndex, file])
  useEffect(() => {
    if (!requiresSinglePlate || plateMode === 'single') return
    setPlateMode('single')
  }, [plateMode, requiresSinglePlate])
  useEffect(() => {
    if (plateMode !== 'single' || slicePlateOptions.length === 0) return
    if (slicePlateOptions.some((plate) => String(plate.index) === plateNumber)) return
    const firstPlate = slicePlateOptions[0]
    if (firstPlate) setPlateNumber(String(firstPlate.index))
  }, [plateMode, plateNumber, slicePlateOptions])
  const selectedPlate = !requiresSinglePlate && plateMode === 'all' ? 0 : Number.parseInt(plateNumber, 10)
  const selectedPlateOption = useMemo(
    () => slicePlateOptions.find((plate) => plate.index === selectedPlate) ?? null,
    [selectedPlate, slicePlateOptions]
  )
  const plateObjects = useMemo(() => selectedPlateOption?.objects ?? [], [selectedPlateOption])
  const plateObjectIdsKey = useMemo(() => plateObjects.map((object) => object.id).join(','), [plateObjects])
  // Reset the selection to "all objects" whenever the active plate's object set changes. Keyed on
  // the id string (not the array) so a same-object refetch does not discard the user's deselections.
  useEffect(() => {
    setSelectedSliceObjectIds(new Set(plateObjectIdsKey ? plateObjectIdsKey.split(',').map(Number) : []))
  }, [plateObjectIdsKey])
  // Per-object print selection + overrides are managed in the per-object dialog (a single plate's
  // objects). Available whenever the targeted plate has objects.
  const hasPlateObjects = selectedPlate > 0 && plateObjects.length > 0
  const toggleSliceObject = (id: number) => setSelectedSliceObjectIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  // Only narrow the slice when a strict subset is kept; otherwise let the slicer take every object.
  const submitSelectedObjectIds = hasPlateObjects && selectedSliceObjectIds.size < plateObjects.length
    ? plateObjects.filter((object) => selectedSliceObjectIds.has(object.id)).map((object) => object.id)
    : undefined
  const objectOverrideCount = useMemo(
    () => Object.values(objectProcessOverrides).filter((overrides) => Object.keys(overrides).length > 0).length,
    [objectProcessOverrides]
  )
  const submitObjectProcessOverrides = useMemo(() => {
    const entries = Object.entries(objectProcessOverrides).filter(([, overrides]) => Object.keys(overrides).length > 0)
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }, [objectProcessOverrides])
  const baseProjectFilaments = useMemo(
    () => buildSliceDialogProjectFilaments(file, bakedIndex, selectedPlate),
    [bakedIndex, file, selectedPlate]
  )
  // Add/remove materials overlay (Bambu-style, editor only). `removedFilamentIds`
  // drops base filaments; `addedFilaments` appends new slots (each seeded — see
  // handleAddFilament — from the first material so it has a valid profile). The
  // resulting list bakes into the saved/sliced 3MF via `desiredFilaments`.
  const [removedFilamentIds, setRemovedFilamentIds] = useState<Set<number>>(() => new Set())
  // Slots whose material PROFILE the user explicitly changed (via the dropdown or the loaded-material
  // picker). A profile change writes a new `filament_settings_id`, but unlike a recolor it isn't
  // detectable by comparing values (the baked short name "Bambu PLA Basic" never equals the resolved
  // full preset "Bambu PLA Basic @BBL H2D 0.4 nozzle"), so we track the explicit edits instead. Drives
  // `desiredFilaments` so the choice persists into the saved 3MF. (Programmatic default application
  // sets the option ids directly, not through `handleMaterialOptionChange`, so it never flags here.)
  const [profileEditedFilamentIds, setProfileEditedFilamentIds] = useState<Set<number>>(() => new Set())
  const [addedFilaments, setAddedFilaments] = useState<Array<{ projectFilamentId: number; label: string; color: string | null; nozzleId: number | null; usedOnSelectedPlate: boolean }>>([])
  // 0-based source filament each added slot clones its slicer settings from.
  const [addedFilamentSourceIndex, setAddedFilamentSourceIndex] = useState<Record<number, number>>({})
  const addedFilamentIds = useMemo(() => new Set(addedFilaments.map((entry) => entry.projectFilamentId)), [addedFilaments])
  const projectFilaments = useMemo(
    () => [
      ...baseProjectFilaments.filter((filament) => !removedFilamentIds.has(filament.projectFilamentId)),
      ...addedFilaments
    ],
    [baseProjectFilaments, removedFilamentIds, addedFilaments]
  )
  // The print/slice dialog targets one plate, so it lists, validates, and maps only
  // the materials that plate actually uses — a project can carry materials for other
  // plates, and surfacing them all there just invites mis-mapping. `desiredFilaments`
  // still rewrites the full ordered set so other plates are never dropped.
  //
  // The full 3D EDITOR is different: like BambuStudio it must show EVERY project material
  // at all times (you assign materials to parts across plates, and the 3D preview colours
  // objects by their own filament regardless of the active plate). Filtering to the active
  // plate's used set there hides materials and, worse, drops an object's filament from the
  // colour set so it renders black. So only narrow to the plate in the print/slim flow.
  const isFullProjectEditor = flow === 'library' && file.kind === '3mf'
  const visibleProjectFilaments = useMemo(
    () => isFullProjectEditor ? projectFilaments : projectFilaments.filter((filament) => filament.usedOnSelectedPlate),
    [projectFilaments, isFullProjectEditor]
  )
  const filamentCountChanged = removedFilamentIds.size > 0 || addedFilaments.length > 0
  // A material PROFILE change (e.g. PLA -> PETG) must persist its new `filament_settings_id`,
  // otherwise the saved 3MF keeps the old preset and reopens as the previous material.
  const filamentProfilesChanged = profileEditedFilamentIds.size > 0
  // A recolor (without add/remove) must also persist: otherwise a saved 3MF keeps the old
  // filament_colour even though the live preview/thumbnail shows the new colour.
  const filamentColorsChanged = useMemo(
    () => baseProjectFilaments.some((filament) => {
      const id = filament.projectFilamentId
      const current = filamentColors[id]
      return current != null && normalizeSliceFilamentColor(current) !== normalizeSliceFilamentColor(filament.color ?? '#FFFFFF')
    }),
    [baseProjectFilaments, filamentColors]
  )
  const sliceToolheads = buildSliceDialogToolheads(nozzleDiameter, nozzleFlow, targetMode === 'realPrinter' ? selectedPrinterStatus : undefined, selectedPrinterModel)
  const materialToolheadOptions = sliceToolheads.length > 1 ? sliceToolheads : []
  const missingFilamentProfile = visibleProjectFilaments.some((filament) => !filamentMaterialOptionIds[filament.projectFilamentId])
  const missingFilamentToolhead = materialToolheadOptions.length > 0 && visibleProjectFilaments.some((filament) => !filamentToolheadIds[filament.projectFilamentId])
  // A nozzle reassignment (which extruder a material prints on) must also persist: otherwise the
  // saved 3MF keeps the old `filament_nozzle_map` / slice_info group ids and reopens on the old
  // nozzle. Compared against each slot's baked nozzle so a nozzle-only change still lights up Save
  // (dual-nozzle only — there are no toolhead options to change on a single-nozzle machine).
  const filamentNozzlesChanged = useMemo(
    () => materialToolheadOptions.length > 0 && baseProjectFilaments.some((filament) => {
      const selected = parseSliceToolheadNozzleId(filamentToolheadIds[filament.projectFilamentId])
      return selected != null && selected !== (filament.nozzleId ?? null)
    }),
    [materialToolheadOptions.length, baseProjectFilaments, filamentToolheadIds]
  )
  // The full ordered filament list to bake into the saved/sliced 3MF — only when the user changed
  // the material count, a colour, a profile, or a nozzle (an otherwise unchanged project never
  // rewrites project_settings.config). `sourceIndex` tells the writer which original filament to
  // clone slicer settings from for each slot; `nozzleId` carries the per-slot nozzle assignment.
  const desiredFilaments = useMemo<SceneEditFilament[] | null>(() => {
    if (!filamentCountChanged && !filamentColorsChanged && !filamentProfilesChanged && !filamentNozzlesChanged) return null
    return projectFilaments.map((filament) => {
      const isAdded = addedFilamentIds.has(filament.projectFilamentId)
      const sourceIndex = isAdded
        ? (addedFilamentSourceIndex[filament.projectFilamentId] ?? 0)
        : baseProjectFilaments.findIndex((base) => base.projectFilamentId === filament.projectFilamentId)
      const selectedOption = materialOptions.find((option) => option.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
      return {
        color: normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color ?? '#FFFFFF'),
        type: selectedOption?.materialType ?? (isAdded ? 'PLA' : null),
        // The selected preset name (e.g. "Bambu PETG HF @BBL H2D 0.4 nozzle") so the material
        // choice persists as `filament_settings_id`. Null keeps the slot's existing preset.
        settingsId: selectedOption?.material ?? null,
        sourceIndex: sourceIndex >= 0 ? sourceIndex : 0,
        // The chosen toolhead's runtime nozzle id (0 = right, 1 = left), falling back to the slot's
        // baked nozzle so unchanged slots keep their assignment. Null on single-nozzle projects.
        nozzleId: parseSliceToolheadNozzleId(filamentToolheadIds[filament.projectFilamentId]) ?? filament.nozzleId ?? null
      }
    })
  }, [filamentCountChanged, filamentColorsChanged, filamentProfilesChanged, filamentNozzlesChanged, projectFilaments, addedFilamentIds, addedFilamentSourceIndex, baseProjectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors, filamentToolheadIds])
  const handleAddFilament = useCallback(() => {
    const template = projectFilaments[0] ?? null
    const templateId = template?.projectFilamentId ?? null
    setAddedFilaments((current) => {
      const maxId = Math.max(0, ...baseProjectFilaments.map((entry) => entry.projectFilamentId), ...current.map((entry) => entry.projectFilamentId))
      const newId = maxId + 1
      // Seed the new slot's profile/color/toolhead from the first material so it is
      // immediately sliceable (BambuStudio needs a valid filament profile per slot).
      if (templateId != null) {
        setFilamentMaterialOptionIds((prev) => ({ ...prev, [newId]: prev[templateId] ?? '' }))
        setFilamentColors((prev) => ({ ...prev, [newId]: prev[templateId] ?? normalizeSliceFilamentColor(template?.color ?? '#FFFFFF') }))
        setFilamentToolheadIds((prev) => ({ ...prev, [newId]: prev[templateId] ?? '' }))
      }
      setAddedFilamentSourceIndex((prev) => ({ ...prev, [newId]: 0 }))
      return [...current, {
        projectFilamentId: newId,
        label: template?.label ?? 'PLA',
        color: template?.color ?? '#FFFFFF',
        nozzleId: template?.nozzleId ?? null,
        usedOnSelectedPlate: true
      }]
    })
  }, [projectFilaments, baseProjectFilaments])
  const handleRemoveFilament = useCallback((projectFilamentId: number) => {
    setAddedFilaments((current) => current.filter((entry) => entry.projectFilamentId !== projectFilamentId))
    setAddedFilamentSourceIndex((current) => {
      if (!(projectFilamentId in current)) return current
      const next = { ...current }
      delete next[projectFilamentId]
      return next
    })
    setRemovedFilamentIds((current) => {
      if (!baseProjectFilaments.some((base) => base.projectFilamentId === projectFilamentId)) return current
      const next = new Set(current)
      next.add(projectFilamentId)
      return next
    })
  }, [baseProjectFilaments])
  // Material state is immutably updated, so capturing references gives a valid snapshot
  // the editor's undo/redo can restore (removedFilamentIds copied to an array + rebuilt).
  const materialsSnapshot = useMemo<SliceMaterialsSnapshot>(() => ({
    removedFilamentIds: [...removedFilamentIds],
    profileEditedFilamentIds: [...profileEditedFilamentIds],
    addedFilaments,
    addedFilamentSourceIndex,
    filamentColors,
    filamentMaterialOptionIds,
    filamentToolheadIds,
    filamentMaterialTypeFilters,
    objectProcessOverrides
  }), [removedFilamentIds, profileEditedFilamentIds, addedFilaments, addedFilamentSourceIndex, filamentColors, filamentMaterialOptionIds, filamentToolheadIds, filamentMaterialTypeFilters, objectProcessOverrides])
  const restoreMaterials = useCallback((snapshot: SliceMaterialsSnapshot) => {
    setRemovedFilamentIds(new Set(snapshot.removedFilamentIds))
    setProfileEditedFilamentIds(new Set(snapshot.profileEditedFilamentIds ?? []))
    setAddedFilaments(snapshot.addedFilaments)
    setAddedFilamentSourceIndex(snapshot.addedFilamentSourceIndex)
    setFilamentColors(snapshot.filamentColors)
    setFilamentMaterialOptionIds(snapshot.filamentMaterialOptionIds)
    setFilamentToolheadIds(snapshot.filamentToolheadIds)
    setFilamentMaterialTypeFilters(snapshot.filamentMaterialTypeFilters)
    setObjectProcessOverrides(snapshot.objectProcessOverrides ?? {})
  }, [])
  const suggestedOutputFileName = useMemo(() => {
    if (!requiresSinglePlate && plateMode !== 'single') return buildSlicedOutputFileName(file.name)
    return buildSlicedOutputFileName(file.name, {
      plateName: selectedPlateOption?.name ?? null,
      plateNumber: Number.isInteger(selectedPlate) && selectedPlate > 0 ? selectedPlate : null
    })
  }, [file.name, plateMode, requiresSinglePlate, selectedPlate, selectedPlateOption?.name])
  // The configuration form should not become interactive until the slicer capabilities, profiles,
  // and 3MF plate data have loaded and the embedded defaults are seeded — otherwise the user sees
  // values populate and change underneath them.
  const slicerDataReady = configured
    && !waitingForSlicingProfiles
    && !slicingProfilesQuery.isLoading
    && !platesQuery.isLoading
    && (!platesQuery.data || bakedDefaultsApplied)

  const canSubmit = Boolean(configured)
    && selectedSlicerTargetId.length > 0
    && suggestedOutputFileName.trim().length > 0
    && printerProfileId.length > 0
    && processProfileId.length > 0
    && selectedNozzleDiameters.length > 0
    && !missingFilamentProfile
    && !missingFilamentToolhead
    && (Boolean(sceneEdit) || (!requiresSinglePlate && plateMode === 'all') || (Number.isInteger(selectedPlate) && selectedPlate > 0))
    && (Boolean(sceneEdit) || !hasPlateObjects || selectedSliceObjectIds.size > 0)
    && (targetMode === 'realPrinter' ? printerId.length > 0 : true)
    && !submitting

  // Show the Bambu "*" marker when the process diverges from its preset: explicit session
  // overrides, or a project profile that carries the 3MF's (typically modified) embedded config.
  const processProfileModified = Object.keys(processSettingOverrides).length > 0
    || (selectedProcessProfile != null && isProjectSlicingProfile(selectedProcessProfile))

  const buildSubmitInput = (options?: { outputFileName?: string; outputFolderId?: string | null }): SliceFileSubmitInput => ({
    slicerTargetId: selectedSlicerTargetId,
    outputFileName: (options?.outputFileName ?? suggestedOutputFileName).trim(),
    outputFolderId: options?.outputFolderId ?? null,
    // With a custom layout the edit defines the plates; honor the editor's chosen
    // plate scope (a 1-based index, or 0 for all). Without an edit, use the slim
    // dialog's plate selection.
    plate: sceneEdit ? (editorPlatePreference ?? 0) : selectedPlate,
    sceneEdit: sceneEdit ?? undefined,
    selectedObjectIds: sceneEdit ? undefined : submitSelectedObjectIds,
    objectProcessOverrides: submitObjectProcessOverrides,
    target: targetMode === 'realPrinter'
      ? {
          mode: 'realPrinter',
          printerId,
          printerProfileId,
          plateType,
          nozzleDiameters: selectedNozzleDiameters,
          toolheads: sliceToolheads,
          processProfileId,
          processSettingOverrides: Object.keys(processSettingOverrides).length > 0 ? processSettingOverrides : undefined,
          filamentMappings: buildFilamentMappings(visibleProjectFilaments, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, materialOptions)
        }
      : {
          mode: 'manualProfile',
          printerProfileId,
          printerModel: manualPrinterModel,
          plateType,
          nozzleDiameters: selectedNozzleDiameters,
          toolheads: sliceToolheads,
          processProfileId,
          processSettingOverrides: Object.keys(processSettingOverrides).length > 0 ? processSettingOverrides : undefined,
          filamentMappings: buildFilamentMappings(visibleProjectFilaments, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, materialOptions)
        }
  })

  const submit = (action: SliceFileSubmitAction, options?: { outputFileName?: string; outputFolderId?: string | null }) => {
    if (!canSubmit) return
    const input = buildSubmitInput(options)
    if (input.outputFileName.length === 0) return
    onSubmit(input, action)
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!saveActionVisible) {
      submit('print')
    }
  }

  const printerModelOptions = ensurePrinterModelOptions(file.compatiblePrinterModels, selectedPrinter?.model, machineProfiles)
  const selectedPrinterMaterialPickerFilament = projectFilaments.find((filament) => filament.projectFilamentId === printerMaterialPickerFilamentId) ?? null
  const selectedPrinterMaterialPickerOptions = selectedPrinterMaterialPickerFilament
    ? prioritizeLoadedMaterialOptionsForFilament(loadedMaterialOptions, selectedPrinterMaterialPickerFilament.nozzleId ?? null)
    : []
  const groupedSelectedPrinterMaterialPickerOptions = groupSliceMaterialOptionsByGroup(selectedPrinterMaterialPickerOptions)
  // Maps a loaded option's trayId back to its tray so the picker can show how much
  // filament that tray has left (only for RFID/Bambu spools that report it).
  const printerTrayMap = useMemo(() => buildPrinterTrayMap(selectedPrinterStatus), [selectedPrinterStatus])
  const handleMaterialOptionChange = (projectFilamentId: number, option: SliceMaterialOption | null) => {
    setFilamentMaterialOptionIds((current) => ({ ...current, [projectFilamentId]: option?.id ?? '' }))
    setProfileEditedFilamentIds((current) => current.has(projectFilamentId) ? current : new Set(current).add(projectFilamentId))
    if (option) {
      setFilamentMaterialTypeFilters((current) => ({ ...current, [projectFilamentId]: option.materialType }))
    }
    if (option?.color) {
      setFilamentColors((current) => ({ ...current, [projectFilamentId]: option.color ?? current[projectFilamentId] ?? '' }))
    }
    if (option?.toolheadId) {
      setFilamentToolheadIds((current) => ({ ...current, [projectFilamentId]: option.toolheadId ?? current[projectFilamentId] ?? '' }))
    }
    // Notify the editor (if any) so a pick from its picker Modal flips the unsaved-changes flag.
    materialEditListenerRef.current?.()
  }

  // Manual-profile target for the editor's "save as a different printer" flow. Only built when
  // the selected machine is cross-model with the project's source, so saving a same-model project
  // never round-trips the slicer. A project with NO source machine (a new-project scaffold, which
  // embeds no project_settings) always builds a target so its first save persists the chosen
  // machine — otherwise the printer pick silently vanishes on reopen. Always a manualProfile shape
  // (the slicer only needs the target machine to switch to); printerModel resolves a real
  // printer's model or the manual selection.
  const retargetTarget: SlicingManualProfileTarget | null = (
    printerProfileId.length > 0
    && processProfileId.length > 0
    && Boolean(targetPrinterModel)
    && sourcePrinterModel !== targetPrinterModel
  )
    ? {
        mode: 'manualProfile',
        printerProfileId,
        printerModel: selectedPrinterModel,
        plateType,
        nozzleDiameters: selectedNozzleDiameters,
        toolheads: sliceToolheads,
        processProfileId,
        processSettingOverrides: Object.keys(processSettingOverrides).length > 0 ? processSettingOverrides : undefined,
        filamentMappings: buildFilamentMappings(visibleProjectFilaments, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, materialOptions)
      }
    : null

  // The shared settings surface for both the slim dialog and the 3D editor's
  // Settings tab. State stays here (single source of truth); the controller is
  // the bridge. See SliceSettingsController.
  const sliceController: SliceSettingsController = {
    file, resourceBasePath, flow, requiresSinglePlate, canOpenThreeDimensionalPreview, isMobileViewport,
    tenantSlug, navigate, onClose,
    slicerTargets, selectedSlicerTargetId, setSelectedSlicerTargetId,
    slicerStatus: {
      capabilitiesLoading,
      hasCapabilities: capabilities != null,
      capabilitiesError,
      configured,
      slicerRestarting: Boolean(capabilities?.configured && !capabilities.healthy),
      slicerDataReady,
      profilesError: slicingProfilesQuery.isError
        ? (slicingProfilesQuery.error instanceof Error ? slicingProfilesQuery.error.message : 'Failed to load slicer profiles for this version.')
        : null
    },
    printers, selectedPrinter, lockedPreferredPrinter, targetMode, setTargetMode, setPrinterId,
    selectedPrinterModel, manualPrinterModelTouchedRef, setManualPrinterModel, printerModelOptions,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, nozzleFlow, setNozzleFlow,
    plateType, setPlateType, plateTypeOptions,
    plateMode, setPlateMode, sceneEdit, setSceneEdit, plateNumber, setPlateNumber, slicePlateOptions, setPreviewFileId,
    compatibleProcessProfiles, selectedProcessProfile, processProfileModified, setProcessProfileId, setProcessSettingOverrides,
    processProfileSelectionTouchedRef, selectedSlicerTargetIdForGuards: selectedSlicerTargetId, processSettingOverrides, setProcessSettingsDialogOpen,
    hasPlateObjects, objectOverrideCount, setPerObjectDialogOpen, selectedSliceObjectIds, plateObjects,
    perObjectSettings: selectedProcessProfile ? {
      slicerTargetId: selectedSlicerTargetId,
      processProfileId: selectedProcessProfile.id,
      sourceFileId: file.id,
      globalOverrides: processSettingOverrides,
      visibilityContext: { printerModel: targetMode === 'manualProfile' ? manualPrinterModel : (selectedPrinter?.model ?? '') },
      value: objectProcessOverrides,
      onChange: setObjectProcessOverrides,
      printSelection: selectedSliceObjectIds,
      onTogglePrint: toggleSliceObject
    } : null,
    usedFilamentIdsForPlate: (plateIndex: number) => new Set(bakedIndex?.plates.find((plate) => plate.index === plateIndex)?.filaments.map((filament) => filament.id) ?? []),
    projectFilaments: visibleProjectFilaments, materialOptions, loadedMaterialOptions, materialToolheadOptions,
    filamentMaterialOptionIds, filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentToolheadIds, setFilamentToolheadIds, filamentColors, setFilamentColors,
    setPrinterMaterialPickerFilamentId, handleMaterialOptionChange,
    desiredFilaments, retargetTarget, onAddFilament: handleAddFilament, onRemoveFilament: handleRemoveFilament,
    materialsSnapshot, restoreMaterials, materialEditListenerRef
  }

  // The editor owns geometry; the slice is otherwise valid when printer/process/
  // filament settings are complete. (Plate/object-selection clauses are excluded —
  // the editor expresses plate scope via its own action.)
  const canSliceFromEditor = Boolean(configured)
    && selectedSlicerTargetId.length > 0
    && printerProfileId.length > 0
    && processProfileId.length > 0
    && selectedNozzleDiameters.length > 0
    && !missingFilamentProfile
    && !missingFilamentToolhead
    && (targetMode === 'realPrinter' ? printerId.length > 0 : true)
    && !submitting

  // Human-readable explanation for a disabled Slice button so the editor never just greys it
  // out "for unknown reasons". See resolveSliceDisabledReason for the clause ordering.
  const sliceDisabledReason = resolveSliceDisabledReason({
    canSlice: canSliceFromEditor,
    configured: Boolean(configured),
    selectedSlicerTargetId,
    profilesError: slicingProfilesQuery.isError
      ? (slicingProfilesQuery.error instanceof Error ? slicingProfilesQuery.error.message : 'Slicer profiles failed to load.')
      : null,
    slicerDataReady,
    printerProfileId,
    processProfileId,
    nozzleDiameterCount: selectedNozzleDiameters.length,
    missingFilamentProfile,
    missingFilamentToolhead,
    targetMode,
    printerId,
    submitting
  })

  // Slice a single plate from the 3D editor without persisting a project: produces a
  // hidden gcode + slicing stats and opens the results dialog (which can save/print).
  const handleEditorSlice = (opts: { plate: number; sceneEdit: SceneEdit }) => {
    if (!canSliceFromEditor) return
    setSceneEdit(opts.sceneEdit)
    setEditorPlatePreference(opts.plate)
    // Name the output from the scope actually being sliced — `suggestedOutputFileName`
    // tracks the editor's per-object plate selection (always a single plate), so a
    // whole-project slice (plate 0) would otherwise wrongly get a "Plate 1" suffix.
    const slicedPlate = opts.plate > 0 ? opts.sceneEdit.plates.find((plate) => plate.index === opts.plate) : null
    const outputFileName = buildSlicedOutputFileName(
      file.name,
      opts.plate > 0 ? { plateName: slicedPlate?.name ?? null, plateNumber: opts.plate } : undefined
    )
    const input: SliceFileSubmitInput = {
      ...buildSubmitInput({ outputFileName }),
      plate: opts.plate,
      sceneEdit: opts.sceneEdit,
      selectedObjectIds: undefined,
      // Land the (initially hidden) gcode next to the source project, so "Save to
      // library" only has to reveal it.
      outputFolderId: file.folderId ?? null
    }
    onSubmit(input, 'slice', { keepDialogOpen: true })
  }

  // Context handed to the 3D editor (the "full slicer"). Shared by the slim
  // dialog's "Open full editor" button and the direct-open path below.
  const editorSlotContext = {
    fileId: file.id,
    baseVersionId: versionId ?? null,
    isNewProject,
    // The library context the new file should default into when saved (so the save dialog can
    // browse folders and the save lands on the right bridge).
    bridgeId,
    folderId: currentFolderId,
    currentEdit: sceneEdit,
    onApply: setSceneEdit,
    onSlice: handleEditorSlice,
    canSlice: canSliceFromEditor,
    sliceDisabledReason,
    slicing: submitting && (submitAction === 'print' || submitAction === 'slice'),
    sliceConfig: sliceController,
    initialPlateIndex: Number.parseInt(plateNumber, 10),
    targetPrinterModel: editorTargetPrinterModel,
    objectOverrideCount,
    hasPlateObjects,
    canEditSettings: Boolean(selectedProcessProfile && selectedSlicerTargetId),
    onEditObjectSettings: () => setPerObjectDialogOpen(true),
    onClose
  }
  // Simple mode is gone for the library flow: slicing opens the full 3D editor
  // directly. The print-prep flow (a file targeted at one printer) keeps the slim
  // dialog. The editor handles its own plate loading/errors.
  const editorOnly = flow === 'library' && file.kind === '3mf'

  return (
    <>
      {editorOnly ? (
        <PluginSlot name="slicing.editor" context={{ ...editorSlotContext, autoOpen: true }} />
      ) : (
      <Modal open onClose={onClose}>
        <ScrollableModalDialog sx={{ maxWidth: 560, width: '100%' }}>
          <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography level="h4">{dialogTitle}</Typography>
            <ScrollableDialogBody sx={{ mt: 1 }}>
              <Stack spacing={1.25}>
                {dialogDescription && (
                  <Typography level="body-sm" textColor="text.tertiary">
                    {dialogDescription}
                  </Typography>
                )}
              {/* The panel renders its own slicer availability/loading notices. */}
              <SliceSettingsPanel controller={sliceController} mode="simple" />
              {(!saveDestinationOpen || submitAction !== 'save') && submitError && <Typography level="body-sm" color="danger">{submitError}</Typography>}
            </Stack>
          </ScrollableDialogBody>
          <DialogActions sx={{ pt: 1, justifyContent: onBack ? 'space-between' : undefined }}>
            {onBack && (
              <Button
                type="button"
                variant="plain"
                color="neutral"
                startDecorator={<ArrowBackRoundedIcon />}
                onClick={onBack}
                disabled={submitting}
              >
                Back
              </Button>
            )}
            <Stack direction="row" spacing={1}>
              <Button type="button" variant="plain" onClick={onClose}>{flow === 'print' ? 'Cancel' : 'Close'}</Button>
              {saveActionVisible && (
                <Button
                  type="button"
                  variant="outlined"
                  loading={submitting && submitAction === 'save'}
                  disabled={!canSubmit || submitting}
                  startDecorator={<ContentCutRoundedIcon />}
                  onClick={() => setSaveDestinationOpen(true)}
                >
                  {saveActionLabel}
                </Button>
              )}
              <Button
                type="button"
                loading={submitting && submitAction === 'print'}
                disabled={!canSubmit || submitting}
                // The print-prep flow "continues" to a follow-up step (printer selection or
                // the queue dialog), so no print icon; the direct library print keeps it.
                startDecorator={flow === 'print' ? undefined : <PrintRoundedIcon />}
                onClick={() => submit('print')}
              >
                {printActionLabel}
              </Button>
            </Stack>
          </DialogActions>
          </Box>
        </ScrollableModalDialog>
      </Modal>
      )}
      {/* Per-object + process settings dialogs live at the top level so they stack
          above the editor in editor-only mode (and above the slim dialog otherwise). */}
      {perObjectDialogOpen && selectedProcessProfile && (
        <Suspense fallback={null}>
          <PerObjectSettingsDialog
            open={perObjectDialogOpen}
            onClose={() => setPerObjectDialogOpen(false)}
            objects={plateObjects}
            slicerTargetId={selectedSlicerTargetId}
            processProfileId={selectedProcessProfile.id}
            processProfileName={selectedProcessProfile.name}
            sourceFileId={file.id}
            globalOverrides={processSettingOverrides}
            visibilityContext={{ printerModel: targetMode === 'manualProfile' ? manualPrinterModel : (selectedPrinter?.model ?? '') }}
            value={objectProcessOverrides}
            onChange={setObjectProcessOverrides}
            printSelection={selectedSliceObjectIds}
            onTogglePrint={toggleSliceObject}
            applyScope={editorOnly ? 'project' : 'slice'}
          />
        </Suspense>
      )}
      {processSettingsDialogOpen && selectedProcessProfile && (
        <Suspense fallback={null}>
          <ProcessSettingsDialog
            open={processSettingsDialogOpen}
            onClose={() => setProcessSettingsDialogOpen(false)}
            slicerTargetId={selectedSlicerTargetId}
            processProfileId={selectedProcessProfile.id}
            processProfileName={selectedProcessProfile.name}
            sourceFileId={file.id}
            initialOverrides={processSettingOverrides}
            visibilityContext={{ printerModel: targetMode === 'manualProfile' ? manualPrinterModel : (selectedPrinter?.model ?? '') }}
            profileOptions={compatibleProcessProfiles.map((profile) => ({ id: profile.id, name: formatSlicingProfileDisplayName(profile) }))}
            applyScope={editorOnly ? 'project' : 'slice'}
            onProfileChange={(profileId, carryOverrides) => {
              processProfileSelectionTouchedRef.current = true
              setProcessProfileId(profileId)
              setProcessSettingOverrides(carryOverrides)
            }}
            onApply={(overrides) => setProcessSettingOverrides(overrides)}
          />
        </Suspense>
      )}
      {saveActionVisible && saveDestinationOpen && (
        <LibraryDestinationDialog
          title="Save sliced file"
          description="Choose where to save the sliced file, then confirm the file name. Picking an existing file saves over it."
          showFiles
          fileNameField={{
            label: 'File name',
            initialValue: suggestedOutputFileName,
            extension: '.gcode.3mf'
          }}
          initialFolderId={currentFolderId}
          folders={folders}
          bridgeId={bridgeId}
          bridgeName={bridgeName}
          showRoot={showRoot}
          dialogWidth={720}
          submitting={submitting && submitAction === 'save'}
          error={submitAction === 'save' ? submitError : null}
          confirmStartDecorator={<ContentCutRoundedIcon />}
          confirmActionLabel={({ outputFolderId, rootDestinationLabel }) => outputFolderId ? 'Save here' : `Save to ${rootDestinationLabel}`}
          onClose={() => setSaveDestinationOpen(false)}
          onSubmit={({ outputFileName, outputFolderId }) => submit('save', { outputFileName: outputFileName ?? suggestedOutputFileName, outputFolderId })}
        />
      )}
      <PluginSlot
        name="library.overlays"
        context={{ previewFileId, previewPlateIndex: Number.parseInt(plateNumber, 10), onPreviewClose: () => setPreviewFileId(null) }}
      />
      <Modal open={Boolean(printerMaterialPickerFilamentId)} onClose={() => setPrinterMaterialPickerFilamentId(null)}>
        <ModalDialog size="md" sx={{ maxWidth: 480, width: '100%' }}>
          <Typography level="h4">Choose material {selectedPrinterMaterialPickerFilament ? projectFilaments.findIndex((filament) => filament.projectFilamentId === selectedPrinterMaterialPickerFilament.projectFilamentId) + 1 : ''}</Typography>
          <Stack spacing={1}>
            {selectedPrinterMaterialPickerOptions.length === 0 ? (
              <Typography level="body-sm" textColor="text.tertiary">No loaded printer materials are available for this material.</Typography>
            ) : groupedSelectedPrinterMaterialPickerOptions.map((group) => (
              <Stack key={group.label} spacing={0.5}>
                <Typography level="body-xs" textColor="text.tertiary" sx={{ fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{group.label}</Typography>
                {group.options.map((option) => {
                  const tray = option.trayId != null ? printerTrayMap.get(option.trayId) : undefined
                  // Remaining: the tracked spool's figure first (covers non-RFID custom
                  // filament); otherwise only RFID/Bambu spools report a reliable estimate.
                  const remainGrams = option.remainingGrams
                    ?? (tray && tray.trayUuid != null ? estimateRemainGrams(tray.remainPercent) : null)
                  const remainPercent = option.remainPercent ?? tray?.remainPercent
                  // Pre-fold "brand + type" so the brand isn't doubled when the label already carries it,
                  // then hand the whole identity to the shared label as the name (type left to the label).
                  const brandLabel = option.brand && !option.label.toLowerCase().includes(option.brand.toLowerCase())
                    ? `${option.brand} ${option.label}`
                    : option.label
                  return (
                    <Sheet
                      key={option.id}
                      variant="outlined"
                      onClick={() => {
                        if (!selectedPrinterMaterialPickerFilament) return
                        handleMaterialOptionChange(selectedPrinterMaterialPickerFilament.projectFilamentId, option)
                        setPrinterMaterialPickerFilamentId(null)
                      }}
                      sx={{ p: 1, borderRadius: 'sm', cursor: 'pointer', transition: 'border-color 120ms', '&:hover': { borderColor: 'primary.500' } }}
                    >
                      <FilamentOptionLabel
                        color={option.color}
                        colors={option.colors}
                        colorName={option.colorName ?? (tray ? resolveFilamentDisplay(tray).name : null)}
                        filamentName={brandLabel}
                        swatchLabel={option.slotLabel}
                        remainingGrams={remainGrams}
                        remainPercent={remainPercent}
                      />
                    </Sheet>
                  )
                })}
              </Stack>
            ))}
          </Stack>
          <DialogActions>
            <Button type="button" variant="plain" onClick={() => setPrinterMaterialPickerFilamentId(null)}>Cancel</Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  )
}
