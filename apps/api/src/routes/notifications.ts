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
  notificationTemplateUpdateSchema
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
