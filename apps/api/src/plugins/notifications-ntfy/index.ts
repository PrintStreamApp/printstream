/**
 * ntfy notifications plugin (built-in).
 *
 * Forwards printer-domain events to a configured ntfy-style HTTP topic
 * URL. Message formatting is delegated to the shared notification
 * helper so this plugin only owns delivery semantics.
 *
 * Configuration is tenant-scoped: each tenant stores its own topic URL
 * via `context.settings.forTenant(tenantId)`. Falls back to the
 * `NTFY_TOPIC_URL` env var when no per-tenant setting exists.
 * Notifications are only delivered when the owning tenant has a topic
 * configured.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { env } from '../../lib/env.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { requireRequestTenantId } from '../../lib/request-helpers.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'

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
      const tenantId = requireRequestTenantId(request)
      const tenantSettings = context.settings.forTenant(tenantId)
      const topicUrl = (await tenantSettings.get('topicUrl')) ?? env.NTFY_TOPIC_URL ?? null
      response.json({ enabled: Boolean(topicUrl), topicConfigured: Boolean(topicUrl) })
    })

    context.router.put('/topic', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const tenantId = requireRequestTenantId(request)
      const tenantSettings = context.settings.forTenant(tenantId)
      const value = typeof request.body?.topicUrl === 'string' ? request.body.topicUrl.trim() : ''
      if (!value) {
        await tenantSettings.delete('topicUrl')
        response.json({ topicConfigured: false })
        return
      }
      await tenantSettings.set('topicUrl', value)
      response.json({ topicConfigured: true })
    })

    const off = subscribePrinterNotifications(
      context.printerEvents,
      async (message) => {
        if (!message.tenantId) return
        const tenantSettings = context.settings.forTenant(message.tenantId)
        const topicUrl = (await tenantSettings.get('topicUrl')) ?? env.NTFY_TOPIC_URL ?? null
        if (!topicUrl) return
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
        await fetch(topicUrl, { method: 'POST', headers, body: message.body })
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
