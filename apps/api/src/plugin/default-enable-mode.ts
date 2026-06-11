/**
 * Plugin default-enable policy.
 *
 * The first boot after this policy ships decides how missing `_enabled`
 * flags should be interpreted for this installation:
 *
 * - Fresh installs (no `Setting` rows yet) default plugins to disabled.
 * - Existing installs keep the legacy behavior and treat missing flags as enabled.
 *
 * The chosen mode is persisted once so future boots stay consistent.
 */
export const PLUGIN_DEFAULT_ENABLE_MODE_KEY = 'plugins:_default_enable_mode'

export type PluginDefaultEnableMode = 'enabled' | 'disabled'

export function derivePluginDefaultEnableMode(existingSettingCount: number): PluginDefaultEnableMode {
  return existingSettingCount === 0 ? 'disabled' : 'enabled'
}

export function isPluginEnabledByDefault(mode: PluginDefaultEnableMode): boolean {
  return mode === 'enabled'
}