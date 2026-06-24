/**
 * Per-tenant opt-in storage for the email notifications channel.
 *
 * Mirrors `notifications-browser`'s per-tenant subscription list, but stores only
 * the opted-in user ids (the address comes from the user's account at send time).
 */
import type { PluginSettingStore } from '../../plugin/types.js'

const SUBSCRIBERS_KEY = 'subscribers'

export async function readEmailSubscribers(tenantSettings: PluginSettingStore): Promise<string[]> {
  const raw = await tenantSettings.get(SUBSCRIBERS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

export async function writeEmailSubscribers(tenantSettings: PluginSettingStore, userIds: readonly string[]): Promise<void> {
  await tenantSettings.set(SUBSCRIBERS_KEY, JSON.stringify([...new Set(userIds)]))
}
