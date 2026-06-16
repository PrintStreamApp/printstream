/**
 * Workspace-scoped auth-provider state helpers.
 *
 * Auth providers remain loaded as API plugins so their routes stay reachable,
 * but whether they are operational is tracked per workspace. State lives in
 * the plugin setting store under a tenant-aware key.
 *
 * Reads fall back to the legacy plugin `_enabled` flag so older installs keep
 * their previous auth availability until an explicit workspace-scoped choice
 * is saved.
 */
import type { PluginSettingStore } from '../plugin/types.js'
import { getSettingScopePrefix } from './tenant-settings.js'

const AUTH_PROVIDER_ENABLED_KEY = 'enabled'
const AUTH_PROVIDER_SETUP_COMPLETE_KEY = 'setupComplete'
const LEGACY_PLUGIN_ENABLED_KEY = '_enabled'

export async function readScopedAuthProviderEnabled(settings: PluginSettingStore): Promise<boolean> {
  const scoped = await settings.get(scopedAuthProviderStateKey(AUTH_PROVIDER_ENABLED_KEY))
  if (scoped != null) {
    return scoped !== 'false'
  }

  const legacy = await settings.get(LEGACY_PLUGIN_ENABLED_KEY)
  return legacy === 'true'
}

export async function writeScopedAuthProviderEnabled(settings: PluginSettingStore, enabled: boolean): Promise<void> {
  await settings.set(scopedAuthProviderStateKey(AUTH_PROVIDER_ENABLED_KEY), enabled ? 'true' : 'false')
}

export async function readScopedAuthProviderSetupComplete(settings: PluginSettingStore): Promise<boolean> {
  return (await readScopedAuthProviderSetupCompleteState(settings)) === true
}

export async function readScopedAuthProviderSetupCompleteState(settings: PluginSettingStore): Promise<boolean | null> {
  const scoped = await settings.get(scopedAuthProviderStateKey(AUTH_PROVIDER_SETUP_COMPLETE_KEY))
  if (scoped == null) {
    return null
  }
  return scoped === 'true'
}

export async function writeScopedAuthProviderSetupComplete(settings: PluginSettingStore, complete: boolean): Promise<void> {
  await settings.set(scopedAuthProviderStateKey(AUTH_PROVIDER_SETUP_COMPLETE_KEY), complete ? 'true' : 'false')
}

function scopedAuthProviderStateKey(key: string): string {
  return `${getSettingScopePrefix()}:${key}`
}