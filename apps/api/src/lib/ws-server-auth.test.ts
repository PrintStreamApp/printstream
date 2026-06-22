process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import type { AuthProviderCapabilities } from '@printstream/shared'
import { authProviderRegistry } from './auth-registry.js'
import { prisma, rootPrisma } from './prisma.js'
import { CameraRelay } from './camera-relay.js'
import { CameraSnapshotHub } from './camera-snapshot-hub.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { printerDiscovery } from './printer-discovery.js'
import { attachWebSocketServer, wsBroadcaster } from './ws-server.js'
import { printerManager } from './printer-manager.js'
import { getCurrentTenant } from './tenant-context.js'

const localAuthCapabilities: AuthProviderCapabilities = {
  signIn: true,
  setup: true,
  accountSecurity: true,
  adminUserProvisioning: true,
  adminUserCredentials: true,
  recentVerificationMethods: ['passkey']
}

const originalAuthSessionFindUnique = prisma.authSession.findUnique
const originalAuthSessionUpdateMany = prisma.authSession.updateMany
const originalAuthUserGroupMembershipFindMany = prisma.authUserGroupMembership.findMany
const originalTenantFindUnique = prisma.tenant.findUnique
const originalPrinterFindMany = prisma.printer.findMany
const originalPrinterFindFirst = prisma.printer.findFirst
const originalRootServiceAccountFindUnique = rootPrisma.authServiceAccount.findUnique
const originalRootServiceAccountUpdateMany = rootPrisma.authServiceAccount.updateMany
const originalRootBridgeFindMany = rootPrisma.bridge.findMany
const originalRootPrinterFindMany = rootPrisma.printer.findMany
const originalRootPrinterFindFirst = rootPrisma.printer.findFirst
const originalRootSettingFindMany = rootPrisma.setting.findMany
const printerManagerPrototype = Object.getPrototypeOf(printerManager) as typeof printerManager

afterEach(() => {
  authProviderRegistry.clear()
  prisma.authSession.findUnique = originalAuthSessionFindUnique
  prisma.authSession.updateMany = originalAuthSessionUpdateMany
  prisma.authUserGroupMembership.findMany = originalAuthUserGroupMembershipFindMany
  prisma.tenant.findUnique = originalTenantFindUnique
  prisma.printer.findMany = originalPrinterFindMany
  prisma.printer.findFirst = originalPrinterFindFirst
  rootPrisma.authServiceAccount.findUnique = originalRootServiceAccountFindUnique
  rootPrisma.authServiceAccount.updateMany = originalRootServiceAccountUpdateMany
  rootPrisma.bridge.findMany = originalRootBridgeFindMany
  rootPrisma.printer.findMany = originalRootPrinterFindMany
  rootPrisma.printer.findFirst = originalRootPrinterFindFirst
  rootPrisma.setting.findMany = originalRootSettingFindMany
  mock.restoreAll()
})

test('websocket upgrade rejects anonymous clients once auth is enabled', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    await assert.rejects(
      connectWebSocket(`ws://127.0.0.1:${address.port}/ws`),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 401)
        return true
      }
    )
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket upgrade rejects bearer-authenticated service accounts without tenant context', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })
  rootPrisma.authServiceAccount.findUnique = ((async () => ({
    id: 'service-account-1',
    lastUsedAt: null,
    revokedAt: null,
    memberships: [{ group: { permissions: ['printers.view'] } }]
  })) as unknown) as typeof rootPrisma.authServiceAccount.findUnique
  rootPrisma.authServiceAccount.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.authServiceAccount.updateMany

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)
  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    await assert.rejects(
      connectWebSocketWithFirstTextMessage(`ws://127.0.0.1:${address.port}/ws`, {
        Authorization: 'Bearer bhs_test_token'
      }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 401)
        return true
      }
    )
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket replay only sends printer statuses for the selected tenant context', async () => {
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.printer.findMany = ((async (args: { where?: { tenantId?: string }; select?: { id: true } }) => {
    if (args.where?.tenantId === 'tenant-1') {
      return [{ id: 'printer-1' }]
    }
    return []
  }) as unknown) as typeof rootPrisma.printer.findMany
  // Replay looks each tenant printer up by id (getStatus), not by scanning all
  // snapshots — so only printer-1 (the tenant's printer per the findMany stub)
  // is ever requested here.
  mock.method(printerManagerPrototype, 'getStatus', (printerId: string) =>
    ({ printerId, online: true, stage: 'printing' }) as never)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket, messages } = await connectWebSocketAndCollectMessages(`ws://127.0.0.1:${address.port}/ws`, {
      'x-printstream-tenant': 'alpha'
    })

    await closeWebSocket(socket)

    const parsedMessages = messages.map((message) => JSON.parse(message) as { type: string; status?: { printerId: string } })
    assert.equal(parsedMessages[0]?.type, 'hello')
    assert.deepEqual(
      parsedMessages.filter((message) => message.type === 'printer.status').map((message) => message.status?.printerId),
      ['printer-1']
    )
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket replay honors the tenant query parameter for browser tab isolation', async () => {
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.printer.findMany = ((async (args: { where?: { tenantId?: string }; select?: { id: true } }) => {
    if (args.where?.tenantId === 'tenant-1') {
      return [{ id: 'printer-1' }]
    }
    return []
  }) as unknown) as typeof rootPrisma.printer.findMany
  // Replay looks each tenant printer up by id (getStatus), not by scanning all
  // snapshots — so only printer-1 (the tenant's printer per the findMany stub)
  // is ever requested here.
  mock.method(printerManagerPrototype, 'getStatus', (printerId: string) =>
    ({ printerId, online: true, stage: 'printing' }) as never)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket, messages } = await connectWebSocketAndCollectMessages(`ws://127.0.0.1:${address.port}/ws?tenant=alpha`)

    await closeWebSocket(socket)

    const parsedMessages = messages.map((message) => JSON.parse(message) as { type: string; status?: { printerId: string } })
    assert.equal(parsedMessages[0]?.type, 'hello')
    assert.deepEqual(
      parsedMessages.filter((message) => message.type === 'printer.status').map((message) => message.status?.printerId),
      ['printer-1']
    )
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket replay only sends active printer FTPS state for the selected tenant context', async () => {
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.printer.findMany = ((async (args: { where?: { tenantId?: string }; select?: { id: true } }) => {
    if (args.where?.tenantId === 'tenant-1') {
      return [{ id: 'printer-1' }]
    }
    return []
  }) as unknown) as typeof rootPrisma.printer.findMany
  bridgeSessionManager.setPrinterFtpActivity('bridge-1', 'printer-1', true)
  bridgeSessionManager.setPrinterFtpActivity('bridge-1', 'printer-2', true)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket, messages } = await connectWebSocketAndCollectMessages(`ws://127.0.0.1:${address.port}/ws?tenant=alpha`)

    await closeWebSocket(socket)

    const parsedMessages = messages.map((message) => JSON.parse(message) as { type: string; printerId?: string; active?: boolean })
    assert.deepEqual(
      parsedMessages.filter((message) => message.type === 'printer.ftps.active').map((message) => ({ printerId: message.printerId, active: message.active })),
      [{ printerId: 'printer-1', active: true }]
    )
  } finally {
    bridgeSessionManager.setPrinterFtpActivity('bridge-1', 'printer-1', false)
    bridgeSessionManager.setPrinterFtpActivity('bridge-1', 'printer-2', false)
    await attached.close()
    await close(server)
  }
})

test('websocket auth change notification reaches affected tenant user and recycles the socket', async () => {
  authProviderRegistry.register(() => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: getCurrentTenant()?.slug === 'alpha',
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  }))
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: false,
      tenantMemberships: [{
        loginDisabled: false,
        tenant: {
          id: 'tenant-1',
          slug: 'alpha',
          name: 'Alpha'
        }
      }],
      memberships: [{ group: { permissions: ['printers.view'] } }]
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany
  rootPrisma.printer.findMany = ((async () => []) as unknown) as typeof rootPrisma.printer.findMany
  mock.method(printerManagerPrototype, 'snapshots', () => [] as never)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket } = await connectWebSocketWithFirstTextMessage(`ws://127.0.0.1:${address.port}/ws?tenant=alpha`, {
      Cookie: 'printstream_auth=session-secret'
    })

    wsBroadcaster.notifyAuthChanged({ userIds: ['user-1'], tenantId: 'tenant-1' })
    const message = await waitForJsonMessage(socket, (payload) => payload.type === 'auth.changed')
    assert.deepEqual(JSON.parse(message), { type: 'auth.changed' })
    await waitForSocketClose(socket)
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket replay binds tenant-scoped user sessions to their session tenant without requiring a tenant header', async () => {
  authProviderRegistry.register(() => ({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: getCurrentTenant()?.slug === 'alpha',
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  }))
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: false,
      tenantMemberships: [{
        loginDisabled: false,
        tenant: {
          id: 'tenant-1',
          slug: 'alpha',
          name: 'Alpha'
        }
      }],
      memberships: [{ group: { permissions: ['printers.view'] } }]
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany
  rootPrisma.printer.findMany = ((async (args: { where?: { tenantId?: string }; select?: { id: true } }) => {
    if (args.where?.tenantId === 'tenant-1') {
      return [{ id: 'printer-1' }]
    }
    return []
  }) as unknown) as typeof rootPrisma.printer.findMany
  // Replay looks each tenant printer up by id (getStatus), not by scanning all
  // snapshots — so only printer-1 (the tenant's printer per the findMany stub)
  // is ever requested here.
  mock.method(printerManagerPrototype, 'getStatus', (printerId: string) =>
    ({ printerId, online: true, stage: 'printing' }) as never)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket, messages } = await connectWebSocketAndCollectMessages(`ws://127.0.0.1:${address.port}/ws`, {
      Cookie: 'printstream_auth=session-secret'
    })

    await closeWebSocket(socket)

    const parsedMessages = messages.map((message) => JSON.parse(message) as { type: string; status?: { printerId: string } })
    assert.equal(parsedMessages[0]?.type, 'hello')
    assert.deepEqual(
      parsedMessages.filter((message) => message.type === 'printer.status').map((message) => message.status?.printerId),
      ['printer-1']
    )
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket replay ignores stale tenant cookies when platform support access is disabled', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.id === 'tenant-1') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.tenant.findMany = ((async () => ([{
    id: 'tenant-1',
    slug: 'alpha',
    name: 'Alpha'
  }])) as unknown) as typeof rootPrisma.tenant.findMany
  rootPrisma.setting.findMany = ((async () => ([{
    key: 'tenant:tenant-1:auth:supportAccessEnabled',
    value: 'false'
  }])) as unknown) as typeof rootPrisma.setting.findMany
  prisma.authSession.findUnique = ((async () => ({
    id: 'session-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: null,
    user: {
      id: 'user-1',
      isPlatformUser: true,
      tenantMemberships: [],
      memberships: []
    },
    serviceAccount: null
  })) as unknown) as typeof prisma.authSession.findUnique
  prisma.authSession.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof prisma.authSession.updateMany
  prisma.authUserGroupMembership.findMany = ((async () => ([{
    group: { permissions: ['printers.view'] }
  }])) as unknown) as typeof prisma.authUserGroupMembership.findMany
  let printerListQueried = false
  rootPrisma.printer.findMany = ((async () => {
    printerListQueried = true
    return [{ id: 'printer-1' }]
  }) as unknown) as typeof rootPrisma.printer.findMany
  mock.method(printerManagerPrototype, 'snapshots', () => [
    { printerId: 'printer-1', online: true, stage: 'printing' }
  ] as never)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket, messages } = await connectWebSocketAndCollectMessages(`ws://127.0.0.1:${address.port}/ws?tenant=alpha`, {
      Cookie: 'printstream_auth=session-secret'
    }, 200)

    await closeWebSocket(socket)

    const parsedMessages = messages.map((message) => JSON.parse(message) as { type: string })
    assert.equal(parsedMessages[0]?.type, 'hello')
    assert.deepEqual(parsedMessages.filter((message) => message.type === 'printer.status'), [])
    assert.equal(printerListQueried, false)
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket discovered-printer replay only filters adopted serials inside the selected tenant', async () => {
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  const printerQueries: Array<{ where?: unknown; select?: unknown }> = []
  rootPrisma.printer.findMany = ((async (args: { where?: unknown; select?: unknown }) => {
    printerQueries.push(args)
    return []
  }) as unknown) as typeof rootPrisma.printer.findMany
  rootPrisma.bridge.findMany = ((async () => ([{ id: 'bridge-1' }] as never)) as unknown) as typeof rootPrisma.bridge.findMany
  mock.method(printerManagerPrototype, 'snapshots', () => [] as never)
  mock.method(printerDiscovery, 'list', () => ([{
    name: 'Shared Printer',
    host: 'printer.local',
    serial: 'SERIAL-1',
    model: 'X1C'
  }] as never))

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket, messages } = await connectWebSocketAndCollectMessages(`ws://127.0.0.1:${address.port}/ws`, {
      'x-printstream-tenant': 'alpha'
    })

    await closeWebSocket(socket)

    const discovered = messages
      .map((message) => JSON.parse(message) as { type: string; printers?: Array<{ serial: string }> })
      .find((message) => message.type === 'printer.discovered')
    assert.deepEqual(discovered?.printers, [{
      name: 'Shared Printer',
      host: 'printer.local',
      serial: 'SERIAL-1',
      model: 'X1C'
    }])
    assert.deepEqual(
      printerQueries.find((query) => query.select && (query.select as { serial?: true }).serial === true)?.where,
      { tenantId: 'tenant-1' }
    )
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket camera subscribe requires the camera.view permission', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.authServiceAccount.findUnique = ((async () => ({
    id: 'service-account-1',
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    lastUsedAt: null,
    revokedAt: null,
    memberships: [{ group: { permissions: ['printers.view'] } }]
  })) as unknown) as typeof rootPrisma.authServiceAccount.findUnique
  rootPrisma.authServiceAccount.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.authServiceAccount.updateMany
  const subscribe = mock.method(CameraRelay.prototype, 'subscribe', () => undefined)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket } = await connectWebSocketWithFirstTextMessage(`ws://127.0.0.1:${address.port}/ws`, {
      Authorization: 'Bearer bhs_test_token',
      'x-printstream-tenant': 'alpha'
    })

    socket.send(JSON.stringify({ type: 'camera.subscribe', printerId: 'printer-1' }))
    const message = await waitForJsonMessage(socket, (payload) => payload.type === 'error')

    assert.deepEqual(JSON.parse(message), {
      type: 'error',
      message: 'You do not have permission to perform this action.'
    })
    assert.equal(subscribe.mock.callCount(), 0)
    await closeWebSocket(socket)
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket camera snapshot watch only allows printers in the selected tenant', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.authServiceAccount.findUnique = ((async () => ({
    id: 'service-account-1',
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    lastUsedAt: null,
    revokedAt: null,
    memberships: [{ group: { permissions: ['camera.view'] } }]
  })) as unknown) as typeof rootPrisma.authServiceAccount.findUnique
  rootPrisma.authServiceAccount.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.authServiceAccount.updateMany
  let requestedWhere: unknown = null
  rootPrisma.printer.findFirst = ((async (args: { where?: unknown }) => {
    requestedWhere = args.where ?? null
    return null
  }) as unknown) as typeof rootPrisma.printer.findFirst
  const watch = mock.method(CameraSnapshotHub.prototype, 'watch', () => undefined)

  const server = createServer()
  attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket } = await connectWebSocketWithFirstTextMessage(`ws://127.0.0.1:${address.port}/ws`, {
      Authorization: 'Bearer bhs_test_token',
      'x-printstream-tenant': 'alpha'
    })

    socket.send(JSON.stringify({ type: 'camera.snapshot.watch', printerId: 'printer-2' }))
    const message = await waitForJsonMessage(socket, (payload) => payload.type === 'error')

    assert.deepEqual(JSON.parse(message), {
      type: 'error',
      message: 'Printer not found.'
    })
    assert.deepEqual(requestedWhere, { id: 'printer-2', tenantId: 'tenant-1' })
    assert.equal(watch.mock.callCount(), 0)
    await closeWebSocket(socket)
  } finally {
    await close(server)
  }
})

test('websocket camera subscribe ignores stale authorize results after unsubscribe', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.authServiceAccount.findUnique = ((async () => ({
    id: 'service-account-1',
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    lastUsedAt: null,
    revokedAt: null,
    memberships: [{ group: { permissions: ['camera.view'] } }]
  })) as unknown) as typeof rootPrisma.authServiceAccount.findUnique
  rootPrisma.authServiceAccount.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.authServiceAccount.updateMany

  let resolvePrinter!: (value: { id: string; model: string }) => void
  let markResolverReady!: () => void
  const resolverReady = new Promise<void>((resolve) => {
    markResolverReady = resolve
  })
  rootPrisma.printer.findFirst = ((async () => await new Promise((resolve) => {
    resolvePrinter = resolve as (value: { id: string; model: string }) => void
    markResolverReady()
  })) as unknown) as typeof rootPrisma.printer.findFirst

  const subscribe = mock.method(CameraRelay.prototype, 'subscribe', () => undefined)
  const unsubscribe = mock.method(CameraRelay.prototype, 'unsubscribe', () => undefined)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket } = await connectWebSocketWithFirstTextMessage(`ws://127.0.0.1:${address.port}/ws`, {
      Authorization: 'Bearer bhs_test_token',
      'x-printstream-tenant': 'alpha'
    })

    socket.send(JSON.stringify({ type: 'camera.subscribe', printerId: 'printer-1' }))
    socket.send(JSON.stringify({ type: 'camera.unsubscribe', printerId: 'printer-1' }))
  await resolverReady
    resolvePrinter({ id: 'printer-1', model: 'P1S' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(subscribe.mock.callCount(), 0)
    assert.equal(unsubscribe.mock.callCount(), 1)
    await closeWebSocket(socket)
  } finally {
    await attached.close()
    await close(server)
  }
})

test('websocket camera snapshot watch ignores stale authorize results after unwatch', async () => {
  authProviderRegistry.register({
    id: 'auth-local',
    label: 'Local Auth',
    enabled: true,
    methods: ['passkey'],
    setupRequired: false,
    capabilities: localAuthCapabilities
  })
  prisma.tenant.findUnique = ((async (args: { where: { slug?: string; id?: string } }) => {
    if (args.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique
  rootPrisma.authServiceAccount.findUnique = ((async () => ({
    id: 'service-account-1',
    tenantId: 'tenant-1',
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
    lastUsedAt: null,
    revokedAt: null,
    memberships: [{ group: { permissions: ['camera.view'] } }]
  })) as unknown) as typeof rootPrisma.authServiceAccount.findUnique
  rootPrisma.authServiceAccount.updateMany = ((async () => ({ count: 1 })) as unknown) as typeof rootPrisma.authServiceAccount.updateMany

  let resolvePrinter!: (value: { id: string; model: string }) => void
  let markResolverReady!: () => void
  const resolverReady = new Promise<void>((resolve) => {
    markResolverReady = resolve
  })
  rootPrisma.printer.findFirst = ((async () => await new Promise((resolve) => {
    resolvePrinter = resolve as (value: { id: string; model: string }) => void
    markResolverReady()
  })) as unknown) as typeof rootPrisma.printer.findFirst

  const watch = mock.method(CameraSnapshotHub.prototype, 'watch', () => undefined)
  const unwatch = mock.method(CameraSnapshotHub.prototype, 'unwatch', () => undefined)

  const server = createServer()
  const attached = attachWebSocketServer(server)
  await listen(server)

  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const { socket } = await connectWebSocketWithFirstTextMessage(`ws://127.0.0.1:${address.port}/ws`, {
      Authorization: 'Bearer bhs_test_token',
      'x-printstream-tenant': 'alpha'
    })

    socket.send(JSON.stringify({ type: 'camera.snapshot.watch', printerId: 'printer-1' }))
    socket.send(JSON.stringify({ type: 'camera.snapshot.unwatch', printerId: 'printer-1' }))
  await resolverReady
    resolvePrinter({ id: 'printer-1', model: 'P1S' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(watch.mock.callCount(), 0)
    assert.equal(unwatch.mock.callCount(), 1)
    await closeWebSocket(socket)
  } finally {
    await attached.close()
    await close(server)
  }
})

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function connectWebSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.once('open', () => resolve(socket))
    socket.once('unexpected-response', (_request, response) => {
      reject({ statusCode: response.statusCode })
    })
    socket.once('error', reject)
  })
}

function connectWebSocketWithFirstTextMessage(
  url: string,
  headers?: Record<string, string>
): Promise<{ socket: WebSocket; firstMessage: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })

    socket.once('message', (data) => {
      if (typeof data === 'string') {
        resolve({ socket, firstMessage: data })
        return
      }
      if (Buffer.isBuffer(data)) {
        resolve({ socket, firstMessage: data.toString('utf8') })
        return
      }
      reject(new Error('Expected a text WS message'))
    })
    socket.once('open', () => undefined)
    socket.once('unexpected-response', (_request, response) => {
      reject({ statusCode: response.statusCode })
    })
    socket.once('error', reject)
  })
}

function connectWebSocketAndCollectMessages(
  url: string,
  headers?: Record<string, string>,
  waitMs = 100
): Promise<{ socket: WebSocket; messages: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    const messages: string[] = []

    socket.on('message', (data) => {
      if (typeof data === 'string') {
        messages.push(data)
        return
      }
      if (Buffer.isBuffer(data)) {
        messages.push(data.toString('utf8'))
      }
    })
    socket.once('open', () => {
      setTimeout(() => resolve({ socket, messages }), waitMs)
    })
    socket.once('unexpected-response', (_request, response) => {
      reject({ statusCode: response.statusCode })
    })
    socket.once('error', reject)
  })
}

function waitForJsonMessage(socket: WebSocket, predicate: (payload: Record<string, unknown>) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: unknown) => {
      if (typeof data === 'string') {
        try {
          const payload = JSON.parse(data) as Record<string, unknown>
          if (!predicate(payload)) return
          cleanup()
          resolve(data)
        } catch {
          return
        }
        return
      }
      if (Buffer.isBuffer(data)) {
        try {
          const text = data.toString('utf8')
          const payload = JSON.parse(text) as Record<string, unknown>
          if (!predicate(payload)) return
          cleanup()
          resolve(text)
        } catch {
          return
        }
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('message', onMessage)
      socket.off('error', onError)
    }

    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    socket.once('close', () => resolve())
    socket.close()
  })
}

function waitForSocketClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    socket.once('close', () => resolve())
  })
}