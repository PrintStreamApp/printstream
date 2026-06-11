/**
 * Logs route: returns recent system log entries plus durable audit entries.
 */
import { Router } from 'express'
import { SETTINGS_MANAGE_PERMISSION, logsResponseSchema } from '@printstream/shared'
import { assertRequestPermission } from '../lib/authorization.js'
import { clearLogs, getLogs } from '../lib/logs.js'
import { clearAuditLogs, getAuditLogs } from '../lib/audit-logs.js'
import { broadcastLogsChanged } from '../lib/ws-resource-events.js'

export const logsRouter = Router()

logsRouter.get('/', async (request, response) => {
  assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)
  const limitRaw = Number(request.query.limit ?? 500)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : 500
  const tenantFilter = request.tenant ? { tenantId: request.tenant.id } : undefined
  const [systemEntries, auditEntries] = await Promise.all([
    Promise.resolve(getLogs(limit, tenantFilter)),
    getAuditLogs(limit, tenantFilter)
  ])
  const entries = [...auditEntries, ...systemEntries]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit)
  response.json(logsResponseSchema.parse({ entries }))
})

logsRouter.delete('/', async (request, response) => {
  assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)
  const tenantFilter = request.tenant ? { tenantId: request.tenant.id } : undefined
  clearLogs(tenantFilter)
  await clearAuditLogs(tenantFilter)
  broadcastLogsChanged()
  response.status(204).end()
})
