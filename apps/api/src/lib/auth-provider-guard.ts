/**
 * Shared auth-provider safety checks.
 */
import { prisma } from './prisma.js'
import { SUPPORT_ACCESS_ENABLED_SETTING_KEY } from './support-access.js'
import { authProviderRegistry } from './auth-registry.js'
import { isSelfHostedDeployment } from './deployment-mode.js'
import { conflict } from './http-error.js'
import type { RequestTenantSummary } from './tenant-context.js'
import { withTenantRequestContext } from './tenant-context.js'
import { scopeSettingKeyForTenant } from './tenant-settings.js'

export async function assertAuthProviderCanChangeState(input: {
  providerId: string
  currentEnabled: boolean
  nextEnabled: boolean
  tenant?: RequestTenantSummary | null
  isPlatformUser?: boolean
  /** Defaults to the live deployment mode; overridable for tests. */
  selfHosted?: boolean
}): Promise<void> {
  const selfHosted = input.selfHosted ?? isSelfHostedDeployment()
  // Self-hosted (OSS) is a single-workspace install with no separate platform
  // surface to protect, so workspace sign-in is configured directly. In the
  // hosted cloud, a tenant must not lock down sign-in before platform auth
  // exists (which would otherwise leave the platform open).
  if (input.nextEnabled && !input.currentEnabled && input.tenant && !selfHosted) {
    const platformAuthEnabled = await withTenantRequestContext(null, async () => await authProviderRegistry.hasEnabledProviders())
    if (!platformAuthEnabled) {
      throw conflict('Enable platform authentication before configuring tenant sign-in.')
    }
  }

  if (input.nextEnabled || !input.currentEnabled) {
    return
  }

  const providers = await authProviderRegistry.list()
  if (providers.some((provider) => provider.id !== input.providerId && provider.enabled)) {
    return
  }

  if (input.tenant) {
    // In the cloud, disabling a workspace's last sign-in method (reverting it to
    // open access) is reserved for platform/support users. Self-hosted has no
    // authority above the workspace admin, so they may turn their own sign-in
    // back off — and can re-enable it, since an auth-disabled workspace still
    // grants auth-provider management.
    if (input.isPlatformUser || selfHosted) {
      return
    }

    throw conflict('Only a support user can disable the last sign-in method in this workspace.')
  }

  const currentProvider = providers.find((provider) => provider.id === input.providerId)
  if (currentProvider?.setupRequired) {
    return
  }

  throw conflict('Enable another auth provider before disabling the last sign-in method in this workspace.')
}

export async function restoreSupportAccessWhenWorkspaceAuthDisabled(input: {
  tenant?: RequestTenantSummary | null
  nextEnabled: boolean
  isPlatformUser?: boolean
  prismaClient?: Pick<typeof prisma, 'setting'>
}): Promise<void> {
  if (!input.tenant || input.nextEnabled || !input.isPlatformUser) {
    return
  }

  const authStillEnabled = await withTenantRequestContext(input.tenant, async () => await authProviderRegistry.hasEnabledProviders())
  if (authStillEnabled) {
    return
  }

  const prismaClient = input.prismaClient ?? prisma
  const key = scopeSettingKeyForTenant(input.tenant.id, SUPPORT_ACCESS_ENABLED_SETTING_KEY)
  await prismaClient.setting.upsert({
    where: { key },
    create: { key, value: 'true' },
    update: { value: 'true' }
  })
}