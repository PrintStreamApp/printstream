/**
 * Email delivery for the `notifications-email` channel.
 *
 * Resolves the opted-in members of the event's workspace to their account email
 * addresses and sends one message per recipient through the core email-transport
 * registry. Recipients are filtered to *current, enabled* members so a removed or
 * login-disabled user stops receiving mail even if their opt-in row lingers.
 */
import type { NotificationMessage } from '@printstream/shared'
import { env } from '../../lib/env.js'
import { isEmailDeliveryConfigured, sendEmail } from '../../lib/email-delivery.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import { messageNotificationScope } from '../../lib/notification-scope.js'
import { readEmailSubscribers } from '../../lib/notification-subscribers.js'

/** Builds the notification handler that emails the scope's opted-in users. */
export function createEmailNotificationHandler(context: ApiPluginContext) {
  return async function handle(message: NotificationMessage): Promise<void> {
    // Skip cheaply when no transport can deliver (e.g. OSS before SMTP is set up).
    if (!(await isEmailDeliveryConfigured())) return

    const scope = messageNotificationScope(context, message.tenantId)
    const subscriberIds = await readEmailSubscribers(scope.settings)
    if (subscriberIds.length === 0) return

    const recipients = scope.tenantId
      ? await resolveTenantRecipients(context, scope.tenantId, subscriberIds)
      : await resolvePlatformRecipients(context, subscriberIds)
    if (recipients.length === 0) return

    const html = buildEmailHtml(message)
    for (const to of recipients) {
      try {
        await sendEmail({ to, subject: message.title, text: message.body, html })
      } catch (error) {
        // One bad recipient/transport hiccup must not drop the rest.
        context.logger.warn('failed to send notification email', error)
      }
    }
  }
}

/** Opted-in members of the tenant, filtered to current enabled memberships. */
async function resolveTenantRecipients(context: ApiPluginContext, tenantId: string, subscriberIds: string[]): Promise<string[]> {
  const members = await context.prisma.authTenantMembership.findMany({
    where: { tenantId, userId: { in: subscriberIds }, loginDisabled: false },
    select: { user: { select: { email: true } } }
  })
  return [...new Set(
    members.map((member) => member.user?.email).filter((email): email is string => Boolean(email))
  )]
}

/** Opted-in platform users; a revoked platform flag stops delivery even if the opt-in row lingers. */
async function resolvePlatformRecipients(context: ApiPluginContext, subscriberIds: string[]): Promise<string[]> {
  const users = await context.prisma.authUser.findMany({
    where: { id: { in: subscriberIds }, isPlatformUser: true },
    select: { email: true }
  })
  return [...new Set(users.map((user) => user.email).filter((email): email is string => Boolean(email)))]
}

function buildEmailHtml(message: NotificationMessage): string {
  const parts = [`<p>${escapeHtml(message.body)}</p>`]
  const link = resolvePublicNotificationUrl(message.url)
  if (link) {
    parts.push(`<p><a href="${escapeHtml(link)}">View in PrintStream</a></p>`)
  }
  if (message.imageUrl && /^https?:\/\//i.test(message.imageUrl)) {
    parts.push(`<p><img src="${escapeHtml(message.imageUrl)}" alt="Print snapshot" style="max-width:480px;border-radius:8px" /></p>`)
  }
  return parts.join('')
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
