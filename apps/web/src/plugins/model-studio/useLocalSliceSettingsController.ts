/**
 * Produces the editor's `SliceSettingsController` for a host with NO server behind it: the public
 * 3MF editor. `SliceFileModal` builds the same controller from live workspace data (printers, AMS
 * trays, workspace presets, dispatch); this builds the half that is about the PROJECT (slicer target,
 * printer model + nozzle + plate, process preset, and materials) from what a local host can reach:
 * the anonymous catalogue (`/api/public/slicing/*`) plus the user's browser-stored presets.
 *
 * It deliberately reuses the SAME shared helpers `SliceFileModal` uses (`lib/slicingPresetMatching`,
 * the extracted `useProcessProfileSelection`), so the business rules live in one place, this hook
 * only orchestrates them for a printer-less host. The printer/dispatch fields the type requires are
 * present but inert (no printers, `manualProfile` always, no slicing), and every surface that would
 * render them is already hidden: `SliceSettingsPanel` drops the Plate/Objects sections in editor
 * mode and hides the printer picker when there are no printers.
 *
 * The process and material "tune" dialogs work here too, through the anonymous resolvers in
 * `lib/localProcessResolver.ts` / `lib/localFilamentResolver.ts` (built-ins via
 * `/api/public/slicing/resolve-*`, project presets straight out of the in-tab 3MF). This hook owns
 * only the OPEN state for the material one: the dialogs themselves are rendered by the host, which
 * is why `filamentSettingsFilamentId` and the ungated resolvers are returned alongside the
 * controller rather than buried in it.
 *
 * Counterpart: `apps/web/src/components/library/SliceFileModal.tsx` (the workspace controller).
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { useNavigate } from 'react-router-dom'
import type {
  SlicingManualProfileTarget,
  SlicingPresetSummary
} from '@printstream/shared'
import { isProjectNewerThanSlicer, isProjectSlicingPresetId } from '@printstream/shared'
import {
  buildProcessFilamentChoices,
  buildProjectSlicingPresets,
  buildRedundantProjectPresetCandidates,
  buildSliceDialogProjectFilaments,
  buildSliceDialogToolheads,
  buildSliceMaterialOptions,
  isFilamentProfileCompatible,
  isVisibleFilamentProfile,
  isVisibleProcessProfile,
  mergeProjectSlicingPresets
} from '../../lib/slicingPresetMatching'
import { permuteFilamentIndexOverrides, permutePerObjectFilamentIndexOverrides, remapFilamentIndexOverrides, remapPerObjectFilamentIndexOverrides } from '../../lib/filamentIndexOverrides'
import { useDeepStableValue } from '../../hooks/useDeepStableValue'
import type { ProcessConfigResolver } from '../../components/ProcessSettingsDialog'
import type { FilamentConfigResolver } from '../../components/library/FilamentSettingsDialog'
import type { SettingFilamentChoice } from '../../components/settings/SettingValueField'
import type { SliceConfigSnapshot, SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { useMachineTarget } from '../../components/library/useMachineTarget'
import { useMaterialSlots } from '../../components/library/useMaterialSlots'
import { useProcessProfileSelection } from '../../components/library/useProcessProfileSelection'
import type { ClientThreeMfProject } from './lib/clientThreeMfProject'
import { deriveProjectCarryOverrides } from '../../lib/processCarryOverrides'
import { createBuiltinPresetCache } from './lib/builtinPresetCache'
import { resolveBuiltinProcessViaApi, buildLocalProcessConfigResolver } from './lib/localProcessResolver'
import { resolveBuiltinFilamentViaApi, buildLocalFilamentConfigResolver } from './lib/localFilamentResolver'
import { useUnchangedProjectFilamentPresetIds } from '../../components/library/useBakedPresetChanges'
import { localBakedIndex, localSliceLibraryFile } from './lib/localSliceFile'
import { listLocalSlicingPresets } from './lib/localSlicingPresets'
import { mergeLocalProfilesIntoCatalogue } from './lib/localSliceSettings'
import { resolveSlicerTargetId } from '../../lib/machineTargetResolution'
import { publicSlicerTargetsQueryOptions, publicSlicingPresetsQueryOptions } from './lib/publicSlicingCatalog'

export interface LocalSliceSettingsControllerParams {
  project: ClientThreeMfProject
  isMobileViewport: boolean
  onClose: () => void
}

/** A navigate that goes nowhere: the public host has no library routes for the controller to reach. */
const NOOP_NAVIGATE = (() => undefined) as unknown as ReturnType<typeof useNavigate>

export interface LocalSliceSettings {
  controller: SliceSettingsController
  /**
   * The printer model the editor should render the bed + zones for: passed to `EditorView` as a
   * SEPARATE prop (like the library host does), not part of the controller, so a model switch moves
   * the bed. Undefined when unresolved, which leaves the editor on the project's own bed.
   */
  targetPrinterModel: string | undefined
  /**
   * Anonymous resolver for the process tune dialogs: passed to `EditorView` (per-object dialogs)
   * and used by the host to render the GLOBAL process dialog, which no shared component renders for
   * a server-less host (the library host's still-mounted slice dialog does that job).
   */
  resolveProcessConfig: ProcessConfigResolver
  /**
   * Anonymous resolver for the MATERIAL tune dialog, which the host renders for the same reason as
   * the process one. Ungated (unlike the controller's `resolveFilamentConfig`, which waits for the
   * catalogue so the sidebar badge cannot cache a wrong count), a dialog is opened long after the
   * catalogue has settled.
   */
  resolveFilamentConfig: FilamentConfigResolver
  /** Whether the global process settings dialog is open (the controller owns the toggle state). */
  processSettingsDialogOpen: boolean
  /** The setting key the cross-catalog search picked; seeds the next catalog dialog's search box. */
  settingsSearchKey: string | null
  setSettingsSearchKey: React.Dispatch<React.SetStateAction<string | null>>
  /**
   * Material choices for the global process dialog's filament-index settings ("Support/raft
   * base" etc.) and its support-interface suggestion prompt, the same shared builder the
   * workspace host feeds its dialog from. Without them those settings render as bare number
   * inputs and the suggestion never fires.
   */
  processFilamentChoices: SettingFilamentChoice[]
  /**
   * The INSTALLED filament catalogue (built-ins + the user's browser-stored presets), for the save's
   * machine retarget to pick each slot's rebind from. Project-embedded presets are deliberately not
   * in here: a rebind target has to be a preset that exists on the new machine.
   */
  installedFilamentPresets: SlicingPresetSummary[]
  /** Which material's tune dialog is open, by 1-based project filament id. Null when none is. */
  filamentSettingsFilamentId: number | null
  setFilamentSettingsFilamentId: (filamentId: number | null) => void
  /** Record an override set for one material slot, as the host's tune dialog applies it. */
  setFilamentSettingOverridesById: React.Dispatch<React.SetStateAction<Record<number, Record<string, string | string[]>>>>
}

export function useLocalSliceSettingsController(params: LocalSliceSettingsControllerParams): LocalSliceSettings {
  const { project, isMobileViewport, onClose } = params

  const file = useMemo(() => localSliceLibraryFile(project), [project])
  const bakedIndex = useMemo(() => localBakedIndex(project), [project])
  // Editor always shows every project material (not narrowed to one plate); the plate index only
  // feeds the per-plate "used" flag, which the editor ignores.
  const selectedPlate = bakedIndex.plates[0]?.index ?? 1
  // Every object across every plate, deduped by id. The editor gates per-object process gears on
  // membership in this set (`sliceObjectIds`), so leaving it empty hid the gear on every object.
  // A union (not one plate) is correct here: the editor shows all plates and switches between them.
  const plateObjects = useMemo(() => {
    const byId = new Map<number, { id: number; name: string }>()
    for (const plate of bakedIndex.plates) {
      for (const object of plate.objects) {
        if (!byId.has(object.id)) byId.set(object.id, { id: object.id, name: object.name })
      }
    }
    return [...byId.values()]
  }, [bakedIndex])

  // ---- Catalogue: anonymous built-ins + the user's browser-stored presets ----
  const targetsQuery = useQuery(publicSlicerTargetsQueryOptions())
  const [slicerTargetIntent, setSlicerTargetIntent] = useState<string | undefined>(undefined)
  const slicerTargets = useMemo(() => targetsQuery.data?.targets ?? [], [targetsQuery.data?.targets])
  // The same shared ladder the workspace host uses (never a prerelease); before S2 this was a
  // third hand-written copy of it.
  const selectedSlicerTargetId = resolveSlicerTargetId(slicerTargets, targetsQuery.data?.defaultTargetId, slicerTargetIntent)
  // An updater form has to see the RESOLVED id, not the sparse intent: see the workspace host.
  const selectedSlicerTargetIdRef = useRef(selectedSlicerTargetId)
  selectedSlicerTargetIdRef.current = selectedSlicerTargetId
  const setSelectedSlicerTargetId = useCallback((value: React.SetStateAction<string>) => {
    setSlicerTargetIntent(typeof value === 'function' ? value(selectedSlicerTargetIdRef.current) : value)
  }, [])

  const profilesQuery = useQuery(publicSlicingPresetsQueryOptions(selectedSlicerTargetId))
  // Browser storage is read at OPEN and then only when the user has been in the preset manager:
  // held state, not a per-render read, so an editor session cannot have its catalogue change under
  // it. The same user-initiated carve-out the workspace host's `refreshSlicingPresets` is.
  const [localProfiles, setLocalProfiles] = useState(listLocalSlicingPresets)
  const refreshSlicingPresets = useCallback(() => { setLocalProfiles(listLocalSlicingPresets()) }, [])
  const catalogue = useMemo(
    () => mergeLocalProfilesIntoCatalogue(profilesQuery.data ?? [], localProfiles),
    [profilesQuery.data, localProfiles]
  )
  const machineProfiles = useMemo(
    () => mergeProjectSlicingPresets(catalogue.filter((profile) => profile.kind === 'machine'), buildProjectSlicingPresets(bakedIndex, 'machine')),
    [bakedIndex, catalogue]
  )
  const processProfiles = useMemo(
    () => mergeProjectSlicingPresets(catalogue.filter((profile) => profile.kind === 'process' && isVisibleProcessProfile(profile)), buildProjectSlicingPresets(bakedIndex, 'process')),
    [bakedIndex, catalogue]
  )
  const installedFilamentProfiles = useMemo(
    () => catalogue.filter((profile) => profile.kind === 'filament' && isVisibleFilamentProfile(profile)),
    [catalogue]
  )
  const projectFilamentProfiles = useMemo(() => buildProjectSlicingPresets(bakedIndex, 'filament'), [bakedIndex])
  // The catalogue INCLUDING every project preset. The config resolver must read this one: it is
  // what resolves a `project:` preset out of the in-tab archive, and the picker's list below has
  // the redundant ones removed: resolving against that would starve the very query that decides
  // which are redundant.
  const unfilteredFilamentProfiles = useMemo(
    () => mergeProjectSlicingPresets(installedFilamentProfiles, projectFilamentProfiles),
    [installedFilamentProfiles, projectFilamentProfiles]
  )

  // ---- Machine target (printer-less: the shared core with no real-printer context) ----
  // The project is parsed in the tab, so its index is already in hand: `projectResolved` is
  // simply true here, where the workspace host waits on a request.
  const {
    selectedPrinterModel, selectPrinterModel,
    printerModelOptions, printerProfileId, selectedMachineProfile, selectPrinterProfile, targetPrinterModel,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, selectedNozzleDiameters,
    nozzleFlow, setNozzleFlow,
    plateType, handlePlateTypeChange, plateTypeOptions,
    selectableMachineProfiles, printerCompatibleProcessProfiles,
    conflicts: targetConflicts,
    origins: targetOrigins,
    machineSnapshot, restoreMachineSnapshot
  } = useMachineTarget({
    file,
    bakedIndex,
    machineProfiles,
    processProfiles,
    projectResolved: true,
    catalogueResolved: (profilesQuery.data?.length ?? 0) > 0 || profilesQuery.isError,
    resetToken: selectedSlicerTargetId
  })

  // ---- Anonymous process-config resolver (tune dialogs + machine-switch carry-over) ----
  // Stable identity (keyed on the project) but reads the live catalogue through a ref, so opening a
  // dialog does not re-fire its load effect while the catalogue settles.
  const processProfilesRef = useRef(processProfiles)
  processProfilesRef.current = processProfiles
  // One cache per open project. A BUILT-IN preset resolves from the slicer image, so its config is a
  // pure function of (presetId, targetId) and cannot change while the tab is open, yet the badge,
  // the repair, the save's authoring pass and every parent lookup each resolved independently, and
  // a project whose slots share a preset resolved it once per slot. See `builtinPresetCache.ts`.
  // `project` is a deliberate RESET KEY, not a value the factory reads: it is what
  // discards one project's cache when another opens. eslint sees an unused dep and
  // suggests dropping it, which would make the cache outlive the project it belongs to.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const builtinCache = useMemo(() => createBuiltinPresetCache(), [project])
  const resolveBuiltinProcess = useMemo(
    () => builtinCache.memoize('process', resolveBuiltinProcessViaApi),
    [builtinCache]
  )
  const resolveBuiltinFilament = useMemo(
    () => builtinCache.memoize('filament', resolveBuiltinFilamentViaApi),
    [builtinCache]
  )
  const resolveProcessConfig = useCallback<ProcessConfigResolver>(
    (request) => buildLocalProcessConfigResolver({ project, processProfiles: processProfilesRef.current, resolveBuiltin: resolveBuiltinProcess })(request),
    [project, resolveBuiltinProcess]
  )
  // Same shape for filament: stable identity, live catalogue through a ref.
  const filamentProfilesRef = useRef(unfilteredFilamentProfiles)
  filamentProfilesRef.current = unfilteredFilamentProfiles
  const resolveFilamentConfig = useCallback<FilamentConfigResolver>(
    (request) => buildLocalFilamentConfigResolver({ project, filamentProfiles: filamentProfilesRef.current, resolveBuiltin: resolveBuiltinFilament })(request),
    [project, resolveBuiltinFilament]
  )
  // Which project presets say nothing their installed twin does not, so the picker can present
  // them as the system preset, the way BambuStudio does. Declared AFTER the resolver because it
  // resolves through it (this host has no server file to resolve against).
  const redundantProjectPresetCandidates = useMemo(
    () => buildRedundantProjectPresetCandidates(projectFilamentProfiles, installedFilamentProfiles, bakedIndex),
    [bakedIndex, installedFilamentProfiles, projectFilamentProfiles]
  )
  const unchangedProjectFilamentPresetIds = useUnchangedProjectFilamentPresetIds({
    slicerTargetId: selectedSlicerTargetId,
    sourceFileId: null,
    presets: redundantProjectPresetCandidates,
    resolveConfig: resolveFilamentConfig
  })
  const filamentProfiles = useMemo(
    () => mergeProjectSlicingPresets(
      installedFilamentProfiles,
      projectFilamentProfiles.filter((profile) => !unchangedProjectFilamentPresetIds.has(profile.id))
    ),
    [installedFilamentProfiles, projectFilamentProfiles, unchangedProjectFilamentPresetIds]
  )
  const projectProcessProfileId = useMemo(
    () => processProfiles.find((profile) => isProjectSlicingPresetId(profile.id))?.id ?? null,
    [processProfiles]
  )
  // Resolve the project's OWN preset (no target) to derive its genuine deltas, so a machine switch
  // carries them onto the new preset, the same mechanism as the workspace host, via the resolver.
  const projectProcessResolveQuery = useQuery({
    queryKey: ['local-project-process-carry', projectProcessProfileId],
    queryFn: () => resolveProcessConfig({ processProfileId: projectProcessProfileId as string, targetId: null, sourceFileId: null }),
    enabled: Boolean(projectProcessProfileId),
    staleTime: Infinity
  })
  const carryOverridesOnRepick = useDeepStableValue(
    useMemo(() => deriveProjectCarryOverrides(projectProcessResolveQuery.data), [projectProcessResolveQuery.data])
  )

  // ---- Process preset selection (the shared hook, same as the workspace path) ----
  const {
    compatibleProcessProfiles, selectedProcessProfile,
    processProfileId, setProcessProfileId,
    processSettingOverrides, setProcessSettingOverrides,
    processProfileSelectionTouchedRef
  } = useProcessProfileSelection({
    processProfiles,
    printerCompatibleProcessProfiles,
    selectedMachineProfile,
    selectedPrinterModel,
    selectedNozzleDiameters,
    plateType,
    bakedProcessProfileName: bakedIndex.processProfileName,
    carryOverridesOnRepick,
    resetToken: selectedSlicerTargetId
  })
  const [processSettingsDialogOpen, setProcessSettingsDialogOpen] = useState(false)
  /** Set by the cross-catalog settings search; seeds the next catalog dialog's search box. */
  const [settingsSearchKey, setSettingsSearchKey] = useState<string | null>(null)
  const [objectProcessOverrides, setObjectProcessOverrides] = useState<Record<string, Record<string, string | string[]>>>({})

  // ---- Materials (the shared slot core: see useMaterialSlots) ----
  const compatibleFilamentProfiles = useMemo(
    () => filamentProfiles.filter((profile) => isFilamentProfileCompatible(profile, selectedMachineProfile, selectedProcessProfile, selectedPrinterModel, selectedNozzleDiameters)),
    [filamentProfiles, selectedMachineProfile, selectedNozzleDiameters, selectedPrinterModel, selectedProcessProfile]
  )
  const materialOptions = useMemo(() => buildSliceMaterialOptions(compatibleFilamentProfiles, []), [compatibleFilamentProfiles])
  // Which material's tune dialog is open. Owned here because the sidebar row opens it through the
  // controller, but RENDERED by the host, a server-less host has no still-mounted slice dialog to
  // render it from, which is the same split the global process dialog uses.
  const [filamentSettingsFilamentId, setFilamentSettingsFilamentId] = useState<number | null>(null)
  const settingsEditListenerRef = useRef<(() => void) | null>(null)

  const baseProjectFilaments = useMemo(() => buildSliceDialogProjectFilaments(file, bakedIndex, selectedPlate), [bakedIndex, file, selectedPlate])
  // Removing a slot must remap the filament-INDEX references living with the process state:
  // see useMaterialSlots.onFilamentRemoved (positions above the removed one shift down).
  const handleFilamentIndexRemap = useCallback((removedPosition: number) => {
    setProcessSettingOverrides((current) => remapFilamentIndexOverrides(current, removedPosition))
    setObjectProcessOverrides((current) => remapPerObjectFilamentIndexOverrides(current, removedPosition))
  }, [setProcessSettingOverrides])
  // A reorder renumbers every position at once: same duty, permutation form.
  const handleFilamentIndexPermute = useCallback((remap: ReadonlyMap<number, number>) => {
    setProcessSettingOverrides((current) => permuteFilamentIndexOverrides(current, remap))
    setObjectProcessOverrides((current) => permutePerObjectFilamentIndexOverrides(current, remap))
  }, [setProcessSettingOverrides])
  // Declared BEFORE the material core: it feeds the core's nozzle-validity clamp.
  const sliceToolheads = useMemo(() => buildSliceDialogToolheads(nozzleDiameter, nozzleFlow, undefined, selectedPrinterModel), [nozzleDiameter, nozzleFlow, selectedPrinterModel])
  const {
    projectFilaments,
    filamentMaterialOptionIds,
    filamentColors, setFilamentColors,
    filamentToolheadIds, setFilamentToolheadIds,
    filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentSettingOverridesById, setFilamentSettingOverridesById,
    handleAddFilament, handleRemoveFilament, handleReorderFilament, handleMaterialOptionChange,
    materialEditListenerRef,
    desiredFilaments, filamentMappingResult,
    onProjectSaved: handleProjectSaved,
    materialSnapshot, restoreMaterialSnapshot
  } = useMaterialSlots({
    file,
    bakedIndex,
    baseProjectFilaments,
    filamentProfiles,
    compatibleFilamentProfiles,
    materialOptions,
    selectedMachineProfile,
    toolheadOptions: sliceToolheads,
    // The editor shows every project material (no per-plate narrowing): see the modal's rule.
    onFilamentRemoved: handleFilamentIndexRemap,
    onFilamentReordered: handleFilamentIndexPermute
  })
  const materialToolheadOptions = useMemo(() => {
    const toolheads = buildSliceDialogToolheads(nozzleDiameter, nozzleFlow, undefined, selectedPrinterModel)
    return toolheads.length > 1 ? toolheads : []
  }, [nozzleDiameter, nozzleFlow, selectedPrinterModel])

  // Choices for the global process dialog's filament-index settings + suggestion prompt.
  // Plate 0 = all-plates: the editor targets no single plate, exactly as the library editor
  // host does (SliceFileModal in editor mode keeps plateMode 'all'), so every project
  // material counts as a model candidate for the recommendation's homogeneity gate.
  const processFilamentChoices = useMemo(
    () => buildProcessFilamentChoices({ projectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors, bakedIndex, selectedPlate: 0 }),
    [projectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors, bakedIndex]
  )

  /**
   * The project's OWN machine settings, as a diff against the resolved printer preset. Held here
   * beside the process overrides because it travels with them everywhere: the slice request, the
   * save request, the undo snapshot. Cleared by nothing implicitly -- a machine override survives a
   * preset switch, and the server re-resolves the new preset and lays these back over it.
   */
  const [machineSettingOverrides, setMachineSettingOverrides] = useState<Record<string, string | string[]>>({})
  /** Which printer the overrides above were authored against; drives the carried-overrides warning. */
  const [machineOverridesModel, setMachineOverridesModel] = useState<string | null>(null)

  const retargetTarget: SlicingManualProfileTarget | null = (printerProfileId.length > 0 && processProfileId.length > 0 && Boolean(targetPrinterModel))
    ? {
        mode: 'manualProfile',
        printerProfileId,
        // Whether the user PICKED this preset or the cascade derived it. The server cannot tell
        // from the id alone, and rewriting a project's machine on a derived id threw away
        // hand-tuned printers on ordinary saves.
        printerProfileChosen: targetOrigins.printerProfileId === 'user',
        // Always sent, empty included: an empty map is how "reset every printer override" is
        // expressed, and omitting it made a reset in this editor save a file that still carried the
        // override. Safe to send unconditionally here in a way it is not for the library host: this
        // controller reads the project the tab already parsed, so the map is never empty merely
        // because a lookup has not answered.
        machineSettingOverrides,
        printerModel: selectedPrinterModel,
        plateType,
        nozzleDiameters: selectedNozzleDiameters,
        toolheads: sliceToolheads,
        processProfileId,
        processSettingOverrides: Object.keys(processSettingOverrides).length > 0 ? processSettingOverrides : undefined,
        filamentMappings: filamentMappingResult.mappings
      }
    : null

  // ---- Undo snapshot (scene edits are undone by the editor; this covers the settings) ----
  const configSnapshot = useMemo<SliceConfigSnapshot>(() => ({
    selectedSlicerTargetId,
    ...machineSnapshot,
    ...materialSnapshot,
    objectProcessOverrides,
    processProfileId,
    processProfileSelectionTouched: processProfileSelectionTouchedRef.current,
    processSettingOverrides,
    machineSettingOverrides,
    machineOverridesModel
  }), [selectedSlicerTargetId, machineSnapshot, materialSnapshot, objectProcessOverrides, processProfileId, processSettingOverrides, machineSettingOverrides, machineOverridesModel, processProfileSelectionTouchedRef])
  const restoreConfig = useCallback((snapshot: SliceConfigSnapshot) => {
    setSelectedSlicerTargetId(snapshot.selectedSlicerTargetId)
    restoreMachineSnapshot(snapshot)
    restoreMaterialSnapshot(snapshot)
    setObjectProcessOverrides(snapshot.objectProcessOverrides ?? {})
    if (snapshot.processProfileId != null) setProcessProfileId(snapshot.processProfileId)
    processProfileSelectionTouchedRef.current = snapshot.processProfileSelectionTouched
    setProcessSettingOverrides(snapshot.processSettingOverrides ?? {})
    setMachineSettingOverrides(snapshot.machineSettingOverrides ?? {})
    setMachineOverridesModel(snapshot.machineOverridesModel ?? null)
  }, [processProfileSelectionTouchedRef, restoreMachineSnapshot, restoreMaterialSnapshot, setProcessProfileId, setProcessSettingOverrides, setSelectedSlicerTargetId])

  const selectedSlicerTarget = slicerTargets.find((target) => target.id === selectedSlicerTargetId) ?? null
  const projectIsNewerThanSlicer = isProjectNewerThanSlicer(file.projectVersion, selectedSlicerTarget?.version)
  const [allowNewerProjectFile, setAllowNewerProjectFile] = useState(false)
  const slicerDataReady = Boolean(targetsQuery.data) && !profilesQuery.isLoading && (profilesQuery.data?.length ?? 0) > 0

  const controller: SliceSettingsController = {
    // Supplied by `EditorView`, which holds the archive these are read from: see the note on the
    // library host's controller.
    flushVolumes: null,
    file,
    resourceBasePath: '',
    flow: 'library',
    settingsSearchKey,
    setSettingsSearchKey,
    requiresSinglePlate: false,
    canOpenThreeDimensionalPreview: false,
    isMobileViewport,
    workspaceSlug: undefined,
    navigate: NOOP_NAVIGATE,
    onClose,
    slicerTargets,
    selectedSlicerTargetId,
    setSelectedSlicerTargetId,
    projectVersionWarning: projectIsNewerThanSlicer
      ? {
          projectVersion: file.projectVersion ?? null,
          engineVersion: selectedSlicerTarget?.version ?? null,
          acknowledged: allowNewerProjectFile,
          onAcknowledgedChange: setAllowNewerProjectFile
        }
      : null,
    slicerStatus: {
      capabilitiesLoading: targetsQuery.isLoading,
      hasCapabilities: Boolean(targetsQuery.data),
      capabilitiesError: targetsQuery.isError ? 'Failed to load slicer versions.' : null,
      configured: targetsQuery.data?.configured ?? false,
      slicerRestarting: false,
      slicerDataReady,
      profilesError: profilesQuery.isError ? 'Failed to load slicing presets.' : null
    },
    // Printer surface, inert (no LAN access from a browser). Every renderer of these is hidden.
    printers: [],
    selectedPrinter: null,
    lockedPreferredPrinter: null,
    targetMode: 'manualProfile',
    selectPrinter: () => undefined,
    selectedPrinterModel,
    selectPrinterModel,
    printerModelOptions,
    targetConflicts,
    selectedMachineProfile,
    selectableMachineProfiles,
    selectPrinterProfile,
    nozzleDiameter,
    setNozzleDiameter,
    nozzleDiameterOptions,
    nozzleFlow,
    setNozzleFlow,
    plateType,
    setPlateType: handlePlateTypeChange,
    plateTypeOptions,
    // Plate/objects sections are simple-dialog only; the editor renders its own. Inert here.
    plateMode: 'all',
    setPlateMode: () => undefined,
    sceneEdit: null,
    setSceneEdit: () => undefined,
    plateNumber: '1',
    setPlateNumber: () => undefined,
    slicePlateOptions: bakedIndex.plates,
    setPreviewFileId: () => undefined,
    compatibleProcessProfiles,
    selectedProcessProfile,
    processProfileModified: Object.keys(processSettingOverrides).length > 0,
    setProcessProfileId,
    setProcessSettingOverrides,
    processProfileSelectionTouchedRef,
    selectedSlicerTargetIdForGuards: selectedSlicerTargetId,
    processSettingOverrides,
    machineSettingOverrides,
    setMachineSettingOverrides,
    // Always known here: this host reads the project the tab already parsed, so there is no lookup
    // that could leave the map empty for want of an answer.
    machineSettingOverridesKnown: true,
    machineOverridesModel,
    setMachineOverridesModel,
    setProcessSettingsDialogOpen,
    hasPlateObjects: plateObjects.length > 0,
    selectedSliceObjectIds: new Set(),
    plateObjects,
    onToggleSliceObject: () => undefined,
    openSliceObjectSettings: () => undefined,
    plateGcode: null,
    perObjectSettings: selectedProcessProfile ? {
      slicerTargetId: selectedSlicerTargetId,
      processProfileId: selectedProcessProfile.id,
      sourceFileId: null,
      globalOverrides: processSettingOverrides,
      visibilityContext: { printerModel: selectedPrinterModel },
      value: objectProcessOverrides,
      onChange: setObjectProcessOverrides,
      printSelection: new Set(),
      onTogglePrint: () => undefined
    } : null,
    projectFilaments,
    materialOptions,
    loadedMaterialOptions: [],
    printerTrayMap: new Map(),
    materialToolheadOptions,
    filamentMaterialOptionIds,
    filamentMaterialTypeFilters,
    setFilamentMaterialTypeFilters,
    filamentToolheadIds,
    setFilamentToolheadIds,
    filamentColors,
    setFilamentColors,
    filamentSettingOverridesById,
    openFilamentSettings: setFilamentSettingsFilamentId,
    handleMaterialOptionChange,
    desiredFilaments,
    retargetTarget,
    onAddFilament: handleAddFilament,
    onRemoveFilament: handleRemoveFilament,
    onReorderFilament: handleReorderFilament,
    configSnapshot,
    restoreConfig,
    materialEditListenerRef,
    // The shared core's post-save rebase (a local save renumbers slots exactly like an api one).
    onProjectSaved: handleProjectSaved,
    settingsEditListenerRef,
    // Anonymous baseline resolver for the panel's "changed vs preset" badge (no workspace).
    // Gated on `slicerDataReady`: the resolver reads the LIVE built-in catalogue to find a project
    // preset's standard parent, so firing the badge's resolve query before the catalogue loads
    // resolves against an empty set (no parent match), caches that wrong low count for `staleTime`,
    // and never re-runs (its query key doesn't track catalogue readiness). Withholding it until the
    // catalogue is in hand makes the badge wait, then settle on the correct parent-resolved count.
    // The tune dialogs use the raw `resolveProcessConfig` directly (opened later, always ready).
    resolveConfig: slicerDataReady ? resolveProcessConfig : undefined,
    // Same gating for the per-material "changed vs preset" badge's filament resolver.
    resolveFilamentConfig: slicerDataReady ? resolveFilamentConfig : undefined,
    // Re-read browser storage after the user has been in the preset manager. Same contract as the
    // workspace controller's: only a change the user made THERE reaches the open editor.
    refreshSlicingPresets
  }

  return {
    controller,
    targetPrinterModel: targetPrinterModel ?? undefined,
    resolveProcessConfig,
    resolveFilamentConfig,
    installedFilamentPresets: installedFilamentProfiles,
    processSettingsDialogOpen,
    settingsSearchKey,
    setSettingsSearchKey,
    processFilamentChoices,
    filamentSettingsFilamentId,
    setFilamentSettingsFilamentId,
    setFilamentSettingOverridesById
  }
}
