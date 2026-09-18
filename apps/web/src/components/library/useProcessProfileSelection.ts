/**
 * Which PROCESS preset a project slices with, and how that choice survives a machine change.
 *
 * Lifted out of `SliceFileModal`, which built it inline among ~36 other pieces of state. Two hosts
 * need it now: the slice dialog, and the public 3MF editor, which has no printers or dispatch but
 * still has to pick a process preset. Extracting it means one wiring rather than two that drift.
 *
 * The compatibility and ranking RULES are not here, they live in `lib/slicingPresetMatching.ts` and
 * `lib/slicingPresetSelection.ts` and are only composed by this hook. What this owns is the
 * decision of WHEN to re-pick, which is the part that is easy to get subtly wrong.
 *
 * The re-pick mirrors BambuStudio's machine-switch fallback, in order: the target machine's
 * `default_print_profile` when it shares the previous profile's layer height, else the closest
 * layer-height match by name, else that machine default anyway, else 0.20mm Standard, else whatever
 * is first. A fresh selection with no prior profile deliberately skips the "nearest" step rather
 * than latching onto an arbitrary preset.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { isProjectSlicingPresetId, type SlicingPresetSummary } from '@printstream/shared'
import { dedupeVisibleProcessProfiles, isProcessProfileCompatible } from '../../lib/slicingPresetMatching'
import {
  extractLayerHeightToken,
  pickMostSimilarSlicingPresetByName,
  pickProjectFallbackSlicingPresetByName,
  pickSelectableSlicingPresetByName,
  pickSlicingPresetByDeclaredName,
  pickStandardProcessProfile,
  resolveProfileLayerHeight
} from '../../lib/slicingPresetSelection'

export interface ProcessProfileSelectionInput {
  /** Every process preset in the catalogue, for resolving a selection made under another machine. */
  processProfiles: SlicingPresetSummary[]
  /** Those the current printer allows, before per-machine compatibility narrowing. */
  printerCompatibleProcessProfiles: SlicingPresetSummary[]
  /** The whole summary, not a narrowed shape: the compatibility helpers read more than one field. */
  selectedMachineProfile: SlicingPresetSummary | null
  selectedPrinterModel: string
  selectedNozzleDiameters: number[]
  plateType: string
  /** The process preset name baked into the opened project, when it has one. */
  bakedProcessProfileName: string | null | undefined
  /**
   * The project's GENUINE process deltas versus its own preset baseline (key -> value), resolved
   * once against the project's system baseline and stable across machine changes. When the fallback
   * re-picks a NON-project preset in place of the project's own preset (a machine switch), these are
   * merged into `processSettingOverrides` so the new preset's full overwrite can't silently drop the
   * customizations that only lived in the project's baked config. Null until resolved (then the
   * re-pick simply doesn't carry, matching the old behaviour). The HOST must keep this reference
   * stable, or the re-pick effect re-fires every render.
   */
  carryOverridesOnRepick?: Record<string, string | string[]> | null
  /** False while the destination engine catalogue is loading; partial lists cannot re-pick. */
  catalogueReady?: boolean
  /** Engine identity, so a changed catalogue cannot masquerade as a deliberate machine change. */
  catalogueKey?: string
  /** False until the project's baked deltas are known; do not abandon them while resolving. */
  carryOverridesReady?: boolean
  /**
   * Whether the profile list is COMPLETE: specifically, whether the project's own embedded presets
   * have been merged in yet. Defaults to true for hosts that build the list from one source.
   *
   * Load-bearing, not cosmetic. The library host feeds this hook from TWO independent queries: the
   * slicer catalogue and the 3MF index (fetched in parallel on purpose). When the catalogue wins
   * that race the list is populated but MISSING the `project:` preset, so the re-pick below sees a
   * non-empty list that does not contain the project's own preset and latches a built-in, and it
   * never recovers, because the "prefer the project's own preset" rung is first-pick-only and a
   * selection now exists. That silently swapped a user's custom project preset for a stock one.
   * An EMPTY list was always safe (nothing to pick); a partial one is the dangerous state.
   */
  projectPresetsReady?: boolean
}

export interface ProcessProfileSelection {
  compatibleProcessProfiles: SlicingPresetSummary[]
  /** The selection resolved against the COMPATIBLE list; null when the current pick is not allowed. */
  selectedProcessProfile: SlicingPresetSummary | null
  /** The selection resolved against every profile, so a cross-machine pick is still identifiable. */
  selectedAnyProcessProfile: SlicingPresetSummary | null
  processProfileId: string
  setProcessProfileId: React.Dispatch<React.SetStateAction<string>>
  processSettingOverrides: Record<string, string | string[]>
  setProcessSettingOverrides: React.Dispatch<React.SetStateAction<Record<string, string | string[]>>>
  /** Set once the user picks deliberately, so the fallback stops overriding an empty selection. */
  processProfileSelectionTouchedRef: React.MutableRefObject<boolean>
}

export function useProcessProfileSelection(input: ProcessProfileSelectionInput): ProcessProfileSelection {
  const {
    processProfiles, printerCompatibleProcessProfiles, selectedMachineProfile,
    selectedPrinterModel, selectedNozzleDiameters, plateType, bakedProcessProfileName,
    carryOverridesOnRepick, catalogueKey, catalogueReady = true, carryOverridesReady = true, projectPresetsReady = true
  } = input

  const processProfileSelectionTouchedRef = useRef(false)
  // Deliberately starts EMPTY and lets the effect below make the first pick, one render later.
  // Picking here instead looked equivalent but ran before `projectPresetsReady` could be consulted,
  // so a host whose catalogue had prefetched (the library dialog always has) latched a built-in on
  // mount, and the effect then saw a selection that WAS in the compatible list and returned early,
  // making the swap permanent. An empty id for one render is the price of not guessing.
  const [processProfileId, setProcessProfileId] = useState('')
  const [processSettingOverrides, setProcessSettingOverrides] = useState<Record<string, string | string[]>>({})

  const compatibleProcessProfiles = useMemo(
    () => dedupeVisibleProcessProfiles(
      printerCompatibleProcessProfiles.filter((profile) => isProcessProfileCompatible(profile, selectedMachineProfile, selectedPrinterModel, selectedNozzleDiameters, plateType, processProfiles)),
      selectedMachineProfile,
      selectedPrinterModel
    ),
    [plateType, printerCompatibleProcessProfiles, processProfiles, selectedMachineProfile, selectedPrinterModel, selectedNozzleDiameters]
  )

  const selectedAnyProcessProfile = processProfiles.find((profile) => profile.id === processProfileId) ?? null
  // Narrowed to a primitive so the machine-switch effect depends on the layer height itself rather
  // than on the profile object's identity.
  const selectedProcessLayerHeight = selectedAnyProcessProfile ? resolveProfileLayerHeight(selectedAnyProcessProfile) : null
  const selectedProcessProfile = compatibleProcessProfiles.find((profile) => profile.id === processProfileId) ?? null
  // Narrowed to a primitive for the same reason as the layer height above: the re-pick only needs
  // to know whether there IS a prior selection, and depending on the profile object would re-fire
  // the effect on every catalogue refetch.
  const hasSelectedProcessProfile = selectedAnyProcessProfile != null

  // Version changes may alter availability, but cannot authorize a different process. Only a
  // physical machine/nozzle/plate change invokes the established machine-switch fallback.
  // Two presets for the same physical model may have different process compatibility.
  const machineKey = JSON.stringify([selectedPrinterModel, selectedNozzleDiameters, plateType, selectedMachineProfile?.id])
  const selectionMachineRef = useRef<string | null>(null)
  const selectionCatalogueRef = useRef(catalogueKey)

  useEffect(() => {
    // Never re-pick against a half-built list: see `projectPresetsReady`.
    if (!projectPresetsReady || !catalogueReady) return
    if (selectionCatalogueRef.current !== catalogueKey) {
      selectionCatalogueRef.current = catalogueKey
      // The new engine may temporarily derive a fallback machine too. That is still an engine
      // switch, not permission to replace the process the user selected.
      selectionMachineRef.current = machineKey
    }
    if (processProfileId && compatibleProcessProfiles.some((profile) => profile.id === processProfileId)) {
      selectionMachineRef.current = machineKey
      return
    }
    // Keep an unavailable choice unresolved, so Slice remains blocked and switching back restores
    // it. Replacing the id here made a round trip permanently forget the user's selected preset.
    if (processProfileId && selectionMachineRef.current === machineKey) return
    if (isProjectSlicingPresetId(processProfileId) && !carryOverridesReady) return
    if (!processProfileId && processProfileSelectionTouchedRef.current) return
    const nextId = ((): string | null => {
      const previousName = selectedAnyProcessProfile?.name ?? bakedProcessProfileName ?? null
      // FIRST pick only: the project's OWN embedded preset beats an identically-named installed
      // one, because it carries the 3MF's saved overrides (wall_loops and friends) where the
      // installed preset would collapse them to its defaults: BambuStudio likewise loads a
      // project's embedded settings on open. Deliberately not on a RE-pick: a machine switch drops
      // the project preset from the compatible list on purpose, and re-selecting it would slice an
      // A1-authored process on an H2D. (Before S2 this rung lived in the workspace host's
      // baked-defaults effect, so the public editor never had it.)
      if (!hasSelectedProcessProfile) {
        const bakedPreset = pickProjectFallbackSlicingPresetByName(compatibleProcessProfiles, bakedProcessProfileName)
          ?? pickSelectableSlicingPresetByName(compatibleProcessProfiles, bakedProcessProfileName)
        if (bakedPreset) return bakedPreset.id
      }
      const machineDefaultProfile = pickSlicingPresetByDeclaredName(compatibleProcessProfiles, selectedMachineProfile?.defaultProcessProfile)
      // Read the previous profile's real layer height when we still hold its summary; only a bare
      // baked NAME has to fall back to the name token.
      const previousLayerHeight = selectedProcessLayerHeight ?? extractLayerHeightToken(previousName)
      if (machineDefaultProfile && (!previousLayerHeight || resolveProfileLayerHeight(machineDefaultProfile) === previousLayerHeight)) return machineDefaultProfile.id
      // Only match a "nearest" preset when there is an actual prior profile to match; for a fresh
      // selection (new project, no baked/previous profile) skip it so we do not latch onto an
      // arbitrary preset.
      const nearestProfile = previousName ? pickMostSimilarSlicingPresetByName(compatibleProcessProfiles, previousName) : null
      if (nearestProfile) return nearestProfile.id
      if (machineDefaultProfile) return machineDefaultProfile.id
      // Prefer the 0.20mm Standard preset over whatever happens to be first in the list.
      return (pickStandardProcessProfile(compatibleProcessProfiles) ?? compatibleProcessProfiles[0])?.id ?? null
    })()
    if (!nextId) return
    // When the re-pick abandons the project's OWN preset for a non-project one (the machine-switch
    // case), the new preset overwrites every process key at slice time -- so any customization that
    // lived only in the project's baked config (e.g. wall_loops) would vanish. Materialize the
    // project's genuine deltas as overrides here, UNDER any existing session edits (which already
    // survive on their own): an explicit edit still wins on a shared key, and repeated switches stay
    // idempotent. Switching between builtins carries nothing new because the deltas are already in
    // the map from the first switch.
    if (isProjectSlicingPresetId(processProfileId) && !isProjectSlicingPresetId(nextId) && carryOverridesOnRepick) {
      setProcessSettingOverrides((prev) => ({ ...carryOverridesOnRepick, ...prev }))
    }
    selectionMachineRef.current = machineKey
    setProcessProfileId(nextId)
  }, [catalogueKey, catalogueReady, carryOverridesReady, machineKey, bakedProcessProfileName, carryOverridesOnRepick, compatibleProcessProfiles, hasSelectedProcessProfile, processProfileId, projectPresetsReady, selectedAnyProcessProfile?.name, selectedProcessLayerHeight, selectedMachineProfile?.defaultProcessProfile])

  return {
    compatibleProcessProfiles,
    selectedProcessProfile,
    selectedAnyProcessProfile,
    processProfileId,
    setProcessProfileId,
    processSettingOverrides,
    setProcessSettingOverrides,
    processProfileSelectionTouchedRef
  }
}
