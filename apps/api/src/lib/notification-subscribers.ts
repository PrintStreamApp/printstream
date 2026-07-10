/**
 * Opt-in subscriber storage for notification channels: a JSON array of the
 * opted-in user ids in a plugin setting store (the address comes from the
 * user's account at send time). The tenant email channel stores it per tenant
 * (`settings.forTenant`); the cloud platform channel uses its base store.
 */
import type { PluginSettingStore } from '../plugin/types.js'

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
