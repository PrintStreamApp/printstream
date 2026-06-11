process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { bridgesRouter } from './bridges.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { HttpError } from '../lib/http-error.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

const p = prisma as unknown as Record<string, Record<string, unknown>>
const rp = rootPrisma as unknown as Record<string, Record<string, unknown>>
// Auto-restore the prisma/rootPrisma methods these tests override (was a per-method save/restore block).
restorePrismaMethodsAfterEach([
  [p.bridge, 'findMany'],
  [p.bridge, 'findUnique'],
  [p.bridge, 'update'],
  [p.bridge, 'count'],
  [p.printer, 'findMany'],
  [rp.bridge, 'findUnique'],
  [rp.bridge, 'findMany'],
  [rp.bridge, 'update'],
  [rp.printer, 'findMany'],
  [rp.printer, 'updateMany'],
  [rp.libraryFile, 'updateMany'],
  [rp.libraryFolder, 'updateMany'],
  [rp.libraryFileVersion, 'updateMany'],
  [rp.libraryFileReplica, 'updateMany'],
  [rp, '$transaction']
])
const originalSetTenantId = bridgeSessionManager.setTenantId
const originalSendMessage = bridgeSessionManager.sendMessage
const originalGetConnectionStats = bridgeSessionManager.getConnectionStats
const originalRequestRpc = bridgeSessionManager.requestRpc
const originalIsConnected = bridgeSessionManager.isConnected

const unknownBridgeUpdate = {
  status: 'unknown',
  currentVersion: null,
  latestVersion: '0.1.0',
  currentBuildRevision: null,
  latestBuildRevision: null,
  protocolVersion: null,
  runnerAbiVersion: null,
  channel: 'stable',
  lastCheckedAt: null,
  lastError: null,
  manualUpdateCommand: null
}

afterEach(() => {
  bridgeSessionManager.setTenantId = originalSetTenantId
  bridgeSessionManager.sendMessage = originalSendMessage
  bridgeSessionManager.getConnectionStats = originalGetConnectionStats
  bridgeSessionManager.requestRpc = originalRequestRpc
  bridgeSessionManager.isConnected = originalIsConnected
})

function mockBridgeLibraryRecovery(input: {
  files?: number
  folders?: number
  versions?: number
  replicas?: number
  calls?: Array<[string, unknown]>
} = {}): void {
  rootPrisma.libraryFile.updateMany = ((async (args: unknown) => {
    input.calls?.push(['files', args])
    return { count: input.files ?? 0 }
  }) as unknown) as typeof rootPrisma.libraryFile.updateMany
  rootPrisma.libraryFolder.updateMany = ((async (args: unknown) => {
    input.calls?.push(['folders', args])
    return { count: input.folders ?? 0 }
  }) as unknown) as typeof rootPrisma.libraryFolder.updateMany
  rootPrisma.libraryFileVersion.updateMany = ((async (args: unknown) => {
    input.calls?.push(['versions', args])
    return { count: input.versions ?? 0 }
  }) as unknown) as typeof rootPrisma.libraryFileVersion.updateMany
  rootPrisma.libraryFileReplica.updateMany = ((async (args: unknown) => {
    input.calls?.push(['replicas', args])
    return { count: input.replicas ?? 0 }
  }) as unknown) as typeof rootPrisma.libraryFileReplica.updateMany
}

test('bridge list requires authentication once auth is enabled', async () => {
  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('bridge list returns connected tenant bridges for settings managers', async () => {
  let bridgeFindManyArgs: unknown
  prisma.bridge.findMany = ((async (args: unknown) => {
    bridgeFindManyArgs = args
    return [
    {
      id: 'bridge-1',
      name: 'Bridge One',
      lastSeenAt: new Date('2026-05-08T18:30:00.000Z'),
      createdAt: new Date('2026-05-08T18:00:00.000Z'),
      updatedAt: new Date('2026-05-08T18:40:00.000Z'),
      _count: { printers: 2 }
    }
  ]
  }) as unknown) as typeof prisma.bridge.findMany
  bridgeSessionManager.getConnectionStats = ((bridgeId: string) => {
    assert.equal(bridgeId, 'bridge-1')
    return {
      connected: true,
      connectedAt: '2026-05-08T18:20:00.000Z',
      pendingRpcCount: 1,
      activeCameraWatchCount: 2,
      activePrinterFtpCount: 1
    }
  }) as typeof bridgeSessionManager.getConnectionStats

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      bridges: [
        {
          id: 'bridge-1',
          name: 'Bridge One',
          printerCount: 2,
          lastSeenAt: '2026-05-08T18:30:00.000Z',
          createdAt: '2026-05-08T18:00:00.000Z',
          updatedAt: '2026-05-08T18:40:00.000Z',
          connectionStats: {
            connected: true,
            connectedAt: '2026-05-08T18:20:00.000Z',
            pendingRpcCount: 1,
            activeCameraWatchCount: 2,
            activePrinterFtpCount: 1
          },
          update: unknownBridgeUpdate
        }
      ]
    })
    assert.deepEqual(bridgeFindManyArgs, {
      where: { tenantId: 'tenant-1' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        version: true,
        buildRevision: true,
        sourceFingerprint: true,
        protocolVersion: true,
        runnerAbiVersion: true,
        updateChannel: true,
        updateStatus: true,
        latestAvailableVersion: true,
        lastUpdateCheckAt: true,
        lastUpdateError: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            printers: true
          }
        }
      }
    })
  })
})

test('bridge connect attaches a dormant bridge to the current tenant', async () => {
  mockBridgeLibraryRecovery()
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: null
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1',
    name: 'Workshop Bridge',
    lastSeenAt: null,
    createdAt: new Date('2026-05-08T18:00:00.000Z'),
    updatedAt: new Date('2026-05-08T18:45:00.000Z'),
    _count: { printers: 0 }
  })) as unknown) as typeof rootPrisma.bridge.update

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectCode: 'connect-123', name: 'Workshop Bridge' })
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), {
      bridge: {
        id: 'bridge-1',
        name: 'Workshop Bridge',
        printerCount: 0,
        lastSeenAt: null,
        createdAt: '2026-05-08T18:00:00.000Z',
        updatedAt: '2026-05-08T18:45:00.000Z',
        connectionStats: {
          connected: false,
          connectedAt: null,
          pendingRpcCount: 0,
          activeCameraWatchCount: 0,
          activePrinterFtpCount: 0
        },
        update: unknownBridgeUpdate
      }
    })
  })
})

test('bridge connect notifies a connected bridge session that it is now connected to a workspace', async () => {
  mockBridgeLibraryRecovery()
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: null
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1',
    name: 'Workshop Bridge',
    lastSeenAt: null,
    createdAt: new Date('2026-05-08T18:00:00.000Z'),
    updatedAt: new Date('2026-05-08T18:45:00.000Z'),
    _count: { printers: 0 }
  })) as unknown) as typeof rootPrisma.bridge.update

  const outboundMessages: unknown[] = []
  bridgeSessionManager.setTenantId = ((bridgeId: string, tenantId: string | null) => {
    assert.equal(bridgeId, 'bridge-1')
    assert.equal(tenantId, 'tenant-1')
    return true
  }) as typeof bridgeSessionManager.setTenantId
  bridgeSessionManager.sendMessage = ((bridgeId, message) => {
    assert.equal(bridgeId, 'bridge-1')
    outboundMessages.push(message)
    return true
  }) as typeof bridgeSessionManager.sendMessage

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectCode: 'connect-123', name: 'Workshop Bridge' })
    })

    assert.equal(response.status, 201)
    assert.deepEqual(outboundMessages, [{
      type: 'bridge.welcome',
      bridgeId: 'bridge-1',
      connected: true,
      tenantId: 'tenant-1',
      heartbeatIntervalSeconds: 15
    }])
  })
})

test('bridge connect rehomes bridge-owned library metadata to the current tenant', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: null
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1',
    name: 'Workshop Bridge',
    lastSeenAt: null,
    createdAt: new Date('2026-05-08T18:00:00.000Z'),
    updatedAt: new Date('2026-05-08T18:45:00.000Z'),
    _count: { printers: 0 }
  })) as unknown) as typeof rootPrisma.bridge.update

  const libraryCalls: Array<[string, unknown]> = []
  mockBridgeLibraryRecovery({ files: 2, folders: 1, versions: 3, replicas: 4, calls: libraryCalls })

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectCode: 'connect-123', name: 'Workshop Bridge' })
    })

    assert.equal(response.status, 201)
  })

  assert.deepEqual(libraryCalls, [
    ['files', {
      where: {
        ownerBridgeId: 'bridge-1',
        tenantId: { not: 'tenant-1' }
      },
      data: { tenantId: 'tenant-1' }
    }],
    ['folders', {
      where: {
        ownerBridgeId: 'bridge-1',
        tenantId: { not: 'tenant-1' }
      },
      data: { tenantId: 'tenant-1' }
    }],
    ['versions', {
      where: {
        ownerBridgeId: 'bridge-1',
        tenantId: { not: 'tenant-1' }
      },
      data: { tenantId: 'tenant-1' }
    }],
    ['replicas', {
      where: {
        bridgeId: 'bridge-1',
        tenantId: { not: 'tenant-1' }
      },
      data: { tenantId: 'tenant-1' }
    }]
  ])
})

test('bridge connect reattaches orphaned tenant printers when this is the only tenant bridge', async () => {
  mockBridgeLibraryRecovery()
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: null
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1',
    name: 'Workshop Bridge',
    lastSeenAt: null,
    createdAt: new Date('2026-05-08T18:00:00.000Z'),
    updatedAt: new Date('2026-05-08T18:45:00.000Z'),
    _count: { printers: 0 }
  })) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.bridge.findMany = ((async () => ([{ id: 'bridge-1' }])) as unknown) as typeof rootPrisma.bridge.findMany
  rootPrisma.printer.findMany = ((async () => ([
    {
      id: 'printer-1',
      tenantId: 'tenant-1',
      bridgeId: null,
      name: 'Printer One',
      host: 'printer-one.local',
      serial: 'SERIAL-1',
      accessCode: 'secret',
      model: 'P1S',
      currentPlateType: null,
      currentNozzleDiameters: null,
      position: 0,
      createdAt: new Date('2026-05-08T18:00:00.000Z'),
      updatedAt: new Date('2026-05-08T18:40:00.000Z')
    }
  ])) as unknown) as typeof rootPrisma.printer.findMany

  let printerUpdateManyArgs: unknown = null
  rootPrisma.printer.updateMany = ((async (args: unknown) => {
    printerUpdateManyArgs = args
    return { count: 1 }
  }) as unknown) as typeof rootPrisma.printer.updateMany

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectCode: 'connect-123', name: 'Workshop Bridge' })
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), {
      bridge: {
        id: 'bridge-1',
        name: 'Workshop Bridge',
        printerCount: 1,
        lastSeenAt: null,
        createdAt: '2026-05-08T18:00:00.000Z',
        updatedAt: '2026-05-08T18:45:00.000Z',
        connectionStats: {
          connected: false,
          connectedAt: null,
          pendingRpcCount: 0,
          activeCameraWatchCount: 0,
          activePrinterFtpCount: 0
        },
        update: unknownBridgeUpdate
      }
    })
  })

  assert.deepEqual(printerUpdateManyArgs, {
    where: {
      tenantId: 'tenant-1',
      id: { in: ['printer-1'] }
    },
    data: { bridgeId: 'bridge-1' }
  })
})

test('bridge connect rejects bridges already connected to a workspace', async () => {
  mockBridgeLibraryRecovery()
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-2'
  })) as unknown) as typeof rootPrisma.bridge.findUnique

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectCode: 'connect-123' })
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'Bridge has already been connected to a workspace.' })
  })
})

test('bridge test confirms that a connected bridge responds', async () => {
  prisma.bridge.count = ((async () => 1) as unknown) as typeof prisma.bridge.count
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  bridgeSessionManager.requestRpc = (async (bridgeId, method, params) => {
    assert.equal(bridgeId, 'bridge-1')
    assert.equal(method, 'bridge.ping')
    assert.equal(typeof (params as { requestedAt?: unknown }).requestedAt, 'string')
    return {
      respondedAt: '2026-05-08T18:50:00.000Z'
    }
  }) as typeof bridgeSessionManager.requestRpc

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/bridge-1/test`, {
      method: 'POST'
    })

    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.respondedAt, '2026-05-08T18:50:00.000Z')
    assert.equal(typeof payload.responseTimeMs, 'number')
    assert.equal(payload.responseTimeMs >= 0, true)
  })
})

test('bridge test rejects offline bridges', async () => {
  prisma.bridge.count = ((async () => 1) as unknown) as typeof prisma.bridge.count
  bridgeSessionManager.isConnected = (() => false) as typeof bridgeSessionManager.isConnected

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/bridge-1/test`, {
      method: 'POST'
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'Bridge is not connected.' })
  })
})

test('bridge update check refreshes API-side compatibility status', async () => {
  prisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    version: '0.1.0',
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    updateChannel: 'stable',
    updateStatus: null,
    latestAvailableVersion: null,
    lastUpdateCheckAt: null,
    lastUpdateError: null
  })) as unknown) as typeof prisma.bridge.findUnique
  let updateArgs: unknown = null
  prisma.bridge.update = ((async (args: unknown) => {
    updateArgs = args
    return {}
  }) as unknown) as typeof prisma.bridge.update

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/bridge-1/update/check`, {
      method: 'POST'
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      accepted: false,
      status: 'current',
      message: 'Bridge is current.'
    })
  })

  const persisted = updateArgs as { where: { id: string }; data: { updateStatus: string; latestAvailableVersion: string; lastUpdateCheckAt: Date; lastUpdateError: string | null } }
  assert.deepEqual(persisted.where, { id: 'bridge-1' })
  assert.equal(persisted.data.updateStatus, 'current')
  assert.equal(persisted.data.latestAvailableVersion, '0.1.0')
  assert.ok(persisted.data.lastUpdateCheckAt instanceof Date)
  assert.equal(persisted.data.lastUpdateError, null)
})

test('bridge update start asks the connected bridge to install an app update', async () => {
  prisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    version: '0.1.0',
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    updateChannel: 'stable',
    updateStatus: null,
    latestAvailableVersion: null,
    lastUpdateCheckAt: null,
    lastUpdateError: null
  })) as unknown) as typeof prisma.bridge.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  bridgeSessionManager.requestRpc = (async (bridgeId, method, params) => {
    assert.equal(bridgeId, 'bridge-1')
    assert.equal(method, 'bridge.update.install')
    assert.equal(typeof (params as { requestedAt?: unknown }).requestedAt, 'string')
    return { accepted: false, status: 'current', message: 'Bridge is current.' }
  }) as typeof bridgeSessionManager.requestRpc
  let updateArgs: unknown = null
  prisma.bridge.update = ((async (args: unknown) => {
    updateArgs = args
    return {}
  }) as unknown) as typeof prisma.bridge.update

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/bridge-1/update/start`, {
      method: 'POST'
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      accepted: false,
      status: 'current',
      message: 'Bridge is current.'
    })
  })

  const persisted = updateArgs as { where: { id: string }; data: { updateStatus: string; lastUpdateCheckAt: Date; lastUpdateError: string | null } }
  assert.deepEqual(persisted.where, { id: 'bridge-1' })
  assert.equal(persisted.data.updateStatus, 'current')
  assert.ok(persisted.data.lastUpdateCheckAt instanceof Date)
  assert.equal(persisted.data.lastUpdateError, null)
})

test('bridge rename requires settings manage permission', async () => {
  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/bridge-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Bridge' })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('bridge delete detaches the bridge and unassigns attached printers', async () => {
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    tenantId: 'tenant-1'
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  prisma.printer.findMany = ((async () => [
    {
      id: 'printer-1',
      tenantId: 'tenant-1',
      bridgeId: 'bridge-1',
      name: 'Printer One',
      host: 'printer-one.local',
      serial: 'SERIAL-1',
      accessCode: 'secret',
      model: 'P1S',
      currentPlateType: null,
      currentNozzleDiameters: null,
      position: 0,
      createdAt: new Date('2026-05-08T18:00:00.000Z'),
      updatedAt: new Date('2026-05-08T18:40:00.000Z')
    }
  ]) as unknown) as typeof prisma.printer.findMany

  let printerUpdateManyArgs: unknown = null
  let bridgeUpdateArgs: unknown = null
  rootPrisma.printer.updateMany = ((async (args: unknown) => {
    printerUpdateManyArgs = args
    return { count: 1 }
  }) as unknown) as typeof rootPrisma.printer.updateMany
  rootPrisma.bridge.update = ((async (args: unknown) => {
    bridgeUpdateArgs = args
    return {
      id: 'bridge-1',
      name: 'Bridge One',
      lastSeenAt: null,
      createdAt: new Date('2026-05-08T18:00:00.000Z'),
      updatedAt: new Date('2026-05-08T18:40:00.000Z'),
      _count: { printers: 0 }
    }
  }) as unknown) as typeof rootPrisma.bridge.update
  rootPrisma.$transaction = (((callback: (transaction: typeof rootPrisma) => Promise<unknown>) => callback(rootPrisma)) as unknown) as typeof rootPrisma.$transaction

  const outboundMessages: unknown[] = []
  bridgeSessionManager.setTenantId = ((bridgeId: string, tenantId: string | null) => {
    assert.equal(bridgeId, 'bridge-1')
    assert.equal(tenantId, null)
    return true
  }) as typeof bridgeSessionManager.setTenantId
  bridgeSessionManager.sendMessage = ((bridgeId, message) => {
    assert.equal(bridgeId, 'bridge-1')
    outboundMessages.push(message)
    return true
  }) as typeof bridgeSessionManager.sendMessage

  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/bridge-1`, {
      method: 'DELETE'
    })

    assert.equal(response.status, 204)
    assert.equal(await response.text(), '')
  })

  assert.deepEqual(printerUpdateManyArgs, {
    where: {
      tenantId: 'tenant-1',
      bridgeId: 'bridge-1'
    },
    data: { bridgeId: null }
  })
  assert.deepEqual(bridgeUpdateArgs, {
    where: { id: 'bridge-1' },
    data: { tenantId: null }
  })
  assert.deepEqual(outboundMessages, [{
    type: 'bridge.welcome',
    bridgeId: 'bridge-1',
    connected: false,
    tenantId: null,
    heartbeatIntervalSeconds: 15
  }])
})

test('bridge delete requires settings manage permission', async () => {
  await withBridgesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridges/bridge-1`, {
      method: 'DELETE'
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

async function withBridgesApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>,
  input: {
    tenant?: { id: string; slug: string; name: string } | null
  } = {}
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = input.tenant ?? { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }
    next()
  })
  app.use('/api/bridges', bridgesRouter)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run(baseUrl)
  } finally {
    await close(server)
  }
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function close(server: Server): Promise<void> {
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