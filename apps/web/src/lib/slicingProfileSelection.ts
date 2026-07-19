/**
 * Slicing-profile selection and display helpers shared by the slice/print flows.
 * Resolves baked profile names to installed, built-in, or 3MF-embedded
 * (`project:`) presets — mirroring how BambuStudio names, filters, and falls back
 * between presets — and maps the slice form's gating state to a disabled-reason
 * string. Project profiles carry the 3MF's saved overrides and are treated
 * specially so a user's authored settings survive through to the slicer.
 */
import type { SlicingProfileSummary } from '@printstream/shared'

const PROJECT_SLICING_PROFILE_ID_PREFIX = 'project:'

export function isProjectSlicingProfileId(id: string): boolean {
  return id.startsWith(PROJECT_SLICING_PROFILE_ID_PREFIX)
}

export function isSelectableSlicingProfile(profile: SlicingProfileSummary): boolean {
  return !isProjectSlicingProfileId(profile.id)
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
export function formatSlicingProfileDisplayName(profile: SlicingProfileSummary): string {
  if (profile.kind !== 'filament') return profile.name.trim() || profile.name

  let displayName = profile.name.slice(0, profile.name.indexOf('@') === -1 ? undefined : profile.name.indexOf('@')).trim()
  if (!displayName) displayName = profile.name.trim()

  const vendor = profile.filamentVendor?.trim()
  if (vendor) {
    const vendorPrefix = `${vendor === 'Bambu Lab' ? 'Bambu' : vendor} `
    if (displayName.startsWith(vendorPrefix)) displayName = displayName.slice(vendorPrefix.length)
  }

  return displayName || profile.name
}

export function pickSelectableSlicingProfileByName(
  profiles: SlicingProfileSummary[],
  bakedName: string | null | undefined
): SlicingProfileSummary | null {
  const selectableProfiles = profiles.filter(isSelectableSlicingProfile)
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
export function pickProjectFallbackSlicingProfileByName(
  profiles: SlicingProfileSummary[],
  bakedName: string | null | undefined
): SlicingProfileSummary | null {
  if (!bakedName) return null
  const normalizedBakedName = normalizedProfileText(bakedName)
  return profiles.find((profile) => isProjectSlicingProfileId(profile.id) && normalizedProfileText(profile.name) === normalizedBakedName)
    ?? null
}

export function pickMostSimilarSlicingProfileByName(
  profiles: SlicingProfileSummary[],
  profileName: string | null | undefined
): SlicingProfileSummary | null {
  if (!profileName || profiles.length === 0) return null
  const normalizedTarget = normalizedProfileText(profileName)
  if (!normalizedTarget) return null
  const targetTokens = new Set(normalizedTarget.split(/\s+/).filter(Boolean))
  let bestProfile: SlicingProfileSummary | null = null
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

export function isSelectableOrProjectFallbackSlicingProfile(
  profile: SlicingProfileSummary,
  profiles: SlicingProfileSummary[],
  bakedName: string | null | undefined
): boolean {
  return isSelectableSlicingProfile(profile)
    || pickProjectFallbackSlicingProfileByName(profiles, bakedName)?.id === profile.id
}

/**
 * Resolves a profile by its baked (full) name: exact normalized match first,
 * then a substring match in either direction. Matches any profile kind,
 * including project (3MF-embedded) profiles.
 */
export function pickSlicingProfileByBakedName(
  profiles: SlicingProfileSummary[],
  bakedName: string | null | undefined
): SlicingProfileSummary | null {
  if (!bakedName) return null
  const normalizedBakedName = normalizedProfileText(bakedName)
  return profiles.find((profile) => normalizedProfileText(profile.name) === normalizedBakedName)
    ?? profiles.find((profile) => normalizedProfileText(profile.name).includes(normalizedBakedName) || normalizedBakedName.includes(normalizedProfileText(profile.name)))
    ?? null
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
 */
export function pickMachineDefaultFilamentProfile(
  profiles: SlicingProfileSummary[],
  machineProfile: SlicingProfileSummary | null,
  filamentType: string | null | undefined
): SlicingProfileSummary | null {
  const defaults = machineProfile?.defaultFilamentProfiles ?? []
  if (defaults.length === 0) return null
  const candidates = defaults
    .map((name) => pickSlicingProfileByBakedName(profiles, name))
    .filter((profile): profile is SlicingProfileSummary => Boolean(profile))
  if (candidates.length === 0) return null
  const normalizedType = filamentType?.trim().toLowerCase()
  if (normalizedType) {
    const typed = candidates.find((profile) => (profile.filamentType ?? '').trim().toLowerCase() === normalizedType)
    if (typed) return typed
  }
  return candidates[0] ?? null
}

/**
 * Pick the conventional default process preset for a fresh selection — the 0.20mm
 * "Standard" profile (BambuStudio's out-of-the-box default) — so a new project lands on
 * 0.20mm Standard rather than whatever preset happens to be first in the list. Falls back
 * to a 0.20mm preset of any name if no explicit "Standard" exists.
 */
export function pickStandardProcessProfile(profiles: SlicingProfileSummary[]): SlicingProfileSummary | null {
  const twentyMicron = profiles.filter((profile) => extractLayerHeightToken(profile.name) === '0.20mm')
  return twentyMicron.find((profile) => profile.name.toLowerCase().includes('standard')) ?? twentyMicron[0] ?? null
}

function normalizedProfileText(value: string): string {
  return value.toLowerCase().replace(/bambu\s+lab/g, '').replace(/[^a-z0-9.]+/g, ' ').trim()
}

/** Inputs to {@link resolveSliceDisabledReason}: the slice form's gating signals. */
export interface SliceDisabledReasonInput {
  /** Whether the slice is fully valid (when true, there is no reason — returns null). */
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
  nozzleDiameterCount: number
  missingFilamentProfile: boolean
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
  if (!input.slicerDataReady) return 'Loading slicer data…'
  if (input.printerProfileId.length === 0) return 'No matching printer profile is installed for this printer and nozzle.'
  if (input.printerProfileIncompatible) return 'The selected printer profile doesn’t match the target printer.'
  if (input.processProfileId.length === 0) return 'Choose a print-settings profile.'
  if (input.processProfileIncompatible) return 'The selected print settings aren’t compatible with the target printer — choose a compatible profile.'
  if (input.nozzleDiameterCount === 0) return 'Choose a nozzle size.'
  if (input.missingFilamentProfile) return 'Assign a filament to every material slot.'
  if (input.missingFilamentToolhead) return 'Assign a nozzle to every material slot.'
  if (input.targetMode === 'realPrinter' && input.printerId.length === 0) return 'Choose a printer to slice for.'
  if (input.submitting) return 'Slicing…'
  return 'Some slice settings are incomplete.'
}