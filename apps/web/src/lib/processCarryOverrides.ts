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
 * anything not surfaced as an override is silently lost. The caller resolves the project preset
 * against NO target (`targetId: null`) so the system baseline is matched by NAME regardless of the
 * machine currently selected, a machine-scoped resolve would fail to find an A1 baseline once the
 * target is H2D, collapsing the diff to empty and dropping the carry.
 */
import {
  applyProcessConfigDefaults,
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
 * it did NOT (parent preset not installed, so the endpoint returns the 3MF's own
 * `different_settings_to_system` as `overriddenKeys`), that list is authoritative: valued from the
 * effective config.
 */
export function deriveProjectCarryOverrides(
  resolve: ResolveProcessConfigResponse | null | undefined
): ProcessSettingOverrides {
  if (!resolve) return {}
  const effective = applyProcessConfigDefaults(resolve.config)
  if (resolve.overriddenKeys.length > 0) {
    const carry: ProcessSettingOverrides = {}
    for (const key of resolve.overriddenKeys) {
      const value = effective[key]
      if (value !== undefined) carry[key] = value
    }
    return carry
  }
  return diffProcessConfig(applyProcessConfigDefaults(resolve.baseConfig), effective)
}
