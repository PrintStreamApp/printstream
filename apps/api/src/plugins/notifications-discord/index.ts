/**
 * Discord notifications plugin (built-in).
 *
 * Posts printer-domain notifications to a configured Discord webhook.
 * Formatting is delegated to the shared notification helper; this
 * plugin only owns Discord-specific delivery (embed colour, payload
 * shape).
 *
 * Configuration is tenant-scoped: each tenant stores its own webhook
 * URL via `context.settings.forTenant(tenantId)`. Notifications are
 * only delivered to the webhook belonging to the tenant that owns the
 * printer the event originated from.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import {
  SETTINGS_MANAGE_PERMISSION,
  type NotificationLevel
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest } from '../../lib/http-error.js'
import { requireRequestTenantId } from '../../lib/request-helpers.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'
import { env } from '../../lib/env.js'

/** Bound outbound webhook POSTs so a slow/unreachable host can't wedge delivery. */
const OUTBOUND_TIMEOUT_MS = 10_000

const COLOUR_BY_LEVEL: Record<NotificationLevel, number> = {
  info: 0x3498db,
  success: 0x2ecc71,
  warning: 0xf1c40f,
  error: 0xe74c3c
}

const WEBHOOK_PATTERN = /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//i

export const notificationsDiscordPlugin: ApiPlugin = {
  name: 'notifications-discord',
  version: '0.1.0',
  description: 'Forward printer notifications to a Discord webhook.',
  async register(context) {
    context.router.get('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const tenantId = requireRequestTenantId(request)
      const tenantSettings = context.settings.forTenant(tenantId)
      const webhookUrl = await tenantSettings.get('webhookUrl')
      response.json({ webhookConfigured: Boolean(webhookUrl) })
    })

    context.router.put('/webhook', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const tenantId = requireRequestTenantId(request)
      const tenantSettings = context.settings.forTenant(tenantId)
      const value = typeof request.body?.webhookUrl === 'string' ? request.body.webhookUrl.trim() : ''
      if (!value) {
        await tenantSettings.delete('webhookUrl')
        // The webhook URL is a secret; only record whether one is configured.
        annotateRequestAuditLog(request, {
          action: 'update-discord-webhook',
          resource: 'Discord notification webhook',
          summary: 'Cleared the Discord notification webhook.',
          metadata: { configured: false }
        })
        response.json({ webhookConfigured: false })
        return
      }
      if (!WEBHOOK_PATTERN.test(value)) {
        throw badRequest('Not a valid Discord webhook URL')
      }
      await tenantSettings.set('webhookUrl', value)
      annotateRequestAuditLog(request, {
        action: 'update-discord-webhook',
        resource: 'Discord notification webhook',
        summary: 'Configured the Discord notification webhook.',
        metadata: { configured: true }
      })
      response.json({ webhookConfigured: true })
    })

    const off = subscribePrinterNotifications(
      context.printerEvents,
      async (message) => {
        if (!message.tenantId) return
        const tenantSettings = context.settings.forTenant(message.tenantId)
        const webhookUrl = await tenantSettings.get('webhookUrl')
        if (!webhookUrl) return
        // Discord embeds need an absolute URL for the image; relative
        // paths get silently dropped. We attach via embed only when
        // the API is configured with a public base URL.
        const absoluteImage = message.imageUrl && /^https?:\/\//i.test(message.imageUrl)
          ? message.imageUrl
          : undefined
        const absoluteUrl = resolvePublicNotificationUrl(message.url)
        const payload = {
          username: 'PrintStream',
          embeds: [
            {
              title: message.title,
              url: absoluteUrl,
              description: message.body,
              color: COLOUR_BY_LEVEL[message.level],
              timestamp: message.timestamp,
              footer: message.printerName ? { text: message.printerName } : undefined,
              image: absoluteImage ? { url: absoluteImage } : undefined
            }
          ]
        }
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
        })
        if (!res.ok) {
          throw new Error(`Discord webhook responded ${res.status}`)
        }
      },
      {
        onError: (error) => context.logger.warn('failed to publish Discord notification', error),
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
