/**
 * Editable notification template endpoints.
 *
 * Templates are core (shared across notification plugins) so they live
 * outside `/api/plugins/<name>` and have their own router. Reads return
 * every known template plus its defaults so the UI can render a "reset
 * to default" affordance without a second round trip.
 */
import { Router } from 'express'
import {
  SETTINGS_MANAGE_PERMISSION,
  notificationTemplateEventSchema,
  notificationTemplateUpdateSchema,
  platformNotificationTemplateListResponseSchema,
  platformNotificationTemplateUpdateSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest, notFound } from '../lib/http-error.js'
import {
  getNotificationTemplate,
  listNotificationTemplates,
  resetNotificationTemplate,
  updateNotificationTemplate
} from '../lib/notification-templates.js'
import {
  isKnownPlatformNotificationEvent,
  listPlatformNotificationTemplates,
  resetPlatformNotificationTemplate,
  updatePlatformNotificationTemplate
} from '../lib/platform-notification-events.js'
import { getSnapshot } from '../lib/notification-snapshots.js'
import { broadcastNotificationTemplatesChanged } from '../lib/ws-resource-events.js'

export const notificationsRouter = Router()

notificationsRouter.get('/templates', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), (_request, response) => {
  response.json({ templates: listNotificationTemplates() })
})

notificationsRouter.get('/templates/:event', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), (request, response) => {
  const parsed = notificationTemplateEventSchema.safeParse(request.params.event)
  if (!parsed.success) {
    throw notFound(`Unknown notification event: ${request.params.event}`)
  }
  response.json({ template: getNotificationTemplate(parsed.data) })
})

notificationsRouter.put('/templates/:event', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const parsedEvent = notificationTemplateEventSchema.safeParse(request.params.event)
  if (!parsedEvent.success) {
    throw notFound(`Unknown notification event: ${request.params.event}`)
  }
  const parsedBody = notificationTemplateUpdateSchema.safeParse(request.body ?? {})
  if (!parsedBody.success) {
    throw badRequest(parsedBody.error.issues[0]?.message ?? 'Invalid template update')
  }
  const template = await updateNotificationTemplate(parsedEvent.data, parsedBody.data)
  annotateRequestAuditLog(request, {
    action: 'update-notification-template',
    resource: 'notification template',
    summary: `Updated the notification template for ${parsedEvent.data}.`,
    metadata: {
      event: parsedEvent.data
    }
  })
  broadcastNotificationTemplatesChanged()
  response.json({ template })
})

notificationsRouter.delete('/templates/:event', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const parsed = notificationTemplateEventSchema.safeParse(request.params.event)
  if (!parsed.success) {
    throw notFound(`Unknown notification event: ${request.params.event}`)
  }
  const template = await resetNotificationTemplate(parsed.data)
  annotateRequestAuditLog(request, {
    action: 'reset-notification-template',
    resource: 'notification template',
    summary: `Reset the notification template for ${parsed.data} to its default.`,
    metadata: {
      event: parsed.data
    }
  })
  broadcastNotificationTemplatesChanged()
  response.json({ template })
})


/**
 * Platform-scope template endpoints. The event set is the deployment's
 * registered platform events (dynamic, unlike the printer-event enum), and
 * the templates live under the platform settings scope — so these routes are
 * platform-workspace only: a tenant-context request must not reach platform
 * configuration with tenant-scoped authority.
 */
function requirePlatformContext(request: import('express').Request): void {
  if (request.tenant) {
    throw notFound('Platform notification templates are managed from the platform workspace.')
  }
}

notificationsRouter.get('/platform-templates', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  requirePlatformContext(request)
  response.json(platformNotificationTemplateListResponseSchema.parse({
    templates: await listPlatformNotificationTemplates()
  }))
})

notificationsRouter.put('/platform-templates/:event', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  requirePlatformContext(request)
  const event = String(request.params.event ?? '')
  if (!isKnownPlatformNotificationEvent(event)) {
    throw notFound(`Unknown platform notification event: ${event}`)
  }
  const parsedBody = platformNotificationTemplateUpdateSchema.safeParse(request.body ?? {})
  if (!parsedBody.success) {
    throw badRequest(parsedBody.error.issues[0]?.message ?? 'Invalid template update')
  }
  const template = await updatePlatformNotificationTemplate(event, parsedBody.data)
  annotateRequestAuditLog(request, {
    action: 'update-platform-notification-template',
    resource: 'platform notification template',
    summary: `Updated the platform notification template for ${event}.`,
    metadata: { event }
  })
  response.json({ template })
})

notificationsRouter.delete('/platform-templates/:event', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  requirePlatformContext(request)
  const event = String(request.params.event ?? '')
  if (!isKnownPlatformNotificationEvent(event)) {
    throw notFound(`Unknown platform notification event: ${event}`)
  }
  const template = await resetPlatformNotificationTemplate(event)
  annotateRequestAuditLog(request, {
    action: 'reset-platform-notification-template',
    resource: 'platform notification template',
    summary: `Reset the platform notification template for ${event} to its default.`,
    metadata: { event }
  })
  response.json({ template })
})

/**
 * Serve a transient JPEG captured at notification dispatch time. The id
 * is an unguessable UUID; entries expire after a short TTL (see
 * `notification-snapshots`). Returns 404 once expired so dead links
 * don't surprise users.
 */
notificationsRouter.get('/snapshots/:id', (request, response) => {
  const entry = getSnapshot(request.params.id)
  if (!entry) {
    throw notFound('Snapshot not available')
  }
  response.setHeader('Content-Type', entry.contentType)
  response.setHeader('Cache-Control', 'public, max-age=60')
  response.send(entry.buffer)
})
