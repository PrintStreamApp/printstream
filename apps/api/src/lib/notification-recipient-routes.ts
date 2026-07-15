/**
 * Shared HTTP surface for channels that keep a recipients list (see
 * `notification-recipients.ts`): list, add, and remove destination entries
 * per scope. Mounted on each channel plugin's router so both Discord and
 * ntfy expose the identical contract:
 *
 * - `GET /` — `{ configured, recipients }` (labels + audience only; the
 *   destination URLs are secrets and never leave the server).
 * - `POST /recipients` — add an entry. `audience: 'everyone'` is the shared
 *   scope destination; `audience: 'mine'` binds the entry to the REQUESTING
 *   user (self-service only — see the recipients module header for why).
 * - `DELETE /recipients/:id` — remove an entry.
 */
import { z } from 'zod'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import type { ApiPluginContext } from '../plugin/types.js'
import { annotateRequestAuditLog } from './audit-logs.js'
import { requireRequestPermission } from './authorization.js'
import { badRequest, unauthorized } from './http-error.js'
import {
  createChannelRecipient,
  readChannelRecipients,
  writeChannelRecipients,
  type ChannelRecipient
} from './notification-recipients.js'
import { requestNotificationScope } from './notification-scope.js'
import { requireRouteParam } from './request-helpers.js'

const addRecipientSchema = z.object({
  url: z.string().trim().url().max(2048),
  label: z.string().trim().max(80).optional(),
  audience: z.enum(['everyone', 'mine'])
})

export interface ChannelRecipientRouteOptions {
  /** Human channel name for audit summaries ("Discord", "ntfy"). */
  channelLabel: string
  /** Legacy single-URL setting key this channel used before lists. */
  legacyUrlKey: string
  /** Label for the implicit legacy entry. */
  legacyLabel: string
  /** Channel-specific URL validation; throw `HttpError` on rejection. */
  validateUrl: (url: string) => void
  /** Extra "configured" signal beyond stored recipients (ntfy env fallback). */
  fallbackConfigured?: () => boolean
}

/** A recipient as serialized to the settings UI — deliberately URL-free. */
export interface ChannelRecipientView {
  id: string
  label: string
  audience: 'everyone' | 'personal'
  userName?: string
}

function toView(entry: ChannelRecipient): ChannelRecipientView {
  return {
    id: entry.id,
    label: entry.label,
    audience: entry.userId ? 'personal' : 'everyone',
    userName: entry.userName
  }
}

export function registerChannelRecipientRoutes(context: ApiPluginContext, options: ChannelRecipientRouteOptions): void {
  const legacyOptions = { legacyUrlKey: options.legacyUrlKey, legacyLabel: options.legacyLabel }

  context.router.get('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
    const scope = requestNotificationScope(context, request)
    const recipients = await readChannelRecipients(scope.settings, legacyOptions)
    response.json({
      configured: recipients.length > 0 || (options.fallbackConfigured?.() ?? false),
      recipients: recipients.map(toView)
    })
  })

  context.router.post('/recipients', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
    const scope = requestNotificationScope(context, request)
    const parsed = addRecipientSchema.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid recipient payload.')
    }
    options.validateUrl(parsed.data.url)

    let userId: string | undefined
    let userName: string | undefined
    if (parsed.data.audience === 'mine') {
      // Personal entries bind to the requesting user only; routing another
      // user's personal notifications to a destination you control is not
      // representable on purpose.
      if (request.auth.actor.type !== 'user') {
        throw unauthorized('Personal destinations require a signed-in user.')
      }
      userId = request.auth.actor.userId
      const user = await context.prisma.authUser.findUnique({
        where: { id: userId },
        select: { displayName: true, email: true }
      })
      userName = user?.displayName ?? user?.email ?? undefined
    }

    const recipients = await readChannelRecipients(scope.settings, legacyOptions)
    const entry = createChannelRecipient({ url: parsed.data.url, label: parsed.data.label, userId, userName })
    await writeChannelRecipients(scope.settings, [...recipients, entry], legacyOptions)

    // The destination URL is a secret; record only audience + label.
    annotateRequestAuditLog(request, {
      action: `add-${options.channelLabel.toLowerCase()}-recipient`,
      resource: `${options.channelLabel} notification recipients`,
      summary: `Added a ${parsed.data.audience === 'mine' ? 'personal' : 'shared'} ${options.channelLabel} notification destination.`,
      metadata: { recipientId: entry.id, label: entry.label, audience: parsed.data.audience }
    })
    response.status(201).json({
      configured: true,
      recipients: [...recipients, entry].map(toView)
    })
  })

  context.router.delete('/recipients/:id', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
    const scope = requestNotificationScope(context, request)
    const id = requireRouteParam(request.params.id, 'id')
    const recipients = await readChannelRecipients(scope.settings, legacyOptions)
    const next = recipients.filter((entry) => entry.id !== id)
    const removed = next.length !== recipients.length
    if (removed) {
      await writeChannelRecipients(scope.settings, next, legacyOptions)
    }
    annotateRequestAuditLog(request, {
      action: `remove-${options.channelLabel.toLowerCase()}-recipient`,
      resource: `${options.channelLabel} notification recipients`,
      summary: `Removed a ${options.channelLabel} notification destination.`,
      metadata: { recipientId: id, removed }
    })
    response.json({
      configured: next.length > 0 || (options.fallbackConfigured?.() ?? false),
      recipients: next.map(toView)
    })
  })
}
