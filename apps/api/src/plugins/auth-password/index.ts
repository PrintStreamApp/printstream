/**
 * Password auth plugin (`auth-password`).
 *
 * The self-hosted (OSS) sign-in provider: basic email/password accounts with
 * no email infrastructure required. It is the build-exclusive counterpart to the
 * cloud `auth-local` provider (passkeys + one-time email codes) — exactly one of
 * the two is registered per deployment (see `isSelfHostedDeployment` and the API
 * plugin `builtin` wiring).
 *
 * Routes:
 * - `GET/POST /api/plugins/auth-password/enabled` — provider enable state.
 * - `GET /api/plugins/auth-password/status` — setup summary for the setup UI.
 * - `POST /api/plugins/auth-password/bootstrap/admin` — first-run admin + password.
 * - `POST /api/plugins/auth-password/sign-in` — email/password sign-in.
 * - `GET|POST /api/plugins/auth-password/me/password[/change]` — self-service.
 * - `POST|DELETE /api/plugins/auth-password/users/:userId/password` — admin set/reset.
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
import { registerAuthPasswordAccountRoutes } from './account.js'
import { registerAuthPasswordBootstrapRoutes } from './bootstrap.js'
import { registerAuthPasswordManagementRoutes } from './password-management.js'
import { registerAuthPasswordResetRoutes } from './password-reset.js'
import { registerAuthPasswordSignInRoutes } from './sign-in.js'
import { buildPasswordAuthStatus } from './state.js'

type AuthPasswordPluginDeps = {
  buildStatus(prisma: AnyPrismaClient, input?: { setupComplete?: boolean | null }): Promise<import('@printstream/shared').PasswordAuthStatus>
}

const defaultDeps: AuthPasswordPluginDeps = {
  buildStatus: buildPasswordAuthStatus
}

export function createAuthPasswordPlugin(deps: Partial<AuthPasswordPluginDeps> = {}): ApiPlugin {
  const services: AuthPasswordPluginDeps = {
    ...defaultDeps,
    ...deps
  }

  return {
    name: 'auth-password',
    version: '0.1.0',
    description: 'Email and password authentication for self-hosted operators.',
    async register(context) {
      const readStatus = async () => await services.buildStatus(context.prisma, {
        setupComplete: await readScopedAuthProviderSetupCompleteState(context.settings)
      })
      const providerBase: Omit<RegisteredAuthProvider, 'setupRequired'> = {
        id: 'auth-password',
        label: 'Password',
        enabled: false,
        methods: ['password'],
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: false,
          adminUserCredentials: true,
          recentVerificationMethods: ['password']
        }
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
            providerId: 'auth-password',
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
          summary: `${parsed.data.enabled ? 'Enabled' : 'Disabled'} the Password provider.`,
          metadata: {
            provider: 'auth-password',
            enabled: parsed.data.enabled
          }
        })

        response.json(authProviderEnabledStateSchema.parse({ enabled: parsed.data.enabled }))
      })

      registerAuthPasswordBootstrapRoutes(context, {
        buildStatus: async (prisma) => await services.buildStatus(prisma, {
          setupComplete: await readScopedAuthProviderSetupCompleteState(context.settings)
        })
      })
      registerAuthPasswordSignInRoutes(context)
      registerAuthPasswordResetRoutes(context)
      registerAuthPasswordAccountRoutes(context)
      registerAuthPasswordManagementRoutes(context)

      context.router.get('/status', async (_request, response) => {
        response.json(await readStatus())
      })
    }
  }
}

export const authPasswordPlugin = createAuthPasswordPlugin()
