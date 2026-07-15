/**
 * Discord notifications plugin (built-in).
 *
 * Posts printer-domain notifications to configured Discord webhooks.
 * Formatting is delegated to the shared notification helper; this
 * plugin only owns Discord-specific delivery (embed colour, payload
 * shape).
 *
 * Destinations are a per-scope recipients list (shared team webhooks for
 * broadcast notifications, self-bound personal webhooks for the requesting
 * user's targeted messages — see `lib/notification-recipients.ts`). Each
 * tenant stores its list via `context.settings.forTenant(tenantId)`, the
 * platform workspace in the plugin's base store; a pre-list `webhookUrl`
 * setting keeps working as an implicit shared entry until first write.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import type { NotificationLevel, NotificationMessage } from '@printstream/shared'
import { badRequest } from '../../lib/http-error.js'
import { registerChannelRecipientRoutes } from '../../lib/notification-recipient-routes.js'
import { resolveChannelDeliveryUrls } from '../../lib/notification-recipients.js'
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

const RECIPIENT_OPTIONS = {
  channelLabel: 'Discord',
  legacyUrlKey: 'webhookUrl',
  legacyLabel: 'Discord webhook',
  validateUrl: (url: string) => {
    if (!WEBHOOK_PATTERN.test(url)) {
      throw badRequest('Not a valid Discord webhook URL')
    }
  }
}

export const notificationsDiscordPlugin: ApiPlugin = {
  name: 'notifications-discord',
  version: '0.2.0',
  description: 'Forward printer notifications to Discord webhooks (shared channels and personal ones).',
  async register(context) {
    registerChannelRecipientRoutes(context, RECIPIENT_OPTIONS)

    const off = subscribePrinterNotifications(
      context.printerEvents,
      async (message) => {
        const urls = await resolveChannelDeliveryUrls({
          ...RECIPIENT_OPTIONS,
          message,
          pluginName: context.pluginName,
          prisma: context.prisma,
          settingsForScope: (tenantId) => tenantId ? context.settings.forTenant(tenantId) : context.settings,
          isEnabledForTenant: (tenantId) => context.isEnabledForTenant?.(tenantId) ?? true
        })
        if (urls.length === 0) return
        const payload = buildDiscordPayload(message)
        const results = await Promise.allSettled(urls.map(async (url) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
          })
          if (!res.ok) {
            throw new Error(`Discord webhook responded ${res.status}`)
          }
        }))
        for (const result of results) {
          // One dead webhook must not hide the others; URLs are secrets, so
          // only the failure itself is logged.
          if (result.status === 'rejected') {
            context.logger.warn('failed to publish Discord notification', result.reason)
          }
        }
      },
      {
        onError: (error) => context.logger.warn('failed to publish Discord notification', error)
        // No shouldHandleTenantId gate: targeted messages may fan out beyond
        // the event's own scope, so the resolver enforces plugin enablement
        // per DELIVERY scope instead of per event scope.
      }
    )
    context.onShutdown(off)
  }
}

function buildDiscordPayload(message: NotificationMessage) {
  // Discord embeds need an absolute URL for the image; relative
  // paths get silently dropped. We attach via embed only when
  // the API is configured with a public base URL.
  const absoluteImage = message.imageUrl && /^https?:\/\//i.test(message.imageUrl)
    ? message.imageUrl
    : undefined
  const absoluteUrl = resolvePublicNotificationUrl(message.url)
  return {
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
