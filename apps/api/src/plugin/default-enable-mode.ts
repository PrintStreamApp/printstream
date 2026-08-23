/**
 * Plugin default-enable policy.
 *
 * The first boot after this policy ships decides how a missing `_enabled` flag
 * is read for the life of this installation:
 *
 * - A fresh install defaults plugins to **disabled**, so nothing the operator
 *   never asked for is running.
 * - An install that predates the policy keeps the legacy reading (missing means
 *   enabled), because its plugins were already running and an upgrade must not
 *   silently switch them off.
 *
 * The chosen mode is persisted once so later boots stay consistent, and a
 * plugin the operator has explicitly toggled carries its own
 * `plugin:<name>:_enabled` row, which wins over the mode either way.
 *
 * **The signal is plugin state, not "is the database empty".** It used to be
 * the latter, a total `Setting` count taken at first plugin registration,
 * which left the policy hostage to whatever else happened to write a row first.
 * On self-hosted builds `registerLicenseEnforcement()` stamps
 * `license:first-run-at` from module scope, racing plugin registration, so a
 * genuinely fresh install read as legacy and came up with every plugin enabled
 * (reported on the native app: Orders on out of the box). Counting only
 * `plugin:` rows measures what the question is actually about, and no amount of
 * unrelated bootstrap can move it.
 */

/** Every per-plugin setting hangs off this; the policy row deliberately does not. */
export const PLUGIN_SETTING_PREFIX = 'plugin:'

export const PLUGIN_DEFAULT_ENABLE_MODE_KEY = 'plugins:_default_enable_mode'

export type PluginDefaultEnableMode = 'enabled' | 'disabled'

/**
 * @param existingPluginSettingCount rows whose key starts with
 * {@link PLUGIN_SETTING_PREFIX}. An install that has ever run a plugin has at
 * least one, the auth provider records its setup there when the first user is
 * created, while a fresh database has none.
 */
export function derivePluginDefaultEnableMode(
  existingPluginSettingCount: number
): PluginDefaultEnableMode {
  return existingPluginSettingCount === 0 ? 'disabled' : 'enabled'
}

export function isPluginEnabledByDefault(mode: PluginDefaultEnableMode): boolean {
  return mode === 'enabled'
}
