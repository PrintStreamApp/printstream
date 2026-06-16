process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { inactiveBridgeDebugCaptureStatus } from '@printstream/shared'
import { bridgeRuntimeRouter } from './bridge-runtime.js'
import { HttpError } from '../lib/http-error.js'
import { env } from '../lib/env.js'
import { rootPrisma } from '../lib/prisma.js'
import { hashBridgeRuntimeToken } from '../lib/bridge-runtime-auth.js'

const originalCreate = rootPrisma.bridge.create
const originalFindUnique = rootPrisma.bridge.findUnique
const originalUpdate = rootPrisma.bridge.update
const originalTenantFindMany = rootPrisma.tenant.findMany
const originalManagedBridge = env.MANAGED_BRIDGE
const originalManagedBridgeTokenFile = env.MANAGED_BRIDGE_TOKEN_FILE

const MANAGED_TOKEN = 'managed-token-value'
let managedTokenDir: string | null = null

// Seeds a known provisioning token on disk and switches the API into managed
// mode so attemptManagedAutoPair verifies against it.
function enableManagedMode(token: string = MANAGED_TOKEN): void {
  managedTokenDir = mkdtempSync(path.join(tmpdir(), 'managed-bridge-'))
  const file = path.join(managedTokenDir, 'token')
  writeFileSync(file, token)
  env.MANAGED_BRIDGE = true
  env.MANAGED_BRIDGE_TOKEN_FILE = file
}

const RELEASE_FINGERPRINT = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

const currentBridgeUpdate = {
  status: 'current',
  currentReleaseFingerprint: RELEASE_FINGERPRINT,
  latestReleaseFingerprint: null,
  currentBuildRevision: null,
  latestBuildRevision: null,
  latestReleasedAt: null,
  protocolVersion: 1,
  runnerAbiVersion: 'node22-ffmpeg7-v1',
  lastCheckedAt: '2026-05-08T21:45:00.000Z',
  lastError: null,
  manualUpdateCommand: null
}

afterEach(() => {
  rootPrisma.bridge.create = originalCreate
  rootPrisma.bridge.findUnique = originalFindUnique
  rootPrisma.bridge.update = originalUpdate
  rootPrisma.tenant.findMany = originalTenantFindMany
  env.MANAGED_BRIDGE = originalManagedBridge
  env.MANAGED_BRIDGE_TOKEN_FILE = originalManagedBridgeTokenFile
  if (managedTokenDir) {
    rmSync(managedTokenDir, { recursive: true, force: true })
    managedTokenDir = null
  }
})

function stubDormantBridgeCreate() {
  rootPrisma.bridge.create = ((async () => ({
    id: 'bridge-1',
    name: 'Bench Bridge',
    connectCode: 'connect-123',
    tenantId: null,
    version: '0.1.0',
    lastSeenAt: new Date('2026-05-08T21:30:00.000Z'),
    createdAt: new Date('2026-05-08T21:30:00.000Z'),
    updatedAt: new Date('2026-05-08T21:30:00.000Z'),
    _count: { printers: 0 }
  })) as unknown) as typeof rootPrisma.bridge.create
}

test('managed-bridge register consults the sole workspace when the provisioning token matches', async () => {
  enableManagedMode()
  stubDormantBridgeCreate()
  // Returning no candidates keeps resolveSoleTenant ambiguous, so the route
  // leaves the bridge unpaired — letting us assert the lookup happened without
  // exercising the full pairing chain.
  let soleTenantLookups = 0
  rootPrisma.tenant.findMany = ((async () => {
    soleTenantLookups += 1
    return []
  }) as unknown) as typeof rootPrisma.tenant.findMany

  await withBridgeRuntimeApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridge-runtime/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bench Bridge', provisionSecret: MANAGED_TOKEN })
    })

    assert.equal(response.status, 201)
    assert.equal(soleTenantLookups, 1)
  })
})

test('managed-bridge register ignores a wrong provisioning token', async () => {
  enableManagedMode()
  stubDormantBridgeCreate()
  let soleTenantLookups = 0
  rootPrisma.tenant.findMany = ((async () => {
    soleTenantLookups += 1
    return []
  }) as unknown) as typeof rootPrisma.tenant.findMany

  await withBridgeRuntimeApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridge-runtime/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bench Bridge', provisionSecret: 'wrong-token-value' })
    })

    assert.equal(response.status, 201)
    assert.equal(soleTenantLookups, 0)
  })
})

test('register ignores a provisioning token when managed-bridge mode is off', async () => {
  env.MANAGED_BRIDGE = false
  stubDormantBridgeCreate()
  let soleTenantLookups = 0
  rootPrisma.tenant.findMany = ((async () => {
    soleTenantLookups += 1
    return []
  }) as unknown) as typeof rootPrisma.tenant.findMany

  await withBridgeRuntimeApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridge-runtime/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bench Bridge', provisionSecret: 'any-token-value' })
    })

    assert.equal(response.status, 201)
    assert.equal(soleTenantLookups, 0)
  })
})

test('bridge runtime register creates a dormant bridge with runtime credentials', async () => {
  rootPrisma.bridge.create = ((async () => ({
    id: 'bridge-1',
    name: 'Bench Bridge',
    connectCode: 'connect-123',
    tenantId: null,
    version: '0.1.0',
    lastSeenAt: new Date('2026-05-08T21:30:00.000Z'),
    createdAt: new Date('2026-05-08T21:30:00.000Z'),
    updatedAt: new Date('2026-05-08T21:30:00.000Z'),
    _count: { printers: 0 }
  })) as unknown) as typeof rootPrisma.bridge.create

  await withBridgeRuntimeApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridge-runtime/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bench Bridge', version: '0.1.0' })
    })

    assert.equal(response.status, 201)
    const payload = await response.json()
    assert.equal(payload.bridge.id, 'bridge-1')
    assert.equal(payload.bridge.name, 'Bench Bridge')
    assert.equal(payload.bridge.connectCode, 'connect-123')
    assert.equal(typeof payload.runtimeToken, 'string')
    assert.equal(payload.connectPath, '/api/bridge-runtime/connect')
    assert.equal(payload.heartbeatIntervalSeconds, 15)
  })
})

test('bridge runtime register refreshes an existing bridge when credentials match', async () => {
  const runtimeToken = 'bridge-token'
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    name: 'Bench Bridge',
    connectCode: 'connect-123',
    tenantId: null,
    version: '0.1.0',
    runtimeTokenHash: hashBridgeRuntimeToken(runtimeToken),
    lastSeenAt: new Date('2026-05-08T21:30:00.000Z'),
    createdAt: new Date('2026-05-08T21:00:00.000Z'),
    updatedAt: new Date('2026-05-08T21:30:00.000Z'),
    _count: { printers: 1 }
  })) as unknown) as typeof rootPrisma.bridge.findUnique
  rootPrisma.bridge.update = ((async () => ({
    id: 'bridge-1',
    name: 'Bench Bridge',
    connectCode: 'connect-123',
    tenantId: null,
    version: '0.2.0',
    releaseFingerprint: RELEASE_FINGERPRINT,
    protocolVersion: 1,
    runnerAbiVersion: 'node22-ffmpeg7-v1',
    updateChannel: 'stable',
    updateStatus: null,
    latestAvailableVersion: null,
    lastUpdateCheckAt: new Date('2026-05-08T21:45:00.000Z'),
    lastUpdateError: null,
    lastSeenAt: new Date('2026-05-08T21:45:00.000Z'),
    createdAt: new Date('2026-05-08T21:00:00.000Z'),
    updatedAt: new Date('2026-05-08T21:45:00.000Z'),
    _count: { printers: 1 }
  })) as unknown) as typeof rootPrisma.bridge.update

  await withBridgeRuntimeApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridge-runtime/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bridgeId: 'bridge-1',
        runtimeToken,
        version: '0.2.0',
        releaseFingerprint: RELEASE_FINGERPRINT,
        protocolVersion: 1,
        runnerAbiVersion: 'node22-ffmpeg7-v1'
      })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      bridge: {
        id: 'bridge-1',
        name: 'Bench Bridge',
        connectCode: 'connect-123',
        printerCount: 1,
        lastSeenAt: '2026-05-08T21:45:00.000Z',
        createdAt: '2026-05-08T21:00:00.000Z',
        updatedAt: '2026-05-08T21:45:00.000Z',
        connectionStats: {
          connected: false,
          connectedAt: null,
          pendingRpcCount: 0,
          activeCameraWatchCount: 0,
          activePrinterFtpCount: 0
        },
        update: currentBridgeUpdate,
        debugCapture: inactiveBridgeDebugCaptureStatus
      },
      runtimeToken,
      connectPath: '/api/bridge-runtime/connect',
      heartbeatIntervalSeconds: 15
    })
  })
})

test('bridge runtime register preserves a connected bridge name on reconnect', async () => {
  const runtimeToken = 'bridge-token'
  rootPrisma.bridge.findUnique = ((async () => ({
    id: 'bridge-1',
    name: 'Workshop Bridge',
    connectCode: 'connect-123',
    tenantId: 'tenant-1',
    version: '0.1.0',
    runtimeTokenHash: hashBridgeRuntimeToken(runtimeToken),
    lastSeenAt: new Date('2026-05-08T21:30:00.000Z'),
    createdAt: new Date('2026-05-08T21:00:00.000Z'),
    updatedAt: new Date('2026-05-08T21:30:00.000Z'),
    _count: { printers: 1 }
  })) as unknown) as typeof rootPrisma.bridge.findUnique

  let updateData: Record<string, unknown> | null = null
  rootPrisma.bridge.update = ((async (input: { data: Record<string, unknown> }) => {
    updateData = input.data
    return {
      id: 'bridge-1',
      name: 'Workshop Bridge',
      connectCode: 'connect-123',
      tenantId: 'tenant-1',
      version: '0.2.0',
      releaseFingerprint: RELEASE_FINGERPRINT,
      protocolVersion: 1,
      runnerAbiVersion: 'node22-ffmpeg7-v1',
      updateChannel: 'stable',
      updateStatus: null,
      latestAvailableVersion: null,
      lastUpdateCheckAt: new Date('2026-05-08T21:45:00.000Z'),
      lastUpdateError: null,
      lastSeenAt: new Date('2026-05-08T21:45:00.000Z'),
      createdAt: new Date('2026-05-08T21:00:00.000Z'),
      updatedAt: new Date('2026-05-08T21:45:00.000Z'),
      _count: { printers: 1 }
    }
  }) as unknown) as typeof rootPrisma.bridge.update

  await withBridgeRuntimeApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridge-runtime/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bridgeId: 'bridge-1',
        runtimeToken,
        name: 'PrintStream Bridge',
        version: '0.2.0',
        releaseFingerprint: RELEASE_FINGERPRINT,
        protocolVersion: 1,
        runnerAbiVersion: 'node22-ffmpeg7-v1'
      })
    })

    assert.equal(response.status, 200)
    assert.equal(updateData?.name, undefined)
    assert.equal(updateData?.version, '0.2.0')
    assert.equal(updateData?.protocolVersion, 1)
    assert.equal(updateData?.runnerAbiVersion, 'node22-ffmpeg7-v1')
    assert.equal(updateData?.releaseFingerprint, RELEASE_FINGERPRINT)
    assert.equal(updateData?.updateChannel, undefined)
    assert.deepEqual(await response.json(), {
      bridge: {
        id: 'bridge-1',
        name: 'Workshop Bridge',
        connectCode: 'connect-123',
        printerCount: 1,
        lastSeenAt: '2026-05-08T21:45:00.000Z',
        createdAt: '2026-05-08T21:00:00.000Z',
        updatedAt: '2026-05-08T21:45:00.000Z',
        connectionStats: {
          connected: false,
          connectedAt: null,
          pendingRpcCount: 0,
          activeCameraWatchCount: 0,
          activePrinterFtpCount: 0
        },
        update: currentBridgeUpdate,
        debugCapture: inactiveBridgeDebugCaptureStatus
      },
      runtimeToken,
      connectPath: '/api/bridge-runtime/connect',
      heartbeatIntervalSeconds: 15
    })
  })
})

test('bridge runtime releases endpoint announces no build before promotion', async () => {
  await withBridgeRuntimeApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridge-runtime/releases`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      schemaVersion: 2,
      generatedAt: '1970-01-01T00:00:00.000Z',
      minimumSupportedProtocol: 1,
      current: null
    })

    // Legacy channel path stays routable for old bridges.
    assert.equal((await fetch(`${baseUrl}/api/bridge-runtime/releases/stable`)).status, 200)
  })
})

test('bridge runtime register rejects incomplete persisted credentials', async () => {
  await withBridgeRuntimeApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bridge-runtime/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridgeId: 'bridge-1' })
    })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Bridge runtime credentials are incomplete.' })
  })
})

async function withBridgeRuntimeApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use('/api/bridge-runtime', bridgeRuntimeRouter)
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