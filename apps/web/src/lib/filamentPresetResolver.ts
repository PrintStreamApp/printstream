/**
 * The single answer to "which filament preset is this slot?".
 *
 * Owns filament-preset resolution for every slice/print surface: an AMS slot, an
 * external spool, or a 3MF project filament, resolved against the workspace's
 * merged preset catalogue. Replaces the scattered name matchers that each
 * answered the question slightly differently (issue #66).
 *
 * Contract callers rely on:
 * - The result is an **identity**, not a name: a resolved preset id plus its
 *   provenance and the signal that matched it. Names are display text and must
 *   never travel onward as identity: writing a display name where a preset name
 *   belongs is what overwrote a project's `filament_settings_id` with a string no
 *   catalogue contains, failing the settings-repair export and segfaulting the CLI.
 * - **Unresolved is a first-class result, never a silent fallback.** A slot that
 *   matches nothing returns `status: 'unresolved'` with a reason the UI can show
 *   and the request can refuse. There is no "closest preset" consolation match.
 * - Matching prefers real preset fields over text. `filament_id` is an exact join
 *   against the AMS tray id; `filament_type` and `filament_is_support` are hard
 *   vetoes, then an exact DERIVED-type match, then the polymer family. Name
 *   comparison survives only where the name is stored intent (a spool's pinned
 *   preset, a slot's own embedded preset), never as a substring, and never as a
 *   contributor to printer-model matching.
 *
 * Counterpart: the catalogue this resolves against comes from `/api/slicing/profiles`
 * (`apps/api/src/routes/slicing.ts`), whose builtin half is minted by the slicer's
 * `listBuiltinProfiles`. `resolveDisplayFilamentType` in `@printstream/shared` is
 * the shared derivation both sides type filaments through.
 */
import {
  isProjectSlicingPresetId,
  isSupportDisplayFilamentType,
  normalizeFilamentFamily,
  resolveDisplayFilamentType,
  slicingPresetProvenance,
  type SlicingPresetProvenance,
  type SlicingPresetSummary
} from '@printstream/shared'
import { formatSlicingPresetBrandedName, pickMachineDefaultFilamentProfile, slicingPresetAlias } from './slicingPresetSelection'
import {
  declaresIncompatiblePrinterModel,
  matchesCompatiblePrinters,
  matchesProfileNozzleTarget,
  resolveMachineProfileNozzleDiameters
} from './profilePrinterCompatibility'

/** Which signal identified the preset, strongest first. Surfaced for diagnostics and tests. */
export type FilamentPresetMatchSignal =
  /** The slot's own 3MF-embedded preset, minted from this very slot: identity, not a match. */
  | 'projectPreset'
  /** The AMS tray's `filament_id` (`GFA00`) joined a preset's `filament_id` exactly. */
  | 'filamentId'
  /** The spool's user-pinned slicing preset. */
  | 'pinnedPreset'
  /** The preset name matched the tray's RFID name or the project's baked preset name. */
  | 'presetName'
  /** The selected machine's declared `default_filament_profile`, on a cross-family switch. */
  | 'machineDefault'
  /** The DERIVED filament types matched exactly (`PLA-CF` to `PLA-CF`, not to plain `PLA`). */
  | 'filamentType'
  /** Only the filament family agreed (a custom "PLA" tray picking a PLA preset for this machine). */
  | 'filamentFamily'

/** Why a slot could not be identified. Each maps to user-facing copy at the call site. */
export type FilamentPresetUnresolvedReason =
  /** No preset in the catalogue carries any signal this slot identifies with. */
  | 'noMatch'
  /** The catalogue is empty or has not loaded yet: retry rather than report a bad slot. */
  | 'noCatalogue'

export type FilamentPresetResolution =
  | {
      status: 'resolved'
      /** The preset's id. This, not `profile.name`, is what travels in a slice request. */
      profileId: string
      provenance: SlicingPresetProvenance
      matchedBy: FilamentPresetMatchSignal
      profile: SlicingPresetSummary
    }
  | {
      status: 'unresolved'
      reason: FilamentPresetUnresolvedReason
    }

export interface FilamentPresetQuery {
  /** The tray's RFID/user-set name, if any. */
  trayName: string | null
  /** The tray's Bambu filament id (`GFA00`); the strongest available signal. */
  trayInfoIdx: string | null
  /** The tray's reported filament type, in BambuStudio's DERIVED spelling (`PLA-S`). */
  trayFilamentType: string | null
  /** A spool's user-pinned preset name, which wins outright when it resolves. */
  pinnedPresetName?: string | null
  /** The selected machine preset, used only to RANK equally-identified presets. */
  selectedMachineProfile: SlicingPresetSummary | null
  /** The selected printer model key, used only to RANK equally-identified presets. */
  selectedPrinterModel: string
}

/**
 * Resolve the filament preset for one slot.
 *
 * Machine compatibility only ever RANKS presets the slot already identifies; it
 * can never select one on its own. Without that rule an unidentified custom tray
 * took whichever machine-compatible preset sorted first, mislabelling a plain PLA
 * spool as "ASA - Custom".
 */
export function resolveFilamentPreset(
  profiles: SlicingPresetSummary[],
  query: FilamentPresetQuery
): FilamentPresetResolution {
  const filamentProfiles = profiles.filter((profile) => profile.kind === 'filament')
  if (filamentProfiles.length === 0) return { status: 'unresolved', reason: 'noCatalogue' }

  // A user's explicit pin outranks every derived signal. The caller's catalogue is
  // already machine-filtered, so a pin that no longer applies simply misses here
  // and falls through to the derived match rather than forcing an invalid preset.
  const pinned = findPresetByName(filamentProfiles, query.pinnedPresetName)
  if (pinned) return resolved(pinned, 'pinnedPreset')

  let best: { profile: SlicingPresetSummary; candidate: FilamentPresetCandidate } | null = null
  for (const profile of filamentProfiles) {
    const candidate = scoreFilamentPreset(profile, query)
    if (!candidate) continue
    if (best && !outranks(candidate, best.candidate)) continue
    best = { profile, candidate }
  }

  if (!best) return { status: 'unresolved', reason: 'noMatch' }
  return resolved(best.profile, best.candidate.signal)
}

function resolved(profile: SlicingPresetSummary, matchedBy: FilamentPresetMatchSignal): FilamentPresetResolution {
  return {
    status: 'resolved',
    profileId: profile.id,
    // A catalogue preset that predates the unified id codec still classifies by its
    // `custom:`/`builtin:` prefix; anything unrecognised is treated as workspace-owned.
    provenance: slicingPresetProvenance(profile.id) ?? (profile.source === 'builtin' ? 'builtin' : 'workspace'),
    matchedBy,
    profile
  }
}

/** A 3MF project filament slot, as the index parser reports it. */
export interface ProjectFilamentPresetQuery {
  /** The slot's baked `filament_settings_id`: the preset the project itself names. */
  presetName: string | null
  /** The slot's raw `filament_type` (`PLA`), NOT the derived display type. */
  filamentType: string | null
  /** The slot's `filament_is_support` flag; null when the 3MF carried none. */
  isSupport: boolean | null
  /** The selected machine preset: the authority for what the slice targets. */
  selectedMachineProfile: SlicingPresetSummary | null
  /** The selected printer model key, used only to RANK equally-identified presets. */
  selectedPrinterModel: string
}

/**
 * Resolve the preset for one 3MF project filament slot.
 *
 * The project-side counterpart of {@link resolveFilamentPreset}: a slot in the file
 * rather than a slot in the AMS. Ordered so every step is a real-field decision:
 * the slot's own embedded preset, then identity against the installed catalogue,
 * then the machine's DECLARED default on a cross-family switch. Nothing here
 * substring-matches a type into a preset name, which is how a plain `PLA` slot used
 * to land on whichever preset happened to spell "PLA" first (`PLA Aero`, or a
 * support PLA) (issues #66, #68).
 *
 * The project's own preset wins outright when it is present: it was minted from
 * this slot and carries the settings the file was authored with, so substituting an
 * identically-named installed preset would silently drop the user's overrides.
 * Project presets belonging to OTHER slots are excluded from the later steps, a
 * project preset is only ever the identity of the slot that produced it.
 */
export function resolveProjectFilamentPreset(
  profiles: SlicingPresetSummary[],
  query: ProjectFilamentPresetQuery
): FilamentPresetResolution {
  const filamentProfiles = profiles.filter((profile) => profile.kind === 'filament')
  if (filamentProfiles.length === 0) return { status: 'unresolved', reason: 'noCatalogue' }

  const presetName = normalizePresetText(query.presetName)
  const own = presetName
    ? filamentProfiles.find((profile) => isProjectSlicingPresetId(profile.id) && normalizePresetText(profile.name) === presetName)
    : null
  if (own) return resolved(own, 'projectPreset')

  // Derived on both sides: the slot states `PLA` + `filament_is_support`, the picker
  // and every preset filter speak the `PLA-S` BambuStudio displays.
  const displayType = resolveDisplayFilamentType({
    filamentType: query.filamentType,
    filamentIsSupport: query.isSupport
  }) ?? null

  const installed = filamentProfiles.filter((profile) => !isProjectSlicingPresetId(profile.id))

  // The file NAMES its preset, so binding to an INSTALLED preset of that exact name is a lookup and
  // must happen before any ranking, this is BambuStudio's whole binding step
  // (`PresetCollection::load_external_preset` -> `find_preset_internal(original_name)`, no scoring).
  // Structural rather than incidental: the ranked path below can reach the same answer, but it
  // ranks `filamentId` ABOVE `presetName`, and a workspace preset that inherits a built-in carries
  // the same filament id. The two then tie and catalogue order decides, which is how a project
  // that names the built-in bound to an inheriting variant and reported settings the user never
  // changed. Requires `query.presetName` to be the RAW `filament_settings_id`; the display name
  // strips the machine suffix and matches nothing here.
  const exact = presetName
    ? installed.find((profile) => normalizePresetText(profile.name) === presetName)
    : null
  if (exact) return resolved(exact, 'presetName')
  const derived = installed.length > 0
    ? resolveFilamentPreset(installed, {
        trayName: query.presetName,
        trayInfoIdx: null,
        trayFilamentType: displayType,
        selectedMachineProfile: query.selectedMachineProfile,
        selectedPrinterModel: query.selectedPrinterModel
      })
    : ({ status: 'unresolved', reason: 'noMatch' } as const)
  if (derived.status === 'resolved' && derived.matchedBy === 'presetName') return derived

  // The project's preset is filtered out of a cross-family catalogue (an X1C project
  // sliced on an H2D), leaving only a family-level match. BambuStudio falls back to
  // the target machine's own default filament there, so mirror it, and prefer it
  // over the weaker family signal, which is what `derived` still holds.
  const machineDefault = pickMachineDefaultFilamentProfile(installed, query.selectedMachineProfile, displayType)
  if (machineDefault) return resolved(machineDefault, 'machineDefault')
  return derived
}

interface FilamentPresetCandidate {
  signal: FilamentPresetMatchSignal
}

/**
 * Identity signals in precedence order, strongest first: the INDEX is the rank.
 *
 * This used to be arithmetic: each signal contributed a spaced score (1000 / 500 / 300 / 200) that
 * the machine rank (max 100) was added to, relying on the gaps being wider than anything that could
 * be added. That invariant lived only in a comment, and adding a further term is enough to break it
 * silently. Comparing the two axes in order says the same thing structurally, so precedence cannot
 * be perturbed by a new addend.
 *
 * Only the DERIVED signals appear here; `pinnedPreset`, `projectPreset` and `machineDefault` are
 * returned directly by their resolvers and never compete.
 */
const IDENTITY_PRECEDENCE: readonly FilamentPresetMatchSignal[] = [
  'filamentId', 'presetName', 'filamentType', 'filamentFamily'
]

function identityRank(signal: FilamentPresetMatchSignal): number {
  const rank = IDENTITY_PRECEDENCE.indexOf(signal)
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank
}

/**
 * Identity precedence, and nothing else. Strictly stronger, so equally-identified presets keep the
 * earlier one (catalogue order).
 *
 * The printer axis contributes no ranking at all, it is entirely filters (see
 * {@link scoreFilamentPreset}). A "declares my printer beats declares nothing" preference briefly
 * lived here for presets carrying no compatibility, but that case does not arise: a preset with an
 * `inherits` parent is served with the parent's `compatiblePrinters` merged in (see
 * `resolveProfileMetadata` in the API's slicing-profiles), which is our equivalent of BambuStudio
 * inheriting compatibility from an `@base` preset. A live catalogue of 2901 filament presets, 42 of
 * them workspace-authored, had zero that declared neither field.
 */
function outranks(candidate: FilamentPresetCandidate, best: FilamentPresetCandidate): boolean {
  return identityRank(candidate.signal) < identityRank(best.signal)
}

/**
 * Score one preset against the slot, or return `null` when the preset is vetoed
 * or carries no identifying signal at all.
 */
function scoreFilamentPreset(profile: SlicingPresetSummary, query: FilamentPresetQuery): FilamentPresetCandidate | null {
  if (isVetoedByMaterial(profile, query.trayFilamentType)) return null
  // Compatibility is a FILTER, not a ranking. A preset that declares it targets a different printer
  // cannot represent this slot at any score, and BambuStudio never offers one, it evaluates
  // `compatible_printers` when loading the bundle, so an incompatible preset is not in the list to
  // be chosen from. We used to keep it eligible and merely outscore it, which meant the pick
  // depended on catalogue order whenever the identity signals tied. Presets declaring no target at
  // all stay eligible; absence of evidence is not a mismatch.
  // Only ever REJECTS with a machine to judge against. `matchesCompatiblePrinters` answers false for
  // a null machine (its catalogue-filter contract: "cannot confirm"), which as a veto rejects every
  // preset that declares a printer, that is all of them, and leaves every slot unresolved, so the
  // UI falls back to a bare filament type and the material appears to lose its brand. Callers do
  // resolve without a machine: the session's initial seed, and any render between switching printer
  // model and the new machine profile resolving. No machine means no judgement, not no match.
  if (query.selectedMachineProfile && !matchesCompatiblePrinters(profile, query.selectedMachineProfile, query.selectedPrinterModel)) return null
  // Both printer axes: a preset can name its target in `compatible_printers` or in `printer_model`,
  // and the check above reads only the first. Covering the second by model KEY is what the deleted
  // machine ranking was quietly doing, an A1-mini preset otherwise satisfies an A1, since "a1" sits
  // inside "a1 mini" at a legitimate token boundary.
  if (declaresIncompatiblePrinterModel(profile, query.selectedMachineProfile, query.selectedPrinterModel)) return null
  // Nozzle completes the compatibility filter, matching BambuStudio: its `compatible_printers`
  // entries name the machine INCLUDING the nozzle ("Bambu Lab A1 0.6 nozzle"), so a preset built for
  // another nozzle is not a candidate at all. Vendors do not publish every combination, an A1 has
  // no 0.6 Bambu PLA preset, which is exactly why the CALLER must have a fallback: BambuStudio's
  // update_compatible(Always) re-selects some compatible preset rather than leaving the slot empty
  // (see resolveProjectFilamentPreset).
  if (!matchesProfileNozzleTarget(profile, query.selectedMachineProfile, query.selectedMachineProfile ? resolveMachineProfileNozzleDiameters(query.selectedMachineProfile) : [])) return null

  const signal = scoreIdentity(profile, query)
  if (!signal) return null

  return { signal }
}

/**
 * Hard material vetoes. A preset of a different polymer family can never
 * represent the tray no matter how machine-compatible it is, and a dedicated
 * support filament is not interchangeable with a model filament of the same
 * polymer, a `PLA-S` tray resolving to "Bambu PLA Basic" would slice supports
 * with model material (and vice versa) with no warning.
 */
function isVetoedByMaterial(profile: SlicingPresetSummary, trayFilamentType: string | null): boolean {
  const trayFamily = normalizeFilamentFamily(trayFilamentType)
  const profileFamily = normalizeFilamentFamily(profile.filamentType ?? null)
  if (trayFamily && profileFamily && profileFamily !== trayFamily) return true

  // Only veto on the support axis when the tray actually states a type; a tray
  // with no reported type tells us nothing about which side it belongs on.
  if (!trayFilamentType?.trim()) return false
  // An ABSENT flag means unknown, never "not support", a preset catalogue served
  // by a slicer older than `filamentIsSupport` carries none, and inferring `false`
  // there would veto every preset for a support tray and block the slice outright.
  // Unknown stays lenient; the veto engages once the flag is actually carried.
  if (profile.filamentIsSupport == null) return false
  return isSupportDisplayFilamentType(trayFilamentType) !== profile.filamentIsSupport
}

/** The identifying signal this preset carries for the slot, or null when it carries none. */
function scoreIdentity(profile: SlicingPresetSummary, query: FilamentPresetQuery): FilamentPresetMatchSignal | null {
  // Exact id join. Bambu filament ids are opaque tokens (`GFA00`), so they are
  // compared verbatim, normalizing them, or routing them through a catalogue
  // NAME and re-matching that, only loses precision.
  const trayFilamentId = query.trayInfoIdx?.trim()
  // A DERIVATIVE is excluded here, not merely outranked. A `filament_id` identifies the filament
  // PRODUCT, and every preset derived from that product inherits the id, six workspace presets in
  // one test workspace carry GFA00 alongside the built-in "Bambu PLA Basic", so the id cannot tell
  // them apart, and the winner fell to catalogue order (customs first). Picking a derivative applies
  // settings the user tuned for another situation to a slice they only said "this is the filament in
  // my AMS" about.
  //
  // This mirrors BambuStudio rather than inventing a precedence: `AMSMaterialsSetting::
  // get_filament_by_id`, the path that picks a preset to APPLY for a tray, skips any preset that
  // is not its own base (`filaments.get_preset_base(preset) != &preset`) before comparing
  // `filament_id`. (Its `PresetBundle::get_filament_by_filament_id` sibling does allow children, but
  // only ever returns basic INFO, name/type/vendor, which its own comment notes is identical
  // between parent and child.) A user who wants their derivative pins it on the spool, which
  // outranks every derived signal above.
  if (trayFilamentId && !profile.derivedFromPresetName && (profile.filamentIds ?? []).includes(trayFilamentId)) {
    return 'filamentId'
  }

  const trayName = normalizePresetText(query.trayName)
  // The preset's own name, OR its ALIAS. A 3MF's `filament_settings_id` is the alias BambuStudio
  // displays ("Bambu PETG HF"), while the installed preset carries its machine suffix ("Bambu PETG
  // HF @BBL H2D 0.4 nozzle"), so a name-only comparison never matches a project's filament to the
  // catalogue, and the slot falls through to the machine default, turning a PETG project's material
  // into Bambu PLA Basic. BambuStudio matches on alias for the same reason (PreferedProfileMatch
  // gives an alias hit priority over everything else).
  //
  // Three forms, because the name can arrive in any of them. `slicingPresetAlias` is the one
  // BambuStudio itself compares and the only one derived from the NAME alone: the branded form
  // prepends `filament_vendor`, which an installed preset declares and a 3MF's
  // `filament_settings_id` never carries, so it could not match a third-party product whose brand
  // is not already the first word of its name ("Polymaker PolyLite PLA" against the project's
  // "PolyLite PLA"). That slot then fell through to the family match and resolved to whichever PLA
  // the catalogue happened to offer. The branded form stays because it covers the reverse case: an
  // RFID tray name carrying a vendor the preset name omits.
  if (trayName && (normalizePresetText(profile.name) === trayName
    || normalizePresetText(slicingPresetAlias(profile)) === trayName
    || normalizePresetText(formatSlicingPresetBrandedName(profile)) === trayName)) {
    return 'presetName'
  }

  // The derived types agree exactly. Ranked above a family match because the family
  // table folds every variant into its base polymer: a plain PLA slot and a
  // `PLA-CF` preset are both family PLA, and letting them tie left the winner to
  // list order, a composite (hardened-nozzle) filament for an ordinary slot.
  const trayType = query.trayFilamentType?.trim().toLowerCase()
  const profileType = resolveDisplayFilamentType(profile)?.trim().toLowerCase()
  if (trayType && profileType && trayType === profileType) {
    return 'filamentType'
  }

  // Weakest signal: the families simply agree. Enough to pick a sensible preset for
  // a custom/unbranded spool, never enough to claim a specific product.
  const trayFamily = normalizeFilamentFamily(query.trayFilamentType)
  const profileFamily = normalizeFilamentFamily(profile.filamentType ?? null)
  if (trayFamily && profileFamily && trayFamily === profileFamily) {
    return 'filamentFamily'
  }

  return null
}

/**
 * Find a preset by an exact name, for the one case where a NAME is the user's
 * stored intent rather than a derived guess: a spool pinned to a preset.
 *
 * Kept deliberately strict (exact, normalized): the pin is stored text, so a
 * fuzzy match here would silently substitute a different product.
 */
function findPresetByName(profiles: SlicingPresetSummary[], name: string | null | undefined): SlicingPresetSummary | null {
  const normalized = normalizePresetText(name)
  if (!normalized) return null
  return profiles.find((profile) => normalizePresetText(profile.name) === normalized) ?? null
}

/**
 * Case- and punctuation-insensitive preset-name normalization.
 *
 * The single normalizer for preset text. Three near-duplicates used to exist with
 * subtly different rules (one stripped `bambu lab`, one kept `@`), so a name
 * normalized by one was not comparable to the same name normalized by another.
 */
export function normalizePresetText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}
