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
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { AUTHENTICATION_REQUIRED_MESSAGE } from '../lib/authorization.js'
import { assertRequestPermission } from '../lib/authorization.js'
import { blockedPluginsForTenant } from '../lib/plugin-plan-gate.js'
import { pluginRegistry } from '../plugin/registry.js'
import { badRequest, forbidden, unauthorized } from '../lib/http-error.js'

export const pluginCatalogRouter = Router()

pluginCatalogRouter.get('/', async (request, response) => {
  if (request.auth.authEnabled && request.auth.actor.type === 'anonymous') {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }

  // Plan-gated plugins (e.g. Pro plugins on a Free workspace) surface as
  // enabled: false so tabs/routes hide, plus planBlocked so the plugin manager
  // can explain why instead of showing a dead toggle.
  const blocked = request.tenant ? await blockedPluginsForTenant(request.tenant.id) : null
  const plugins = pluginRegistry.listCatalog(request).map((plugin) =>
    blocked?.has(plugin.name)
      ? { ...plugin, enabled: false, planBlocked: true }
      : plugin
  )
  response.json({ plugins })
})

pluginCatalogRouter.post('/:name/enabled', async (request, response) => {
  if (!request.tenant) {
    throw forbidden('Switch to a tenant workspace to manage plugins for this workspace.')
  }

  assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)

  if (typeof request.body?.enabled !== 'boolean') {
    throw badRequest('Expected { enabled: boolean }')
  }

  if (request.body.enabled) {
    const blocked = await blockedPluginsForTenant(request.tenant.id)
    if (blocked.has(request.params.name)) {
      throw forbidden('This plugin requires the Pro plan.')
    }
  }

  const plugin = await pluginRegistry.setTenantEnabled(
    request.params.name,
    request.tenant.id,
    request.body.enabled,
    request
  )

  annotateRequestAuditLog(request, {
    action: request.body.enabled ? 'enable-plugin' : 'disable-plugin',
    resource: 'plugin',
    summary: `${request.body.enabled ? 'Enabled' : 'Disabled'} plugin ${plugin.name} for this workspace.`,
    metadata: {
      pluginName: plugin.name,
      enabled: request.body.enabled
    }
  })

  response.json({ plugin })
})