import type { SlicingProfileSummary } from '@printstream/shared'
import { filamentPresetNameFromId } from '../data/bambuFilamentPresets'

interface LoadedMaterialProfileSelectionInput {
  trayName: string | null
  trayInfoIdx: string | null
  mappedPresetName: string | null
  selectedMachineProfile: SlicingProfileSummary | null
  selectedPrinterModel: string
}

/**
 * Prefer the most printer-specific compatible filament profile for an AMS slot.
 * BambuStudio first syncs against the tray's filament id, then upgrades to a
 * compatible printer-specific preset for the selected machine when available.
 */
export function pickLoadedMaterialProfile(
  profiles: SlicingProfileSummary[],
  input: LoadedMaterialProfileSelectionInput
): SlicingProfileSummary | null {
  const normalizedTrayInfoIdx = normalizeProfileText(input.trayInfoIdx ?? '')
  const normalizedTrayName = normalizeProfileText(input.trayName ?? '')
  const normalizedMappedPresetName = normalizeProfileText(input.mappedPresetName ?? '')
  const normalizedPresetFamily = normalizeProfileFamily(input.mappedPresetName ?? input.trayName ?? '')

  let best: SlicingProfileSummary | null = null
  let bestScore = 0

  for (const profile of profiles) {
    const score = scoreLoadedMaterialProfile(profile, {
      normalizedTrayInfoIdx,
      normalizedTrayName,
      normalizedMappedPresetName,
      normalizedPresetFamily,
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
    selectedMachineProfile: SlicingProfileSummary | null
    selectedPrinterModel: string
  }
): number {
  let score = 0
  const normalizedName = normalizeProfileText(profile.name)

  if (
    input.normalizedTrayInfoIdx
    && (profile.filamentIds ?? []).some((id) => normalizeProfileText(id) === input.normalizedTrayInfoIdx)
  ) {
    score += 40
  }
  if (input.normalizedMappedPresetName && normalizedName === input.normalizedMappedPresetName) {
    score += 25
  }
  if (input.normalizedTrayName && normalizedName === input.normalizedTrayName) {
    score += 20
  }
  if (input.normalizedPresetFamily && normalizeProfileFamily(profile.name) === input.normalizedPresetFamily) {
    score += 10
  }

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

function normalizeProfileText(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

function profileTextCandidates(value: string): string[] {
  const normalized = normalizeProfileText(value)
  if (!normalized) return []
  const compact = normalized.replace(/\s+/g, '')
  return compact === normalized ? [normalized] : [normalized, compact]
}