process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { logsRouter } from './logs.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { HttpError } from '../lib/http-error.js'
import { rootPrisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

const rp = rootPrisma as unknown as Record<string, Record<string, unknown>>
// Auto-restore the prisma/rootPrisma methods these tests override (was a per-method save/restore block).
restorePrismaMethodsAfterEach([
  [rp.auditLog, 'findMany'],
  [rp.auditLog, 'deleteMany']
])

afterEach(() => {
})

test('logs read requires authentication once auth is enabled', async () => {
  await withLogsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/logs`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('logs read allows actors with settings management permission', async () => {
  await withLogsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/logs?limit=10`)
    const body = await response.json() as { entries: unknown[] }

    assert.equal(response.status, 200)
    assert.ok(Array.isArray(body.entries))
  })
})

test('logs clear returns 403 without settings.manage permission', async () => {
  await withLogsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/logs`, { method: 'DELETE' })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('tenant logs allow tenant settings managers without platform tenant-management permission', async () => {
  await withLogsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/logs?limit=10`)
    const body = await response.json() as { entries: unknown[] }

    assert.equal(response.status, 200)
    assert.ok(Array.isArray(body.entries))
  }, {
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }
  })
})

async function withLogsApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>,
  input: {
    tenant?: { id: string; slug: string; name: string } | null
  } = {}
): Promise<void> {
  rootPrisma.auditLog.findMany = (async () => []) as typeof rootPrisma.auditLog.findMany
  rootPrisma.auditLog.deleteMany = (async () => ({ count: 0 })) as typeof rootPrisma.auditLog.deleteMany

  const app = express()
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = input.tenant ?? null
    next()
  })
  app.use('/api/logs', logsRouter)
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