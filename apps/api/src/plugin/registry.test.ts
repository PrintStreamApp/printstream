process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { authProviderRegistry } from '../lib/auth-registry.js'
import { env } from '../lib/env.js'
import { printGuards } from '../lib/print-guards.js'
import { prisma } from '../lib/prisma.js'
import { printerManager } from '../lib/printer-manager.js'
import { wsBroadcaster } from '../lib/ws-server.js'
import { PluginRegistry } from './registry.js'

// Pin the deployment mode: buildBootstrap() forwards isSelfHostedDeployment() into runtimePolicy, which
// derives from whether the cloud private modules are present. The private build has them (false); the
// public OSS snapshot strips them (true). These assertions expect the cloud shape, so force it.
env.SELF_HOSTED = false

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
      workspace: null,
      memberWorkspaces: [],
      availableWorkspaces: [],
    customers: [],
      workspaceHasConnectedBridges: false,
      runtimePolicy: { demoMode: false, managedBridge: false, selfHosted: false }
    })

    await registry.shutdown()

    assert.deepEqual(await authProviderRegistry.buildBootstrap({ demoMode: false }), {
      authEnabled: false,
      platformAuthEnabled: false,
      setupRequired: false,
      providers: [],
      workspace: null,
      memberWorkspaces: [],
      availableWorkspaces: [],
    customers: [],
      workspaceHasConnectedBridges: false,
      runtimePolicy: { demoMode: false, managedBridge: false, selfHosted: false }
    })
  } finally {
    Object.defineProperty(prisma, 'setting', {
      configurable: true,
      value: originalSetting
    })
  }
})

test('dual-surface controlled channels have an independent platform-enable bit', async () => {
  const registry = new PluginRegistry()
  const originalSetting = prisma.setting
  const originalWorkspaceFindMany = prisma.workspace.findMany
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
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 })
    }
  })
  prisma.workspace.findMany = ((async () => []) as unknown) as typeof prisma.workspace.findMany

  try {
    let registrations = 0
    let lastContextPlatformEnabled: boolean | undefined
    // Mirrors the notification channels: workspace-'controlled' (where `enabled`
    // means the workspace default) but also running a platform side, whose
    // enablement is its own persisted bit.
    await registry.register({
      name: 'notifications-test-channel',
      async register(context) {
        registrations += 1
        lastContextPlatformEnabled = context.isEnabledForWorkspace?.(null)
      }
    }, {
      runtimeSurfaces: ['platform', 'workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled',
      defaultEnabled: false
    })

    // Fresh install with defaultEnabled false: platform scope starts off.
    assert.equal(registrations, 0, 'not active until platform-enabled or a workspace enables it')
    let platformEntry = registry.listCatalog({ workspace: null })[0]
    assert.equal(platformEntry?.enabled, false)
    assert.equal(platformEntry?.platformEnabled, false)
    assert.equal(platformEntry?.availableInCurrentContext, true)

    // Enabling for the platform activates the plugin without touching the
    // workspace default.
    await registry.setPlatformEnabled('notifications-test-channel', true)
    assert.equal(registrations, 1, 'platform enable activates the plugin')
    assert.equal(lastContextPlatformEnabled, true)
    assert.equal(store.get('plugin:notifications-test-channel:_platformEnabled'), 'true')

    platformEntry = registry.listCatalog({ workspace: null })[0]
    assert.equal(platformEntry?.enabled, true)
    assert.equal(platformEntry?.platformEnabled, true)

    const workspaceEntry = registry.listCatalog({ workspace: { id: 'workspace-1' } as never })[0]
    assert.equal(workspaceEntry?.enabled, false, 'workspace scope still honors the workspace default')
    assert.equal(store.get('plugin:notifications-test-channel:_enabled'), undefined, 'workspace default flag untouched')
  } finally {
    Object.defineProperty(prisma, 'setting', {
      configurable: true,
      value: originalSetting
    })
    prisma.workspace.findMany = originalWorkspaceFindMany
  }
})

test('controlled workspace plugins use platform policy for availability and workspace-local enablement', async () => {
  const registry = new PluginRegistry()
  const originalSetting = prisma.setting
  const originalWorkspaceFindMany = prisma.workspace.findMany
  const store = new Map<string, string>()
  const pluginBroadcastWorkspaceIds: Array<string | null> = []

  wsBroadcaster.broadcast = ((event, workspaceId) => {
    if (event.type === 'resource.changed' && event.resource === 'plugins') {
      pluginBroadcastWorkspaceIds.push(workspaceId)
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
  prisma.workspace.findMany = ((async () => ([
    { id: 'workspace-1' },
    { id: 'workspace-2' }
  ])) as unknown) as typeof prisma.workspace.findMany

  try {
    await registry.register({
      name: 'orders',
      async register() {}
    }, {
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled',
      defaultEnabled: false
    })

    assert.deepEqual(registry.listCatalog({ workspace: null }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: false,
      platformEnabled: null,
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled',
      availableInCurrentContext: false
    }])

    assert.deepEqual(registry.listCatalog({ workspace: { id: 'workspace-1' } as never }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: false,
      platformEnabled: null,
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled',
      availableInCurrentContext: true
    }])

    await registry.setWorkspaceAvailability('orders', { allowed: true, enabledByDefault: true })

    assert.deepEqual(registry.listCatalog({ workspace: { id: 'workspace-1' } as never }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: true,
      platformEnabled: null,
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled',
      availableInCurrentContext: true
    }])

    await registry.setWorkspaceEnabled('orders', 'workspace-1', false, { workspace: { id: 'workspace-1' } as never })

    assert.equal(pluginBroadcastWorkspaceIds[pluginBroadcastWorkspaceIds.length - 1], 'workspace-1')

    assert.deepEqual(registry.listCatalog({ workspace: { id: 'workspace-1' } as never }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: false,
      platformEnabled: null,
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled',
      availableInCurrentContext: true
    }])

    assert.deepEqual(registry.listCatalog({ workspace: { id: 'workspace-2' } as never }), [{
      name: 'orders',
      version: undefined,
      description: undefined,
      source: 'builtin',
      installed: true,
      enabled: true,
      platformEnabled: null,
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled',
      availableInCurrentContext: true
    }])
  } finally {
    await registry.shutdown()
    Object.defineProperty(prisma, 'setting', {
      configurable: true,
      value: originalSetting
    })
    prisma.workspace.findMany = originalWorkspaceFindMany
  }
})

test('print guards from controlled workspace plugins do not block workspaces where the plugin is disabled', async () => {
  const registry = new PluginRegistry()
  const originalSetting = prisma.setting
  const originalWorkspaceFindMany = prisma.workspace.findMany
  const originalGetWorkspaceId = printerManager.getWorkspaceId.bind(printerManager)
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
  prisma.workspace.findMany = ((async () => ([
    { id: 'workspace-1' },
    { id: 'workspace-2' }
  ])) as unknown) as typeof prisma.workspace.findMany
  printerManager.getWorkspaceId = ((printerId: string) => {
    if (printerId === 'printer-1') return 'workspace-1'
    if (printerId === 'printer-2') return 'workspace-2'
    return null
  }) as typeof printerManager.getWorkspaceId

  try {
    await registry.register({
      name: 'plate-clearing',
      async register(context) {
        context.registerPrintGuard(() => ({ allowed: false, reason: 'blocked' }))
      }
    }, {
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled',
      defaultEnabled: false
    })

    await registry.setWorkspaceAvailability('plate-clearing', { allowed: true, enabledByDefault: true })
    await registry.setWorkspaceEnabled('plate-clearing', 'workspace-1', false, { workspace: { id: 'workspace-1' } as never })

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
    prisma.workspace.findMany = originalWorkspaceFindMany
    printerManager.getWorkspaceId = originalGetWorkspaceId as typeof printerManager.getWorkspaceId
  }
})
test('a fresh install defaults plugins to disabled even when boot has already written non-plugin settings', async () => {
  const registry = new PluginRegistry()
  const originalSetting = prisma.setting
  // The real shape of the bug: on a self-hosted build `registerLicenseEnforcement()`
  // stamps `license:first-run-at` from module scope, so by the time the first plugin
  // registers the table is no longer empty, while no plugin has ever run.
  const rows = new Map<string, string>([['license:first-run-at', new Date(0).toISOString()]])

  Object.defineProperty(prisma, 'setting', {
    configurable: true,
    value: {
      ...originalSetting,
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = rows.get(where.key)
        return value == null ? null : { key: where.key, value }
      },
      count: async (args?: { where?: { key?: { startsWith?: string } } }) => {
        const startsWith = args?.where?.key?.startsWith
        return [...rows.keys()].filter((key) => startsWith == null || key.startsWith(startsWith)).length
      },
      upsert: async ({ create }: { create: { key: string; value: string } }) => {
        rows.set(create.key, create.value)
        return create
      },
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 })
    }
  })

  try {
    await registry.register({ name: 'orders', async register() {} }, {
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled'
    })

    assert.equal(rows.get('plugins:_default_enable_mode'), 'disabled')
    const orders = registry.list().find((plugin) => plugin.name === 'orders')
    assert.equal(orders?.enabled, false)
  } finally {
    await registry.shutdown()
    Object.defineProperty(prisma, 'setting', { configurable: true, value: originalSetting })
  }
})
