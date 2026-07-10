import { normalizeFilamentFamily, type SlicingProfileSummary } from '@printstream/shared'
import { filamentPresetNameFromId } from '../data/bambuFilamentPresets'

interface LoadedMaterialProfileSelectionInput {
  trayName: string | null
  trayInfoIdx: string | null
  /** The tray's reported filament type ("PLA"); vetoes profiles of a different family. */
  trayFilamentType: string | null
  mappedPresetName: string | null
  selectedMachineProfile: SlicingProfileSummary | null
  selectedPrinterModel: string
}

/**
 * Prefer the most printer-specific compatible filament profile for an AMS slot.
 * BambuStudio first syncs against the tray's filament id, then upgrades to a
 * compatible printer-specific preset for the selected machine when available.
 *
 * A profile is only eligible when the tray actually identifies it: its filament
 * family must not conflict with the tray's reported type, and at least one
 * identity signal (filament id, preset/tray name, family, or type agreement)
 * must score. Machine compatibility alone never selects a profile — that is
 * what used to label an unidentified custom PLA tray with whichever
 * machine-compatible profile sorted first (e.g. "ASA - Custom").
 */
export function pickLoadedMaterialProfile(
  profiles: SlicingProfileSummary[],
  input: LoadedMaterialProfileSelectionInput
): SlicingProfileSummary | null {
  const normalizedTrayInfoIdx = normalizeProfileText(input.trayInfoIdx ?? '')
  const normalizedTrayName = normalizeProfileText(input.trayName ?? '')
  const normalizedMappedPresetName = normalizeProfileText(input.mappedPresetName ?? '')
  const normalizedPresetFamily = normalizeProfileFamily(input.mappedPresetName ?? input.trayName ?? '')
  const trayTypeFamily = normalizeFilamentFamily(input.trayFilamentType)

  let best: SlicingProfileSummary | null = null
  let bestScore = 0

  for (const profile of profiles) {
    const score = scoreLoadedMaterialProfile(profile, {
      normalizedTrayInfoIdx,
      normalizedTrayName,
      normalizedMappedPresetName,
      normalizedPresetFamily,
      trayTypeFamily,
      selectedMachineProfile: input.selectedMachineProfile,
      selectedPrinterModel: input.selectedPrinterModel
    })
    if (score <= bestScore) continue
    best = profile
    bestScore = score
  }

  return best
}

export function resolveLoadedMaterialPreset(
  profiles: SlicingProfileSummary[],
  input: Omit<LoadedMaterialProfileSelectionInput, 'mappedPresetName'>
): { name: string | null; profile: SlicingProfileSummary | null } {
  const mappedPresetName = filamentPresetNameFromId(input.trayInfoIdx)
  const profile = pickLoadedMaterialProfile(profiles, {
    ...input,
    mappedPresetName
  })
  return {
    name: profile?.name ?? mappedPresetName ?? input.trayName?.trim() ?? null,
    profile
  }
}

function scoreLoadedMaterialProfile(
  profile: SlicingProfileSummary,
  input: {
    normalizedTrayInfoIdx: string
    normalizedTrayName: string
    normalizedMappedPresetName: string
    normalizedPresetFamily: string
    trayTypeFamily: string | null
    selectedMachineProfile: SlicingProfileSummary | null
    selectedPrinterModel: string
  }
): number {
  const normalizedName = normalizeProfileText(profile.name)

  // Hard veto: a profile of a different filament family can never represent the
  // tray, no matter how machine-compatible it is (PLA tray ≠ ASA profile).
  const profileTypeFamily = normalizeFilamentFamily(profile.filamentType ?? null)
  if (input.trayTypeFamily && profileTypeFamily && profileTypeFamily !== input.trayTypeFamily) {
    return 0
  }

  let identityScore = 0
  if (
    input.normalizedTrayInfoIdx
    && (profile.filamentIds ?? []).some((id) => normalizeProfileText(id) === input.normalizedTrayInfoIdx)
  ) {
    identityScore += 40
  }
  if (input.normalizedMappedPresetName && normalizedName === input.normalizedMappedPresetName) {
    identityScore += 25
  }
  if (input.normalizedTrayName && normalizedName === input.normalizedTrayName) {
    identityScore += 20
  }
  if (input.normalizedPresetFamily && normalizeProfileFamily(profile.name) === input.normalizedPresetFamily) {
    identityScore += 10
  }
  // Weak identity: the profile's own filament family agrees with the tray's
  // reported type — lets a custom "PLA" tray pick a PLA profile for the machine.
  if (input.trayTypeFamily && profileTypeFamily && profileTypeFamily === input.trayTypeFamily) {
    identityScore += 15
  }

  // No identity signal at all → not selectable; machine bonuses only rank
  // among profiles the tray already identifies.
  if (identityScore === 0) return 0

  let score = identityScore
  const exactMachineMatch = matchesExactMachineProfile(profile, input.selectedMachineProfile)
  if (exactMachineMatch) score += 100
  if (matchesSelectedMachineProfile(profile, input.selectedMachineProfile, input.selectedPrinterModel)) {
    score += 60
  }
  if (matchesSelectedPrinterModel(profile, input.selectedPrinterModel)) {
    score += 40
  }
  if ((profile.compatiblePrinters?.length ?? 0) > 0) score += 10
  if ((profile.printerModels?.length ?? 0) > 0) score += 5

  return score
}

function matchesExactMachineProfile(
  profile: SlicingProfileSummary,
  selectedMachineProfile: SlicingProfileSummary | null
): boolean {
  if (!selectedMachineProfile) return false
  const normalizedMachineName = normalizeProfileText(selectedMachineProfile.name)
  return (profile.compatiblePrinters ?? []).some((entry) => normalizeProfileText(entry) === normalizedMachineName)
}

function matchesSelectedMachineProfile(
  profile: SlicingProfileSummary,
  selectedMachineProfile: SlicingProfileSummary | null,
  selectedPrinterModel: string
): boolean {
  if (!selectedMachineProfile) return false
  const selectedTargets = [
    selectedMachineProfile.name,
    ...(selectedMachineProfile.compatiblePrinters ?? []),
    selectedPrinterModel
  ].filter(Boolean)
  return (profile.compatiblePrinters ?? []).some((entry) =>
    selectedTargets.some((target) => profileTargetMatches(entry, target))
  )
}

function matchesSelectedPrinterModel(profile: SlicingProfileSummary, selectedPrinterModel: string): boolean {
  if (!selectedPrinterModel || selectedPrinterModel === 'unknown') return false
  return [profile.name, ...(profile.printerModels ?? []), ...(profile.compatiblePrinters ?? [])].some((entry) =>
    profileTargetMatches(entry, selectedPrinterModel)
  )
}

function profileTargetMatches(left: string, right: string): boolean {
  const leftCandidates = profileTextCandidates(left)
  const rightCandidates = profileTextCandidates(right)
  return leftCandidates.some((leftCandidate) =>
    rightCandidates.some((rightCandidate) => leftCandidate.includes(rightCandidate) || rightCandidate.includes(leftCandidate))
  )
}

function normalizeProfileFamily(value: string): string {
  const base = value.split('@')[0]?.trim() ?? value
  return normalizeProfileText(base)
}

/** Case/punctuation-insensitive profile-name normalization (also used to match a spool's stored preset name). */
export function normalizeProfileText(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

function profileTextCandidates(value: string): string[] {
  const normalized = normalizeProfileText(value)
  if (!normalized) return []
  const compact = normalized.replace(/\s+/g, '')
  return compact === normalized ? [normalized] : [normalized, compact]
}