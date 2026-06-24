/**
 * In-memory auth provider registry.
 *
 * Auth plugins register their public bootstrap metadata here so the core API
 * can expose a stable discovery endpoint without importing any plugin code.
 */
import type { AuthBootstrap, AuthMethod, AuthProviderBootstrap, AuthProviderCapabilities } from '@printstream/shared'
import { getCurrentTenant } from './tenant-context.js'
import { isManagedBridgeMode } from './managed-bridge.js'
import { isSelfHostedDeployment } from './deployment-mode.js'

type AuthBootstrapBase = Omit<AuthBootstrap, 'permissions' | 'actor' | 'capabilities'>

export type RegisteredAuthProviderResolver = () => RegisteredAuthProvider | Promise<RegisteredAuthProvider>

export interface RegisteredAuthProvider {
  id: string
  label: string
  enabled: boolean
  methods: AuthMethod[]
  setupRequired: boolean
  capabilities: AuthProviderCapabilities
}

class AuthProviderRegistry {
  private readonly providers = new Set<RegisteredAuthProviderResolver>()

  register(provider: RegisteredAuthProvider | RegisteredAuthProviderResolver): () => void {
    const resolve = typeof provider === 'function'
      ? provider
      : () => provider
    this.providers.add(resolve)
    return () => {
      this.providers.delete(resolve)
    }
  }

  clear(): void {
    this.providers.clear()
  }

  async hasEnabledProviders(): Promise<boolean> {
    return (await this.resolveProviders()).some((provider) => provider.enabled && !provider.setupRequired)
  }

  async list(): Promise<AuthProviderBootstrap[]> {
    return (await this.resolveProviders()).map((provider) => ({
      id: provider.id,
      label: provider.label,
      enabled: provider.enabled,
      methods: [...provider.methods],
      setupRequired: provider.setupRequired,
      capabilities: {
        ...provider.capabilities,
        recentVerificationMethods: [...provider.capabilities.recentVerificationMethods]
      }
    }))
  }

  async buildBootstrap(input: { demoMode: boolean }): Promise<AuthBootstrapBase> {
    const providers = await this.resolveProviders()
    const tenant = getCurrentTenant()
    const authEnabled = providers.some((provider) => provider.enabled && !provider.setupRequired)
    return {
      authEnabled,
      platformAuthEnabled: authEnabled,
      setupRequired: !authEnabled && providers.some((provider) => provider.enabled && provider.setupRequired),
      providers: await this.list(),
      tenant,
      memberTenants: [],
      availableTenants: [],
      tenantHasConnectedBridges: false,
      runtimePolicy: {
        demoMode: input.demoMode,
        managedBridge: isManagedBridgeMode(),
        selfHosted: isSelfHostedDeployment()
      }
    }
  }

  private async resolveProviders(): Promise<RegisteredAuthProvider[]> {
    const providers = await Promise.all(Array.from(this.providers.values(), async (resolve) => await resolve()))
    return providers.sort((left, right) => left.id.localeCompare(right.id))
  }
}

export const authProviderRegistry = new AuthProviderRegistry()