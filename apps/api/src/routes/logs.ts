/**
 * Logs route: returns recent system log entries plus durable audit entries.
 */
import { Router } from 'express'
import { SETTINGS_MANAGE_PERMISSION, logsResponseSchema } from '@printstream/shared'
import { assertRequestPermission } from '../lib/authorization.js'
import { clearLogs, getLogs } from '../lib/logs.js'
import { annotateRequestAuditLog, clampLogLimit, clearAuditLogs, getAuditLogs } from '../lib/audit-logs.js'
import { broadcastLogsChanged } from '../lib/ws-resource-events.js'

export const logsRouter = Router()

logsRouter.get('/', async (request, response) => {
  assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)
  const limitRaw = Number(request.query.limit ?? 500)
  const limit = Number.isFinite(limitRaw) ? clampLogLimit(Math.floor(limitRaw)) : 500
  const workspaceFilter = request.workspace ? { workspaceId: request.workspace.id } : undefined
  const [systemEntries, auditEntries] = await Promise.all([
    Promise.resolve(getLogs(limit, workspaceFilter)),
    getAuditLogs(limit, workspaceFilter)
  ])
  const entries = [...auditEntries, ...systemEntries]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit)
  response.json(logsResponseSchema.parse({ entries }))
})

logsRouter.delete('/', async (request, response) => {
  assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)
  const workspaceFilter = request.workspace ? { workspaceId: request.workspace.id } : undefined
  // Destructive: this clears the durable audit trail itself. Record the
  // scope so the cleared range is auditable even though the entries are gone.
  annotateRequestAuditLog(request, {
    action: 'clear-logs',
    resource: 'logs',
    summary: request.workspace
      ? 'Cleared all system and audit log entries for this workspace.'
      : 'Cleared all system and audit log entries platform-wide.',
    metadata: {
      scope: request.workspace ? 'workspace' : 'platform',
      ...(request.workspace ? { workspaceId: request.workspace.id } : {})
    }
  })
  clearLogs(workspaceFilter)
  await clearAuditLogs(workspaceFilter)
  broadcastLogsChanged()
  response.status(204).end()
})
