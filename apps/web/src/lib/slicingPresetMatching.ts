/**
 * Pure slice-dialog profile/material matching helpers, extracted from `LibraryView`.
 *
 * Owns the BambuStudio-mirroring compatibility logic that drives the slice and
 * print dialogs: slicing-profile sorting/visibility, machine/process/filament
 * profile compatibility matching, printer-model and nozzle-diameter token
 * matching, plate-type and material-type ordering, loaded-material option
 * building, and filament colour/mapping normalization.
 *
 * Everything here is a side-effect-free data transform over `SlicingPresetSummary`,
 * `ThreeMfIndex`, `LibraryFile`, and printer status/spool data, no React, no
 * component state. The text/token matchers intentionally mirror BambuStudio's
 * permissive profile-family behavior; prefer the explicit profile metadata and
 * fall back to normalized name/condition matching only as those functions document.
 */
import type {
  LibraryFile,
  Printer,
  PrinterNozzleFlow,
  PrinterStatus,
  SlicingPresetSummary,
  ThreeMfIndex,
  ThreeMfPlate
} from '@printstream/shared'
import {
  amsTrayIndex,
  buildProjectSlicingPresetId,
  effectiveAmsNozzleId,
  formatNozzleLabel,
  getPrinterControlCapabilities,
  isProjectSlicingPresetId,
  normalizeFilamentVendorLabel,
  printerModelSchema,
  resolveDisplayFilamentType
} from '@printstream/shared'
import {
  canonicalBambuModelKey,
  normalizeBambuStudioPrinterModelOption
} from './bambuPrinterModels'
import {
  compactProfileText,
  declaresIncompatiblePrinterModel,
  extractNozzleDiameterTokens,
  extractProfilePrinterTargets,
  matchesCompatiblePrinters,
  matchesNozzleDiameters,
  matchesProfileNozzleTarget,
  statesADifferentNozzle,
  nozzleDiameterToken,
  resolveMachineProfileNozzleDiameters,
  normalizedProfileText,
  printerModelCompatibleTextCandidates,
  printerModelTextCandidates,
  matchesProfilePrinterTarget,
  profileTargetMatchesSelectedPrinter,
  profileTextCandidates,
  selectedPrinterCompatibilityTargets,
  textCandidatesMatch,
  tokenBoundaryIncludes
} from './profilePrinterCompatibility'
// Re-exported so this module's public surface is unchanged by the extraction; the definitions
// live in profilePrinterCompatibility so filamentPresetResolver can import them without a cycle.
export {
  compactProfileText,
  declaresIncompatiblePrinterModel,
  extractNozzleDiameterTokens,
  extractProfilePrinterTargets,
  matchesCompatiblePrinters,
  matchesNozzleDiameters,
  matchesProfileNozzleTarget,
  statesADifferentNozzle,
  nozzleDiameterToken,
  resolveMachineProfileNozzleDiameters,
  normalizedProfileText,
  printerModelCompatibleTextCandidates,
  printerModelTextCandidates,
  matchesProfilePrinterTarget,
  profileTargetMatchesSelectedPrinter,
  profileTextCandidates,
  selectedPrinterCompatibilityTargets,
  tokenBoundaryIncludes
}
import { resolveFilamentIdentity } from './filamentColor'
import type { SettingFilamentChoice } from '../components/settings/SettingValueField'
import type { SlotFilamentIdentityLookup } from './slotFilamentIdentity'
import { resolveFilamentPreset, resolveProjectFilamentPreset } from './filamentPresetResolver'
import { formatSlicingPresetBrandedName, formatSlicingPresetDisplayName, slicingPresetAlias } from './slicingPresetSelection'
import { amsUnitLetter } from './printerTrayMapping'

/**
 * Whether a `/api/slicing/profiles` response is complete enough to drive the
 * slice dialog, i.e. it carries at least one **builtin** preset.
 *
 * The slicer can answer while it is restarting or still indexing its bundled
 * `*_full/` system-preset dirs, returning only the workspace's custom profiles
 * (or nothing). BambuStudio always ships builtin machine/process/filament
 * presets, so a builtin-less response is never legitimate, it means the slicer
 * replied early. Caching that partial result strands the editor on a custom-only
 * catalogue: no builtin machine profile to auto-pick (Slice silently disabled),
 * and every loaded/AMS material collapses to the nearest custom filament (e.g.
 * PETG slots all mislabel as "PLA Basic") because the real "@BBL <model>" presets
 * the matcher scores against are absent. Callers should treat `false` as a
 * transient failure and retry rather than cache the response.
 */
export function slicingPresetsResponseIsUsable(profiles: SlicingPresetSummary[] | null | undefined): boolean {
  return Boolean(profiles?.some((profile) => profile.source === 'builtin'))
}

export function sortSlicingPresets(profiles: SlicingPresetSummary[]): SlicingPresetSummary[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...profiles].sort((left, right) => {
    if (isProjectSlicingPreset(left) !== isProjectSlicingPreset(right)) return isProjectSlicingPreset(left) ? -1 : 1
    if (left.source !== right.source) return left.source === 'custom' ? -1 : 1
    return collator.compare(left.name, right.name)
  })
}

export function buildProjectSlicingPresets(bakedIndex: ThreeMfIndex | null, kind: SlicingPresetSummary['kind']): SlicingPresetSummary[] {
  if (!bakedIndex) return []
  if (kind === 'machine') return buildProjectSlicingPresetList(kind, bakedIndex.printerProfileName ? [bakedIndex.printerProfileName] : [])
  // The process preset carries its LINEAGE. A project preset declares no compatibility of its own,
  // so without the parent the only evidence about which machine it was authored for is its own
  // name, and a name like "0.20mm Speed - Tablet Mount" states nothing. The engine has no such
  // blind spot: it judges the project's process by this parent (see `processProfileInherits`), so
  // carrying it is what lets the picker below reach the same verdict before the slice does.
  if (kind === 'process') {
    return buildProjectSlicingPresetList(kind, bakedIndex.processProfileName
      ? [{ name: bakedIndex.processProfileName, derivedFrom: bakedIndex.processProfileInherits }]
      : [])
  }
  const byName = new Map<string, SlicingPresetSummary>()
  for (const filament of bakedIndex.projectFilaments) {
    // The RAW `filament_settings_id`, not the display name beside it. That one is
    // lossy in a way that destroys identity: it strips `@BBL...`, so a built-in
    // ("Bambu PLA Basic @BBL H2D") and a preset inheriting it ("... - 55 degree
    // plate") both collapse to "Bambu PLA Basic". Two consequences, both bugs:
    // the slots COLLAPSE INTO ONE preset here, and the resolver -- which looks a
    // project preset up by the raw name -- never matches, so the project's own
    // preset loses and an uninstalled one falls through to the machine default.
    // Display code strips the suffix at render time; identity keeps it.
    const name = (filament.filamentPresetName ?? filament.filamentName)?.trim()
    if (!name || byName.has(name)) continue
    byName.set(name, {
      id: buildProjectSlicingPresetId(kind, name),
      source: 'custom' as const,
      kind,
      name,
      filamentType: filament.filamentType ?? undefined,
      // The 3MF records `filament_vendor` per slot, so a project preset brands itself the same way
      // its installed twin does. Without it the two disagree for any vendor whose name is not the
      // first word of the preset ("Polymaker PolyLite PLA" vs "PolyLite PLA"), which is enough to
      // stop a comparison matching a preset against ITSELF. Undefined when the 3MF (or a bridge on
      // an older parser) recorded none, which brands from the name as before.
      filamentVendor: filament.filamentVendor ?? undefined,
      // The 3MF records `filament_is_support` per slot, so a project's support
      // material carries its flag rather than relying on its name reading as one.
      filamentIsSupport: filament.isSupport ?? undefined,
      updatedAt: null
    })
  }
  return [...byName.values()]
}

export function buildProjectSlicingPresetList(
  kind: SlicingPresetSummary['kind'],
  /**
   * Each preset the project names, paired with the system preset IT was derived from. Per name
   * rather than one parent for the list: a lineage is evidence about which printer a preset was
   * authored for, and `isProcessProfileCompatible` treats it as authoritative, so stamping one
   * entry's parent onto its neighbours would refuse (or admit) presets on somebody else's record.
   * Today only the single-element process call carries one, but the machine call already passes a
   * list through here.
   */
  entries: ReadonlyArray<string | { name: string; derivedFrom?: string | null }>
): SlicingPresetSummary[] {
  const byName = new Map<string, string | null>()
  for (const entry of entries) {
    const name = (typeof entry === 'string' ? entry : entry.name).trim()
    if (!name || byName.has(name)) continue
    const derivedFrom = typeof entry === 'string' ? null : entry.derivedFrom?.trim() ?? null
    byName.set(name, derivedFrom && derivedFrom !== name ? derivedFrom : null)
  }
  return [...byName].map(([name, derivedFrom]) => ({
    id: buildProjectSlicingPresetId(kind, name),
    source: 'custom' as const,
    kind,
    name,
    ...(derivedFrom ? { derivedFromPresetName: derivedFrom } : {}),
    updatedAt: null
  }))
}

export function mergeProjectSlicingPresets(installedProfiles: SlicingPresetSummary[], projectProfiles: SlicingPresetSummary[]): SlicingPresetSummary[] {
  return sortSlicingPresets([
    ...projectProfiles,
    ...installedProfiles
  ])
}

/**
 * Project presets worth asking "is this actually different?" about, paired with the slot to ask on.
 *
 * Only presets that NAME an installed preset qualify: one naming something this catalogue does not
 * carry has nothing to fall back to, so it must stay whatever the answer would be. The slot is the
 * FIRST filament naming that preset, matching how `buildProjectSlicingPresets` dedupes by name.
 */
export function buildRedundantProjectPresetCandidates(
  projectProfiles: SlicingPresetSummary[],
  installedProfiles: SlicingPresetSummary[],
  bakedIndex: ThreeMfIndex | null
): Array<{ filamentProfileId: string; projectFilamentId: number }> {
  if (!bakedIndex) return []
  // RAW name first, because that is what BambuStudio binds on
  // (`find_preset_internal(original_name)`, an exact lookup with no branding applied) and a 3MF's
  // `filament_settings_id` is the full name with its machine suffix ("PolyLite PLA @BBL H2D").
  //
  // BambuStudio's alias stays as a WIDENING, for the slots that carry only the display name
  // ("Bambu PETG HF" against a catalogue "Bambu PETG HF @BBL H2D 0.4 nozzle"). It is
  // `slicingPresetAlias`, derived from the name alone, and NOT either display formatter: those
  // consult `filamentVendor`, which an installed preset declares and a project preset minted from
  // the 3MF does not, so they brand the same preset differently on the two sides. Never nominated
  // meant never checked, so a third-party project preset stayed in the catalogue and shadowed its
  // installed twin under the same label, carrying the `profileId: null` that the filament-physics
  // repair resolves through: the defect blocked its own repair.
  //
  // Neither test may be mistaken for how a slot BINDS to a preset. The question here is only "is
  // there an installed twin worth diffing against"; two presets can share an alias and differ only
  // past the `@`, which is why the raw test is the precise one and the alias merely widens it.
  const alias = (profile: SlicingPresetSummary) => normalizedProfileText(slicingPresetAlias(profile))
  const rawName = (profile: SlicingPresetSummary) => normalizedProfileText(profile.name)
  const installedAliases = new Set(installedProfiles.map(alias))
  const installedRawNames = new Set(installedProfiles.map(rawName))
  const candidates: Array<{ filamentProfileId: string; projectFilamentId: number }> = []
  for (const profile of projectProfiles) {
    if (!installedRawNames.has(rawName(profile)) && !installedAliases.has(alias(profile))) continue
    // Raw to raw: the profile carries the slot's `filament_settings_id` verbatim.
    const slot = bakedIndex.projectFilaments.find(
      (filament) => ((filament.filamentPresetName ?? filament.filamentName) ?? '').trim() === profile.name
    )
    if (slot) candidates.push({ filamentProfileId: profile.id, projectFilamentId: slot.id })
  }
  return candidates
}

export function isProjectSlicingPreset(profile: SlicingPresetSummary): boolean {
  return isProjectSlicingPresetId(profile.id)
}

export function isVisibleProcessProfile(profile: SlicingPresetSummary): boolean {
  const normalizedName = normalizedProfileText(profile.name)
  return !normalizedName.startsWith('fdm process')
}

export function isVisibleFilamentProfile(profile: SlicingPresetSummary): boolean {
  // Defensive client-side mirror of the slicer ingestion rule. During dev/HMR
  // or while an older slicer container is still running, helper JSON resources
  // can still appear in `/profiles`; BambuStudio does not show these as presets.
  return !isInternalBambuStudioResourceName(profile.name)
}

export function isInternalBambuStudioResourceName(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\\/]+/g, '_').replace(/\s+/g, '_')
  return normalized.startsWith('fdm_')
    || normalized.startsWith('filament_')
    || normalized.startsWith('filaments_')
    || normalized.includes('recommended_params')
}

export type SliceMaterialOption = {
  id: string
  label: string
  group: string
  materialType: string
  brand: string
  profileId: string | null
  material: string | null
  color: string | null
  colors: string[]
  source: 'ams' | 'externalSpool' | 'manual'
  trayId: number | null
  nozzleId: number | null
  toolheadId: string | null
  metadata: string
  /**
   * Short AMS/external slot badge (e.g. `A1`, `B2`, `Ext-L`) for loaded-material
   * options, matching the swatch labels in the print dialog. `null` for manual
   * profile options, which aren't tied to a physical slot.
   */
  slotLabel: string | null
  /**
   * Display name of the slicing preset actually behind this option ("Generic PLA"),
   * for loaded options whose label names the FILAMENT (e.g. a tracked spool) rather
   * than the preset. `null` when no preset resolved.
   */
  presetLabel: string | null
  /** Canonical colour name of the loaded filament ("White", "Jade White"). */
  colorName: string | null
  /**
   * Remaining quantity from the TRACKED spool (filament-manager): covers non-RFID
   * custom spools the printer cannot estimate. Null when untracked; callers may
   * fall back to the RFID tray estimate.
   */
  remainingGrams: number | null
  remainPercent: number | null
}

export function pickMachineProfileForPrinter(profiles: SlicingPresetSummary[], printer?: Printer | null): SlicingPresetSummary | null {
  if (!printer) return null
  return pickMachineProfileByName(profiles, printer.name, printer.model)
}

export function pickMachineProfileByName(profiles: SlicingPresetSummary[], name: string | null | undefined, model: string): SlicingPresetSummary | null {
  const normalizedModel = normalizedProfileText(model)
  const normalizedName = normalizedProfileText(name ?? '')
  return profiles.find((profile) => normalizedProfileText(profile.name).includes(normalizedModel))
    ?? profiles.find((profile) => normalizedName && (normalizedName.includes(normalizedProfileText(profile.name)) || normalizedProfileText(profile.name).includes(normalizedName)))
    ?? null
}

export function isMachineProfileCompatible(profile: SlicingPresetSummary, model: string, nozzleDiameters: number[]): boolean {
  if (isProjectSlicingPreset(profile)) return true
  return matchesPrinterModel(profile, model) && matchesProfileNozzleTarget(profile, null, nozzleDiameters)
}

export function isProcessProfileCompatible(
  profile: SlicingPresetSummary,
  selectedMachineProfile: SlicingPresetSummary | null,
  model: string,
  nozzleDiameters: number[],
  plateType: string,
  /**
   * The installed catalogue, used ONLY to resolve a project preset's parent. Optional because the
   * name rules below are a complete answer without it; supplying it upgrades a project preset from
   * name-guessing to the parent's real declarations, which is what the engine reads.
   */
  installedProfiles?: readonly SlicingPresetSummary[]
): boolean {
  // A project's own process preset is normally the basis for that project and stays available
  // whatever else is selected. The exception is a genuine MACHINE change: process values like
  // speed, acceleration, and cooling are machine-tuned, which is why BambuStudio ships
  // "@BBL A1" and "@BBL H2D" variants of one preset name. Retargeting rewrites machine-owned
  // keys only, so keeping an A1-authored process on an H2D would slice it with A1 values.
  //
  // Narrow on purpose: only positively identifying a DIFFERENT machine in the preset's name drops
  // it. A project preset that names no machine stays compatible, so a custom or hand-named preset
  // is never silently discarded.
  // A project preset carries only a NAME, so every declared axis below has no evidence and passes.
  // The name is still evidence: it usually states both the machine and the nozzle it was authored
  // for, and a process tuned for a 0.2 nozzle is not a process for 0.8. Both halves stay positive
  // identification only, so a hand-named preset that states neither is never discarded.
  //
  // Its PARENT is the third piece of evidence, and the decisive one, because a preset the user
  // renamed states nothing while its parent still names the machine it came from ("0.20mm Speed -
  // Tablet Mount" inheriting "0.20mm Strength @BBL P1P"). The engine judges the project's process
  // by exactly that parent, so a preset we call compatible here on a machine the parent excludes is
  // one the slice will refuse (exit 239) after the user has picked everything else. Prod, 7 Sep
  // 2026: a P1P project retargeted to an X2D kept its own process, this gate saw a name stating no
  // machine, and eighteen consecutive slices failed on a preset the picker never offered to change.
  if (isProjectSlicingPreset(profile)) {
    if (namesADifferentPrinterModel(profile, model) || statesADifferentNozzle(profile, nozzleDiameters)) return false
    const parent = resolveProjectPresetParent(profile, installedProfiles)
    // With the parent IN HAND, judge its real declarations rather than its name. This is the axis a
    // name cannot cover: `compatible_printers` is nozzle-specific ("0.20mm Strength @BBL P1P" lists
    // only `Bambu Lab P1P 0.4 nozzle`) while the name says nothing about a nozzle at all, so a
    // 0.4 -> 0.6 switch on the same model passed every name rule and still failed the slice.
    // Deliberately not `matchesPlateType`: the plate type is the PROJECT's, not something inherited,
    // and it is not part of the engine's process-vs-printer decision either.
    if (parent) {
      // The ENGINE's rule, not the permissive one used for an ordinary preset: a literal
      // `compatible_printers` containment of the machine PRESET name
      // (`BambuStudio.cpp:2937-2941`). It has to be the engine's, because the save's own fallback
      // (`processPresetFitsMachine`) tests exactly this, and a picker that answered more loosely
      // would offer a preset the save then silently replaced -- discarding the project's tuned
      // process values with no UI signal, which is the "refused by a check the dialog did not show"
      // shape one level over. It is also the axis a name cannot reach: the list is nozzle-specific
      // ("0.20mm Strength @BBL P1P" names only `Bambu Lab P1P 0.4 nozzle`) while the name says
      // nothing about a nozzle, so a 0.4 -> 0.6 switch passed every name rule and still failed.
      // Deliberately not `matchesPlateType`: the plate type is the PROJECT's, not something
      // inherited, and it is not part of the engine's process-vs-printer decision either.
      if (selectedMachineProfile) return declaredCompatiblePrintersAccept(parent, selectedMachineProfile.name)
      // No machine preset resolved yet: nothing to compare against, so fall through to the
      // permissive axes rather than refusing on absent evidence.
      return matchesCompatiblePrinters(parent, selectedMachineProfile, model)
        && matchesProfilePrinterTarget(parent, selectedMachineProfile, model)
        && matchesProfileNozzleTarget(parent, selectedMachineProfile, nozzleDiameters)
    }
    return !derivedFromADifferentPrinterModel(profile, model)
  }
  return matchesCompatiblePrinters(profile, selectedMachineProfile, model)
    && matchesProfilePrinterTarget(profile, selectedMachineProfile, model)
    && matchesProfileNozzleTarget(profile, selectedMachineProfile, nozzleDiameters)
    && matchesPlateType(profile, plateType)
}

export function isFilamentProfileCompatible(
  profile: SlicingPresetSummary,
  selectedMachineProfile: SlicingPresetSummary | null,
  selectedProcessProfile: SlicingPresetSummary | null,
  model: string,
  nozzleDiameters: number[]
): boolean {
  if (isProjectSlicingPreset(profile)) return true
  return matchesCompatiblePrinters(profile, selectedMachineProfile, model)
    // Reads the RAW declared models, unlike `matchesProfilePrinterTarget` below, whose targets are
    // alias-EXPANDED: "Bambu Lab A1 mini" expands into A1's own alias family, so an A1-mini preset
    // satisfied an A1 machine. `matchesCompatiblePrinters` already guards its own axis by model
    // key; this is the same guard for the `printer_model` axis, which had none.
    && !declaresIncompatiblePrinterModel(profile, selectedMachineProfile, model)
    && matchesProfilePrinterTarget(profile, selectedMachineProfile, model)
    && matchesProfileNozzleTarget(profile, selectedMachineProfile, nozzleDiameters)
    && matchesCompatiblePrints(profile, selectedProcessProfile)
}

/**
 * True only when the preset's own name identifies a printer model AND that model differs from the
 * one selected. An unnamed or unrecognised machine answers false: absence of evidence must not
 * read as a mismatch.
 */
export function namesADifferentPrinterModel(profile: SlicingPresetSummary, model: string): boolean {
  const selected = normalizeSliceDialogPrinterModel(model)
  if (!selected) return false
  const authored = normalizeSliceDialogPrinterModel(profile.name)
  return authored != null && authored !== selected
}

/**
 * BambuStudio's own compatibility test, over a preset SUMMARY: does its declared
 * `compatible_printers` literally name this machine preset?
 *
 * The web-side twin of `processPresetFitsMachine` (`@printstream/shared/machine-retarget`), which
 * the SAVE applies, and deliberately the same string comparison the engine makes rather than the
 * alias-expanded text matching {@link matchesCompatiblePrinters} does for an ordinary preset. The
 * two must agree or a save silently undoes what the picker allowed. Declaring nothing fits
 * everything, the same absence-is-not-a-mismatch carve-out both of those follow.
 */
export function declaredCompatiblePrintersAccept(
  profile: SlicingPresetSummary,
  machinePresetName: string | null | undefined
): boolean {
  const declared = (profile.compatiblePrinters ?? []).map((entry) => entry.trim()).filter(Boolean)
  if (declared.length === 0 || !machinePresetName) return true
  return declared.includes(machinePresetName.trim())
}

/**
 * The INSTALLED preset a profile names as its parent, by exact name, or null.
 *
 * Exact-name, because that is how BambuStudio binds a preset to its base (`PresetCollection::
 * find_preset`); a fuzzy match here would silently judge a project against a preset it does not
 * inherit from. A parent that is not installed is unknown rather than wrong, and the caller falls
 * back to reading its name.
 */
export function resolveProjectPresetParent(
  profile: SlicingPresetSummary,
  installedProfiles: readonly SlicingPresetSummary[] | undefined
): SlicingPresetSummary | null {
  const parentName = profile.derivedFromPresetName?.trim()
  if (!parentName || !installedProfiles) return null
  return installedProfiles.find((candidate) =>
    candidate.kind === profile.kind
    && !isProjectSlicingPreset(candidate)
    && candidate.name.trim() === parentName) ?? null
}

/**
 * Whether the preset the profile was DERIVED from positively identifies another printer model.
 *
 * The same positive-identification rule as {@link namesADifferentPrinterModel}, applied one link up
 * the chain, and it exists because that is the link the engine reads: BambuStudio resolves a
 * project's process compatibility from `inherits_group[0]`, never from the leaf's own name. A user
 * who renames a derived preset therefore erases the only signal the leaf carries while leaving the
 * authoritative one intact.
 *
 * A profile with no recorded parent, or a parent naming no model, answers false: absence of
 * evidence is not a mismatch, exactly as the leaf-name rule treats a preset that names no machine.
 */
export function derivedFromADifferentPrinterModel(profile: SlicingPresetSummary, model: string): boolean {
  const selected = normalizeSliceDialogPrinterModel(model)
  if (!selected || !profile.derivedFromPresetName) return false
  const authored = normalizeSliceDialogPrinterModel(profile.derivedFromPresetName)
  return authored != null && authored !== selected
}

export function matchesPrinterModel(profile: SlicingPresetSummary, model: string): boolean {
  const modelCandidates = [...(profile.printerModels ?? []), ...(profile.compatiblePrinters ?? []), profile.name]
  if (model === 'unknown' || modelCandidates.length === 0) return true
  const selectedModels = printerModelTextCandidates(model)
  return modelCandidates.some((candidate) => {
    const candidateModels = profileTextCandidates(candidate)
    return candidateModels.some((candidateModel) => selectedModels.some((selectedModel) => textCandidatesMatch(candidateModel, selectedModel)))
  })
}

export function resolveSliceDialogSourcePrinterModel(bakedIndex: ThreeMfIndex | null, fallbackModels: readonly string[]): string | null {
  return normalizeSliceDialogPrinterModel(bakedIndex?.printerProfileName)
    ?? normalizeSliceDialogPrinterModel(bakedIndex?.compatiblePrinterModels[0])
    ?? normalizeSliceDialogPrinterModel(fallbackModels[0])
}

export function resolveSliceDialogTargetPrinterModel(selectedPrinterModel: string, selectedMachineProfile: SlicingPresetSummary | null): string | null {
  return normalizeSliceDialogPrinterModel(selectedPrinterModel)
    ?? normalizeSliceDialogPrinterModel(selectedMachineProfile?.name)
}

export function normalizeSliceDialogPrinterModel(value: unknown): string | null {
  return canonicalBambuModelKey(value)
}

export function formatSliceDialogPrinterModel(value: string): string {
  switch (value) {
    case 'H2DPRO': return 'H2D Pro'
    case 'H2D': return 'H2D'
    case 'H2C': return 'H2C'
    case 'A1mini': return 'A1 Mini'
    default: return value
  }
}


export function matchesCompatiblePrints(profile: SlicingPresetSummary, selectedProcessProfile: SlicingPresetSummary | null): boolean {
  const compatiblePrints = profile.compatiblePrints ?? []
  if (compatiblePrints.length === 0 || !selectedProcessProfile) return true
  return compatiblePrints.some((compatiblePrint) => compatiblePrint.trim() === selectedProcessProfile.name)
}






export function matchesPlateType(profile: SlicingPresetSummary, plateType: string): boolean {
  if (!profile.plateTypes || profile.plateTypes.length === 0 || !plateType) return true
  const selected = normalizedProfileText(plateType)
  return profile.plateTypes.some((profilePlateType) => {
    const normalized = normalizedProfileText(profilePlateType)
    return normalized === selected || normalized.includes(selected) || selected.includes(normalized)
  })
}

/**
 * The standard BambuStudio bed types every Bambu printer accepts. Profiles only carry
 * their DEFAULT bed (`curr_bed_type`), so these are always offered, otherwise targets
 * whose profiles name a single plate (e.g. P1S) never list SuperTack at all.
 */
export const BAMBU_STUDIO_PLATE_TYPES = ['cool_plate', 'engineering_plate', 'high_temp_plate', 'textured_pei_plate', 'supertack_plate']

export function resolveCompatiblePlateTypes(file: LibraryFile, bakedIndex: ThreeMfIndex | null, selectedMachineProfile: SlicingPresetSummary | null, processProfiles: SlicingPresetSummary[]): string[] {
  const profilePlateTypes = [selectedMachineProfile, ...processProfiles]
    .flatMap((profile) => profile?.plateTypes ?? [])
  const bakedPlateTypes = bakedIndex?.plates.flatMap((plate) => plate.plateType ? [plate.plateType] : []) ?? []
  const combined = ensureOptionValues([...bakedPlateTypes, ...file.plateTypeChips, ...profilePlateTypes], BAMBU_STUDIO_PLATE_TYPES)
  return sortPlateTypesByBambuStudioOrder(dedupePlateTypesByLabel(combined))
}

/**
 * Collapses plate-type values that render to the same display label (e.g. the code
 * `high_temp_plate` and the label form `High Temp Plate` arriving from different sources), keeping
 * the first occurrence so the dropdown doesn't show duplicate entries.
 */
export function dedupePlateTypesByLabel(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = formatPlateTypeLabel(value).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

export function sortPlateTypesByBambuStudioOrder(values: string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...values].sort((left, right) => {
    const leftRank = bambuStudioPlateTypeRank(left)
    const rightRank = bambuStudioPlateTypeRank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return collator.compare(formatPlateTypeLabel(left), formatPlateTypeLabel(right))
  })
}

export function bambuStudioPlateTypeRank(value: string): number {
  const normalized = normalizedProfileText(value)
  if (normalized.includes('cool') || normalized === 'pc') return 0
  if (normalized.includes('engineering') || normalized.includes('eng plate') || normalized === 'pe') return 1
  if (normalized.includes('high temp') || normalized.includes('high temperature') || normalized.includes('hot plate') || normalized.includes('smooth pei') || normalized === 'pei') return 2
  if (normalized.includes('textured') || normalized === 'pte') return 3
  if (normalized.includes('supertack') || normalized.includes('super tack')) return 4
  return 100
}

export function resolveInitialPlateType(file: LibraryFile, bakedIndex: ThreeMfIndex | null): string {
  return resolveProjectPlateType(file, bakedIndex) ?? 'textured_pei_plate'
}

/**
 * The project's own plate type (the project-global `curr_bed_type`, then a file chip), or null.
 *
 * Reads `projectPlateType`, NEVER the first plate that names one. A plate's `plateType` resolves
 * that plate's own `bed_type` ahead of the global, so the old scan returned an OVERRIDE whenever
 * plate 1 carried one, and this value is what the editor seeds its project-wide selector from and
 * re-saves as `curr_bed_type`: one plate's choice would silently become every inheriting plate's.
 * `projectPlateType` is absent on payloads from a server older than the per-plate work, where every
 * plate carried the global anyway, so the scan is still the right fallback for those.
 */
export function resolveProjectPlateType(file: LibraryFile, bakedIndex: ThreeMfIndex | null): string | null {
  // A parser that reports `projectPlateType` has answered definitively, INCLUDING when the answer is
  // null: fall through to the chips there and the promotion comes back by another door, because
  // `collectPlateTypeChips` is built from each plate's RESOLVED type, so `plateTypeChips[0]` is
  // plate 1's override whenever it has one and the project itself states no `curr_bed_type`.
  if (bakedIndex?.projectPlateType !== undefined) return bakedIndex.projectPlateType
  // Legacy payloads only: before per-plate bed types every plate carried the global, so both the
  // plate scan and the chips derived from it genuinely reported the project's own value.
  return bakedIndex?.plates.find((plate) => plate.plateType)?.plateType ?? file.plateTypeChips[0] ?? null
}

/**
 * The plate-type option whose display LABEL matches `desired` (label-insensitive), or null.
 * Label-based so the code form (`high_temp_plate`) and a profile's label form (`High Temp Plate`)
 * resolve to the same option, otherwise the same logical plate falls out of its own option list
 * (the value-form differs between sources) and the selection is silently dropped.
 */
export function matchPlateTypeByLabel(options: readonly string[], desired: string | null | undefined): string | null {
  if (!desired) return null
  const key = formatPlateTypeLabel(desired).toLowerCase()
  return options.find((option) => formatPlateTypeLabel(option).toLowerCase() === key) ?? null
}

/**
 * Resolve which plate type to select from `options`, in priority order: the current choice
 * (matched by label so a value-form change never drops it), the selected printer's loaded plate,
 * then a stable default (Textured PEI, then the first option). Deliberately never snaps to
 * BambuStudio's rank-0 Cool Plate as a fallback, an unrelated profiles recompute must not
 * silently change the user's plate to Cool Plate.
 */
export function resolvePreferredPlateType(
  options: readonly string[],
  preferences: { current?: string | null; printerPlateType?: string | null }
): string {
  return matchPlateTypeByLabel(options, preferences.current)
    ?? matchPlateTypeByLabel(options, preferences.printerPlateType)
    ?? matchPlateTypeByLabel(options, 'textured_pei_plate')
    ?? options[0]
    ?? ''
}

/**
 * Every nozzle diameter the picker may offer for this project + target, ascending.
 *
 * 0.4 is a LAST-RESORT entry so the picker is never empty, not a member of the union: appended
 * unconditionally it put a phantom 0.4 in front of a 0.6-only project's list, and the pre-S2 seed
 * (which took the ascending minimum) then chose it, leaving a 0.4 nozzle paired with a 0.6 machine
 * profile, which the submit gate reports as an incompatible printer profile. Seeding now goes
 * through `resolveMachineTarget`'s ladder (`lib/machineTargetResolution.ts`), which asks the
 * project first; this list only decides what is SELECTABLE.
 */
export function resolveSliceDialogNozzleDiameterOptions(file: LibraryFile, printer: Printer | null, machineProfiles: SlicingPresetSummary[], bakedIndex: ThreeMfIndex | null): string[] {
  const fromBakedPlates = bakedIndex?.plates.flatMap((plate) => plate.nozzleSizes.map((entry) => Number.parseFloat(entry))) ?? []
  const fromBakedFilaments = bakedIndex?.plates.flatMap((plate) => plate.filaments.map((filament) => Number.parseFloat(filament.nozzleDiameter ?? ''))) ?? []
  const fromFile = file.nozzleSizeChips
    .map((entry) => Number.parseFloat(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
  const fromPrinter = printer?.currentNozzleDiameters
    .map((entry) => Number.parseFloat(entry.diameter ?? ''))
    .filter((entry) => Number.isFinite(entry) && entry > 0) ?? []
  const fromMachineProfiles = machineProfiles.flatMap((profile) => resolveMachineProfileNozzleDiameters(profile))
  const known = [...fromBakedPlates, ...fromBakedFilaments, ...fromFile, ...fromPrinter, ...fromMachineProfiles]
    .filter((entry) => Number.isFinite(entry) && entry > 0)
  return Array.from(new Set((known.length > 0 ? known : [0.4]).map((entry) => Number(entry).toString())))
    .sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right))
}


export function buildSliceDialogToolheads(nozzleDiameter: string, nozzleFlow: PrinterNozzleFlow, status: PrinterStatus | undefined, model: string) {
  const diameter = Number.parseFloat(nozzleDiameter)
  if (status?.nozzles.length) {
    return [...status.nozzles].map((nozzle) => ({
      id: buildSliceToolheadId(nozzle.extruderId),
      label: formatNozzleLabel(nozzle.extruderId, 'long', status.nozzles.length) ?? `Nozzle ${nozzle.extruderId + 1}`,
      nozzleDiameter: nozzle.diameter ? Number.parseFloat(nozzle.diameter) : Number.isFinite(diameter) && diameter > 0 ? diameter : null,
      nozzleFlow: nozzle.flow ?? nozzleFlow,
      position: nozzle.extruderId === 1 ? 'left' as const : status.nozzles.length > 1 ? 'right' as const : 'single' as const
    })).sort((left, right) => (left.position === 'left' ? 0 : left.position === 'right' ? 1 : 2) - (right.position === 'left' ? 0 : right.position === 'right' ? 1 : 2))
  }
  const parsedModel = printerModelSchema.safeParse(model)
  if (parsedModel.success && getPrinterControlCapabilities(parsedModel.data).dualNozzles) {
    return [1, 0].map((nozzleId) => ({
      id: buildSliceToolheadId(nozzleId),
      label: formatNozzleLabel(nozzleId, 'long', 2) ?? `Nozzle ${nozzleId + 1}`,
      nozzleDiameter: Number.isFinite(diameter) && diameter > 0 ? diameter : null,
      nozzleFlow,
      position: nozzleId === 1 ? 'left' as const : 'right' as const
    }))
  }
  return [{
    id: 'primary',
    label: 'Primary nozzle',
    nozzleDiameter: Number.isFinite(diameter) && diameter > 0 ? diameter : null,
    nozzleFlow,
    position: 'single' as const
  }]
}

export function buildSliceToolheadId(nozzleId: number): string {
  return `nozzle-${nozzleId}`
}

/**
 * The runtime nozzle id (0 = right, 1 = left) encoded in a `nozzle-<id>` toolhead id, or null
 * for the single-nozzle `primary` id / any non-nozzle toolhead. The inverse of
 * {@link buildSliceToolheadId}; used to carry the editor's toolhead pick into a saved 3MF.
 */
export function parseSliceToolheadNozzleId(toolheadId: string | null | undefined): number | null {
  const match = toolheadId?.match(/^nozzle-(\d+)$/)
  const nozzleId = Number.parseInt(match?.[1] ?? '', 10)
  return Number.isInteger(nozzleId) && nozzleId >= 0 ? nozzleId : null
}






// BambuStudio exposes most compatibility as profile metadata, but some bundled
// profiles still encode model/nozzle hints only in names or condition strings.
// The helpers below prefer explicit metadata and use normalized text matching
// only to mirror BambuStudio's permissive profile-family behavior.









export function buildInitialFilamentProfileSelection(file: LibraryFile, bakedIndex: ThreeMfIndex | null, profiles: SlicingPresetSummary[], machineProfile: SlicingPresetSummary | null = null): Record<number, string> {
  if (bakedIndex) return buildBakedFilamentProfileSelection(bakedIndex, profiles, machineProfile)
  const selections: Record<number, string> = {}
  file.projectFilamentChips.forEach((filament, index) => {
    const match = profiles.find((profile) => profile.name.toLowerCase().includes(filament.label.toLowerCase()))
      ?? profiles.find((profile) => filament.label.toLowerCase().includes(profile.name.toLowerCase()))
    if (match) selections[index + 1] = match.id
  })
  return selections
}

export function buildInitialFilamentMaterialOptionSelection(file: LibraryFile, bakedIndex: ThreeMfIndex | null, profiles: SlicingPresetSummary[], machineProfile: SlicingPresetSummary | null = null): Record<number, string> {
  const profileSelections = buildInitialFilamentProfileSelection(file, bakedIndex, profiles, machineProfile)
  return Object.fromEntries(Object.entries(profileSelections).map(([filamentId, profileId]) => [filamentId, buildProfileMaterialOptionId(profileId)]))
}

/**
 * The preset each project filament slot starts on, keyed by slot id.
 *
 * A slot the resolver cannot identify is LEFT OUT rather than filled with a
 * nearest guess: the dialog then shows it as unassigned and refuses the slice with
 * a reason, which is the whole point of making unresolved first-class (issue #66).
 * The selected machine profile, not the model string, is the compatibility
 * authority here, matching what actually reaches the slicer.
 */
export function buildBakedFilamentProfileSelection(bakedIndex: ThreeMfIndex, profiles: SlicingPresetSummary[], machineProfile: SlicingPresetSummary | null = null): Record<number, string> {
  const selections: Record<number, string> = {}
  for (const filament of bakedIndex.projectFilaments) {
    const resolution = resolveProjectFilamentPreset(profiles, {
      // The RAW `filament_settings_id`, not the display name beside it: binding is a lookup of the
      // name the file states, and the display name has had its `@BBL…` suffix stripped, so it
      // matches no installed preset and forces the resolver into inference. Falls back only for an
      // index built by a bridge/server older than the field.
      presetName: filament.filamentPresetName ?? filament.filamentName,
      filamentType: filament.filamentType,
      isSupport: filament.isSupport ?? null,
      selectedMachineProfile: machineProfile,
      selectedPrinterModel: ''
    })
    if (resolution.status === 'resolved') selections[filament.id] = resolution.profileId
  }
  return selections
}

export function buildInitialFilamentColorSelection(file: LibraryFile, bakedIndex: ThreeMfIndex | null): Record<number, string> {
  const selections: Record<number, string> = {}
  if (bakedIndex?.projectFilaments.length) {
    for (const filament of bakedIndex.projectFilaments) {
      selections[filament.id] = normalizeSliceFilamentColor(filament.color)
    }
    return selections
  }
  file.projectFilamentChips.forEach((filament, index) => {
    selections[index + 1] = normalizeSliceFilamentColor(filament.color)
  })
  return selections
}

export function buildInitialFilamentToolheadSelection(file: LibraryFile, bakedIndex: ThreeMfIndex | null): Record<number, string> {
  const selections: Record<number, string> = {}
  if (bakedIndex?.projectFilaments.length) {
    for (const filament of bakedIndex.projectFilaments) {
      if (filament.nozzleId != null) selections[filament.id] = buildSliceToolheadId(filament.nozzleId)
    }
  }
  return selections
}

/**
 * Whether a plate carries real slice metadata. An UNSLICED plate's filament list
 * is only a geometry estimate built from each object's `extruder` metadata, which
 * captures the base extruder but NOT colour-PAINTED filaments, so it must not be
 * trusted to narrow a project's material/mapping list (it would hide a painted
 * secondary colour). A SLICED plate's `slice_info` records exact per-plate usage.
 */
export function plateHasSliceData(plate: ThreeMfPlate | null | undefined): boolean {
  if (!plate) return false
  return plate.weight != null
    || plate.prediction != null
    || plate.filaments.some((filament) => filament.usedGrams != null)
}

export function buildSliceDialogProjectFilaments(
  file: LibraryFile,
  bakedIndex: ThreeMfIndex | null,
  selectedPlate: number
): Array<{
  projectFilamentId: number
  label: string
  color: string | null
  nozzleId: number | null
  usedOnSelectedPlate: boolean
  mixedFilament?: ThreeMfIndex['projectFilaments'][number]['mixedFilament']
}> {
  if (bakedIndex?.projectFilaments.length) {
    // BambuStudio shows every project material at all times; we mirror that and
    // flag which ones the currently-selected plate actually uses (material/color
    // edits affect the 3D preview regardless of the active plate).
    const selectedPlateData = bakedIndex.plates.find((plate) => plate.index === selectedPlate)
    // Only trust the plate's filament list to flag per-plate usage when the plate is
    // actually sliced. An UNSLICED plate's list is a geometry estimate from object
    // extruder ids that misses colour-PAINTED filaments, so narrowing to it would
    // wrongly drop a painted secondary colour (e.g. black on a white base) from the
    // print/slice material list. With no trustworthy per-plate data, treat every
    // project material as in use.
    const platedFilamentIds = plateHasSliceData(selectedPlateData)
      ? selectedPlateData!.filaments.map((filament) => filament.id)
      : []
    const usedOnPlate = new Set(platedFilamentIds)
    // Support materials are referenced by process SETTINGS (support_filament /
    // support_interface_filament), not by any object's extruder id, so a plate's sliced
    // filament list omits them until a slice actually consumed them. Without this a material
    // assigned as the support interface is missing from the print dialog entirely, it cannot be
    // mapped to a tray, and the print goes out without it. Union only when the plate HAS slice
    // data: with none, every material is already treated as in use below.
    if (platedFilamentIds.length > 0) {
      for (const id of bakedIndex.supportFilamentIds ?? []) usedOnPlate.add(id)
    }
    const hasMixedFilaments = bakedIndex.projectFilaments.some((filament) => filament.mixedFilament != null)
    return bakedIndex.projectFilaments.map((filament) => ({
      projectFilamentId: filament.id,
      label: filament.filamentName ?? filament.filamentType ?? `Filament ${filament.id}`,
      color: filament.color,
      nozzleId: filament.nozzleId ?? null,
      usedOnSelectedPlate: platedFilamentIds.length === 0 ? true : usedOnPlate.has(filament.id),
      // Once a project has a virtual slot, physical nulls are explicit so deleting the last mix
      // still clears the parallel metadata arrays on save. Ordinary projects omit the field and
      // therefore remain byte-stable.
      ...(hasMixedFilaments ? { mixedFilament: filament.mixedFilament ?? null } : {})
    }))
  }
  return file.projectFilamentChips.map((filament, index) => ({
    ...filament,
    projectFilamentId: index + 1,
    nozzleId: null,
    usedOnSelectedPlate: true
  }))
}

/**
 * The 1-based project-filament ids the selected plate's MODEL OBJECTS print with: the
 * model-material side of the support-interface recommendation (`modelFilamentIds` on
 * `recommendSupportSettingsForInterfaceFilament`), approximating BambuStudio's scan of the
 * current plate's volume extruders. Null when there is no baked index (host cannot tell;
 * the combination-table lookup is then skipped).
 *
 * This deliberately does NOT reuse `usedOnSelectedPlate`: that is a display flag whose
 * fallback is "every material is in use" (unsliced plates, plate 0), and which unions the
 * support-referenced slots in, both exactly wrong for the homogeneity gate, which needs the
 * set NARROW (the issue-#79 repro file read as PETG+PLA and never consulted the table). The
 * trust calculus differs too: narrowing the print-mapping list can drop a needed material
 * from a print, while narrowing this set only changes whether a confirm-only prompt appears,
 * so the unsliced geometry estimate is good enough here even though the mapping list refuses
 * to trust it.
 *
 * Slots referenced only by the support process settings (`supportFilamentIds`: the configured
 * base/interface plus `filament_is_support` slots) are subtracted: Studio's volume scan never
 * sees them unless geometry also prints with them, which the index cannot distinguish. The one
 * guard: never subtract down to an empty set, because then the referenced slot IS the model
 * material (a single-colour project whose colour doubles as the support base).
 */
export function plateModelFilamentIds(bakedIndex: ThreeMfIndex | null, selectedPlate: number): Set<number> | null {
  if (!bakedIndex || bakedIndex.projectFilaments.length === 0) return null
  const supportReferenced = new Set(bakedIndex.supportFilamentIds ?? [])
  const knownIds = new Set(bakedIndex.projectFilaments.map((filament) => filament.id))
  const plate = bakedIndex.plates.find((entry) => entry.index === selectedPlate) ?? null
  // The plate's own list when it has one (sliced consumption, or the unsliced geometry
  // estimate); otherwise every project material (plate 0 / plates with no filament metadata).
  const candidateIds = plate && plate.filaments.length > 0
    ? plate.filaments.map((filament) => filament.id).filter((id) => knownIds.has(id))
    : bakedIndex.projectFilaments.map((filament) => filament.id)
  const supportFlagged = new Set(
    bakedIndex.projectFilaments.filter((filament) => filament.isSupport).map((filament) => filament.id)
  )
  const modelIds = new Set(candidateIds.filter((id) => !supportFlagged.has(id) && !supportReferenced.has(id)))
  if (modelIds.size > 0) return modelIds
  // Dedicated support materials stay excluded even in the fallback, they are never model
  // geometry, whereas a support-REFERENCED ordinary colour can be.
  return new Set(candidateIds.filter((id) => !supportFlagged.has(id)))
}

/**
 * Material choices for filament-index process settings ("Support/raft base" etc.) in the global
 * `ProcessSettingsDialog`, ONE builder for every host that renders that dialog (the workspace
 * slice/print dialog and the public editor's local controller), so the hosts cannot drift.
 * Ids are the 1-based POSITION in the full ordered list, the index the slicer reads, not
 * `projectFilamentId`, which can diverge from position after a removal.
 *
 * `filamentType`/`isSupport`/`isSoluble`/`materialName`/`usedByPlateModels` ride along for
 * the support-interface recommendation prompt in ProcessSettingsDialog (they are never
 * rendered). The character fields come from the project's baked config, with the currently
 * selected option filling the gaps (a session-ADDED slot has no baked entry at all, and
 * without its option's type the table's type-matched entries could never fire for it); a
 * wrong classification only means the prompt is offered or withheld, and the user still
 * decides. `usedByPlateModels` comes from `plateModelFilamentIds`, NOT `usedOnSelectedPlate`,
 * whose unsliced-plate fallback marks every material used and broke the homogeneity gate
 * (see that helper's doc). A session-added slot is never a model material (the file's objects
 * cannot print with it), which the id-space lookup gives for free.
 *
 * `selectedPlate` is the slice target: a real plate index when one plate is targeted, 0 in
 * all-plates/editor mode (no single plate is targeted, so every project material is a model
 * candidate).
 */
export function buildProcessFilamentChoices(params: {
  projectFilaments: Array<{ projectFilamentId: number; label: string; color: string | null }>
  materialOptions: SliceMaterialOption[]
  filamentMaterialOptionIds: Record<number, string>
  filamentColors: Record<number, string>
  bakedIndex: ThreeMfIndex | null
  selectedPlate: number
}): SettingFilamentChoice[] {
  const { projectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors, bakedIndex, selectedPlate } = params
  const plateModelIds = plateModelFilamentIds(bakedIndex, selectedPlate)
  return projectFilaments.map((filament, index) => {
    const option = materialOptions.find((entry) => entry.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
    const baked = bakedIndex?.projectFilaments.find((entry) => entry.id === filament.projectFilamentId) ?? null
    return {
      id: index + 1,
      label: option?.label ?? filament.label,
      color: normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color ?? '#FFFFFF'),
      filamentType: baked?.filamentType ?? option?.materialType ?? null,
      isSupport: baked?.isSupport ?? null,
      isSoluble: baked?.isSoluble ?? null,
      // The currently-chosen preset's full name, so the table's name entries can match even
      // when the picker label is vendor-stripped; the baked preset name is the fallback.
      materialName: option?.material ?? baked?.filamentPresetName ?? baked?.filamentName ?? null,
      usedByPlateModels: plateModelIds ? plateModelIds.has(filament.projectFilamentId) : null
    }
  })
}

/** A project filament slot that produced no mapping, and why. */
export interface UnresolvedFilamentSlot {
  projectFilamentId: number
  label: string
  /** `unselected`: nothing chosen yet. `staleSelection`: the chosen option no longer exists (e.g. the printer changed and its AMS options were rebuilt). */
  reason: 'unselected' | 'staleSelection'
}

/** One resolved slot of a slice request's `filamentMappings`. */
export interface ResolvedFilamentMapping {
  projectFilamentId: number
  /** The chosen preset's id, or undefined for a tray whose preset never resolved. */
  profileId: string | undefined
  source: SliceMaterialOption['source']
  trayId: number | null
  toolheadId: string | undefined
  /** Base polymer written to the 3MF's `filament_type`. */
  materialType: string
  /** DISPLAY text for the slot. Never treated as a preset name: see `output-metadata.ts`. */
  material: string
  color: string
  settingOverrides: Record<string, string | string[]> | undefined
}

export interface FilamentMappingResult {
  mappings: ResolvedFilamentMapping[]
  /**
   * Slots that produced no mapping. Callers MUST surface these and refuse the
   * slice rather than submitting a short list: a dropped slot reaches the CLI as
   * a filament the project declares but the request never describes, which
   * downstream becomes a partial config and an opaque segfault (issue #66).
   */
  unresolved: UnresolvedFilamentSlot[]
}

/**
 * Build the per-slot filament mappings for a slice request.
 *
 * Every project filament yields either a mapping or an entry in `unresolved`,
 * a slot is never silently dropped.
 */
export function buildFilamentMappings(
  projectFilaments: Array<{
    projectFilamentId: number
    label: string
    color: string | null
    nozzleId: number | null
    mixedFilament?: unknown
  }>,
  optionIds: Record<number, string>,
  colors: Record<number, string>,
  toolheadIds: Record<number, string>,
  materialOptions: SliceMaterialOption[],
  /** Per-material filament setting overrides (from the material "tune" dialog), keyed by projectFilamentId. */
  settingOverridesById: Record<number, Record<string, string | string[]>> = {}
): FilamentMappingResult {
  const mappings: FilamentMappingResult['mappings'] = []
  const unresolved: UnresolvedFilamentSlot[] = []

  for (const filament of projectFilaments) {
    // A mixed slot is a virtual recipe. The slicer expands it to its physical components, so it
    // never receives a profile/tray mapping of its own.
    if (filament.mixedFilament) {
      continue
    }

    const optionId = optionIds[filament.projectFilamentId]
    if (!optionId) {
      unresolved.push({ projectFilamentId: filament.projectFilamentId, label: filament.label, reason: 'unselected' })
      continue
    }
    const option = materialOptions.find((entry) => entry.id === optionId)
    if (!option) {
      unresolved.push({ projectFilamentId: filament.projectFilamentId, label: filament.label, reason: 'staleSelection' })
      continue
    }
    mappings.push(buildFilamentMapping(filament, option, colors, toolheadIds, settingOverridesById[filament.projectFilamentId]))
  }

  return { mappings, unresolved }
}

function buildFilamentMapping(
  filament: { projectFilamentId: number; label: string; color: string | null; nozzleId: number | null },
  option: SliceMaterialOption,
  colors: Record<number, string>,
  toolheadIds: Record<number, string>,
  overrides: Record<string, string | string[]> | undefined
): ResolvedFilamentMapping {
  return {
    projectFilamentId: filament.projectFilamentId,
    profileId: option.profileId ?? undefined,
    source: option.source,
    trayId: option.trayId,
    toolheadId: toolheadIds[filament.projectFilamentId] || option.toolheadId || (filament.nozzleId != null ? buildSliceToolheadId(filament.nozzleId) : undefined),
    materialType: option.materialType,
    material: option.material ?? option.label ?? filament.label,
    color: normalizeSliceFilamentColor(colors[filament.projectFilamentId] ?? filament.color),
    settingOverrides: overrides && Object.keys(overrides).length > 0 ? overrides : undefined
  }
}

export function buildSliceMaterialOptions(profiles: SlicingPresetSummary[], loadedMaterials: SliceMaterialOption[]): SliceMaterialOption[] {
  const profileOptions = profiles.map((profile) => ({
    id: buildProfileMaterialOptionId(profile.id),
    label: formatSlicingPresetDisplayName(profile),
    // BambuStudio's own terms for these groups (PresetComboBoxes.cpp): "System presets" and
    // "User presets". It says PRESET in the picker even though its prose elsewhere says "profile",
    // and this dialog is the picker, so match it here rather than inventing a third vocabulary.
    // The 3MF group has no BambuStudio counterpart: it loads a project's presets as the named
    // preset (dirty when values differ) rather than listing them separately.
    group: isProjectSlicingPreset(profile) ? '3MF project presets' : profile.source === 'custom' ? 'User presets' : 'System presets',
    materialType: resolveProfileMaterialType(profile),
    brand: resolveProfileMaterialBrand(profile),
    profileId: isProjectSlicingPreset(profile) ? null : profile.id,
    material: profile.name,
    color: null,
    colors: [],
    source: 'manual' as const,
    trayId: null,
    nozzleId: null,
    toolheadId: null,
    metadata: formatSlicingPresetMetadata(profile),
    slotLabel: null,
    presetLabel: formatSlicingPresetBrandedName(profile),
    colorName: null,
    remainingGrams: null,
    remainPercent: null
  }))
  return [...loadedMaterials, ...dedupeSliceMaterialProfileOptions(profileOptions)]
}

export function dedupeSliceMaterialProfileOptions(options: SliceMaterialOption[]): SliceMaterialOption[] {
  const byDisplayKey = new Map<string, SliceMaterialOption>()
  for (const option of options) {
    const key = [option.group, option.label, option.materialType, option.brand, option.metadata].join('\u0000')
    if (!byDisplayKey.has(key)) byDisplayKey.set(key, option)
  }
  return [...byDisplayKey.values()]
}

/**
 * The slice of a printer's status that drives loaded-material options. Extracted
 * so the material dropdown only re-derives when the AMS / external spool / nozzle
 * data changes, instead of on every status frame (temperatures, progress, etc.).
 */
export interface LoadedMaterialSource {
  ams: PrinterStatus['ams']
  externalSpools: PrinterStatus['externalSpools']
  nozzleCount: number | null
}

export function buildLoadedPrinterMaterialOptions(
  source: LoadedMaterialSource | null,
  profiles: SlicingPresetSummary[],
  selectedMachineProfile: SlicingPresetSummary | null,
  selectedPrinterModel: string,
  /** Tracked-spool resolution (core slotFilamentIdentity registry); optional so pure callers/tests can omit it. */
  spoolContext?: { printerId: string | null; resolveSpool: SlotFilamentIdentityLookup } | null
): SliceMaterialOption[] {
  if (!source) return []
  const options: SliceMaterialOption[] = []
  const nozzleCount = source.nozzleCount
  for (const unit of source.ams) {
    // A unit behind a Filament Track Switch feeds EITHER nozzle, so it must not pin a material to
    // one toolhead here, that assignment becomes the sliced `filament_map`, which would undo the
    // routing freedom the switch exists to provide.
    const unitNozzleId = effectiveAmsNozzleId(unit)
    const group = formatPrinterMaterialSourceGroup(`AMS ${amsUnitLetter(unit.unitId)}`, unitNozzleId, nozzleCount)
    for (const slot of unit.slots) {
      if (slot.occupied === false || !hasLoadedMaterialDetails(slot.trayName, slot.filamentType, slot.color)) continue
      const fallbackLabel = slot.trayName?.trim() || slot.filamentType?.trim() || `AMS ${unit.unitId + 1} slot ${slot.slot + 1}`
      // The FILAMENT's own resolved identity, tracked spool first, then the
      // tray, is authoritative for who the filament is (label, brand, colour
      // naming); a matched profile only decides which slicing preset to use.
      // Deriving the brand/label from the profile is what labelled custom
      // filament "Bambu Lab ..." and unlocked marketing colours.
      const spool = spoolContext?.resolveSpool(spoolContext.printerId, unit.unitId, slot.slot) ?? null
      const identity = resolveFilamentIdentity({ ...slot, spool })
      const resolution = resolveFilamentPreset(profiles, {
        trayName: slot.trayName,
        trayInfoIdx: slot.trayInfoIdx,
        trayFilamentType: slot.filamentType,
        pinnedPresetName: spool?.slicingPresetName ?? null,
        selectedMachineProfile,
        selectedPrinterModel
      })
      const preset = { profile: resolution.status === 'resolved' ? resolution.profile : null }
      const identityMaterial = identity.presetName
        ?? ([identity.brand, identity.subtype ?? identity.type].filter(Boolean).join(' ') || null)
      // A tracked spool names the row outright ("Michael's PLA"); otherwise the
      // matched preset names it, with the tray identity as the last fallback.
      const label = spool
        ? identityMaterial ?? fallbackLabel
        : preset.profile ? formatSlicingPresetDisplayName(preset.profile) : identityMaterial ?? fallbackLabel
      const color = normalizeSliceFilamentColor(identity.colorHex ?? slot.color ?? slot.colors[0] ?? null)
      const trayId = amsTrayIndex(unit.type, unit.unitId, slot.slot)
      options.push({
        id: `loaded:ams:${unit.unitId}:${slot.slot}:${preset.profile?.id ?? fallbackLabel}:${color}`,
        label,
        group,
        materialType: resolveLoadedMaterialType(slot.filamentType, preset.profile, preset.profile?.name ?? label),
        brand: identity.brand ?? '',
        profileId: preset.profile?.id ?? null,
        material: preset.profile ? preset.profile.name : identityMaterial ?? slot.filamentType?.trim() ?? label,
        color,
        colors: identity.colors.length > 0 ? identity.colors : slot.colors,
        source: 'ams',
        trayId,
        nozzleId: unitNozzleId,
        toolheadId: unitNozzleId != null ? buildSliceToolheadId(unitNozzleId) : null,
        metadata: [
          `Slot ${slot.slot + 1}`,
          identity.colorName,
          spool && preset.profile ? formatSlicingPresetDisplayName(preset.profile) : null
        ].filter(Boolean).join(' - '),
        slotLabel: `${amsUnitLetter(unit.unitId)}${slot.slot + 1}`,
        presetLabel: preset.profile ? formatSlicingPresetBrandedName(preset.profile) : null,
        colorName: identity.colorName,
        remainingGrams: spool?.remainingGrams ?? null,
        remainPercent: spool?.remainPercent ?? null
      })
    }
  }
  for (const spool of source.externalSpools) {
    if (!hasLoadedMaterialDetails(spool.trayName, spool.filamentType, spool.color)) continue
    const fallbackLabel = spool.trayName?.trim() || spool.filamentType?.trim() || 'External spool'
    // Same rule as AMS slots: the filament's identity (tracked spool first,
    // then the tray) names the row; the matched profile only supplies the
    // slicing preset. External spools track with a null slot id.
    const trackedSpool = spoolContext?.resolveSpool(spoolContext.printerId, spool.amsId, null) ?? null
    const identity = resolveFilamentIdentity({ ...spool, spool: trackedSpool })
    const resolution = resolveFilamentPreset(profiles, {
      trayName: spool.trayName,
      trayInfoIdx: spool.trayInfoIdx,
      trayFilamentType: spool.filamentType,
      pinnedPresetName: trackedSpool?.slicingPresetName ?? null,
      selectedMachineProfile,
      selectedPrinterModel
    })
    const preset = { profile: resolution.status === 'resolved' ? resolution.profile : null }
    const identityMaterial = identity.presetName
      ?? ([identity.brand, identity.subtype ?? identity.type].filter(Boolean).join(' ') || null)
    const label = trackedSpool
      ? identityMaterial ?? fallbackLabel
      : preset.profile ? formatSlicingPresetDisplayName(preset.profile) : identityMaterial ?? fallbackLabel
    const color = normalizeSliceFilamentColor(identity.colorHex ?? spool.color ?? spool.colors[0] ?? null)
    // Same rule as slotLabel below: only a machine with two external spools
    // (dual-nozzle) distinguishes sides; a lone external spool gets no side.
    const sourceLabel = source.externalSpools.length > 1
      ? (spool.amsId === 254 ? 'Left external spool' : spool.amsId === 255 ? 'Right external spool' : 'External spool')
      : 'External spool'
    options.push({
      id: `loaded:external:${spool.amsId}:${preset.profile?.id ?? fallbackLabel}:${color}`,
      label,
      group: formatPrinterMaterialSourceGroup(sourceLabel, spool.nozzleId, nozzleCount),
      materialType: resolveLoadedMaterialType(spool.filamentType, preset.profile, preset.profile?.name ?? label),
      brand: identity.brand ?? '',
      profileId: preset.profile?.id ?? null,
      material: preset.profile ? preset.profile.name : identityMaterial ?? spool.filamentType?.trim() ?? label,
      color,
      colors: identity.colors.length > 0 ? identity.colors : spool.colors,
      source: 'externalSpool',
      trayId: spool.amsId,
      nozzleId: spool.nozzleId,
      toolheadId: spool.nozzleId != null ? buildSliceToolheadId(spool.nozzleId) : null,
      metadata: [
        sourceLabel,
        identity.colorName,
        trackedSpool && preset.profile ? formatSlicingPresetDisplayName(preset.profile) : null
      ].filter(Boolean).join(' - '),
      slotLabel: source.externalSpools.length > 1 ? (spool.amsId === 255 ? 'Ext-R' : 'Ext-L') : 'Ext',
      presetLabel: preset.profile ? formatSlicingPresetBrandedName(preset.profile) : null,
      colorName: identity.colorName,
      remainingGrams: trackedSpool?.remainingGrams ?? null,
      remainPercent: trackedSpool?.remainPercent ?? null
    })
  }
  return options
}

export function formatPrinterMaterialSourceGroup(label: string, nozzleId: number | null, nozzleCount: number | null): string {
  const nozzleLabel = formatPrinterMaterialNozzleLabel(nozzleId, 'long', nozzleCount)
  return [label, nozzleLabel].filter(Boolean).join(' · ')
}

export function formatPrinterMaterialNozzleLabel(nozzleId: number | null, variant: 'short' | 'long', nozzleCount: number | null): string | null {
  if (nozzleCount == null || nozzleCount <= 1) return null
  return formatNozzleLabel(nozzleId, variant, nozzleCount)
}

export function groupSliceMaterialOptionsByGroup(options: SliceMaterialOption[]): Array<{ label: string; options: SliceMaterialOption[] }> {
  const groups: Array<{ label: string; options: SliceMaterialOption[] }> = []
  for (const option of options) {
    const label = option.group || 'Loaded in selected printer'
    let group = groups.find((entry) => entry.label === label)
    if (!group) {
      group = { label, options: [] }
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}

export function resolveMaterialTypeOptions(options: SliceMaterialOption[]): string[] {
  return sortMaterialTypesByBambuStudioOrder(Array.from(new Set(options.map((option) => option.materialType).filter(Boolean))))
}

export function sortMaterialTypesByBambuStudioOrder(values: string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...values].sort((left, right) => {
    const leftRank = bambuStudioMaterialTypeRank(left)
    const rightRank = bambuStudioMaterialTypeRank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return collator.compare(left, right)
  })
}

export function bambuStudioMaterialTypeRank(value: string): number {
  const normalized = normalizedProfileText(value).toUpperCase()
  const exactRank = BAMBU_STUDIO_MATERIAL_TYPE_ORDER.indexOf(normalized)
  if (exactRank !== -1) return exactRank
  const familyRank = BAMBU_STUDIO_MATERIAL_TYPE_ORDER.findIndex((type) => normalized.startsWith(`${type} `))
  if (familyRank !== -1) return familyRank
  if (normalized === 'OTHER') return 100
  return 99
}

export function narrowMaterialOptions(options: SliceMaterialOption[], materialType: string, keepId?: string | null): SliceMaterialOption[] {
  // Always keep the currently-selected option even when the type filter would exclude it,
  // so it stays visible in the dropdown and the Autocomplete's value is never absent from
  // its options (which otherwise logs a "value provided is invalid" warning). Filtering the
  // already-grouped `options` in place preserves group ordering, so no duplicate headers.
  return options.filter((option) => !materialType || option.materialType === materialType || option.id === keepId)
}

/**
 * The material type a preset is FILTERED and LABELLED by: BambuStudio's derived
 * display type, not the preset's raw `filament_type`.
 *
 * A support preset is typed by its base polymer (`filament_type: ["PLA"]`) plus a
 * `filament_is_support` flag, while the AMS and a 3MF's project filaments both
 * speak the derived `PLA-S`. Comparing those two spellings directly matched
 * nothing and hid every support preset from the material picker (issue #66), so
 * both sides go through `resolveDisplayFilamentType` and the exact-equality
 * filter in {@link narrowMaterialOptions} becomes correct rather than forgiving.
 */
export function resolveProfileMaterialType(profile: SlicingPresetSummary): string {
  const derivedType = resolveDisplayFilamentType({
    filamentType: profile.filamentType,
    filamentIds: profile.filamentIds,
    filamentIsSupport: profile.filamentIsSupport
  })
  return normalizeMaterialTypeLabel(derivedType) ?? extractMaterialType(profile.name)
}

export function resolveLoadedMaterialType(filamentType: string | null | undefined, profile: SlicingPresetSummary | null | undefined, fallbackLabel: string): string {
  // The tray's own reported type is already BambuStudio's derived spelling ("PLA-S").
  return normalizeMaterialTypeLabel(filamentType)
    ?? (profile ? normalizeMaterialTypeLabel(resolveProfileMaterialType(profile)) : null)
    ?? extractMaterialType(fallbackLabel)
}

export function extractMaterialType(value: string): string {
  // Fallback only, for presets carrying no `filament_type`/`filament_is_support`
  // at all (e.g. a 3MF project profile that exposes just a display name). This
  // list mirrors BambuStudio's filament_type enum, with local AMS families appended.
  const normalized = normalizedProfileText(value).toUpperCase()
  const readsAsSupport = normalized.includes('SUPPORT')
  for (const type of BAMBU_STUDIO_MATERIAL_TYPE_MATCH_ORDER) {
    const normalizedType = normalizedProfileText(type).toUpperCase()
    if (new RegExp(`(^|[^A-Z0-9])${escapeRegExp(normalizedType)}([^A-Z0-9]|$)`).test(normalized)) {
      // Mirror the derived-type rule for the name-only path too, so a preset named
      // "Bambu Support For PLA" lands on `PLA-S` alongside the flagged presets
      // instead of a bare `SUPPORT` bucket that matches no real filament type.
      return readsAsSupport ? (resolveDisplayFilamentType({ filamentType: type, filamentIsSupport: true }) ?? type) : type
    }
  }
  return readsAsSupport ? 'SUPPORT' : 'Other'
}

export function normalizeMaterialTypeLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || normalizedProfileText(trimmed) === 'other') return null
  return trimmed
}

export const BAMBU_STUDIO_MATERIAL_TYPE_ORDER = [
  'PLA', 'ABS', 'ASA', 'ASA-CF', 'PETG', 'PCTG', 'TPU', 'TPU-AMS', 'PC', 'PA', 'PA-CF', 'PA-GF', 'PA6-CF',
  'PLA-CF', 'PET-CF', 'PETG-CF', 'PVA', 'HIPS', 'PLA-AERO', 'PPS', 'PPS-CF', 'PPA-CF', 'PPA-GF', 'ABS-GF',
  'ASA-AERO', 'PE', 'PP', 'EVA', 'PHA', 'BVOH', 'PE-CF', 'PP-CF', 'PP-GF', 'PA6-GF', 'PAHT-CF', 'PA12-CF', 'PA612-CF', 'PETG-ESD'
]

export const BAMBU_STUDIO_MATERIAL_TYPE_MATCH_ORDER = [...BAMBU_STUDIO_MATERIAL_TYPE_ORDER].sort((left, right) => right.length - left.length)

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function resolveProfileMaterialBrand(profile: SlicingPresetSummary): string {
  // Normalized, not raw: a built-in declares "Bambu Lab" while a 3MF's own preset has no vendor at
  // all and falls to the name-derived "Bambu". Unnormalized, one vendor labels two rows of the same
  // picker differently, which reads as two brands.
  return normalizeFilamentVendorLabel(profile.filamentVendor) || extractMaterialBrand(profile.name)
}

export function extractMaterialBrand(value: string): string {
  // Fallback only: BambuStudio's `filament_vendor` is preferred when present.
  // Internal ids such as `fdm_filament_*` are profile keys, not user brands.
  const beforeAt = value.split('@')[0]?.trim() ?? value
  const words = beforeAt.split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'Other'
  const first = words[0] as string
  if (/^(?:fdm_)?filament_/i.test(first)) return 'Other'
  if (/^(generic|bambu|polymaker|esun|sunlu|overture|prusament|hatchbox|flashforge)$/i.test(first)) {
    return first.replace(/^bambu$/i, 'Bambu')
  }
  return /^[A-Z0-9-]+$/.test(first) ? 'Other' : first
}

/**
 * Filter the material picker's options for a typed query.
 *
 * Searches the whole IDENTITY, not the displayed label: that label is the alias, which has the
 * vendor prefix stripped ("PLA Basic"), so a brand query matched no built-in preset at all. Terms
 * are ANDed so "bambu pla basic" narrows instead of widening.
 *
 * `displayValue` is the text the field shows for the current selection. A query equal to it means
 * the user has opened a filled field without typing, which must list EVERYTHING, otherwise
 * clicking in to change your mind offers only the option you already have. MUI applies that rule to
 * its own filter by blanking the query, but only when the input matches `getOptionLabel`; this
 * picker displays the branded alias while `getOptionLabel` returns the plain one, so the rule never
 * fires there and has to live here.
 */
export function filterSliceMaterialOptions(
  options: SliceMaterialOption[],
  inputValue: string,
  displayValue: string
): SliceMaterialOption[] {
  const query = inputValue.trim()
  if (query === displayValue) return options
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return options
  return options.filter((option) => {
    const haystack = [option.label, option.presetLabel, option.material, option.brand, option.metadata, option.slotLabel, option.colorName]
      .filter(Boolean).join(' ').toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

export function buildProfileMaterialOptionId(profileId: string): string {
  return `profile:${profileId}`
}

/**
 * Carry a material pick across a machine change, BambuStudio-style.
 *
 * When the selected printer changes, a preset built for the old machine leaves the compatible
 * catalogue and its option id no longer resolves. Dropping the pick there re-seeds the slot from the
 * FILE, silently reverting a material the user chose in this session: picking Bambu PLA Basic on a
 * P1P and switching to an A1 put the slot back to the project's original Generic PLA.
 *
 * BambuStudio's `update_compatible(Always)` instead re-selects among the newly compatible presets,
 * and its `PreferedFilamentsProfileMatch` gives a matching preset ALIAS priority over everything
 * else (`std::numeric_limits<int>::max()`). The alias is the product name without the `@<printer>`
 * suffix, which is exactly what `presetLabel` carries, so "Bambu PLA Basic @BBL P1P" hands over to
 * "Bambu PLA Basic @BBL A1" and the material survives the switch.
 *
 * @returns the option id to use instead, or null when no compatible option shares the alias (the
 *   vendor publishes no variant for this machine): the caller then falls back to the file's own
 *   default, which is the honest answer.
 */
export function repointMaterialOptionToCompatibleAlias(
  optionId: string,
  allProfiles: SlicingPresetSummary[],
  options: SliceMaterialOption[]
): string | null {
  if (!optionId.startsWith('profile:')) return null
  const profileId = optionId.slice('profile:'.length)
  const previous = allProfiles.find((profile) => profile.id === profileId)
  if (!previous || previous.kind !== 'filament') return null
  // Both sides through `slicingPresetAlias`, never a display label: it is the one form derived from
  // the NAME alone, so a preset still matches itself when one side declares a vendor and the other
  // does not (an installed profile against the project preset for the same material). Matching on
  // `presetLabel` meant a Polymaker material silently failed to hand over and fell back to the
  // file's default, where a Bambu one survived.
  const alias = slicingPresetAlias(previous)
  if (!alias) return null
  const aliasByProfileId = new Map(allProfiles.map((profile) => [profile.id, slicingPresetAlias(profile)]))
  return options.find((option) =>
    option.source === 'manual'
    && option.profileId != null
    && aliasByProfileId.get(option.profileId) === alias
  )?.id ?? null
}

export function hasLoadedMaterialDetails(trayName: string | null, filamentType: string | null, color: string | null): boolean {
  return Boolean(trayName?.trim() || filamentType?.trim() || color?.trim())
}

export function normalizeSliceFilamentColor(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase()
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toLowerCase()}`
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) return `#${trimmed.slice(1, 7).toLowerCase()}`
  if (/^[0-9a-fA-F]{8}$/.test(trimmed)) return `#${trimmed.slice(0, 6).toLowerCase()}`
  return '#808080'
}

export function ensureOptionValues(values: string[], fallbacks: string[]): string[] {
  return Array.from(new Set([...values.filter(Boolean), ...fallbacks]))
}

/**
 * The target model to start from: the 3MF's own, or `'unknown'` when the project has not said yet.
 *
 * `'unknown'` is the codebase's established "not known" value, compatibility checks short-circuit
 * on it and `canonicalBambuModelKey` maps it to null, so an unresolved target behaves as absent
 * rather than as a specific machine.
 *
 * It deliberately does NOT fall back to the first available model. That guess produced a
 * plausible-looking wrong answer during load, which everything downstream then had to detect and
 * undo: it rendered the wrong bed on a fresh upload, and it let the project's own presets be
 * filtered out against a machine the user never chose, feeding an incompatible builtin to the CLI
 * (exit 239, then SIGSEGV). Not knowing is a state worth representing.
 */
export function resolveInitialManualPrinterModel(file: LibraryFile): string {
  const source = normalizeBambuStudioPrinterModelOption(file.compatiblePrinterModels[0] ?? '')
  return isVisibleBambuStudioPrinterModel(source) ? source : 'unknown'
}

export function ensurePrinterModelOptions(values: readonly string[], fallback?: string, machineProfiles: SlicingPresetSummary[] = []): string[] {
  const machineModels = machineProfiles.flatMap(extractMachineProfilePrinterModelOptions)
  const knownModels = [...values, fallback, ...machineModels]
    .map((value) => normalizeBambuStudioPrinterModelOption(value ?? ''))
    .filter(isVisibleBambuStudioPrinterModel)
  const uniqueKnownModels = Array.from(new Set(knownModels))
  return uniqueKnownModels.length > 0 ? sortPrinterModelOptions(uniqueKnownModels) : ['unknown']
}

/**
 * The printer models a machine preset offers to the target-model list.
 *
 * `printer_model` is authoritative and every BambuStudio machine preset declares
 * it (a custom preset inherits it from the builtin it derives from), so the name
 * parse below is a fallback for the one case the field cannot cover: a
 * hand-written custom machine preset that declares neither `printer_model` nor an
 * `inherits`. It supplemented the real field unconditionally until issue #68,
 * which let any preset whose NAME happened to read like a model contribute one.
 */
export function extractMachineProfilePrinterModelOptions(profile: SlicingPresetSummary): string[] {
  const declaredModels = profile.printerModels ?? []
  if (declaredModels.length > 0) return [...declaredModels]
  const fromName = extractPrinterModelLabelFromProfileName(profile.name)
  return fromName ? [fromName] : []
}

export function extractPrinterModelLabelFromProfileName(value: string): string | null {
  if (looksLikeBambuStudioBaseMachineProfile(value)) return null
  const label = normalizeBambuStudioPrinterModelOption(value)
    .replace(/\b\d+(?:\.\d+)?\s*(?:mm\s*)?nozzle\b/gi, '')
    .replace(/@BBL\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return isVisibleBambuStudioPrinterModel(label) ? label : null
}

export function isVisibleBambuStudioPrinterModel(value: string): boolean {
  if (!value || value === 'unknown') return false
  const normalized = normalizedProfileText(value)
  if (!normalized) return false
  if (looksLikeBambuStudioBaseMachineProfile(value)) return false
  if (/^(?:fdm|template|default|generic)(?:_|\b)/.test(normalized)) return false
  if (normalized.includes('template')) return false
  return /^(?:a|p|h|x)\d/.test(normalized)
}

export function looksLikeBambuStudioBaseMachineProfile(value: string): boolean {
  const normalized = normalizedProfileText(value)
  const compacted = compactProfileText(value)
  return /^(?:fdm|template|default|generic)(?:_|\b)/.test(value.trim().toLowerCase())
    || /^(?:fdm|template|default|generic)(?:\s|$)/.test(normalized)
    || compacted.includes('template')
}

export function sortPrinterModelOptions(values: string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...values].sort((left, right) => {
    const leftRank = printerModelSortRank(left)
    const rightRank = printerModelSortRank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return collator.compare(formatPrinterModelLabel(left), formatPrinterModelLabel(right))
  })
}

export function printerModelSortRank(value: string): number {
  const normalized = normalizedProfileText(value)
  if (normalized.startsWith('a')) return 0
  if (normalized.startsWith('p')) return 1
  if (normalized.startsWith('h')) return 2
  if (normalized.startsWith('x')) return 3
  if (normalized === 'unknown') return 100
  return 50
}

/**
 * What {@link formatSlicingPresetMetadata} falls back to when a preset has no distinguishing
 * metadata of its own: text naming the preset's SOURCE. Named here so the predicate below and the
 * formatter cannot drift apart.
 */
const SOURCE_ONLY_PRESET_METADATA = ['System preset', 'User preset', '3MF project preset'] as const

/**
 * Whether a preset's metadata says only where the preset came from.
 *
 * A picker that GROUPS by source already states this in its group header, so repeating it under
 * every row is noise. Callers that do not group should keep showing it.
 */
export function isSourceOnlyPresetMetadata(metadata: string): boolean {
  return (SOURCE_ONLY_PRESET_METADATA as readonly string[]).includes(metadata)
}

export function formatSlicingPresetMetadata(profile: SlicingPresetSummary): string {
  const parts = [
    profile.nozzleDiameters?.length ? `Nozzle ${profile.nozzleDiameters.map((entry) => `${entry} mm`).join(', ')}` : null,
    profile.plateTypes?.length ? profile.plateTypes.map(formatPlateTypeLabel).join(', ') : null,
    profile.compatiblePrintersCondition ? 'Conditional printer compatibility' : null,
    profile.compatiblePrintsCondition ? 'Conditional quality compatibility' : null
  ].filter((entry): entry is string => Boolean(entry))
  return parts.length > 0 ? parts.join(' · ') : isProjectSlicingPreset(profile) ? '3MF project preset' : profile.source === 'custom' ? 'User preset' : 'System preset'
}

export function dedupeVisibleProcessProfiles(
  profiles: SlicingPresetSummary[],
  selectedMachineProfile: SlicingPresetSummary | null,
  model: string
): SlicingPresetSummary[] {
  const byDisplayName = new Map<string, SlicingPresetSummary>()
  for (const profile of profiles) {
    const key = formatSlicingPresetDisplayName(profile).trim().toLowerCase()
    const existing = byDisplayName.get(key)
    if (!existing) {
      byDisplayName.set(key, profile)
      continue
    }
    // The 3MF-embedded (project:) profile carries the project's overridden settings.
    // BambuStudio loads those embedded settings on open even when a same-named installed
    // preset exists, so never let a same-named installed preset displace it.
    const profileIsProject = isProjectSlicingPreset(profile)
    const existingIsProject = isProjectSlicingPreset(existing)
    if (profileIsProject !== existingIsProject) {
      if (profileIsProject) byDisplayName.set(key, profile)
      continue
    }
    if (scoreVisibleProcessProfile(profile, selectedMachineProfile, model) > scoreVisibleProcessProfile(existing, selectedMachineProfile, model)) {
      byDisplayName.set(key, profile)
    }
  }
  return [...byDisplayName.values()]
}

export function scoreVisibleProcessProfile(
  profile: SlicingPresetSummary,
  selectedMachineProfile: SlicingPresetSummary | null,
  model: string
): number {
  let score = profile.source === 'custom' ? 100 : 0
  if (matchesSelectedProcessPrimaryPrinterModel(profile, model)) score += 50
  if (matchesSelectedProcessMachineProfile(profile, selectedMachineProfile, model)) score += 30
  if (matchesSelectedProcessCompatiblePrinter(profile, model)) score += 20
  if ((profile.printerModels?.length ?? 0) > 0) score += 10
  if ((profile.compatiblePrinters?.length ?? 0) > 0) score += 5
  score -= (profile.printerModels?.length ?? 0) + (profile.compatiblePrinters?.length ?? 0)
  return score
}

export function matchesSelectedProcessPrimaryPrinterModel(profile: SlicingPresetSummary, model: string): boolean {
  if (model === 'unknown') return false
  const modelTargets = new Set(printerModelTextCandidates(model))
  return [profile.name, ...(profile.printerModels ?? [])].some((entry) => profileTextCandidates(entry).some((candidate) => modelTargets.has(candidate)))
}

export function matchesSelectedProcessCompatiblePrinter(profile: SlicingPresetSummary, model: string): boolean {
  if (model === 'unknown') return false
  const modelTargets = new Set(printerModelTextCandidates(model))
  return (profile.compatiblePrinters ?? []).some((entry) => profileTextCandidates(entry).some((candidate) => modelTargets.has(candidate)))
}

export function matchesSelectedProcessMachineProfile(
  profile: SlicingPresetSummary,
  selectedMachineProfile: SlicingPresetSummary | null,
  model: string
): boolean {
  if (!selectedMachineProfile) return false
  const selectedTargets = selectedPrinterCompatibilityTargets(selectedMachineProfile, model)
  return (profile.compatiblePrinters ?? []).some((entry) => entry.trim() === selectedMachineProfile.name || profileTargetMatchesSelectedPrinter(entry, selectedTargets))
}

export function formatPlateTypeLabel(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase() === 'PEI' ? 'PEI' : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function formatPrinterModelLabel(value: string): string {
  return value === 'unknown' ? 'Unknown' : value
}
