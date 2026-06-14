/**
 * Server-side delete operation jobs.
 *
 * Mirrors the print-dispatch surface: browsers start a delete job, the API
 * keeps running it in the background, and clients poll the job list for
 * progress while resource-changed WS events invalidate nearby caches.
 */
import { Router } from 'express'
import {
  deleteOperationsResponseSchema,
  LIBRARY_MANAGE_PERMISSION,
  PRINTERS_MANAGE_STORAGE_EDIT_SCOPE
} from '@printstream/shared'
import { requestHasPermission } from '../lib/auth-context.js'
import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  PERMISSION_REQUIRED_MESSAGE,
  requestIsAuthenticated
} from '../lib/authorization.js'
import { deleteOperationDispatcher } from '../lib/delete-operation-dispatcher.js'
import { forbidden, unauthorized } from '../lib/http-error.js'

export const deleteOperationsRouter = Router()

deleteOperationsRouter.get('/', (request, response) => {
  const canManageLibrary = requestHasPermission(request, LIBRARY_MANAGE_PERMISSION)
  const canManagePrinterStorage = requestHasPermission(request, PRINTERS_MANAGE_STORAGE_EDIT_SCOPE)

  if (request.auth.authEnabled) {
    if (!requestIsAuthenticated(request)) {
      throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
    }
    if (!canManageLibrary && !canManagePrinterStorage) {
      throw forbidden(PERMISSION_REQUIRED_MESSAGE)
    }
  }

  const jobs = deleteOperationDispatcher.list(request.tenant?.id ?? null).filter((job) => {
    if (job.kind === 'library.delete') return canManageLibrary || !request.auth.authEnabled
    if (job.kind === 'printer.storage.delete') return canManagePrinterStorage || !request.auth.authEnabled
    return false
  })

  response.json(deleteOperationsResponseSchema.parse({ jobs }))
})