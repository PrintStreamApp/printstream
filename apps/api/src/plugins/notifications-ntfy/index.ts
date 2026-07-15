/**
 * ntfy notifications plugin (built-in).
 *
 * Forwards printer-domain events to configured ntfy-style HTTP topic
 * URLs. Message formatting is delegated to the shared notification
 * helper so this plugin only owns delivery semantics.
 *
 * Destinations are a per-scope recipients list (shared topics for broadcast
 * notifications, self-bound personal topics for the requesting user's
 * targeted messages — see `lib/notification-recipients.ts`). Each tenant
 * stores its list via `context.settings.forTenant(tenantId)`, the platform
 * workspace in the plugin's base store; a pre-list `topicUrl` setting keeps
 * working as an implicit shared entry.
 *
 * The server-wide `NTFY_TOPIC_URL` env is honored as a broadcast-only
 * fallback in single-box managed-bridge self-hosting (see
 * `globalTopicFallback`); in a multi-tenant cloud it is ignored, since one
 * shared topic would leak every un-configured tenant's notifications to a
 * single operator topic.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { badRequest } from '../../lib/http-error.js'
import { env } from '../../lib/env.js'
import { assertSafeOutboundUrl } from '../../lib/outbound-url-guard.js'
import { isManagedBridgeMode } from '../../lib/managed-bridge.js'
import { registerChannelRecipientRoutes } from '../../lib/notification-recipient-routes.js'
import { resolveChannelDeliveryUrls } from '../../lib/notification-recipients.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'

/** Bound outbound webhook POSTs so a slow/unreachable host can't wedge delivery. */
const OUTBOUND_TIMEOUT_MS = 10_000

/**
 * The server-wide `NTFY_TOPIC_URL` is a single shared topic. Honor it as a
 * fallback only in single-box managed-bridge self-hosting; in a multi-tenant
 * cloud it would silently fan every un-configured tenant's printer/job/error
 * text to one operator topic (a cross-tenant leak), so there delivery is
 * per-tenant only and requires explicitly configured recipients.
 */
function globalTopicFallback(): string | null {
  return isManagedBridgeMode() ? (env.NTFY_TOPIC_URL ?? null) : null
}

const PRIORITY_BY_LEVEL: Record<string, string> = {
  info: 'default',
  success: 'default',
  warning: 'high',
  error: 'urgent'
}

const RECIPIENT_OPTIONS = {
  channelLabel: 'ntfy',
  legacyUrlKey: 'topicUrl',
  legacyLabel: 'ntfy topic',
  // The API POSTs to these URLs on every notification, so validate each as a
  // safe outbound target (no loopback/link-local/metadata SSRF). http is
  // allowed for self-hosted LAN ntfy instances.
  validateUrl: (url: string) => {
    try {
      assertSafeOutboundUrl(url, { allowHttp: true })
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Invalid ntfy topic URL.')
    }
  }
}

export const notificationsNtfyPlugin: ApiPlugin = {
  name: 'notifications-ntfy',
  version: '0.3.0',
  description: 'Forward printer notifications to ntfy topics (shared and personal).',
  async register(context) {
    registerChannelRecipientRoutes(context, {
      ...RECIPIENT_OPTIONS,
      fallbackConfigured: () => Boolean(globalTopicFallback())
    })

    const off = subscribePrinterNotifications(
      context.printerEvents,
      async (message) => {
        const urls = await resolveChannelDeliveryUrls({
          ...RECIPIENT_OPTIONS,
          message,
          pluginName: context.pluginName,
          prisma: context.prisma,
          settingsForScope: (tenantId) => tenantId ? context.settings.forTenant(tenantId) : context.settings,
          isEnabledForTenant: (tenantId) => context.isEnabledForTenant?.(tenantId) ?? true,
          fallbackUrl: globalTopicFallback()
        })
        if (urls.length === 0) return

        const headers: Record<string, string> = {
          'Content-Type': 'text/plain',
          'X-Title': message.title,
          'X-Priority': PRIORITY_BY_LEVEL[message.level] ?? 'default'
        }
        if (message.tag) headers['X-Tags'] = message.tag
        const absoluteUrl = resolvePublicNotificationUrl(message.url)
        if (absoluteUrl) headers['X-Click'] = absoluteUrl
        // ntfy fetches the attachment server-side, so the URL must be
        // reachable from ntfy.sh (or your self-hosted ntfy). Relative
        // URLs are skipped because they cannot resolve there.
        if (message.imageUrl && /^https?:\/\//i.test(message.imageUrl)) {
          headers['X-Attach'] = message.imageUrl
          headers['X-Filename'] = 'snapshot.jpg'
        }

        const results = await Promise.allSettled(urls.map(async (topicUrl) => {
          // Re-check at delivery: the env fallback is operator-supplied and a
          // stored value could predate the write-time guard. Skip (don't
          // throw) on an unsafe target.
          try {
            assertSafeOutboundUrl(topicUrl, { allowHttp: true })
          } catch (error) {
            context.logger.warn('skipping ntfy delivery to an unsafe topic URL', error)
            return
          }
          const res = await fetch(topicUrl, { method: 'POST', headers, body: message.body, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) })
          if (!res.ok) {
            // The topic URL is a secret, so only the status code is included.
            throw new Error(`ntfy responded ${res.status}`)
          }
        }))
        for (const result of results) {
          // One dead topic must not hide the others.
          if (result.status === 'rejected') {
            context.logger.warn('failed to publish ntfy notification', result.reason)
          }
        }
      },
      {
        onError: (error) => context.logger.warn('failed to publish ntfy notification', error)
        // No shouldHandleTenantId gate: targeted messages may fan out beyond
        // the event's own scope, so the resolver enforces plugin enablement
        // per DELIVERY scope instead of per event scope.
      }
    )

    context.onShutdown(off)
  }
}

function resolvePublicNotificationUrl(path: string | undefined): string | undefined {
  if (!path) return undefined
  if (/^https?:\/\//i.test(path)) return path
  if (!env.PUBLIC_BASE_URL) return undefined
  try {
    return new URL(path, `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/`).toString()
  } catch {
    return undefined
  }
}
