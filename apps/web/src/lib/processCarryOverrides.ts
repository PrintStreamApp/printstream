/**
 * The project's GENUINE process deltas, derived from a `resolve-process` response, for carrying onto
 * a NEW preset when a machine switch abandons the project's own preset.
 *
 * This mirrors the in-dialog preset switch (`ProcessSettingsDialog`'s `onProfileChange`, which
 * carries `diffProcessConfig(baseline, config)`): the two paths must produce the same override map,
 * so switching machines and manually re-picking a preset behave identically.
 *
 * Why it matters: a project's customizations (e.g. `wall_loops`) live in its BAKED config, not the
 * session override map. On the project's own preset they are used implicitly. The moment a machine
 * switch re-picks a builtin, `applyProcessProfileToProjectSettings` overwrites every process key, so
 * anything not surfaced as an override is silently lost. Resolve the selected leaf by name in the
 * current engine catalogue, independently of the machine selection, and compare current values
 * AFTER applying session edits, so a reset removes rather than resurrects a saved modification.
 */
import {
  applyProcessConfigDefaults,
  isProcessSettingKey,
  diffProcessConfig,
  type ProcessSettingOverrides,
  type ResolveProcessConfigResponse
} from '@printstream/shared'

/**
 * Returns only the keys the project genuinely changed from its system baseline, option-aware so a
 * serialization-only difference (`"45.0"` vs `"45%"`) never counts. Empty for a null response or a
 * project with no real deltas.
 *
 * When the baseline resolved, the deltas are the value-diff of the effective config against it. When
 * it did NOT, keep every explicitly saved process value: incomplete native metadata cannot prove
 * that a setting was unmodified. The picker explains this conservative transfer to the user.
 */
export function deriveProjectCarryOverrides(
  resolve: ResolveProcessConfigResponse | null | undefined,
  sessionOverrides: ProcessSettingOverrides = {}
): ProcessSettingOverrides {
  if (!resolve) return { ...sessionOverrides }
  const effective = applyProcessConfigDefaults({ ...resolve.config, ...sessionOverrides })
  if (resolve.baselineResolved === false) {
    // A missing leaf gives us no way to separate inherited preset values from project changes.
    // Keep conservatively retains every saved process value, including files whose old writer
    // emitted an empty native record. Discard is the user's explicit way to take the new baseline.
    return Object.fromEntries(Object.entries({ ...resolve.config, ...sessionOverrides }).filter(([key]) => isProcessSettingKey(key)))
  }
  return diffProcessConfig(applyProcessConfigDefaults(resolve.baseConfig), effective)
}
