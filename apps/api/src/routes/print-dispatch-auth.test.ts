process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  JOBS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION
} from '@printstream/shared'
import { printDispatchRouter } from './print-dispatch.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { HttpError } from '../lib/http-error.js'
import { printDispatcher } from '../lib/print-dispatcher.js'
import type { RequestTenantSummary } from '../lib/tenant-context.js'

const TEST_TENANT: RequestTenantSummary = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }

const originalList = printDispatcher.list
const originalCancel = printDispatcher.cancel

afterEach(() => {
  printDispatcher.list = originalList
  printDispatcher.cancel = originalCancel
})

test('dispatch queue requires authentication once auth is enabled', async () => {
  await withDispatchApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/print-dispatch`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('dispatch queue requires tenant context', async () => {
  await withDispatchApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [JOBS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/print-dispatch`)

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Tenant context is required' })
  })
})

test('dispatch queue scopes results to the request tenant', async () => {
  await withDispatchApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [JOBS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    let receivedTenantId: string | null = null
    printDispatcher.list = (((tenantId: string) => {
      receivedTenantId = tenantId
      return []
    }) as unknown) as typeof printDispatcher.list

    const response = await fetch(`${baseUrl}/api/print-dispatch`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { jobs: [] })
    assert.equal(receivedTenantId, TEST_TENANT.id)
  })
})

test('dispatch cancellation returns 403 without prints.dispatch permission', async () => {
  await withDispatchApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [JOBS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/print-dispatch/job-1/cancel`, { method: 'POST' })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('dispatch cancellation passes authorization with prints.dispatch permission', async () => {
  await withDispatchApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [JOBS_VIEW_PERMISSION, PRINTS_DISPATCH_PERMISSION],
    runtimePolicy: { demoMode: false },
    tenant: TEST_TENANT
  }, async (baseUrl) => {
    let received: { tenantId: string; jobId: string } | null = null
    printDispatcher.cancel = (((tenantId: string, jobId: string) => {
      received = { tenantId, jobId }
      return Promise.resolve(null)
    }) as unknown) as typeof printDispatcher.cancel

    const response = await fetch(`${baseUrl}/api/print-dispatch/job-1/cancel`, { method: 'POST' })

    assert.notEqual(response.status, 401)
    assert.notEqual(response.status, 403)
    assert.equal(response.status, 404)
    assert.deepEqual(received, { tenantId: TEST_TENANT.id, jobId: 'job-1' })
  })
})

async function withDispatchApp(
  input: RequestAuthContext & { tenant?: RequestTenantSummary | null },
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = input
    request.tenant = input.tenant ?? null
    next()
  })
  app.use('/api/print-dispatch', printDispatchRouter)
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