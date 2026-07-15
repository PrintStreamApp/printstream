/**
 * Multi-recipient destination lists for broadcast-style notification
 * channels (Discord webhooks, ntfy topics).
 *
 * Each scope (tenant workspace, or the plugin's base store at the platform
 * scope) keeps a list of destination entries. An entry is either:
 *
 * - shared (`userId` unset): receives the scope's broadcast notifications —
 *   the classic team channel/topic; or
 * - user-bound (`userId` set): receives ONLY that user's targeted messages
 *   (`targetUserIds`) — a private channel or personal topic. Binding is
 *   self-service by design: an entry may only be bound to the user who
 *   creates it, because personal messages can carry private content
 *   (support-reply previews) that must not be routed to a destination
 *   someone else controls. Wanting both streams on one URL = two entries.
 *
 * Legacy single-URL configs (`webhookUrl` / `topicUrl` setting) read as an
 * implicit shared entry until the first recipients write migrates them.
 * Destination URLs are secrets: they are stored server-side, never echoed
 * to the browser, and never logged — surfaces show the entry label only.
 */
import { randomUUID } from 'node:crypto'
import type { NotificationMessage } from '@printstream/shared'
import type { PluginSettingStore } from '../plugin/types.js'
import { listTenantScopesWithPluginSetting } from './notification-scope.js'

const RECIPIENTS_KEY = 'recipients'

export interface ChannelRecipient {
  id: string
  /** Destination URL (webhook/topic). Secret — never serialized to clients. */
  url: string
  label: string
  /** Bound user (self-service): entry receives only this user's targeted messages. */
  userId?: string
  /** Display-name snapshot of the bound user, for the settings list. */
  userName?: string
}

/** The id given to a legacy single-URL config surfaced as an implicit entry. */
export const LEGACY_RECIPIENT_ID = 'legacy'

interface LegacyKeyOptions {
  /** The channel's pre-list single-URL setting key (`webhookUrl`, `topicUrl`). */
  legacyUrlKey: string
  /** Label shown for the implicit legacy entry. */
  legacyLabel: string
}

function parseRecipients(raw: string | null): ChannelRecipient[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry): entry is ChannelRecipient => {
      if (typeof entry !== 'object' || entry === null) return false
      const candidate = entry as Partial<ChannelRecipient>
      return typeof candidate.id === 'string'
        && typeof candidate.url === 'string'
        && typeof candidate.label === 'string'
        && (candidate.userId === undefined || typeof candidate.userId === 'string')
        && (candidate.userName === undefined || typeof candidate.userName === 'string')
    })
  } catch {
    return null
  }
}

/**
 * Read a scope's recipient list; a legacy single-URL config appears as one
 * shared entry until the first write migrates it.
 */
export async function readChannelRecipients(
  settings: PluginSettingStore,
  options: LegacyKeyOptions
): Promise<ChannelRecipient[]> {
  const stored = parseRecipients(await settings.get(RECIPIENTS_KEY))
  if (stored !== null) return stored
  const legacyUrl = await settings.get(options.legacyUrlKey)
  if (!legacyUrl) return []
  return [{ id: LEGACY_RECIPIENT_ID, url: legacyUrl, label: options.legacyLabel }]
}

/** Persist a scope's recipient list, retiring any legacy single-URL setting. */
export async function writeChannelRecipients(
  settings: PluginSettingStore,
  recipients: ChannelRecipient[],
  options: LegacyKeyOptions
): Promise<void> {
  await settings.set(RECIPIENTS_KEY, JSON.stringify(recipients))
  await settings.delete(options.legacyUrlKey)
}

export function createChannelRecipient(input: {
  url: string
  label?: string
  /** Bind to this user (must be the requesting user — see module header). */
  userId?: string
  userName?: string
}): ChannelRecipient {
  return {
    id: randomUUID(),
    url: input.url,
    label: input.label?.trim() || (input.userId ? 'Personal destination' : 'Shared destination'),
    userId: input.userId,
    userName: input.userName
  }
}

export interface ResolveChannelDeliveryOptions extends LegacyKeyOptions {
  message: NotificationMessage
  pluginName: string
  /** Prisma slice for cross-scope enumeration (see notification-scope.ts). */
  prisma: Parameters<typeof listTenantScopesWithPluginSetting>[0]
  /** Scoped settings accessor (`null` = the plugin's base/platform store). */
  settingsForScope: (tenantId: string | null) => PluginSettingStore
  /** Plugin enablement per scope; disabled scopes are skipped. */
  isEnabledForTenant: (tenantId: string | null) => boolean
  /**
   * Channel-level fallback URL used ONLY for broadcast messages when the
   * scope has no configured recipients (ntfy's managed-bridge env topic).
   */
  fallbackUrl?: string | null
}

/**
 * Resolve the destination URLs a message delivers to.
 *
 * Broadcast messages go to the shared entries of their own scope (or the
 * channel fallback when the scope has none). Targeted messages go to
 * entries bound to a targeted user — within the message's scope when it has
 * a tenant, across every scope holding recipients when it does not
 * (platform-wide personal events) — deduplicated by URL.
 */
export async function resolveChannelDeliveryUrls(options: ResolveChannelDeliveryOptions): Promise<string[]> {
  const { message } = options
  const targets = message.targetUserIds

  if (!targets || targets.length === 0) {
    const scopeTenantId = message.tenantId ?? null
    if (!options.isEnabledForTenant(scopeTenantId)) return []
    const recipients = await readChannelRecipients(options.settingsForScope(scopeTenantId), options)
    const shared = recipients.filter((entry) => !entry.userId).map((entry) => entry.url)
    if (shared.length === 0 && recipients.length === 0 && options.fallbackUrl) {
      return [options.fallbackUrl]
    }
    return [...new Set(shared)]
  }

  const targetIds = new Set(targets)
  const scopes: Array<string | null> = message.tenantId
    ? [message.tenantId]
    : [null, ...await listTenantScopesWithPluginSetting(options.prisma, options.pluginName, RECIPIENTS_KEY)]

  const urls = new Set<string>()
  for (const tenantId of scopes) {
    if (!options.isEnabledForTenant(tenantId)) continue
    const recipients = await readChannelRecipients(options.settingsForScope(tenantId), options)
    for (const entry of recipients) {
      if (entry.userId && targetIds.has(entry.userId)) urls.add(entry.url)
    }
  }
  return [...urls]
}
