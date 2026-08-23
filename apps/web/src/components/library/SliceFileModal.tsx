/**
 * Slice/prepare dialog extracted from `pages/LibraryView.tsx`.
 *
 * Owns `SliceFileModal`: the slim slicing/print-prep dialog (and, for the
 * library flow on 3MF projects, the direct hand-off to the model studio's full
 * 3D editor via the `slicing.editor` plugin slot). It composes the slice form,
 * engine target, plate scope, per-object overrides, output naming, save
 * destination, the loaded-printer material picker, and feeds it to the shared
 * `SliceSettingsPanel` through a `SliceSettingsController`. The submit payload
 * shape is the shared `SliceFileSubmitInput`.
 *
 * What it does NOT own, and must not take back: the printer/machine/nozzle/plate
 * target (`useMachineTarget`, a derivation over the user's picks), the material
 * slots (`useMaterialSlots`), and the process preset (`useProcessProfileSelection`).
 * Those are the cores the public editor host shares, and a write to any of their
 * values from here would re-create the multi-writer problem they exist to remove:
 * every one of those facts had several writers and no owner, which is what made
 * "who set this value?" unanswerable.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LazyDialogFallback } from '../LazyDialogFallback'
import {
  Box, Button, DialogActions, Stack, Typography
} from '@mui/joy'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import { useQuery } from '@tanstack/react-query'
import type {
  LibraryFile,
  LibraryFolder,
  Printer,
  SceneEdit,
  SceneEditPlateFilamentChanges,
  SceneEditPlatePauses,
  SlicingCapabilities,
  SlicingManualProfileTarget,
  ThreeMfIndex
} from '@printstream/shared'
import { PER_OBJECT_PROCESS_KEYS,
  isProjectNewerThanSlicer,
  isProjectSlicingPresetId
} from '@printstream/shared'
import { useNavigate, useParams } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { deriveProjectCarryOverrides } from '../../lib/processCarryOverrides'
import { permuteFilamentIndexOverrides, permutePerObjectFilamentIndexOverrides, remapFilamentIndexOverrides, remapPerObjectFilamentIndexOverrides } from '../../lib/filamentIndexOverrides'
import { resolveSliceDisabledReason } from '../../lib/slicingPresetSelection'
import {
  buildLoadedPrinterMaterialOptions,
  buildProjectSlicingPresets,
  buildRedundantProjectPresetCandidates,
  buildProcessFilamentChoices,
  buildSliceDialogProjectFilaments,
  buildSliceDialogToolheads,
  buildSliceMaterialOptions,
  isFilamentProfileCompatible,
  isProjectSlicingPreset,
  isVisibleFilamentProfile,
  isVisibleProcessProfile,
  mergeProjectSlicingPresets,
  normalizeSliceFilamentColor,
  type LoadedMaterialSource
} from '../../lib/slicingPresetMatching'
import { useSlotFilamentIdentityLookup } from '../../lib/slotFilamentIdentity'
import { slicingPresetsQueryOptions } from '../../lib/slicingPresetsQuery'
import { useMobileViewport } from '../useMobileViewport'
import { LibraryDestinationDialog } from '../LibraryDestinationDialog'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { RepairProjectSettingsAlert } from './RepairProjectSettingsAlert'
import { ProjectVersionWarningAlert } from './ProjectVersionWarningAlert'
import { PluginSlot } from '../../plugin/PluginSlot'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { useDeepStableValue } from '../../hooks/useDeepStableValue'
import { usePrinterStatuses } from '../../hooks/usePrinterStatuses'
import {
  buildLibraryResourceBasePath,
  buildPrinterTrayMap,
  buildSlicedOutputFileName,
  EMPTY_SLICER_TARGETS,
  EMPTY_SLICING_PRESETS,
  type SliceFileSubmitAction,
  type SliceFileSubmitInput
} from '../../lib/libraryViewHelpers'
import { resolveSlicerTargetId } from '../../lib/machineTargetResolution'
import { useUnchangedProjectFilamentPresetIds } from './useBakedPresetChanges'
import { useMachineTarget } from './useMachineTarget'
import { useMaterialSlots } from './useMaterialSlots'
import { useProcessProfileSelection } from './useProcessProfileSelection'
import { SliceSettingsPanel, type SliceSettingsController, type SliceConfigSnapshot } from './SliceSettingsPanel'
import { SlicingPresetsDialog } from './SlicingPresetsDialog'
import { resolveWorkspaceFilamentConfig } from './workspaceFilamentResolver'
import { resolveWorkspaceProcessConfig } from '../workspaceProcessResolver'
import type { FilamentOption } from './PlateGcodeSections'

const ProcessSettingsDialog = lazy(() => import('../ProcessSettingsDialog'))
const FilamentSettingsDialog = lazy(() => import('./FilamentSettingsDialog'))

/** Stable empty-overrides reference so the per-object dialog's resolve effect doesn't re-fire. */
const EMPTY_OBJECT_OVERRIDES: Record<string, string | string[]> = {}

/**
 * Holds `value` at the first render where it is READY, and keeps serving that until `token` changes.
 *
 * This is the editor's snapshot-at-open rule made concrete for the slicer catalogue. The editor
 * borrows this controller, and the catalogue can refetch underneath it for reasons the user never
 * asked for: staleness, window focus, or a `slicing.profiles` WS invalidation raised by somebody
 * else's edit. A catalogue that changes shape mid-session re-runs the process re-pick, which is how
 * a project's own preset silently became a built-in.
 *
 * Only holds once READY, never before: freezing a half-loaded catalogue is the very failure this is
 * meant to prevent (see `projectPresetsReady` in useProcessProfileSelection). `hold: false` opts a
 * host out entirely, which is what the slim print dialog wants, it has no editor to protect and
 * should track the catalogue live.
 */
function useHeldSnapshot<T>(value: T, { hold, ready, token }: { hold: boolean; ready: boolean; token: number }): T {
  const heldRef = useRef<T | null>(null)
  const tokenRef = useRef(token)
  if (!hold) {
    heldRef.current = null
    return value
  }
  // An explicit refresh (the user edited presets in the manager) drops the snapshot so the next
  // ready value is adopted. Compared during render so the fresh value is served on the same frame.
  if (token !== tokenRef.current) {
    tokenRef.current = token
    heldRef.current = null
  }
  if (heldRef.current === null && ready) heldRef.current = value
  return heldRef.current ?? value
}


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
  capabilities,
  capabilitiesLoading,
  capabilitiesError,
  submitting,
  submitAction,
  submitError,
  flow = 'library',
  preferredPrinterId,
  defaultPlateNumber,
  initialSlicerTargetId,
  flowCopy,
  onBack,
  onClose,
  onSavedAs,
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
  /**
   * Seed the engine-target INTENT (e.g. re-slicing a project with the engine its earlier
   * slice used). Only an initial value: it goes through the same resolution ladder as a
   * user pick, so an engine that is no longer installed falls back rather than sticking.
   */
  initialSlicerTargetId?: string
  /** Override the print-flow title/description/continue-button copy (e.g. for "add to queue"). */
  flowCopy?: { title?: string; description?: string | null; continueLabel?: string }
  /**
   * When provided, the dialog shows a "Back" action that returns to the step it was
   * opened from (e.g. the library file picker in the printers flow), which stays
   * mounted underneath. Without it, only Cancel/Close is offered.
   */
  onBack?: () => void
  onClose: () => void
  /** After a "Save as" in the editor: re-open the editor on the newly-created file (`file.id` changes). */
  onSavedAs?: (file: { id: string; name: string }) => void
  onSubmit: (input: SliceFileSubmitInput, action: SliceFileSubmitAction, options?: { keepDialogOpen?: boolean }) => void
}) {
  const navigate = useNavigate()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
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
  const appliedMaterialDefaultsRef = useRef(false)
  // Mirrors appliedMaterialDefaultsRef as state so the form can wait for the 3MF's material
  // defaults before becoming interactive (avoids showing values that change once the slicer data
  // loads). The machine target needs no such latch, it DERIVES (see useMachineTarget), but
  // materials are path-dependent, so they still seed exactly once.
  const [materialDefaultsApplied, setMaterialDefaultsApplied] = useState(false)
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
  // The engine target: the user's pick while that target still exists, else the shared fallback
  // ladder (which never lands on a prerelease). Derived rather than reconciled by an effect,
  // the same shape as the machine target below, and it retires the third copy of this ladder.
  const [slicerTargetIntent, setSlicerTargetIntent] = useState<string | undefined>(initialSlicerTargetId)
  const selectedSlicerTargetId = resolveSlicerTargetId(slicerTargets, capabilities?.defaultTargetId, slicerTargetIntent)
  // An updater form has to see the RESOLVED id, not the sparse intent (which is undefined until
  // the user picks): same rule as the machine target's setters.
  const selectedSlicerTargetIdRef = useRef(selectedSlicerTargetId)
  selectedSlicerTargetIdRef.current = selectedSlicerTargetId
  const setSelectedSlicerTargetId = useCallback((value: React.SetStateAction<string>) => {
    setSlicerTargetIntent(typeof value === 'function' ? value(selectedSlicerTargetIdRef.current) : value)
  }, [])
  // Reset whenever the chosen engine changes: an acknowledgement is about ONE project/engine pair.
  const [allowNewerProjectFile, setAllowNewerProjectFile] = useState(false)
  useEffect(() => {
    // Scoped to ONE project/engine pair: switching slicer version must re-ask, or an ack given for
    // a 2.7 engine would silently carry over to a different one.
    setAllowNewerProjectFile(false)
  }, [selectedSlicerTargetId, file.id])
  const shouldLoadSlicingPresets = configured && selectedSlicerTargetId.length > 0
  // Shared definition (key, usability check, retry/staleness) so views can PREFETCH the
  // same cache entry before this dialog opens: see `lib/slicingPresetsQuery.ts`.
  const slicingPresetsQuery = useQuery({
    ...slicingPresetsQueryOptions(selectedSlicerTargetId),
    enabled: shouldLoadSlicingPresets
  })
  const liveProfiles = slicingPresetsQuery.data?.profiles ?? EMPTY_SLICING_PRESETS
  // The editor owns the whole surface in the library flow, so it, not the slim dialog, is what
  // the snapshot protects. `flow`/`file.kind` are fixed for a mounted dialog (it is keyed per file).
  const editorOwnsSurface = flow === 'library' && file.kind === '3mf'
  const [profilesSnapshotToken, setProfilesSnapshotToken] = useState(0)
  /** Re-take the catalogue snapshot. The editor calls this after the user edits presets. */
  const refreshSlicingPresets = useCallback(() => { setProfilesSnapshotToken((token) => token + 1) }, [])
  const profiles = useHeldSnapshot(liveProfiles, {
    hold: editorOwnsSurface,
    ready: liveProfiles.length > 0,
    token: profilesSnapshotToken
  })
  // "Should have profiles but don't yet", not merely "the query is actively fetching". The slicer
  // can briefly return an empty list while restarting, so the query throws and retries with backoff;
  // between retries `isLoading` flickers false while `profiles` is still empty. Gating only on
  // `isLoading` let the slice dialog apply, and one-shot lock (`appliedBakedDefaultsRef`), its
  // filament defaults against an empty profile list during that gap, so a project's actual material
  // matched nothing and fell back to the generic machine default ("Bambu PLA Basic") until the dialog
  // was reopened after the profiles query had cached. Treat the whole load+retry window as waiting;
  // excluding the terminal error state preserves the existing error / empty-defaults handling.
  const waitingForSlicingPresets = shouldLoadSlicingPresets && liveProfiles.length === 0 && !slicingPresetsQuery.isError
  // Self-heal the profiles catalogue when the slicer recovers. The profiles query throws + retries
  // (×5) on an empty/restarting response, then settles into an error; previously a slice-progress WS
  // tick (`slicing`) would re-invalidate it and recover once the slicer came back, but that path now
  // only fires on actual profile mutations (`slicing.profiles`) to stop the per-tick refetch spam. So
  // recover here instead: on the slicer's unhealthy→healthy transition, refetch if the catalogue is
  // errored or empty: the editor un-strands itself without the user reopening, and a healthy slicer
  // with profiles already loaded triggers nothing.
  const slicerHealthy = Boolean(capabilities?.healthy)
  const prevSlicerHealthyRef = useRef(slicerHealthy)
  const profilesRefetch = slicingPresetsQuery.refetch
  const profilesIsError = slicingPresetsQuery.isError
  const profilesEmpty = liveProfiles.length === 0
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
    // profile catalogue instead of after it: the plate/object list and per-object UI become
    // available sooner. Applying baked slice defaults still waits for both (see the
    // `appliedBakedDefaultsRef` effect, which gates on `waitingForSlicingPresets`).
    staleTime: 60_000
  })
  // Same snapshot rule as the catalogue above. The index is invalidated by `invalidateLibraryQueries`,
  // which the editor's OWN save calls, and re-reading the file after our own save is precisely what
  // the in-memory-after-open rule forbids (session state is authoritative until the next open).
  // Version restores and library-wide operations invalidate it too, and those are somebody else's
  // activity, which must not reshape a mounted editor either.
  const liveBakedIndex = platesQuery.data ?? null
  const [indexSnapshotToken, setIndexSnapshotToken] = useState(0)
  /**
   * Re-take the index snapshot. The one caller is Repair, which the user runs from the editor's own
   * alert and which rewrites the project's settings, so its result has to come back, while every
   * ambient invalidation above still gets nothing.
   */
  const refreshProjectIndex = useCallback(() => { setIndexSnapshotToken((token) => token + 1) }, [])
  const bakedIndex = useHeldSnapshot(liveBakedIndex, {
    hold: editorOwnsSurface,
    ready: liveBakedIndex != null,
    token: indexSnapshotToken
  })
  const slicePlateOptions = useMemo(() => bakedIndex?.plates ?? [], [bakedIndex])
  const canOpenThreeDimensionalPreview = file.kind === '3mf' && slicePlateOptions.length > 0
  const machineProfiles = useMemo(
    () => mergeProjectSlicingPresets(profiles.filter((profile) => profile.kind === 'machine'), buildProjectSlicingPresets(bakedIndex, 'machine')),
    [bakedIndex, profiles]
  )
  const processProfiles = useMemo(
    () => mergeProjectSlicingPresets(profiles.filter((profile) => profile.kind === 'process' && isVisibleProcessProfile(profile)), buildProjectSlicingPresets(bakedIndex, 'process')),
    [bakedIndex, profiles]
  )
  const installedFilamentProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === 'filament' && isVisibleFilamentProfile(profile)),
    [profiles]
  )
  const projectFilamentProfiles = useMemo(() => buildProjectSlicingPresets(bakedIndex, 'filament'), [bakedIndex])
  // Only worth asking about a project preset that HAS an installed twin to fall back to; one naming
  // a preset this catalogue does not carry must stay, unchanged or not.
  const redundantProjectPresetCandidates = useMemo(
    () => buildRedundantProjectPresetCandidates(projectFilamentProfiles, installedFilamentProfiles, bakedIndex),
    [bakedIndex, installedFilamentProfiles, projectFilamentProfiles]
  )
  const unchangedProjectFilamentPresetIds = useUnchangedProjectFilamentPresetIds({
    slicerTargetId: selectedSlicerTargetId,
    sourceFileId: file.id,
    presets: redundantProjectPresetCandidates
  })
  const filamentProfiles = useMemo(
    () => mergeProjectSlicingPresets(
      installedFilamentProfiles,
      projectFilamentProfiles.filter((profile) => !unchangedProjectFilamentPresetIds.has(profile.id))
    ),
    [installedFilamentProfiles, projectFilamentProfiles, unchangedProjectFilamentPresetIds]
  )
  // The whole printer/machine/nozzle/plate target lives in the shared core, as a DERIVATION over
  // the user's picks (never `printers[0]`, which was a guess that stuck; issue #66). This host only
  // supplies the real-printer context and the two readiness flags: every reconciliation effect that
  // used to live here writes nothing now, because there is nothing to reconcile.
  const machineTarget = useMachineTarget({
    file,
    bakedIndex,
    machineProfiles,
    processProfiles,
    printers,
    lockedPreferredPrinter,
    // Settled, NOT "data arrived": a project whose index fails to load must still reach a usable
    // target rather than waiting on a request that will never succeed.
    projectResolved: platesQuery.isSuccess || platesQuery.isError,
    catalogueResolved: !waitingForSlicingPresets,
    resetToken: selectedSlicerTargetId
  })
  const {
    targetMode, printerId, selectedPrinter, selectPrinter,
    selectedPrinterModel, manualPrinterModel, selectPrinterModel,
    printerModelOptions, printerProfileId, selectedMachineProfile, targetPrinterModel,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, selectedNozzleDiameters,
    nozzleFlow, setNozzleFlow,
    plateType, handlePlateTypeChange, plateTypeOptions,
    compatibleMachineProfiles, printerCompatibleProcessProfiles,
    conflicts: targetConflicts,
    machineSnapshot, restoreMachineSnapshot
  } = machineTarget
  const [processSettingsDialogOpen, setProcessSettingsDialogOpen] = useState(false)
  const [filamentSettingsFilamentId, setFilamentSettingsFilamentId] = useState<number | null>(null)
  const [objectProcessOverrides, setObjectProcessOverrides] = useState<Record<string, Record<string, string | string[]>>>({})
  // The plate object whose restricted per-object settings dialog is open (the inline
  // Objects section's gear), stacked above the slim dialog / editor.
  const [editingSliceObject, setEditingSliceObject] = useState<{ id: number; name: string } | null>(null)
  const [plateMode, setPlateMode] = useState<'all' | 'single'>(() => requiresSinglePlate || defaultPlateNumber != null ? 'single' : 'all')
  const [plateNumber, setPlateNumber] = useState(() => String(defaultPlateNumber ?? 1))
  // Sibling of useMaterialSlots' materialEditListenerRef for global process-setting edits (profile switch + the
  // process-settings dialog's overrides). The editor registers a snapshot-then-dirty handler so
  // those edits light Save and land in undo history. Null in the simple slice path.
  const processEditListenerRef = useRef<(() => void) | null>(null)
  const [saveDestinationOpen, setSaveDestinationOpen] = useState(false)
  const [slicingPresetsOpen, setSlicingPresetsOpen] = useState(false)
  // Slice-time object selection (single-plate only). Tracks the kept objects; defaults to all.
  const [selectedSliceObjectIds, setSelectedSliceObjectIds] = useState<Set<number>>(new Set())
  // Subscribed HERE rather than passed in: statuses arrive several times a second and every
  // observer re-renders on each frame, so the hosts that merely forwarded them were paying a
  // full page render for a dialog that is usually closed. See usePrinterStatuses.
  const printerStatuses = usePrinterStatuses({ ignoreTelemetry: true })
  // Ambient telemetry must not redraw the editor, which borrows this controller. The status object
  // is REPLACED on every MQTT frame, measured at ~1.4/s while an editor sat idle, and three
  // things derive from it (loaded materials, toolheads, the tray map), so a fresh reference here
  // re-rendered the whole 3D editor for a temperature tick. Held stable on the projection this
  // dialog actually reads; a real change (tray swapped, nozzle changed) still flows through.
  const selectedPrinterStatus = printerId ? printerStatuses[printerId] : undefined
  // Resolve the project's OWN process preset against no target, so its system baseline is matched by
  // name regardless of the machine currently selected, and derive the project's genuine deltas. This
  // is what the machine-switch fallback carries onto a builtin so a baked customization (e.g. wall
  // loops) isn't lost when the new preset overwrites every process key. Stable per file, so it does
  // not churn as the target changes.
  const projectProcessProfileId = useMemo(
    () => processProfiles.find((profile) => isProjectSlicingPresetId(profile.id))?.id ?? null,
    [processProfiles]
  )
  const projectProcessResolveQuery = useQuery({
    queryKey: ['slice-project-process-carry', projectProcessProfileId, file.id],
    queryFn: ({ signal }) => resolveWorkspaceProcessConfig(
      { processProfileId: projectProcessProfileId as string, targetId: null, sourceFileId: file.id },
      { signal }
    ),
    enabled: Boolean(projectProcessProfileId && file.id),
    staleTime: Infinity
  })
  const carryOverridesOnRepick = useDeepStableValue(
    useMemo(() => deriveProjectCarryOverrides(projectProcessResolveQuery.data), [projectProcessResolveQuery.data])
  )

  // Process-preset selection + the machine-switch fallback live in their own hook so the public
  // editor gets the identical behaviour without this component's printers and dispatch.
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
    bakedProcessProfileName: bakedIndex?.processProfileName,
    carryOverridesOnRepick,
    // The 3MF index arrives on its own query; until it does the project's own preset is missing
    // from the list, and a re-pick would latch a built-in permanently (see the hook's docs).
    projectPresetsReady: bakedIndex != null || platesQuery.isError,
    resetToken: selectedSlicerTargetId
  })
  const compatibleFilamentProfiles = useMemo(
    // Project filament presets stay available for every target, for the same reason as the
    // process list above.
    () => filamentProfiles.filter((profile) => isFilamentProfileCompatible(profile, selectedMachineProfile, selectedProcessProfile, selectedPrinterModel, selectedNozzleDiameters)),
    [filamentProfiles, selectedMachineProfile, selectedNozzleDiameters, selectedPrinterModel, selectedProcessProfile]
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
  const selectedPlate = !requiresSinglePlate && plateMode === 'all' ? 0 : Number.parseInt(plateNumber, 10)
  const baseProjectFilaments = useMemo(
    () => buildSliceDialogProjectFilaments(file, bakedIndex, selectedPlate),
    [bakedIndex, file, selectedPlate]
  )
  // The print/slice dialog targets one plate, so it lists, validates, and maps only the materials
  // that plate actually uses, a project can carry materials for other plates, and surfacing them
  // all there just invites mis-mapping. `desiredFilaments` still rewrites the full ordered set so
  // other plates are never dropped.
  //
  // The full 3D EDITOR is different: like BambuStudio it must show EVERY project material at all
  // times (you assign materials to parts across plates, and the 3D preview colours objects by
  // their own filament regardless of the active plate). Filtering to the active plate's used set
  // there hides materials and, worse, drops an object's filament from the colour set so it
  // renders black. So only narrow to the plate in the print/slim flow.
  const isFullProjectEditor = flow === 'library' && file.kind === '3mf'
  const visibleFilamentsFilter = useCallback(
    (filament: { usedOnSelectedPlate: boolean }) => filament.usedOnSelectedPlate,
    []
  )
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
  // Declared BEFORE the material core: it feeds the core's nozzle-validity clamp (a stale
  // dual-nozzle assignment on a single-nozzle machine segfaults the slicer).
  const sliceToolheads = buildSliceDialogToolheads(nozzleDiameter, nozzleFlow, targetMode === 'realPrinter' ? selectedPrinterStatus : undefined, selectedPrinterModel)
  const materialSlots = useMaterialSlots({
    file,
    bakedIndex,
    baseProjectFilaments,
    filamentProfiles,
    compatibleFilamentProfiles,
    materialOptions,
    selectedMachineProfile,
    toolheadOptions: sliceToolheads,
    visibleFilamentsFilter: isFullProjectEditor ? undefined : visibleFilamentsFilter,
    onFilamentRemoved: handleFilamentIndexRemap,
    onFilamentReordered: handleFilamentIndexPermute
  })
  const {
    projectFilaments, visibleProjectFilaments,
    filamentMaterialOptionIds,
    filamentColors, setFilamentColors,
    filamentToolheadIds, setFilamentToolheadIds,
    filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentSettingOverridesById, setFilamentSettingOverridesById,
    handleAddFilament, handleRemoveFilament, handleReorderFilament, handleMaterialOptionChange,
    materialEditListenerRef,
    desiredFilaments, filamentMappingResult,
    onProjectSaved: handleProjectSaved,
    applyBakedMaterialDefaults,
    materialSnapshot, restoreMaterialSnapshot
  } = materialSlots
  // The editor's bed override. `targetPrinterModel` normalises an unresolved model to null, so an
  // unknown target simply passes nothing and the editor's scene falls back to the project's own
  // embedded settings: the accurate bed by definition. Previously this had to ask "has the guess
  // been replaced yet?" across three flags; with nothing guessing, null already means "not known".
  const editorTargetPrinterModel = targetPrinterModel ?? undefined
  // Materials still seed ONCE per engine target. Unlike the machine target they are
  // path-dependent, a user's option pick has to survive a catalogue refetch, and the add/remove
  // overlay has no derivation, so this stays a latch rather than becoming a derivation.
  useEffect(() => {
    appliedMaterialDefaultsRef.current = false
    setMaterialDefaultsApplied(false)
  }, [selectedSlicerTargetId])
  useEffect(() => {
    if (!bakedIndex || appliedMaterialDefaultsRef.current || !machineTarget.resolved) return
    // The callback composes the baked seed with the compat reconciliation in one updater, so effect
    // order across the module boundary is not load-bearing (see useMaterialSlots).
    applyBakedMaterialDefaults()
    appliedMaterialDefaultsRef.current = true
    setMaterialDefaultsApplied(true)
  }, [applyBakedMaterialDefaults, bakedIndex, machineTarget.resolved])
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
  // The per-object overrides the FILE already carries, from the parsed index (this dialog never
  // loads the scene). Seeding from them is not cosmetic: the slice-time transform is authoritative
  // per object, so editing one setting against an empty seed used to tell the server the object had
  // only that setting -- silently dropping its other baked values from the slice.
  const bakedObjectOverrides = useMemo(() => {
    const out: Record<string, Record<string, string | string[]>> = {}
    for (const object of plateObjects) {
      if (object.processOverrides && Object.keys(object.processOverrides).length > 0) {
        out[String(object.id)] = { ...object.processOverrides }
      }
    }
    return out
  }, [plateObjects])
  const bakedObjectOverridesKey = useMemo(() => JSON.stringify(bakedObjectOverrides), [bakedObjectOverrides])
  // Keyed on the CONTENT, so a refetch that returns the same overrides does not wipe an edit in
  // progress (the array identity changes on every refetch).
  useEffect(() => {
    const baked = JSON.parse(bakedObjectOverridesKey) as Record<string, Record<string, string | string[]>>
    // MERGE UNDER, never replace. `bakedObjectOverrides` covers the SELECTED PLATE only, so
    // replacing dropped every other plate's entry on each plate switch, and the editor host, which
    // seeds all plates from the scene, then had them silently erased. Existing entries win so a
    // refetch (or a session edit) is never clobbered.
    setObjectProcessOverrides((current) => ({ ...baked, ...current }))
  }, [bakedObjectOverridesKey])
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
  // Send only the objects whose overrides DIFFER from what the file already carries. An object left
  // alone is omitted, so the slice-time transform never touches it (it rewrites only the objects it
  // is given) -- which keeps an ordinary slice byte-for-byte the same as before this seeding. An
  // object the user CLEARED must still be sent, as an empty map, or the clear would not apply;
  // that is why this compares against the baked set rather than filtering out empties.
  const submitObjectProcessOverrides = useMemo(() => {
    const baked = JSON.parse(bakedObjectOverridesKey) as Record<string, Record<string, string | string[]>>
    const entries = Object.entries(objectProcessOverrides)
      .filter(([objectId, overrides]) => JSON.stringify(overrides) !== JSON.stringify(baked[objectId] ?? {}))
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }, [objectProcessOverrides, bakedObjectOverridesKey])
  // Material choices for filament-index process settings + the support-interface recommendation
  // prompt: the shared builder, so this host and the public editor's controller cannot drift
  // (see `buildProcessFilamentChoices` for the field semantics).
  const processFilamentChoices = useMemo(
    () => buildProcessFilamentChoices({ projectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors, bakedIndex, selectedPlate }),
    [projectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors, bakedIndex, selectedPlate]
  )
  // Slice-time layer G-code (filament changes + pauses): session edits keyed by plate
  // index, displayed over the file's baked entries (now part of the plates index). Edits
  // ride the slice request only, nothing persists to the library file. `undefined` per
  // plate means untouched; a present-but-empty list deliberately clears the baked entries.
  const [plateFilamentChangeEdits, setPlateFilamentChangeEdits] = useState<Record<number, Array<{ z: number; filamentId: number }>>>({})
  const [platePauseEdits, setPlatePauseEdits] = useState<Record<number, Array<{ z: number }>>>({})
  const gcodeFilamentOptions = useMemo<FilamentOption[]>(
    () => visibleProjectFilaments.map((filament) => {
      const option = materialOptions.find((entry) => entry.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
      return {
        id: filament.projectFilamentId,
        // Position in the FULL ordered list, not this narrowed one: the dialog only shows the
        // selected plate's materials, and a subset-relative number would disagree with the file.
        number: projectFilaments.findIndex((entry) => entry.projectFilamentId === filament.projectFilamentId) + 1,
        color: normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color ?? '#FFFFFF'),
        label: option?.label ?? filament.label,
        colorName: null
      }
    }),
    [visibleProjectFilaments, projectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors]
  )
  const submitFilamentChanges = useMemo<SceneEditPlateFilamentChanges[] | undefined>(() => {
    const entries = Object.entries(plateFilamentChangeEdits).map(([plateIndex, changes]) => ({
      plateIndex: Number(plateIndex),
      changes: changes.map((change) => ({
        ...change,
        // Sidecar display colour (slicer metadata only): the live palette colour for the material.
        color: normalizeSliceFilamentColor(filamentColors[change.filamentId] ?? '#FFFFFF')
      }))
    }))
    return entries.length > 0 ? entries : undefined
  }, [plateFilamentChangeEdits, filamentColors])
  const submitPauses = useMemo<SceneEditPlatePauses[] | undefined>(() => {
    const entries = Object.entries(platePauseEdits).map(([plateIndex, pauses]) => ({ plateIndex: Number(plateIndex), pauses }))
    return entries.length > 0 ? entries : undefined
  }, [platePauseEdits])
  const materialToolheadOptions = sliceToolheads.length > 1 ? sliceToolheads : []
  // Covers BOTH "nothing chosen" and "the chosen option no longer exists": the
  // latter (e.g. after a printer change rebuilt the AMS options) used to drop the
  // slot from the request silently while this gate still read as satisfied.
  const missingFilamentProfile = filamentMappingResult.unresolved.length > 0
  const missingFilamentToolhead = materialToolheadOptions.length > 0 && visibleProjectFilaments.some((filament) => !filamentToolheadIds[filament.projectFilamentId])
  // Slice-config state is immutably updated, so capturing references gives a valid snapshot
  // the editor's undo/redo can restore (the Sets are copied to arrays + rebuilt). The printer
  // target contributes only the user's PICKS: the rest of it re-derives from them, so a restore
  // cannot land on an inconsistent combination the way it could when values and their "touched"
  // flags were restored separately.
  const configSnapshot = useMemo<SliceConfigSnapshot>(() => ({
    selectedSlicerTargetId,
    ...machineSnapshot,
    ...materialSnapshot,
    objectProcessOverrides,
    processProfileId,
    processProfileSelectionTouched: processProfileSelectionTouchedRef.current,
    processSettingOverrides
  }), [selectedSlicerTargetId, machineSnapshot, materialSnapshot, objectProcessOverrides, processProfileId, processSettingOverrides, processProfileSelectionTouchedRef])
  const restoreConfig = useCallback((snapshot: SliceConfigSnapshot) => {
    setSelectedSlicerTargetId(snapshot.selectedSlicerTargetId)
    restoreMachineSnapshot(snapshot)
    restoreMaterialSnapshot(snapshot)
    setObjectProcessOverrides(snapshot.objectProcessOverrides ?? {})
    // Session-only snapshots always carry these; guard for forward-compat.
    if (snapshot.processProfileId != null) setProcessProfileId(snapshot.processProfileId)
    processProfileSelectionTouchedRef.current = snapshot.processProfileSelectionTouched
    setProcessSettingOverrides(snapshot.processSettingOverrides ?? {})
  }, [processProfileSelectionTouchedRef, restoreMachineSnapshot, restoreMaterialSnapshot, setProcessProfileId, setProcessSettingOverrides, setSelectedSlicerTargetId])
  const suggestedOutputFileName = useMemo(() => {
    if (!requiresSinglePlate && plateMode !== 'single') return buildSlicedOutputFileName(file.name)
    return buildSlicedOutputFileName(file.name, {
      plateName: selectedPlateOption?.name ?? null,
      plateNumber: Number.isInteger(selectedPlate) && selectedPlate > 0 ? selectedPlate : null,
      plateCount: slicePlateOptions.length
    })
  }, [file.name, plateMode, requiresSinglePlate, selectedPlate, selectedPlateOption?.name, slicePlateOptions.length])
  // The configuration form should not become interactive until the slicer capabilities, profiles,
  // and 3MF plate data have loaded and the embedded defaults are seeded, otherwise the user sees
  // values populate and change underneath them.
  const slicerDataReady = configured
    && !waitingForSlicingPresets
    && !slicingPresetsQuery.isLoading
    && !platesQuery.isLoading
    && (!platesQuery.data || materialDefaultsApplied)

  // A SET-but-incompatible profile id must block submission: the reconciliation effects re-pick
  // selections when the target changes, but a submit racing them (or any state they miss) would
  // send a cross-model pairing the slicer hard-rejects: the CLI's "process not compatible with
  // printer" exit, historically surfaced as an opaque mid-slice segfault. Gate on membership in
  // the compatible lists, not just non-emptiness. Only enforced once the slicer data is ready:
  // while profiles/plates are still loading the compatible lists are empty, and flagging the
  // seeded ids against them would misreport "incompatible" for ordinary loading states.
  const printerProfileIncompatible = slicerDataReady
    && printerProfileId.length > 0
    && !compatibleMachineProfiles.some((profile) => profile.id === printerProfileId)
  const processProfileIncompatible = slicerDataReady
    && processProfileId.length > 0
    && selectedProcessProfile == null

  // The project was saved by a NEWER Bambu Studio than the selected engine, which BambuStudio
  // refuses to open at all (exit 232 before anything loads). Unlike the settings-repair notice
  // this DOES gate: no retry or setting can get past the vendor's version check. The user can
  // override it with an explicit acknowledgement, which passes `--allow-newer-file`, the same
  // escape hatch Bambu Studio itself offers behind a warning.
  const selectedSlicerTarget = slicerTargets.find((target) => target.id === selectedSlicerTargetId) ?? null
  const projectIsNewerThanSlicer = isProjectNewerThanSlicer(file.projectVersion, selectedSlicerTarget?.version)
  const blockedByProjectVersion = projectIsNewerThanSlicer && !allowNewerProjectFile

  // ADVISORY ONLY, deliberately does not block slicing. A slice that targets a printer re-authors
  // the machine into the temporary copy handed to the engine (`authorProjectMachineFromProfile`,
  // applied to every slice path), and that write sizes the flush matrix for the target, so these
  // projects usually slice fine without being repaired. Gating them refused work that succeeds.
  // The stored file is still wrong, for a download into Bambu Studio, or a slice that re-authors
  // no machine, so the notice stays and offers the repair; only the user triggers it.
  const needsSettingsRepair = file.needsSettingsRepair === true && !sceneEdit

  const canSubmit = Boolean(configured)
    && selectedSlicerTargetId.length > 0
    && suggestedOutputFileName.trim().length > 0
    && printerProfileId.length > 0
    && processProfileId.length > 0
    && !printerProfileIncompatible
    && !processProfileIncompatible
    && !blockedByProjectVersion
    // A flagged file is repaired deliberately in the editor, never printed through slice-time
    // fix-ups the user never sees. The repair alert above the footer names the remedy.
    && !needsSettingsRepair
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
    || (selectedProcessProfile != null && isProjectSlicingPreset(selectedProcessProfile))

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
    // Slice-time layer G-code edits (per-plate replace semantics; only touched plates are
    // sent). With a sceneEdit the edit carries its own entries, so these are omitted.
    filamentChanges: sceneEdit ? undefined : submitFilamentChanges,
    pauses: sceneEdit ? undefined : submitPauses,
    allowNewerProjectFile: allowNewerProjectFile || undefined,
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
          filamentMappings: filamentMappingResult.mappings
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
          filamentMappings: filamentMappingResult.mappings
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

  // Maps a loaded option's trayId back to its tray so the settings panel's material menu can show
  // how much that tray has left (only for RFID/Bambu spools that report it).
  const printerTrayMap = useMemo(() => buildPrinterTrayMap(selectedPrinterStatus), [selectedPrinterStatus])

  // The machine a save should leave the project defined for. Sent whenever a printer + process are
  // selected, NOT only when the model differs from the project's source. "Same printer" does not
  // mean "fully defined": a project can name `printer_model: H2D` while carrying none of H2D's
  // dual-nozzle topology, and a same-model save used to skip authoring entirely and leave it that
  // way (which is how a project reached the slicer under-defined and failed with exit 206). The
  // SERVER decides whether anything needs authoring, it checks the embedded machine for
  // completeness (`projectHasCompleteMachine`) and no-ops when the project is already complete, so
  // an unchanged printer never rewrites the user's process settings. Always a manualProfile shape;
  // printerModel resolves a real printer's model or the manual selection.
  const retargetTarget: SlicingManualProfileTarget | null = (
    printerProfileId.length > 0
    && processProfileId.length > 0
    && Boolean(targetPrinterModel)
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
        filamentMappings: filamentMappingResult.mappings
      }
    : null

  // The shared settings surface for both the slim dialog and the 3D editor's
  // Settings tab. State stays here (single source of truth); the controller is
  // the bridge. See SliceSettingsController.
  const sliceController: SliceSettingsController = {
    // Purge volumes are project-FILE content edited (and saved) by the editor, which injects this
    // itself from the archive it holds. The prepare-print dialog has no project save to ride, so
    // it offers no button rather than an edit that would silently go nowhere.
    flushVolumes: null,
    file, resourceBasePath, flow, requiresSinglePlate, canOpenThreeDimensionalPreview, isMobileViewport,
    workspaceSlug, navigate, onClose,
    slicerTargets, selectedSlicerTargetId, setSelectedSlicerTargetId,
    projectVersionWarning: projectIsNewerThanSlicer
      ? {
          projectVersion: file.projectVersion ?? null,
          engineVersion: selectedSlicerTarget?.version ?? null,
          acknowledged: allowNewerProjectFile,
          onAcknowledgedChange: setAllowNewerProjectFile
        }
      : null,
    slicerStatus: {
      capabilitiesLoading,
      hasCapabilities: capabilities != null,
      capabilitiesError,
      configured,
      slicerRestarting: Boolean(capabilities?.configured && !capabilities.healthy),
      slicerDataReady,
      profilesError: slicingPresetsQuery.isError
        ? (slicingPresetsQuery.error instanceof Error ? slicingPresetsQuery.error.message : 'Failed to load slicing presets for this version.')
        : null
    },
    // The editor's carve-outs from its snapshot: a preset the user edits in the manager, and a
    // Repair the user runs from the editor's own alert, must both reach the open editor. Explicit,
    // so ambient refetches stay excluded while these still get through.
    refreshSlicingPresets,
    refreshProjectIndex,
    printers, selectedPrinter, lockedPreferredPrinter, targetMode, selectPrinter,
    selectedPrinterModel, selectPrinterModel, printerModelOptions, targetConflicts,
    selectedMachineProfile,
    nozzleDiameter, setNozzleDiameter, nozzleDiameterOptions, nozzleFlow, setNozzleFlow,
    plateType, setPlateType: handlePlateTypeChange, plateTypeOptions,
    plateMode, setPlateMode, sceneEdit, setSceneEdit, plateNumber, setPlateNumber, slicePlateOptions, setPreviewFileId,
    compatibleProcessProfiles, selectedProcessProfile, processProfileModified, setProcessProfileId, setProcessSettingOverrides,
    processProfileSelectionTouchedRef, selectedSlicerTargetIdForGuards: selectedSlicerTargetId, processSettingOverrides, setProcessSettingsDialogOpen,
    hasPlateObjects, selectedSliceObjectIds, plateObjects,
    onToggleSliceObject: toggleSliceObject,
    openSliceObjectSettings: (objectId, name) => setEditingSliceObject({ id: objectId, name }),
    plateGcode: file.kind === '3mf' && selectedPlate > 0 && selectedPlateOption
      ? {
          filamentChanges: plateFilamentChangeEdits[selectedPlate] ?? selectedPlateOption.filamentChanges ?? [],
          pauses: platePauseEdits[selectedPlate] ?? selectedPlateOption.pauses ?? [],
          onFilamentChangesChange: (changes) => setPlateFilamentChangeEdits((current) => ({ ...current, [selectedPlate]: changes })),
          onPausesChange: (pauses) => setPlatePauseEdits((current) => ({ ...current, [selectedPlate]: pauses })),
          filamentOptions: gcodeFilamentOptions
        }
      : null,
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
    projectFilaments: visibleProjectFilaments, materialOptions, loadedMaterialOptions, printerTrayMap, materialToolheadOptions,
    filamentMaterialOptionIds, filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentToolheadIds, setFilamentToolheadIds, filamentColors, setFilamentColors,
    filamentSettingOverridesById, openFilamentSettings: setFilamentSettingsFilamentId,
    handleMaterialOptionChange,
    desiredFilaments, retargetTarget, onAddFilament: handleAddFilament, onRemoveFilament: handleRemoveFilament, onReorderFilament: handleReorderFilament,
    configSnapshot, restoreConfig, materialEditListenerRef, onProjectSaved: handleProjectSaved, processEditListenerRef,
    // The editor resolves each slot's preset at SAVE time from this, so the saved project carries the
    // material's physics and not just its name. Omitting it is not a smaller feature, it silently
    // reverts the save to dropping those values (see `workspaceFilamentResolver.ts`).
    resolveFilamentConfig: resolveWorkspaceFilamentConfig
  }

  // The editor owns geometry; the slice is otherwise valid when printer/process/
  // filament settings are complete. (Plate/object-selection clauses are excluded:
  // the editor expresses plate scope via its own action.)
  const canSliceFromEditor = Boolean(configured)
    && selectedSlicerTargetId.length > 0
    && printerProfileId.length > 0
    && processProfileId.length > 0
    && !printerProfileIncompatible
    && !processProfileIncompatible
    && !blockedByProjectVersion
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
    profilesError: slicingPresetsQuery.isError
      ? (slicingPresetsQuery.error instanceof Error ? slicingPresetsQuery.error.message : 'Slicing presets failed to load.')
      : null,
    slicerDataReady,
    printerProfileId,
    processProfileId,
    printerProfileIncompatible,
    processProfileIncompatible,
    blockedByProjectVersion,
    nozzleDiameterCount: selectedNozzleDiameters.length,
    missingFilamentProfile,
    staleFilamentSelection: filamentMappingResult.unresolved.some((slot) => slot.reason === 'staleSelection'),
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
    // Name the output from the scope actually being sliced: `suggestedOutputFileName`
    // tracks the editor's per-object plate selection (always a single plate), so a
    // whole-project slice (plate 0) would otherwise wrongly get a "Plate 1" suffix.
    const slicedPlate = opts.plate > 0 ? opts.sceneEdit.plates.find((plate) => plate.index === opts.plate) : null
    const outputFileName = buildSlicedOutputFileName(
      file.name,
      opts.plate > 0
        ? { plateName: slicedPlate?.name ?? null, plateNumber: opts.plate, plateCount: opts.sceneEdit.plates.length }
        : undefined
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
    onSavedAs,
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
              {/* Above the slice settings because it describes the project itself, not a setting. */}
              {needsSettingsRepair && <RepairProjectSettingsAlert reasons={file.settingsRepairReasons} />}
              {sliceController.projectVersionWarning && <ProjectVersionWarningAlert {...sliceController.projectVersionWarning} />}
              {/* The panel renders its own slicer availability/loading notices. */}
              {/* Same manager the editor offers. This dialog is inside a workspace, so its
                  presets are the stored ones: the reason the public editor has no button
                  does not apply here, and preparing a print is exactly when someone wants
                  to add or fix a process preset. */}
              <SliceSettingsPanel
                controller={sliceController}
                mode="simple"
                onManagePresets={() => setSlicingPresetsOpen(true)}
                canEditPrinterPreset
                presetSourceStatus={<PluginSlot name="slicing.presets.syncStatus" />}
              />
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
      {/* Top level for the same reason as the settings dialogs below: it has to stack
          above this dialog rather than inside its scrolling body. */}
      <SlicingPresetsDialog open={slicingPresetsOpen} onClose={() => setSlicingPresetsOpen(false)} />
      {/* Per-object + process settings dialogs live at the top level so they stack
          above the editor in editor-only mode (and above the slim dialog otherwise). */}
      {editingSliceObject && selectedProcessProfile && (
        // Restricted per-object settings for one object of the inline Objects list (the
        // panel's gear). Baselined on the global effective config (profile + global
        // overrides) so per-object edits read and reset relative to what the object would
        // otherwise inherit: matching Bambu Studio.
        <Suspense fallback={<LazyDialogFallback label="Opening settings…" />}>
          <ProcessSettingsDialog
            open
            onClose={() => setEditingSliceObject(null)}
            slicerTargetId={selectedSlicerTargetId}
            processProfileId={selectedProcessProfile.id}
            processProfileName={editingSliceObject.name}
            sourceFileId={file.id}
            initialOverrides={objectProcessOverrides[String(editingSliceObject.id)] ?? EMPTY_OBJECT_OVERRIDES}
            visibilityContext={{ printerModel: targetMode === 'manualProfile' ? manualPrinterModel : (selectedPrinter?.model ?? ''), isGlobalConfig: false }}
            allowedKeys={PER_OBJECT_PROCESS_KEYS}
            baseOverlay={processSettingOverrides}
            titlePrefix="Object settings"
            applyScope={editorOnly ? 'project' : 'slice'}
            onApply={(overrides) => {
              setObjectProcessOverrides((current) => {
                const next = { ...current }
                if (Object.keys(overrides).length === 0) delete next[String(editingSliceObject.id)]
                else next[String(editingSliceObject.id)] = overrides
                return next
              })
              setEditingSliceObject(null)
            }}
          />
        </Suspense>
      )}
      {processSettingsDialogOpen && selectedProcessProfile && (
        <Suspense fallback={<LazyDialogFallback label="Opening settings…" />}>
          <ProcessSettingsDialog
            open={processSettingsDialogOpen}
            onClose={() => setProcessSettingsDialogOpen(false)}
            slicerTargetId={selectedSlicerTargetId}
            processProfileId={selectedProcessProfile.id}
            processProfileName={selectedProcessProfile.name}
            sourceFileId={file.id}
            initialOverrides={processSettingOverrides}
            visibilityContext={{ printerModel: targetMode === 'manualProfile' ? manualPrinterModel : (selectedPrinter?.model ?? '') }}
            profileOptions={compatibleProcessProfiles}
            filamentChoices={processFilamentChoices}
            applyScope={editorOnly ? 'project' : 'slice'}
            // Same rule the material dialog next door uses: the workspace's own preset can be
            // updated in place, a built-in or a project-embedded one can only be saved as new.
            canEditOriginal={!selectedProcessProfile.id.startsWith('builtin:') && !selectedProcessProfile.id.startsWith('project:')}
            onProfileChange={(profileId, carryOverrides) => {
              // Snapshot pre-edit state for the editor's undo/dirty (no-op in the simple slice path).
              processEditListenerRef.current?.()
              processProfileSelectionTouchedRef.current = true
              setProcessProfileId(profileId)
              setProcessSettingOverrides(carryOverrides)
            }}
            onApply={(overrides) => {
              processEditListenerRef.current?.()
              setProcessSettingOverrides(overrides)
            }}
          />
        </Suspense>
      )}
      {filamentSettingsFilamentId != null && (() => {
        const option = materialOptions.find((entry) => entry.id === filamentMaterialOptionIds[filamentSettingsFilamentId])
        // Resolve the material's slicing-profile id (see the tune button in SliceSettingsPanel).
        const profileId = option?.profileId
          ?? (option?.id.startsWith('profile:') ? option.id.slice('profile:'.length) : null)
        if (!profileId) return null
        // Bambu system presets are read-only; only a workspace custom preset can be updated in place.
        const canEditOriginal = !profileId.startsWith('builtin:') && !profileId.startsWith('project:')
        return (
          <Suspense fallback={<LazyDialogFallback label="Opening settings…" />}>
            <FilamentSettingsDialog
              open
              onClose={() => setFilamentSettingsFilamentId(null)}
              slicerTargetId={selectedSlicerTargetId}
              filamentProfileId={profileId}
              filamentProfileName={option?.presetLabel ?? option?.material ?? option?.label ?? `Material ${filamentSettingsFilamentId}`}
              filamentPresetFullName={option?.profileId ? option.material : null}
              sourceFileId={file.id}
              projectFilamentId={filamentSettingsFilamentId}
              initialOverrides={filamentSettingOverridesById[filamentSettingsFilamentId] ?? {}}
              canEditOriginal={canEditOriginal}
              applyScope={editorOnly ? 'project' : 'slice'}
              onApply={(overrides) => {
                materialEditListenerRef.current?.()
                setFilamentSettingOverridesById((prev) => {
                  const next = { ...prev }
                  if (Object.keys(overrides).length === 0) delete next[filamentSettingsFilamentId]
                  else next[filamentSettingsFilamentId] = overrides
                  return next
                })
              }}
            />
          </Suspense>
        )
      })()}
      {saveActionVisible && saveDestinationOpen && (
        <LibraryDestinationDialog
          title="Save sliced file"
          description="Choose where to save the sliced file, then confirm the file name. Saving with an existing file's name replaces it."
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
    </>
  )
}
