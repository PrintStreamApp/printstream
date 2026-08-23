/**
 * Server backup routes (issue #78): list/run/delete backups and stage a
 * restore. Deployment-dependent authority:
 *
 *  - Self-hosted: the settings-manage permission, the same gate as the app
 *    update action (`routes/app.ts`), install ≈ workspace there, and on a
 *    fresh install with auth disabled enforcement is bypassed rather than
 *    granted, which is exactly the operator these endpoints exist for.
 *  - Cloud: PLATFORM context only (the platform workspace, a platform user),
 *    a backup spans every workspace on the install, so a workspace admin must
 *    never see it; outside platform context the routes 404 so the surface
 *    does not exist.
 *
 * Restore is the one genuinely destructive action in the product: the route
 * only STAGES it (safety backup + marker + restart); the boot path applies it
 * (`lib/server-backup-restore.ts`).
 */
import express from 'express'
import {
  SETTINGS_MANAGE_PERMISSION,
  serverBackupListResponseSchema,
  serverBackupRestoreResponseSchema,
  serverBackupRunResponseSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { isSelfHostedDeployment } from '../lib/deployment-mode.js'
import { conflict, notFound } from '../lib/http-error.js'
import { requireRouteParam } from '../lib/request-helpers.js'
import { deleteServerBackup, listServerBackups } from '../lib/server-backup-store.js'
import { getServerBackupStatus, startServerBackup } from '../lib/server-backup-manager.js'
import { readPendingRestoreMarker, stageServerRestore } from '../lib/server-backup-restore.js'

export const serverBackupsRouter = express.Router()

serverBackupsRouter.use((request, response, next) => {
  if (isSelfHostedDeployment()) {
    next()
    return
  }
  // Cloud: whole-install backups exist only at the platform scope. 404, not
  // 403, outside it, for a workspace admin the surface does not exist.
  const isPlatformUser = request.auth.actor.type === 'user' && request.auth.actor.isPlatformUser === true
  if (request.workspace || !isPlatformUser) {
    next(notFound('Server backups are managed from the platform workspace.'))
    return
  }
  next()
})
serverBackupsRouter.use(requireRequestPermission(SETTINGS_MANAGE_PERMISSION))

serverBackupsRouter.get('/', async (request, response) => {
  const [status, snapshots] = await Promise.all([getServerBackupStatus(), listServerBackups()])
  response.json(serverBackupListResponseSchema.parse({ status, snapshots }))
})

serverBackupsRouter.post('/run', async (request, response) => {
  let status
  try {
    status = await startServerBackup('manual')
  } catch (error) {
    throw conflict((error as Error).message)
  }
  annotateRequestAuditLog(request, {
    action: 'run-server-backup',
    resource: 'server-backup',
    summary: 'Started a manual server backup.'
  })
  response.status(202).json(serverBackupRunResponseSchema.parse({ status }))
})

serverBackupsRouter.delete('/:name', async (request, response) => {
  const name = requireRouteParam(request.params.name, 'name')
  const marker = await readPendingRestoreMarker()
  if (marker?.backupName === name) {
    throw conflict('This backup is staged for restore; it cannot be deleted right now.')
  }
  try {
    await deleteServerBackup(name)
  } catch {
    throw notFound('Backup not found.')
  }
  annotateRequestAuditLog(request, {
    action: 'delete-server-backup',
    resource: 'server-backup',
    summary: `Deleted server backup ${name}.`,
    metadata: { backupName: name }
  })
  response.status(204).end()
})

serverBackupsRouter.post('/:name/restore', async (request, response) => {
  const name = requireRouteParam(request.params.name, 'name')
  let message: string
  try {
    message = await stageServerRestore(name)
  } catch (error) {
    throw conflict((error as Error).message)
  }
  annotateRequestAuditLog(request, {
    action: 'restore-server-backup',
    resource: 'server-backup',
    summary: `Staged a restore of server backup ${name}; the app is restarting to apply it.`,
    metadata: { backupName: name }
  })
  response.status(202).json(serverBackupRestoreResponseSchema.parse({ accepted: true, message }))
})
