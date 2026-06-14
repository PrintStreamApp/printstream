/**
 * Public plugin catalog for the current workspace context.
 *
 * Returns every known plugin annotated with whether it is available in the
 * current platform or tenant workspace. The UI uses this to gate plugin routes
 * and tenant-scoped plugin settings without depending on the privileged admin
 * plugin management API.
 */
import { Router } from 'express'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { AUTHENTICATION_REQUIRED_MESSAGE } from '../lib/authorization.js'
import { assertRequestPermission } from '../lib/authorization.js'
import { pluginRegistry } from '../plugin/registry.js'
import { badRequest, forbidden, unauthorized } from '../lib/http-error.js'

export const pluginCatalogRouter = Router()

pluginCatalogRouter.get('/', (request, response) => {
  if (request.auth.authEnabled && request.auth.actor.type === 'anonymous') {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }

  response.json({ plugins: pluginRegistry.listCatalog(request) })
})

pluginCatalogRouter.post('/:name/enabled', async (request, response) => {
  if (!request.tenant) {
    throw forbidden('Switch to a tenant workspace to manage plugins for this workspace.')
  }

  assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)

  if (typeof request.body?.enabled !== 'boolean') {
    throw badRequest('Expected { enabled: boolean }')
  }

  const plugin = await pluginRegistry.setTenantEnabled(
    request.params.name,
    request.tenant.id,
    request.body.enabled,
    request
  )

  response.json({ plugin })
})