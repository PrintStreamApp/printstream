/**
 * ntfy notifications plugin (built-in).
 *
 * Forwards printer-domain events to a configured ntfy-style HTTP topic
 * URL. Message formatting is delegated to the shared notification
 * helper so this plugin only owns delivery semantics.
 *
 * Configuration is scoped: each tenant stores its own topic URL via
 * `context.settings.forTenant(tenantId)`, and the platform workspace stores
 * one in the plugin's base store for platform-scope events. The server-wide
 * `NTFY_TOPIC_URL` env is honored as a fallback ONLY in single-box
 * managed-bridge self-hosting (see `globalTopicFallback`); in a
 * multi-tenant cloud it is ignored, since one shared topic would leak
 * every un-configured tenant's notifications to a single operator topic.
 * Notifications are only delivered when a topic resolves for the tenant.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { env } from '../../lib/env.js'
import { badRequest } from '../../lib/http-error.js'
import { assertSafeOutboundUrl } from '../../lib/outbound-url-guard.js'
import { isManagedBridgeMode } from '../../lib/managed-bridge.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { messageNotificationScope, requestNotificationScope } from '../../lib/notification-scope.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'

/** Bound outbound webhook POSTs so a slow/unreachable host can't wedge delivery. */
const OUTBOUND_TIMEOUT_MS = 10_000

/**
 * The server-wide `NTFY_TOPIC_URL` is a single shared topic. Honor it as a
 * fallback only in single-box managed-bridge self-hosting; in a multi-tenant
 * cloud it would silently fan every un-configured tenant's printer/job/error
 * text to one operator topic (a cross-tenant leak), so there delivery is
 * per-tenant only and requires an explicit topicUrl setting.
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

export const notificationsNtfyPlugin: ApiPlugin = {
  name: 'notifications-ntfy',
  version: '0.2.0',
  description: 'Forward printer notifications to a ntfy-style HTTP topic.',
  async register(context) {
    context.router.get('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const scope = requestNotificationScope(context, request)
      const topicUrl = (await scope.settings.get('topicUrl')) ?? globalTopicFallback()
      response.json({ enabled: Boolean(topicUrl), topicConfigured: Boolean(topicUrl) })
    })

    context.router.put('/topic', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const scope = requestNotificationScope(context, request)
      const value = typeof request.body?.topicUrl === 'string' ? request.body.topicUrl.trim() : ''
      if (!value) {
        await scope.settings.delete('topicUrl')
        // The topic URL is a secret; only record whether one is configured.
        annotateRequestAuditLog(request, {
          action: 'update-ntfy-topic',
          resource: 'ntfy notification topic',
          summary: 'Cleared the ntfy notification topic.',
          metadata: { configured: false }
        })
        response.json({ topicConfigured: false })
        return
      }
      // The API POSTs to this URL on every printer event, so validate it as a
      // safe outbound target (no loopback/link-local/metadata SSRF). http is
      // allowed for self-hosted LAN ntfy instances.
      try {
        assertSafeOutboundUrl(value, { allowHttp: true })
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'Invalid ntfy topic URL.')
      }
      await scope.settings.set('topicUrl', value)
      annotateRequestAuditLog(request, {
        action: 'update-ntfy-topic',
        resource: 'ntfy notification topic',
        summary: 'Configured the ntfy notification topic.',
        metadata: { configured: true }
      })
      response.json({ topicConfigured: true })
    })

    const off = subscribePrinterNotifications(
      context.printerEvents,
      async (message) => {
        const scope = messageNotificationScope(context, message.tenantId)
        const topicUrl = (await scope.settings.get('topicUrl')) ?? globalTopicFallback()
        if (!topicUrl) return
        // Re-check at delivery: the env fallback is operator-supplied and a stored
        // value could predate this guard. Skip (don't throw) on an unsafe target.
        try {
          assertSafeOutboundUrl(topicUrl, { allowHttp: true })
        } catch (error) {
          context.logger.warn('skipping ntfy delivery to an unsafe topic URL', error)
          return
        }
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
        const res = await fetch(topicUrl, { method: 'POST', headers, body: message.body, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) })
        if (!res.ok) {
          // Surface delivery failures through the onError warn below. The topic
          // URL is a secret, so only the status code is included.
          throw new Error(`ntfy responded ${res.status}`)
        }
      },
      {
        onError: (error) => context.logger.warn('failed to publish ntfy notification', error),
        shouldHandleTenantId: (tenantId) => context.isEnabledForTenant?.(tenantId) ?? true
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
