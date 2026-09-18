/**
 * Slicing-profile selection and display helpers shared by the slice/print flows.
 * Resolves baked profile names to installed, built-in, or 3MF-embedded
 * (`project:`) presets, mirroring how BambuStudio names, filters, and falls back
 * between presets, and maps the slice form's gating state to a disabled-reason
 * string. Project profiles carry the 3MF's saved overrides and are treated
 * specially so a user's authored settings survive through to the slicer.
 */
import {
  normalizeFilamentVendorLabel,
  isProjectSlicingPresetId,
  isSupportDisplayFilamentType,
  resolveDisplayFilamentType,
  type SlicingPresetSummary
} from '@printstream/shared'

export function isSelectableSlicingPreset(profile: SlicingPresetSummary): boolean {
  return !isProjectSlicingPresetId(profile.id)
}

/**
 * BambuStudio's `Preset::alias`: the preset name up to the first `@`, right-trimmed.
 *
 * IDENTITY, not display, and that distinction is the whole reason it exists separately. Both
 * formatters below consult `filamentVendor` (one PREPENDS the brand, the other STRIPS it) while
 * the same preset reaches us with that field populated (an installed profile) or absent (a project
 * preset minted from a 3MF, which records no vendor on the summary). So either formatter used as a
 * comparison key fails to match a preset against ITSELF, and in opposite directions: the branded
 * form breaks Polymaker ("Polymaker PolyLite PLA" vs "PolyLite PLA"), the display form breaks Bambu
 * ("PLA Basic" vs "Bambu PLA Basic"). Swapping one for the other only moves the bug.
 *
 * Mirrors `PresetCollection::set_custom_preset_alias` (`Preset.cpp`), which is what
 * `PreferedFilamentsProfileMatch` scores at INT_MAX when handing a material to a new machine.
 *
 * Lossy ON PURPOSE: two presets differing only past the `@` share an alias. That is what makes it
 * the right key for "the same product built for another machine" and the WRONG key for BINDING a
 * slot, which matches the raw name exactly (`find_preset_internal`).
 */
export function slicingPresetAlias(profile: SlicingPresetSummary): string {
  const atIndex = profile.name.indexOf('@')
  return (atIndex === -1 ? profile.name : profile.name.slice(0, atIndex)).trim() || profile.name.trim()
}

/**
 * Formats a profile label the way BambuStudio's `PlaterPresetComboBox` does:
 * filament presets display their alias (the name without the `@<printer>`
 * suffix, with the vendor prefix dropped), while every other preset kind
 * (process/quality, machine) displays the full preset name verbatim. Keeping
 * the full name for process profiles preserves user suffixes such as
 * "0.20mm Standard @BBL H2D - Ryan" so custom presets stay distinguishable from
 * the built-in preset they were derived from.
 */
export function formatSlicingPresetDisplayName(profile: SlicingPresetSummary): string {
  if (profile.kind !== 'filament') return profile.name.trim() || profile.name

  let displayName = profile.name.slice(0, profile.name.indexOf('@') === -1 ? undefined : profile.name.indexOf('@')).trim()
  if (!displayName) displayName = profile.name.trim()

  const vendor = profile.filamentVendor?.trim()
  if (vendor) {
    const vendorPrefix = `${normalizeFilamentVendorLabel(vendor)} `
    if (displayName.startsWith(vendorPrefix)) displayName = displayName.slice(vendorPrefix.length)
  }

  return displayName || profile.name
}

/**
 * The same alias, but BRAND-QUALIFIED, for labels that stand alone, with no vendor grouping
 * around them to supply the brand (the materials list rows, the material dialog's preset field).
 *
 * Why this exists rather than reusing {@link formatSlicingPresetDisplayName}: that one drops the
 * vendor because its callers are pickers that GROUP by vendor, so repeating it in every row is
 * noise. A standalone label has no such context, and dropping the vendor there made the SAME
 * material render differently depending on where its preset came from, an installed catalogue
 * preset declares `filamentVendor` and lost its prefix ("PLA Basic"), while the identical preset
 * carried inside a 3MF declares no vendor and kept it ("Bambu PLA Basic"). Provenance is not
 * something the user can see, so the two read as different materials.
 *
 * Prepends the vendor when the name omits it, so the result is stable whichever way the name
 * arrived. The `@<printer>` suffix is still dropped: it is a compatibility tag, not part of the
 * material's name.
 */
export function formatSlicingPresetBrandedName(profile: SlicingPresetSummary): string {
  if (profile.kind !== 'filament') return profile.name.trim() || profile.name

  const atIndex = profile.name.indexOf('@')
  const base = (atIndex === -1 ? profile.name : profile.name.slice(0, atIndex)).trim() || profile.name.trim()

  const vendor = profile.filamentVendor?.trim()
  if (!vendor) return base || profile.name
  const brand = normalizeFilamentVendorLabel(vendor)
  if (base === brand || base.startsWith(`${brand} `)) return base
  return `${brand} ${base}`
}

/**
 * Picker labels for a whole list, keyed by profile id, falling back to the FULL preset name for
 * any alias two profiles in that list share.
 *
 * {@link formatSlicingPresetDisplayName} drops everything from the `@` on, which is right for a
 * picker grouped by vendor, until two presets in the same list collapse onto one label. A
 * workspace preset derived from a built-in does exactly that ("Bambu PLA Basic @BBL H2D" and
 * "Bambu PLA Basic @BBL H2D - 55 degree plate" both render "Bambu PLA Basic"), and then the two
 * rows are not merely noisy, they are IMPOSSIBLE to choose between: the user cannot tell which
 * row is which, and the selected value reads the same either way.
 *
 * Only collisions pay: everything with a unique alias keeps the clean label. The qualifier is the
 * preset's real name rather than an invented suffix, because the whole failure here was a label
 * that showed less than the thing it identified.
 */
export function buildSlicingPresetLabels(profiles: SlicingPresetSummary[]): Map<string, string> {
  const byAlias = new Map<string, SlicingPresetSummary[]>()
  for (const profile of profiles) {
    const alias = formatSlicingPresetDisplayName(profile)
    const bucket = byAlias.get(alias)
    if (bucket) bucket.push(profile)
    else byAlias.set(alias, [profile])
  }

  const labels = new Map<string, string>()
  for (const [alias, bucket] of byAlias) {
    // Distinct NAMES, not distinct entries: the same preset appearing twice in a merged list is
    // not a collision the user has to resolve.
    const collides = new Set(bucket.map((profile) => profile.name.trim())).size > 1
    for (const profile of bucket) {
      labels.set(profile.id, collides ? profile.name.trim() || alias : alias)
    }
  }
  return labels
}

export function pickSelectableSlicingPresetByName(
  profiles: SlicingPresetSummary[],
  bakedName: string | null | undefined
): SlicingPresetSummary | null {
  const selectableProfiles = profiles.filter(isSelectableSlicingPreset)
  if (!bakedName) return null
  const normalizedBakedName = normalizedProfileText(bakedName)
  return selectableProfiles.find((profile) => normalizedProfileText(profile.name) === normalizedBakedName)
    ?? selectableProfiles.find((profile) => normalizedProfileText(profile.name).includes(normalizedBakedName) || normalizedBakedName.includes(normalizedProfileText(profile.name)))
    ?? null
}

/**
 * Resolves the 3MF-embedded (`project:`) process/machine profile that matches a
 * baked profile name. Unlike an identically-named installed preset, the project
 * profile carries the 3MF's saved overrides, so it is returned even when a
 * same-named installed preset exists; BambuStudio likewise loads the project's
 * embedded settings on open rather than substituting the system preset's
 * defaults. Callers that prefer this over the installed preset keep the user's
 * overrides (e.g. `wall_loops`) intact through to the slicer.
 */
export function pickProjectFallbackSlicingPresetByName(
  profiles: SlicingPresetSummary[],
  bakedName: string | null | undefined
): SlicingPresetSummary | null {
  if (!bakedName) return null
  const normalizedBakedName = normalizedProfileText(bakedName)
  return profiles.find((profile) => isProjectSlicingPresetId(profile.id) && normalizedProfileText(profile.name) === normalizedBakedName)
    ?? null
}

export function pickMostSimilarSlicingPresetByName(
  profiles: SlicingPresetSummary[],
  profileName: string | null | undefined
): SlicingPresetSummary | null {
  if (!profileName || profiles.length === 0) return null
  const normalizedTarget = normalizedProfileText(profileName)
  if (!normalizedTarget) return null
  const targetTokens = new Set(normalizedTarget.split(/\s+/).filter(Boolean))
  let bestProfile: SlicingPresetSummary | null = null
  let bestScore = -1

  for (const profile of profiles) {
    const normalizedCandidate = normalizedProfileText(profile.name)
    if (!normalizedCandidate) continue
    if (normalizedCandidate === normalizedTarget) return profile

    const candidateTokens = new Set(normalizedCandidate.split(/\s+/).filter(Boolean))
    let overlap = 0
    for (const token of targetTokens) {
      if (candidateTokens.has(token)) overlap += 1
    }

    const unionSize = new Set([...targetTokens, ...candidateTokens]).size
    const tokenScore = unionSize > 0 ? overlap / unionSize : 0
    const containmentBonus = normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate) ? 0.15 : 0
    const score = tokenScore + containmentBonus

    if (score > bestScore) {
      bestScore = score
      bestProfile = profile
    }
  }

  return bestProfile
}

export function isSelectableOrProjectFallbackSlicingPreset(
  profile: SlicingPresetSummary,
  profiles: SlicingPresetSummary[],
  bakedName: string | null | undefined
): boolean {
  return isSelectableSlicingPreset(profile)
    || pickProjectFallbackSlicingPresetByName(profiles, bakedName)?.id === profile.id
}

/**
 * Resolves the preset a preset FIELD names, `default_print_profile`,
 * `default_filament_profile`, against the catalogue. Matches any profile kind,
 * including project (3MF-embedded) profiles.
 *
 * Exact (normalized) only, deliberately. These fields are references inside
 * BambuStudio's own preset system, so the name either names an installed preset or
 * names nothing; a substring fallback here let a user's renamed derivative
 * ("0.20mm Standard @BBL H2D - Ryan") satisfy a reference to the builtin it was
 * derived from. A miss is a real answer: the caller falls through to its next
 * rule rather than slicing with a preset nobody chose (issue #68).
 */
export function pickSlicingPresetByDeclaredName(
  profiles: SlicingPresetSummary[],
  declaredName: string | null | undefined
): SlicingPresetSummary | null {
  const normalizedName = normalizedProfileText(declaredName ?? '')
  if (!normalizedName) return null
  return profiles.find((profile) => normalizedProfileText(profile.name) === normalizedName) ?? null
}

/**
 * A process preset's layer height as a display token (`0.20mm`).
 *
 * Prefers the preset's real `layer_height`, falling back to the name only for
 * presets that carry no such field (3MF project profiles, which expose just a
 * name). Reading the number rather than the name is what stops a user-renamed
 * preset from reporting the wrong height.
 */
export function resolveProfileLayerHeight(profile: SlicingPresetSummary): string | null {
  if (profile.layerHeight != null) return formatLayerHeightToken(profile.layerHeight)
  return extractLayerHeightToken(profile.name)
}

/** Format a layer height in mm as the `0.20mm` token used for display and comparison. */
export function formatLayerHeightToken(value: number): string {
  return `${value.toFixed(2)}mm`
}

/** Extracts the leading layer-height token (e.g. `0.20mm`) from a profile name. */
export function extractLayerHeightToken(value: string | null | undefined): string | null {
  return value?.toLowerCase().match(/\d+\.\d+\s*mm/)?.[0]?.replace(/\s+/g, '') ?? null
}

/**
 * Project (3MF-embedded) profiles bypass the normal printer-model compatibility
 * checks because they represent the settings the project was authored with.
 * BambuStudio still discards them when the selected printer is cross-family with
 * the project's source model, so this gate hides them in that case while leaving
 * installed/built-in profiles untouched.
 */
/**
 * Resolves the machine profile's `default_filament_profile` to a concrete
 * profile from the supplied (compatible) list, mirroring how BambuStudio picks
 * a fallback filament on a printer switch: the first declared default that is
 * available, preferring one whose filament type matches the project filament.
 *
 * `displayFilamentType` is the DERIVED type (`PLA-S`), and candidates are derived
 * the same way before comparing, a preset's raw `filament_type` is the base
 * polymer, so a raw-to-derived comparison never matches a support filament.
 * A support slot will not accept a model-filament default (or vice versa): the
 * caller falls through to its own next rule rather than silently printing
 * supports in model material.
 */
export function pickMachineDefaultFilamentProfile(
  profiles: SlicingPresetSummary[],
  machineProfile: SlicingPresetSummary | null,
  displayFilamentType: string | null | undefined
): SlicingPresetSummary | null {
  const defaults = machineProfile?.defaultFilamentProfiles ?? []
  if (defaults.length === 0) return null
  const candidates = defaults
    .map((name) => pickSlicingPresetByDeclaredName(profiles, name))
    .filter((profile): profile is SlicingPresetSummary => Boolean(profile))
  if (candidates.length === 0) return null

  const wantedType = displayFilamentType?.trim().toLowerCase()
  if (!wantedType) return candidates[0] ?? null

  // An ABSENT `filamentIsSupport` means unknown, never "not support", a catalogue
  // served by a slicer that predates the field carries none, and vetoing on it there
  // would leave every support slot with no default at all.
  const wantsSupport = isSupportDisplayFilamentType(wantedType)
  const eligible = candidates.filter((profile) => profile.filamentIsSupport == null
    || isSupportDisplayFilamentType(resolveDisplayFilamentType(profile)) === wantsSupport)
  if (eligible.length === 0) return null

  return eligible.find((profile) => resolveDisplayFilamentType(profile)?.trim().toLowerCase() === wantedType)
    ?? eligible[0]
    ?? null
}

/**
 * Pick the conventional default process preset for a fresh selection, the 0.20mm
 * "Standard" profile (BambuStudio's out-of-the-box default), so a new project lands on
 * 0.20mm Standard rather than whatever preset happens to be first in the list. Falls back
 * to a 0.20mm preset of any name if no explicit "Standard" exists.
 */
export function pickStandardProcessProfile(profiles: SlicingPresetSummary[]): SlicingPresetSummary | null {
  const twentyMicron = profiles.filter((profile) => resolveProfileLayerHeight(profile) === '0.20mm')
  const builtins = twentyMicron.filter((profile) => profile.source === 'builtin')
  // The quality TIER genuinely has no field of its own: BambuStudio encodes it in
  // the preset name ("0.20mm Standard @BBL X1C"), so this one stays a name read. A
  // user's derivative can carry the same words and catalogues list custom presets first;
  // the conventional DEFAULT must never silently become that custom profile.
  return builtins.find((profile) => profile.name.toLowerCase().includes('standard'))
    ?? builtins[0]
    ?? twentyMicron.find((profile) => profile.name.toLowerCase().includes('standard'))
    ?? twentyMicron[0]
    ?? null
}

function normalizedProfileText(value: string): string {
  return value.toLowerCase().replace(/bambu\s+lab/g, '').replace(/[^a-z0-9.]+/g, ' ').trim()
}

/** Inputs to {@link resolveSliceDisabledReason}: the slice form's gating signals. */
export interface SliceDisabledReasonInput {
  /** Whether the slice is fully valid (when true, there is no reason: returns null). */
  canSlice: boolean
  configured: boolean
  selectedSlicerTargetId: string
  /** Non-null when the slicer-profiles request failed (e.g. the slicer returned no presets). */
  profilesError: string | null
  /** Whether slicer capabilities/profiles/plate data have all finished loading. */
  slicerDataReady: boolean
  printerProfileId: string
  processProfileId: string
  /** Set-but-incompatible machine selection (id not in the target's compatible machine list). */
  printerProfileIncompatible: boolean
  /** Set-but-incompatible process selection (id not in the target's compatible process list). */
  processProfileIncompatible: boolean
  /**
   * The project was saved by a newer Bambu Studio than the selected engine, and the user has not
   * accepted the override. A genuine block: BambuStudio refuses to open the project at all, so no
   * other setting can rescue the slice.
   */
  blockedByProjectVersion?: boolean
  nozzleDiameterCount: number
  missingFilamentProfile: boolean
  /**
   * A slot's chosen material no longer exists in the options (e.g. the printer
   * changed and its AMS options were rebuilt). Distinguished from a slot that was
   * never chosen because the user already made a choice and needs telling it lapsed.
   */
  staleFilamentSelection?: boolean
  missingFilamentToolhead: boolean
  targetMode: 'realPrinter' | 'manualProfile'
  printerId: string
  submitting: boolean
}

/**
 * Maps the slice form's gating state to a single human-readable explanation for a
 * disabled Slice button, or null when slicing is allowed. The editor greys the
 * Slice button when {@link SliceDisabledReasonInput.canSlice} is false; without
 * this the user sees no reason why. Clauses are ordered to surface the first
 * blocking cause and mirror the `canSliceFromEditor` predicate, with the
 * slicer-loading/error states checked first.
 */
export function resolveSliceDisabledReason(input: SliceDisabledReasonInput): string | null {
  if (input.canSlice) return null
  if (!input.configured) return 'The slicer service isn’t available right now.'
  if (input.selectedSlicerTargetId.length === 0) return 'Choose a slicer version.'
  if (input.profilesError) return input.profilesError
  // Ahead of the per-field reasons: the engine refuses the file before it reads any setting, so
  // pointing at a field would send the user hunting for something that was never the problem.
  if (input.blockedByProjectVersion) return 'This project was saved by a newer Bambu Studio than the selected slicer.'
  if (!input.slicerDataReady) return 'Loading slicer data…'
  if (input.printerProfileId.length === 0) return 'No matching printer profile is installed for this printer and nozzle.'
  if (input.printerProfileIncompatible) return 'The selected printer profile doesn’t match the target printer.'
  if (input.processProfileId.length === 0) return 'Choose a print-settings profile.'
  if (input.processProfileIncompatible) return 'The selected print settings aren’t compatible with the target printer: choose a compatible profile.'
  if (input.nozzleDiameterCount === 0) return 'Choose a nozzle size.'
  if (input.staleFilamentSelection) return 'A material slot’s filament is no longer available: choose it again.'
  if (input.missingFilamentProfile) return 'Assign a filament to every material slot.'
  if (input.missingFilamentToolhead) return 'Assign a nozzle to every material slot.'
  if (input.targetMode === 'realPrinter' && input.printerId.length === 0) return 'Choose a printer to slice for.'
  if (input.submitting) return 'Slicing…'
  return 'Some slice settings are incomplete.'
}
