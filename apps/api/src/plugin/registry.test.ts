process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { authProviderRegistry } from '../lib/auth-registry.js'
import { printGuards } from '../lib/print-guards.js'
import { prisma } from '../lib/prisma.js'
import { printerManager } from '../lib/printer-manager.js'
import { wsBroadcaster } from '../lib/ws-server.js'
import { PluginRegistry } from './registry.js'

const originalWsBroadcast = wsBroadcaster.broadcast

afterEach(() => {
  authProviderRegistry.clear()
  wsBroadcaster.broadcast = originalWsBroadcast
})

test('plugin auth providers are exposed in bootstrap data only while the plugin is active', async () => {
  const registry = new PluginRegistry()
  const originalSetting = prisma.setting

  Object.defineProperty(prisma, 'setting', {
    configurable: true,
    value: {
      ...originalSetting,
      findUnique: async () => null,
      count: async () => 0,
      upsert: async ({ create }: { create: { key: string; value: string } }) => create,
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 })
    }
  })

  try {
    await registry.register({
      name: 'auth-local',
      runtimeSurfaces: ['platform'],
      async register(context) {
        context.registerAuthProvider({
          id: 'auth-local',
          label: 'Local Auth',
          enabled: true,
          methods: ['passkey', 'email-code'],
          setupRequired: true,
          capabilities: {
            signIn: true,
            setup: true,
            accountSecurity: true,
            adminUserProvisioning: true,
            adminUserCredentials: true,
            recentVerificationMethods: ['passkey', 'email-code']
          }
        })
      }
    }, { defaultEnabled: true })

    assert.deepEqual(await authProviderRegistry.buildBootstrap({ demoMode: false }), {
      authEnabled: false,
      platformAuthEnabled: false,
      setupRequired: true,
      providers: [{
        id: 'auth-local',
        label: 'Local Auth',
        enabled: true,
        methods: ['passkey', 'email-code'],
        setupRequired: true,
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
          recentVerificationMethods: ['passkey', 'email-code']
        }
      }],
      tenant: null,
      memberTenants: [],
      availableTenants: [],
      tenantHasConnectedBridges: false,
      runtimePolicy: { demoMode: false, managedBridge: false, selfHosted: false }
    })

    await registry.shutdown()

    assert.deepEqual(await authProviderRegistry.buildBootstrap({ demoMode: false }), {
      authEnabled: false,
      platformAuthEnabled: false,
      setupRequired: false,
      providers: [],
      tenant: null,
      memberTenants: [],
      availableTenants: [],
      tenantHasConnectedBridges: false,
      runtimePolicy: { demoMode: false, managedBridge: false, selfHosted: false }
    })
  } finally {
    Object.defineProperty(prisma, 'setting', {
      configurable: true,
      value: originalSetting
    })
  }
})

test('controlled tenant plugins use platform policy for availability and tenant-local enablement', async () => {
  const registry = new PluginRegistry()
  const originalSetting = prisma.setting
  const originalTenantFindMany = prisma.tenant.findMany
  const store = new Map<string, string>()
  const pluginBroadcastTenantIds: Array<string | null> = []

  wsBroadcaster.broadcast = ((event, tenantId) => {
    if (event.type === 'resource.changed' && event.resource === 'plugins') {
      pluginBroadcastTenantIds.push(tenantId)
    }
  }) as typeof wsBroadcaster.broadcast

  Object.defineProperty(prisma, 'setting', {
    configurable: true,
    value: {
      ...originalSetting,
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = store.get(where.key)
        return value == null ? null : { key: where.key, value }
      },
      count: async () => 0,
      upsert: async ({ where, create, update }: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
        store.set(where.key, update.value ?? create.value)
        return { key: where.key, value: store.get(where.key) ?? create.value }
      },
      findMany: async ({ where, orderBy }: { where: { key: { startsWith?: string; in?: string[] } }; orderBy?: { key: 'asc' } }) => {
        const keys = Array.from(store.keys())
          .filter((key) => where.key.startsWith ? key.startsWith(where.key.startsWith) : where.key.in?.includes(key))
          .sort((left, right) => orderBy?.key === 'asc' ? left.localeCompare(right) : 0)
        return keys.map((key) => ({ key, value: store.get(key) ?? '' }))
      },
      deleteMany: async ({ where }: { where: { key: { in?: string[]; startsWith?: string } } }) => {
        const keys = Array.from(store.keys()).filter((key) => where.key.in?.includes(key) || (where.key.startsWith ? key.startsWith(where.key.startsWith) : false))
        for (const key of keys) {
          store.delete(key)
        }
        return { count: keys.length }
      }
    }
  })
  prisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1' },
    { id: 'tenant-2' }
  ])) as unknown) as typeof prisma.tenant.findMany

  try {
    await registry.register({
      name: 'orders',
      async register() {}
    }, {
      runtimeSurfaces: ['tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'controlled',
      defaultEnabled: false
    })

    assert.deepEqual(registry.listCatalog({ tenant: null }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: false,
      runtimeSurfaces: ['tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'controlled',
      availableInCurrentContext: false
    }])

    assert.deepEqual(registry.listCatalog({ tenant: { id: 'tenant-1' } as never }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: false,
      runtimeSurfaces: ['tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'controlled',
      availableInCurrentContext: true
    }])

    await registry.setTenantAvailability('orders', { allowed: true, enabledByDefault: true })

    assert.deepEqual(registry.listCatalog({ tenant: { id: 'tenant-1' } as never }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: true,
      runtimeSurfaces: ['tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'controlled',
      availableInCurrentContext: true
    }])

    await registry.setTenantEnabled('orders', 'tenant-1', false, { tenant: { id: 'tenant-1' } as never })

    assert.equal(pluginBroadcastTenantIds[pluginBroadcastTenantIds.length - 1], 'tenant-1')

    assert.deepEqual(registry.listCatalog({ tenant: { id: 'tenant-1' } as never }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: false,
      runtimeSurfaces: ['tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'controlled',
      availableInCurrentContext: true
    }])

    assert.deepEqual(registry.listCatalog({ tenant: { id: 'tenant-2' } as never }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: true,
      runtimeSurfaces: ['tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'controlled',
      availableInCurrentContext: true
    }])
  } finally {
    await registry.shutdown()
    Object.defineProperty(prisma, 'setting', {
      configurable: true,
      value: originalSetting
    })
    prisma.tenant.findMany = originalTenantFindMany
  }
})

test('print guards from controlled tenant plugins do not block tenants where the plugin is disabled', async () => {
  const registry = new PluginRegistry()
  const originalSetting = prisma.setting
  const originalTenantFindMany = prisma.tenant.findMany
  const originalGetTenantId = printerManager.getTenantId.bind(printerManager)
  const store = new Map<string, string>()

  Object.defineProperty(prisma, 'setting', {
    configurable: true,
    value: {
      ...originalSetting,
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = store.get(where.key)
        return value == null ? null : { key: where.key, value }
      },
      count: async () => 0,
      upsert: async ({ where, create, update }: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
        store.set(where.key, update.value ?? create.value)
        return { key: where.key, value: store.get(where.key) ?? create.value }
      },
      findMany: async ({ where, orderBy }: { where: { key: { startsWith?: string; in?: string[] } }; orderBy?: { key: 'asc' } }) => {
        const keys = Array.from(store.keys())
          .filter((key) => where.key.startsWith ? key.startsWith(where.key.startsWith) : where.key.in?.includes(key))
          .sort((left, right) => orderBy?.key === 'asc' ? left.localeCompare(right) : 0)
        return keys.map((key) => ({ key, value: store.get(key) ?? '' }))
      },
      deleteMany: async ({ where }: { where: { key: { in?: string[]; startsWith?: string } } }) => {
        const keys = Array.from(store.keys()).filter((key) => where.key.in?.includes(key) || (where.key.startsWith ? key.startsWith(where.key.startsWith) : false))
        for (const key of keys) {
          store.delete(key)
        }
        return { count: keys.length }
      }
    }
  })
  prisma.tenant.findMany = ((async () => ([
    { id: 'tenant-1' },
    { id: 'tenant-2' }
  ])) as unknown) as typeof prisma.tenant.findMany
  printerManager.getTenantId = ((printerId: string) => {
    if (printerId === 'printer-1') return 'tenant-1'
    if (printerId === 'printer-2') return 'tenant-2'
    return null
  }) as typeof printerManager.getTenantId

  try {
    await registry.register({
      name: 'plate-clearing',
      async register(context) {
        context.registerPrintGuard(() => ({ allowed: false, reason: 'blocked' }))
      }
    }, {
      runtimeSurfaces: ['tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'controlled',
      defaultEnabled: false
    })

    await registry.setTenantAvailability('plate-clearing', { allowed: true, enabledByDefault: true })
    await registry.setTenantEnabled('plate-clearing', 'tenant-1', false, { tenant: { id: 'tenant-1' } as never })

    assert.equal(printGuards.evaluate({ printerId: 'printer-1', source: 'dispatch' }), null)
    assert.deepEqual(printGuards.evaluate({ printerId: 'printer-2', source: 'dispatch' }), {
      allowed: false,
      reason: 'blocked'
    })
  } finally {
    await registry.shutdown()
    Object.defineProperty(prisma, 'setting', {
      configurable: true,
      value: originalSetting
    })
    prisma.tenant.findMany = originalTenantFindMany
    printerManager.getTenantId = originalGetTenantId as typeof printerManager.getTenantId
  }
})