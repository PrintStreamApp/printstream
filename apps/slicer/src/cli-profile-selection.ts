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
 * "tune" dialog) into a map keyed by the 1-based **project filament slot**.
 *
 * Keyed by SLOT, not by `profileId`, for two reasons the previous keying got wrong:
 * - A slot left on the project's own preset has no `profileId`, so its tune was skipped
 *   entirely and the user's edit vanished with no warning.
 * - Two slots sharing one preset merged into a single entry, last-write-wins, so one slot
 *   silently inherited the other's temperature/flow.
 */
export function buildPerMaterialFilamentOverrides(
  mappings: ReadonlyArray<{ projectFilamentId: number; settingOverrides?: Record<string, string | string[]> }>
): Record<number, Record<string, string | string[]>> {
  const bySlot: Record<number, Record<string, string | string[]>> = {}
  for (const mapping of mappings) {
    if (!mapping.settingOverrides || Object.keys(mapping.settingOverrides).length === 0) continue
    if (!Number.isInteger(mapping.projectFilamentId) || mapping.projectFilamentId < 1) continue
    bySlot[mapping.projectFilamentId] = { ...(bySlot[mapping.projectFilamentId] ?? {}), ...mapping.settingOverrides }
  }
  return bySlot
}
