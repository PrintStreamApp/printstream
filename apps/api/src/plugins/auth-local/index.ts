/**
 * Local auth plugin scaffold.
 *
 * This built-in plugin owns the future passkey + email-code experience for
 * human operators.
 *
 * Routes:
 * - `GET /api/plugins/auth-local/status` — local-auth setup summary used by
 *   the provider setup UI.
 * - `POST /api/plugins/auth-local/bootstrap/admin` — first-run bootstrap for
 *   the initial local-auth admin.
 * - `POST /api/plugins/auth-local/email-codes/*` — provider-owned one-time
 *   email-code sign-in flows.
 * - `POST /api/plugins/auth-local/passkeys/*` — provider-owned passkey flows
 *   for self-service and setup.
 * - `POST /api/plugins/auth-local/me/email-change/*` and
 *   `/users/:userId/(invite|passkeys/*)` — provider-specific account
 *   management helpers that extend the core auth shell.
 */
import type { RegisteredAuthProvider } from '../../lib/auth-registry.js'
import {
  AUTH_PROVIDERS_MANAGE_PERMISSION,
  authProviderEnabledStateSchema,
  updateAuthProviderEnabledRequestSchema
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { assertAuthProviderCanChangeState, restoreSupportAccessWhenWorkspaceAuthDisabled } from '../../lib/auth-provider-guard.js'
import { broadcastAuthChangedForTenant } from '../../lib/auth-change-events.js'
import { assertAuthMutationsAllowed } from '../../lib/demo-mode.js'
import {
  readScopedAuthProviderEnabled,
  readScopedAuthProviderSetupCompleteState,
  writeScopedAuthProviderEnabled
} from '../../lib/auth-provider-state.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest } from '../../lib/http-error.js'
import type { ApiPlugin } from '../../plugin/types.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { registerAuthLocalBootstrapRoutes } from './bootstrap.js'
import { ensureBuiltInAuthGroups } from '../../lib/default-auth-groups.js'
import { registerAuthLocalEmailCodeRoutes } from './email-codes.js'
import { registerAuthLocalPasskeyRoutes, type AuthLocalPasskeyServices } from './passkeys.js'
import { registerAuthLocalProviderManagementRoutes } from './provider-management.js'
import { buildLocalAuthStatus } from './state.js'

type AuthLocalPluginDeps = {
  buildStatus(prisma: AnyPrismaClient, input?: { setupComplete?: boolean | null }): Promise<import('@printstream/shared').LocalAuthStatus>
  ensureDefaultGroups(prisma: AnyPrismaClient): Promise<void>
  emailCodeServices: Parameters<typeof registerAuthLocalEmailCodeRoutes>[1]
  passkeyServices: Partial<AuthLocalPasskeyServices>
}

const defaultDeps: AuthLocalPluginDeps = {
  buildStatus: buildLocalAuthStatus,
  ensureDefaultGroups: ensureBuiltInAuthGroups,
  emailCodeServices: {},
  passkeyServices: {}
}

export function createAuthLocalPlugin(deps: Partial<AuthLocalPluginDeps> = {}): ApiPlugin {
  const services: AuthLocalPluginDeps = {
    ...defaultDeps,
    ...deps
  }

  return {
    name: 'auth-local',
    version: '0.1.0',
    description: 'Passkey and one-time email-code authentication for local operators.',
    async register(context) {
      const readStatus = async () => await services.buildStatus(context.prisma, {
        setupComplete: await readScopedAuthProviderSetupCompleteState(context.settings)
      })
      const providerBase: Omit<RegisteredAuthProvider, 'setupRequired'> = {
        id: 'auth-local',
        label: 'Local Auth',
        enabled: false,
        methods: ['passkey', 'email-code'],
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
          recentVerificationMethods: ['passkey', 'email-code']
        }
      }
      const syncProviderStatus = (nextStatus: Awaited<ReturnType<typeof services.buildStatus>>) => {
        void nextStatus
      }

      context.registerAuthProvider(async () => {
        const status = await readStatus()
        return {
          ...providerBase,
          enabled: await readScopedAuthProviderEnabled(context.settings),
          setupRequired: status.setupRequired
        }
      })

      context.router.use((request, _response, next) => {
        if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
          next()
          return
        }

        try {
          assertAuthMutationsAllowed(request)
          next()
        } catch (error) {
          next(error)
        }
      })

      context.router.get('/enabled', requireRequestPermission(AUTH_PROVIDERS_MANAGE_PERMISSION), async (_request, response) => {
        response.json(authProviderEnabledStateSchema.parse({
          enabled: await readScopedAuthProviderEnabled(context.settings)
        }))
      })

      context.router.post('/enabled', requireRequestPermission(AUTH_PROVIDERS_MANAGE_PERMISSION), async (request, response) => {
        const parsed = updateAuthProviderEnabledRequestSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid auth provider state payload.')
        }

        const currentEnabled = await readScopedAuthProviderEnabled(context.settings)
        if (parsed.data.enabled !== currentEnabled) {
          await assertAuthProviderCanChangeState({
            providerId: 'auth-local',
            currentEnabled,
            nextEnabled: parsed.data.enabled,
            tenant: request.tenant ?? null,
            isPlatformUser: request.auth.actor.type === 'user' && (request.auth.actor.isPlatformUser ?? false)
          })
          await writeScopedAuthProviderEnabled(context.settings, parsed.data.enabled)
          await restoreSupportAccessWhenWorkspaceAuthDisabled({
            tenant: request.tenant ?? null,
            nextEnabled: parsed.data.enabled,
            isPlatformUser: request.auth.actor.type === 'user' && (request.auth.actor.isPlatformUser ?? false)
          })
          broadcastAuthChangedForTenant(request.tenant?.id)
        }

        annotateRequestAuditLog(request, {
          action: parsed.data.enabled ? 'enable-auth-provider' : 'disable-auth-provider',
          resource: 'auth provider',
          summary: `${parsed.data.enabled ? 'Enabled' : 'Disabled'} the Local Auth provider.`,
          metadata: {
            provider: 'auth-local',
            enabled: parsed.data.enabled
          }
        })

        response.json(authProviderEnabledStateSchema.parse({ enabled: parsed.data.enabled }))
      })

      registerAuthLocalBootstrapRoutes(context, {
        buildStatus: async (prisma) => await services.buildStatus(prisma, {
          setupComplete: await readScopedAuthProviderSetupCompleteState(context.settings)
        }),
        syncProviderStatus,
        ...services.emailCodeServices
      })
      registerAuthLocalPasskeyRoutes(context, {
        buildStatus: async (prisma) => await services.buildStatus(prisma, {
          setupComplete: await readScopedAuthProviderSetupCompleteState(context.settings)
        }),
        syncProviderStatus,
        ...services.passkeyServices
      })
      registerAuthLocalEmailCodeRoutes(context, services.emailCodeServices)
      registerAuthLocalProviderManagementRoutes(context, {
        buildStatus: async (prisma) => await services.buildStatus(prisma, {
          setupComplete: await readScopedAuthProviderSetupCompleteState(context.settings)
        }),
        syncProviderStatus
      })

      context.router.get('/status', async (_request, response) => {
        const nextStatus = await readStatus()
        syncProviderStatus(nextStatus)
        response.json(nextStatus)
      })
    }
  }
}

export const authLocalPlugin = createAuthLocalPlugin()