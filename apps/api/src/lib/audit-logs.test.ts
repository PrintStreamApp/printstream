process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { printFromLibrarySchema, printerStoragePrintSchema } from '@printstream/shared'
import { annotateRequestAuditLog, installAuditLogCapture, noteRequestAuditPermission, printOverrideAuditMetadata, skipRequestAuditLog } from './audit-logs.js'
import { reprintJobSchema } from '../routes/jobs.js'
import type { RequestAuthContext } from './auth-context.js'
import { rootPrisma } from './prisma.js'
import { wsBroadcaster } from './ws-server.js'

const originalCreate = rootPrisma.auditLog.create
const originalWsBroadcast = wsBroadcaster.broadcast

afterEach(() => {
  rootPrisma.auditLog.create = originalCreate
  wsBroadcaster.broadcast = originalWsBroadcast
})

test('audit middleware records successful mutating requests with actor and workspace context', async () => {
  let capturedData: Record<string, unknown> | null = null
  let resolveLogged: (() => void) | null = null
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve
  })
  const logBroadcastWorkspaceIds: Array<string | null> = []

  wsBroadcaster.broadcast = ((event, workspaceId) => {
    if (event.type === 'resource.changed' && event.resource === 'logs') {
      logBroadcastWorkspaceIds.push(workspaceId)
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
    const response = await fetch(`${baseUrl}/api/workspaces`, { method: 'POST' })
    assert.equal(response.status, 201)
  }, {
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' }
  })

  await logged

  assert.deepEqual(logBroadcastWorkspaceIds, ['workspace-1'])
  assert.deepEqual(capturedData, {
    workspaceId: 'workspace-1',
    actorType: 'user',
    actorUserId: 'user-1',
    actorServiceAccountId: null,
    actorLabel: 'user:user-1',
    requestMethod: 'POST',
    requestPath: '/api/workspaces',
    action: 'create',
    resource: 'workspace',
    summary: 'Created or submitted workspace.',
    statusCode: 201,
    ipAddress: '127.0.0.1',
    metadataJson: null
  })
})

test('getAuditLogs exposes stable actor ids alongside the display label', async () => {
  const originalFindMany = rootPrisma.auditLog.findMany

  rootPrisma.auditLog.findMany = (async () => ([{
    id: 'audit-lookup-1',
    workspaceId: 'workspace-1',
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
    workspaceId: 'workspace-1',
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
    const response = await fetch(`${baseUrl}/api/workspaces`)
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
    workspaceId: null,
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
    const response = await fetch(`${baseUrl}/api/auth/workspace-context`, { method: 'POST' })
    assert.equal(response.status, 204)
  }, {
    workspace: { id: 'workspace-1', slug: 'alpha', name: 'Alpha' }
  })

  await logged

  assert.deepEqual(capturedData, {
    workspaceId: null,
    actorType: 'user',
    actorUserId: 'user-1',
    actorServiceAccountId: null,
    actorLabel: 'user:user-1',
    requestMethod: 'POST',
    requestPath: '/api/auth/workspace-context',
    action: 'switch-workspace',
    resource: 'workspace',
    summary: 'Changed the active workspace context.',
    statusCode: 204,
    ipAddress: '127.0.0.1',
    metadataJson: JSON.stringify({
      sourceWorkspaceId: 'workspace-1',
      targetWorkspaceId: 'workspace-2'
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
    workspace?: { id: string; slug: string; name: string } | null
  } = {}
): Promise<void> {
  const app = express()
  app.use((request, _response, next) => {
    request.auth = auth
    request.workspace = input.workspace ?? null
    next()
  })
  app.use(installAuditLogCapture())
  app.get('/api/workspaces', (_request, response) => {
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
  app.post('/api/auth/workspace-context', (request, response) => {
    annotateRequestAuditLog(request, {
      action: 'switch-workspace',
      resource: 'workspace',
      workspaceId: null,
      summary: 'Changed the active workspace context.',
      metadata: {
        sourceWorkspaceId: request.workspace?.id ?? null,
        targetWorkspaceId: 'workspace-2'
      }
    })
    response.status(204).end()
  })
  app.post('/api/workspaces', (_request, response) => {
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
test('print override metadata records only the gates a dispatch actually bypassed', () => {
  // Nothing recorded for an ordinary print: a bag of `false`s on every dispatch says nothing and
  // buries the entries where one is true.
  assert.deepEqual(printOverrideAuditMetadata({}), {})
  assert.deepEqual(printOverrideAuditMetadata({
    allowIncompatibleFilament: false,
    allowPlateTypeMismatch: false,
    allowFilamentTrackSwitchMismatch: false,
    allowInsufficientFilament: false
  }), {})

  assert.deepEqual(printOverrideAuditMetadata({ allowPlateTypeMismatch: true }), { allowPlateTypeMismatch: true })
  assert.deepEqual(printOverrideAuditMetadata({
    allowIncompatibleFilament: true,
    allowPlateTypeMismatch: true,
    allowFilamentTrackSwitchMismatch: true,
    allowInsufficientFilament: true
  }), {
    allowIncompatibleFilament: true,
    allowPlateTypeMismatch: true,
    allowFilamentTrackSwitchMismatch: true,
    allowInsufficientFilament: true
  })
})

test('every dispatch route feeds the audit helper the gates its own schema exposes', () => {
  // The helper takes every flag as OPTIONAL, so a route whose schema stopped carrying one
  // would silently record nothing and still typecheck. These assertions are what makes that
  // visible: they run each real schema's parsed output through the helper, exactly as the routes
  // do, and pin which gates each dispatch path can record.
  const allOverrides = {
    allowIncompatibleFilament: true,
    allowPlateTypeMismatch: true,
    allowFilamentTrackSwitchMismatch: true,
    allowInsufficientFilament: true
  }

  // Library print: carries all three.
  const libraryPrint = printFromLibrarySchema.parse({
    fileId: 'file-1', printerId: 'printer-1', ...allOverrides
  })
  assert.deepEqual(printOverrideAuditMetadata(libraryPrint), allOverrides)

  // Re-print of a history job. The REAL route schema, not a stand-in: it is
  // `.partial()`, so every gate is optional and a dropped one is invisible to the
  // compiler here of all places.
  const reprint = reprintJobSchema.parse({ printerId: 'printer-1', ...allOverrides })
  assert.deepEqual(printOverrideAuditMetadata(reprint), allOverrides)
  // And an override-less re-print bypasses nothing, so it records nothing: consent is never
  // restored from the history row, only re-granted per request.
  assert.deepEqual(printOverrideAuditMetadata(reprintJobSchema.parse({})), {})

  // Printer-storage print, deliberately has NO plate-type gate to bypass (nothing compares a
  // stored file against the printer's plate), so it records the other two and only those.
  const storagePrint = printerStoragePrintSchema.parse({ path: '/model.3mf', ...allOverrides })
  assert.deepEqual(printOverrideAuditMetadata(storagePrint), {
    allowIncompatibleFilament: true,
    allowFilamentTrackSwitchMismatch: true,
    allowInsufficientFilament: true
  })
})
