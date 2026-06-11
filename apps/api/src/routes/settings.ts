/**
 * Core application settings routes.
 *
 * Mounted at `/api/settings` for shared, installation-wide preferences
 * that the web app can combine with device-local overrides.
 */
import { Router } from 'express'
import { AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION, SETTINGS_MANAGE_PERMISSION, filterPermissionsForTenantContext, updateGeneralSettingsSchema } from '@printstream/shared'
import { authProviderRegistry } from '../lib/auth-registry.js'
import { broadcastAuthChangedForTenant } from '../lib/auth-change-events.js'
import { requestHasPermission } from '../lib/auth-context.js'
import { assertSettingsMutationsAllowed } from '../lib/demo-mode.js'
import { requireRecentUserSession } from '../lib/auth-session.js'
import { AUTHENTICATION_REQUIRED_MESSAGE, PERMISSION_REQUIRED_MESSAGE, assertRequestPermission } from '../lib/authorization.js'
import { badRequest, conflict, unauthorized } from '../lib/http-error.js'
import { getGeneralSettings, updateGeneralSettings } from '../lib/general-settings.js'
import { prisma } from '../lib/prisma.js'

export const settingsRouter = Router()

settingsRouter.get('/', async (_request, response) => {
  response.json(await getGeneralSettings())
})

settingsRouter.put('/', async (request, response) => {
  assertSettingsMutationsAllowed(request)

  const parsed = updateGeneralSettingsSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid settings payload.')

  if (parsed.data.appTheme !== undefined || parsed.data.unconstrainedWidth !== undefined || parsed.data.landingPage !== undefined) {
    assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)
  }

  if (parsed.data.supportAccessEnabled !== undefined || parsed.data.supportAccessPermissions !== undefined) {
    if (!request.tenant) {
      throw badRequest('Tenant context is required.')
    }

    assertRequestPermission(request, AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION)

    if (parsed.data.supportAccessPermissions) {
      const visiblePermissions = new Set(filterPermissionsForTenantContext(parsed.data.supportAccessPermissions))
      if (visiblePermissions.size !== parsed.data.supportAccessPermissions.length) {
        throw badRequest('One or more support permissions are not available in this workspace.')
      }
    }

    const tenantHasAnyEnabledAuthProvider = (await authProviderRegistry.list()).some((provider) => provider.enabled)

    if (tenantHasAnyEnabledAuthProvider) {
      if (request.auth.actor.type !== 'user') {
        throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
      }

      await requireRecentUserSession(prisma, request, request.auth.actor.userId)

      if (parsed.data.supportAccessEnabled === false) {
        const enabledTenantAdminCount = await prisma.authUser.count({
          where: {
            tenantMemberships: {
              some: {
                tenantId: request.tenant.id,
                loginDisabled: false
              }
            },
            memberships: {
              some: {
                group: {
                  tenantId: request.tenant.id,
                  key: 'admin'
                }
              }
            }
          }
        })

        if (enabledTenantAdminCount === 0) {
          throw conflict('At least one enabled Admin user must remain before disabling support access.')
        }
      }
    }
  }

  if (parsed.data.appTheme === undefined && parsed.data.unconstrainedWidth === undefined && parsed.data.supportAccessEnabled === undefined && parsed.data.supportAccessPermissions === undefined) {
    if (!request.auth.authEnabled) {
      throw badRequest('At least one general setting must be provided.')
    }

    if (!requestHasPermission(request, SETTINGS_MANAGE_PERMISSION) && !requestHasPermission(request, AUTH_MANAGE_SUPPORT_ACCESS_PERMISSION)) {
      throw unauthorized(PERMISSION_REQUIRED_MESSAGE)
    }
  }

  const updated = await updateGeneralSettings(parsed.data)
  if (parsed.data.supportAccessEnabled !== undefined || parsed.data.supportAccessPermissions !== undefined) {
    broadcastAuthChangedForTenant(request.tenant?.id)
  }
  response.json(updated)
})