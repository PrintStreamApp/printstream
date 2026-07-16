import type { SlicingProfileKind } from '@printstream/shared'

type SliceProfileKind = {
  kind: SlicingProfileKind
}

/**
 * Which profile files reach the CLI's `--load-settings`. Once the input 3MF's
 * project settings were rewritten (identity + any native machine retarget baked
 * in), the machine profile is dropped: the embedded 3MF already carries the
 * correct machine, and re-loading a machine preset alongside a project is what
 * the CLI's crash matrix punishes (see docs/slicer-cross-model-machine-switch.md).
 */
export function selectCliProfileFiles<T extends SliceProfileKind>(
  profileFiles: readonly T[],
  input: {
    rewroteProjectSettings: boolean
  }
): T[] {
  if (!input.rewroteProjectSettings) {
    return [...profileFiles]
  }

  return profileFiles.filter((profile) => profile.kind !== 'machine')
}

/**
 * Collapse the per-material filament overrides (each mapping's `settingOverrides` from the material
 * "tune" dialog) into a map keyed by the slot's filament `profileId`, so the slice-arg builder can
 * apply the right slot's override to that slot's filament file. Mappings without a profileId or
 * without overrides are skipped. Two slots sharing a profileId with differing overrides merge (last
 * write wins per key) — a rare case BambuStudio itself avoids by minting distinct project presets.
 */
export function buildPerMaterialFilamentOverrides(
  mappings: ReadonlyArray<{ profileId?: string | null; settingOverrides?: Record<string, string | string[]> }>
): Record<string, Record<string, string | string[]>> {
  const byProfileId: Record<string, Record<string, string | string[]>> = {}
  for (const mapping of mappings) {
    if (!mapping.profileId || !mapping.settingOverrides || Object.keys(mapping.settingOverrides).length === 0) continue
    byProfileId[mapping.profileId] = { ...(byProfileId[mapping.profileId] ?? {}), ...mapping.settingOverrides }
  }
  return byProfileId
}
