/**
 * Opt-in subscriber storage for notification channels: a JSON array of the
 * opted-in user ids in a plugin setting store (the address comes from the
 * user's account at send time). The workspace email channel stores it per workspace
 * (`settings.forWorkspace`); the cloud platform channel uses its base store.
 */
import type { PluginSettingStore } from '../plugin/types.js'

const SUBSCRIBERS_KEY = 'subscribers'

export async function readEmailSubscribers(workspaceSettings: PluginSettingStore): Promise<string[]> {
  const raw = await workspaceSettings.get(SUBSCRIBERS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

export async function writeEmailSubscribers(workspaceSettings: PluginSettingStore, userIds: readonly string[]): Promise<void> {
  await workspaceSettings.set(SUBSCRIBERS_KEY, JSON.stringify([...new Set(userIds)]))
}
