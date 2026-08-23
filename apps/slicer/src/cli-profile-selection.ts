import type { SlicingPresetKind } from '@printstream/shared'

/** Anything carrying a preset kind, these selectors care about nothing else. */
type PresetKinded = {
  kind: SlicingPresetKind
}

/**
 * Which profile files reach the CLI's `--load-settings`. Once the input 3MF's
 * project settings were rewritten (identity + any native machine retarget baked
 * in), the machine profile is dropped: the embedded 3MF already carries the
 * correct machine, and re-loading a machine preset alongside a project is what
 * the CLI's crash matrix punishes (see docs/slicer-cross-model-machine-switch.md).
 */
export function selectCliProfileFiles<T extends PresetKinded>(
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
 * Which profile files reach the settings-repair export (`ensureEmbeddedProjectSettings` ->
 * `--export-settings`). ALWAYS all of them, this deliberately does NOT apply
 * {@link selectCliProfileFiles}'s machine drop.
 *
 * That drop is right for the slice, where the rewritten 3MF already carries the machine. The
 * export is the opposite situation: it loads NO 3MF at all, so a dropped machine leaves
 * BambuStudio with no printer to test the process preset's `compatible_printers` against, and
 * `run()` fails every process as incompatible (exit 239 CLI_PROCESS_NOT_COMPATIBLE: verified:
 * process-only exits -17, machine + process exports fine). The API then retries without the
 * builtin profiles, so the slice silently completes on the project's own presets instead of the
 * process the user picked.
 *
 * The export equally cannot run with HALF a pair, a machine and no process (the normal state of
 * a slice whose process is the project's own `project:` preset, which resolves to no file by
 * design) exits 239 just as deterministically, and when the machine is a CUSTOM preset the API's
 * builtin-drop retry cannot recover it. `ensureMachineProcessPairForExport` in
 * `project-settings-fallback.ts` repairs that downstream by deriving the missing half from the
 * embedded settings' lineage (or dropping the loaded half); keeping ALL the files here is what
 * hands it the true picture of what the slice loads.
 */
export function selectSettingsExportProfileFiles<T extends PresetKinded>(profileFiles: readonly T[]): T[] {
  return [...profileFiles]
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
