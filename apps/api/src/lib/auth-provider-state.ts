/**
 * Workspace-scoped auth-provider state helpers.
 *
 * Auth providers remain loaded as API plugins so their routes stay reachable,
 * but whether they are operational is tracked per workspace. State lives in
 * the plugin setting store under a workspace-aware key.
 *
 * Reads fall back to the legacy plugin `_enabled` flag so older installs keep
 * their previous auth availability until an explicit workspace-scoped choice
 * is saved.
 */
import type { PluginSettingStore } from '../plugin/types.js'
import type { AnyPrismaClient } from './prisma.js'
import { getSettingScopePrefix, getSettingScopePrefixForWorkspace } from './workspace-settings.js'

export const AUTH_PROVIDER_ENABLED_KEY = 'enabled'
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

/**
 * Of `workspaceIds`, those where `pluginName` is enabled.
 *
 * For the workspace-LESS sign-in page, which has no scope to resolve a provider
 * against but must still not sign someone into a workspace that turned the
 * provider off. Reads the same keys and legacy fallback as
 * `readScopedAuthProviderEnabled`, just for many scopes at once.
 *
 * Availability only — it says nothing about who may enter a workspace, which
 * stays with membership and `loginDisabled`.
 */
export async function filterWorkspacesWithAuthProviderEnabled(
  prisma: AnyPrismaClient,
  pluginName: string,
  workspaceIds: ReadonlyArray<string>
): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set()

  const prefix = `plugin:${pluginName}:`
  const [scopedRows, legacyRow] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: workspaceIds.map((id) => `${prefix}${getSettingScopePrefixForWorkspace(id)}:${AUTH_PROVIDER_ENABLED_KEY}`) } },
      select: { key: true, value: true }
    }),
    prisma.setting.findUnique({ where: { key: `${prefix}${LEGACY_PLUGIN_ENABLED_KEY}` }, select: { value: true } })
  ])

  const scoped = new Map(scopedRows.map((row) => [row.key, row.value] as const))
  const legacyEnabled = legacyRow?.value === 'true'
  const enabled = new Set<string>()
  for (const workspaceId of workspaceIds) {
    const value = scoped.get(`${prefix}${getSettingScopePrefixForWorkspace(workspaceId)}:${AUTH_PROVIDER_ENABLED_KEY}`)
    // Same precedence as the single-scope read: an explicit choice wins, and
    // only an unset scope falls back to the legacy deployment-wide flag.
    if (value != null ? value !== 'false' : legacyEnabled) enabled.add(workspaceId)
  }
  return enabled
}