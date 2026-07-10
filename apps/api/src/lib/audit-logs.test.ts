process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { annotateRequestAuditLog, installAuditLogCapture, noteRequestAuditPermission, skipRequestAuditLog } from './audit-logs.js'
import type { RequestAuthContext } from './auth-context.js'
import { rootPrisma } from './prisma.js'
import { wsBroadcaster } from './ws-server.js'

const originalCreate = rootPrisma.auditLog.create
const originalWsBroadcast = wsBroadcaster.broadcast

afterEach(() => {
  rootPrisma.auditLog.create = originalCreate
  wsBroadcaster.broadcast = originalWsBroadcast
})

test('audit middleware records successful mutating requests with actor and tenant context', async () => {
  let capturedData: Record<string, unknown> | null = null
  let resolveLogged: (() => void) | null = null
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve
  })
  const logBroadcastTenantIds: Array<string | null> = []

  wsBroadcaster.broadcast = ((event, tenantId) => {
    if (event.type === 'resource.changed' && event.resource === 'logs') {
      logBroadcastTenantIds.push(tenantId)
    }
  }) as typeof wsBroadcaster.broadcast

  rootPrisma.auditLog.create = (async (args: { data: Record<string, unknown> }) => {
    capturedData = args.data
    resolveLogged?.()
    return { id: 'audit-1' } as never
  }) as unknown as typeof rootPrisma.auditLog.create

  await withAuditApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tenants`, { method: 'POST' })
    assert.equal(response.status, 201)
  }, {
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
  })

  await logged

  assert.deepEqual(logBroadcastTenantIds, ['tenant-1'])
  assert.deepEqual(capturedData, {
    tenantId: 'tenant-1',
    actorType: 'user',
    actorUserId: 'user-1',
    actorServiceAccountId: null,
    actorLabel: 'user:user-1',
    requestMethod: 'POST',
    requestPath: '/api/tenants',
    action: 'create',
    resource: 'tenant',
    summary: 'Created or submitted tenant.',
    statusCode: 201,
    ipAddress: '127.0.0.1',
    metadataJson: null
  })
})

test('getAuditLogs exposes stable actor ids alongside the display label', async () => {
  const originalFindMany = rootPrisma.auditLog.findMany

  rootPrisma.auditLog.findMany = (async () => ([{
    id: 'audit-lookup-1',
    tenantId: 'tenant-1',
    actorType: 'user',
    actorUserId: 'user-1',
    actorServiceAccountId: null,
    actorLabel: 'user:user-1',
    requestMethod: 'POST',
    action: 'update',
    resource: 'settings',
    summary: 'Updated settings.',
    statusCode: 200,
    metadataJson: null,
    createdAt: new Date('2026-05-05T12:00:00.000Z'),
    actorUser: {
      email: 'operator@example.com',
      displayName: 'Operator'
    },
    actorServiceAccount: null
  }])) as unknown as typeof rootPrisma.auditLog.findMany

  try {
    const [entry] = await import('./audit-logs.js').then((module) => module.getAuditLogs(10))
    assert.equal(entry?.actorLabel, 'Operator')
    assert.equal(entry?.actorUserId, 'user-1')
    assert.equal(entry?.actorServiceAccountId, null)
    assert.equal(entry?.level, 'info')
  } finally {
    rootPrisma.auditLog.findMany = originalFindMany
  }
})

test('getAuditLogs marks annotated GETs as debug activity', async () => {
  const originalFindMany = rootPrisma.auditLog.findMany

  rootPrisma.auditLog.findMany = (async () => ([{
    id: 'audit-lookup-2',
    tenantId: 'tenant-1',
    actorType: 'user',
    actorUserId: 'user-1',
    actorServiceAccountId: null,
    actorLabel: 'user:user-1',
    requestMethod: 'GET',
    action: 'download',
    resource: 'library file',
    summary: 'Downloaded library file sample.3mf.',
    statusCode: 200,
    metadataJson: null,
    createdAt: new Date('2026-05-05T12:05:00.000Z'),
    actorUser: null,
    actorServiceAccount: null
  }])) as unknown as typeof rootPrisma.auditLog.findMany

  try {
    const [entry] = await import('./audit-logs.js').then((module) => module.getAuditLogs(10))
    assert.equal(entry?.level, 'debug')
  } finally {
    rootPrisma.auditLog.findMany = originalFindMany
  }
})
test('audit middleware ignores read-only requests', async () => {
  let called = false

  rootPrisma.auditLog.create = (async () => {
    called = true
    return { id: 'audit-2' } as never
  }) as unknown as typeof rootPrisma.auditLog.create

  await withAuditApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tenants`)
    assert.equal(response.status, 200)
  })

  assert.equal(called, false)
})

test('audit middleware records annotated read-only requests', async () => {
  let capturedData: Record<string, unknown> | null = null
  let resolveLogged: (() => void) | null = null
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve
  })

  rootPrisma.auditLog.create = (async (args: { data: Record<string, unknown> }) => {
    capturedData = args.data
    resolveLogged?.()
    return { id: 'audit-3' } as never
  }) as unknown as typeof rootPrisma.auditLog.create

  await withAuditApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/library/file-1/download`)
    assert.equal(response.status, 200)
  })

  await logged

  assert.deepEqual(capturedData, {
    tenantId: null,
    actorType: 'user',
    actorUserId: 'user-1',
    actorServiceAccountId: null,
    actorLabel: 'user:user-1',
    requestMethod: 'GET',
    requestPath: '/api/library/file-1/download',
    action: 'download',
    resource: 'library file',
    summary: 'Downloaded library file sample.3mf.',
    statusCode: 200,
    ipAddress: '127.0.0.1',
    metadataJson: JSON.stringify({
      fileId: 'file-1',
      fileName: 'sample.3mf'
    })
  })
})

test('audit middleware can force workspace changes into platform-scoped logs', async () => {
  let capturedData: Record<string, unknown> | null = null
  let resolveLogged: (() => void) | null = null
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve
  })

  rootPrisma.auditLog.create = (async (args: { data: Record<string, unknown> }) => {
    capturedData = args.data
    resolveLogged?.()
    return { id: 'audit-5' } as never
  }) as unknown as typeof rootPrisma.auditLog.create

  await withAuditApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/tenant-context`, { method: 'POST' })
    assert.equal(response.status, 204)
  }, {
    tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
  })

  await logged

  assert.deepEqual(capturedData, {
    tenantId: null,
    actorType: 'user',
    actorUserId: 'user-1',
    actorServiceAccountId: null,
    actorLabel: 'user:user-1',
    requestMethod: 'POST',
    requestPath: '/api/auth/tenant-context',
    action: 'switch-workspace',
    resource: 'workspace',
    summary: 'Changed the active workspace context.',
    statusCode: 204,
    ipAddress: '127.0.0.1',
    metadataJson: JSON.stringify({
      sourceTenantId: 'tenant-1',
      targetTenantId: 'tenant-2'
    })
  })
})

test('audit middleware skips mutating requests that opt out via skipRequestAuditLog', async () => {
  let called = false

  rootPrisma.auditLog.create = (async () => {
    called = true
    return { id: 'audit-6' } as never
  }) as unknown as typeof rootPrisma.auditLog.create

  await withAuditApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/plugins/notifications-browser/dismissals`, { method: 'POST' })
    assert.equal(response.status, 202)
  })

  assert.equal(called, false)
})

test('audit middleware ignores read-only requests that only note required permissions', async () => {
  let called = false

  rootPrisma.auditLog.create = (async () => {
    called = true
    return { id: 'audit-4' } as never
  }) as unknown as typeof rootPrisma.auditLog.create

  await withAuditApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/logs`)
    assert.equal(response.status, 200)
  })

  assert.equal(called, false)
})

async function withAuditApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>,
  input: {
    tenant?: { id: string; slug: string; name: string } | null
  } = {}
): Promise<void> {
  const app = express()
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = input.tenant ?? null
    next()
  })
  app.use(installAuditLogCapture())
  app.get('/api/tenants', (_request, response) => {
    response.status(200).json({ ok: true })
  })
  app.get('/api/library/file-1/download', (request, response) => {
    annotateRequestAuditLog(request, {
      action: 'download',
      resource: 'library file',
      summary: 'Downloaded library file sample.3mf.',
      metadata: {
        fileId: 'file-1',
        fileName: 'sample.3mf'
      }
    })
    response.status(200).json({ ok: true })
  })
  app.get('/api/logs', (request, response) => {
    noteRequestAuditPermission(request, 'settings.manage')
    response.status(200).json({ ok: true })
  })
  app.post('/api/auth/tenant-context', (request, response) => {
    annotateRequestAuditLog(request, {
      action: 'switch-workspace',
      resource: 'workspace',
      tenantId: null,
      summary: 'Changed the active workspace context.',
      metadata: {
        sourceTenantId: request.tenant?.id ?? null,
        targetTenantId: 'tenant-2'
      }
    })
    response.status(204).end()
  })
  app.post('/api/tenants', (_request, response) => {
    response.status(201).json({ ok: true })
  })
  app.post('/api/plugins/notifications-browser/dismissals', (request, response) => {
    skipRequestAuditLog(request)
    response.status(202).json({ ok: true })
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