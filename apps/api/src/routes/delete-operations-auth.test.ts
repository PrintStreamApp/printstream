process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  LIBRARY_MANAGE_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  type DeleteOperationJob
} from '@printstream/shared'
import { deleteOperationsRouter } from './delete-operations.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { deleteOperationDispatcher } from '../lib/delete-operation-dispatcher.js'
import { HttpError } from '../lib/http-error.js'
import type { RequestTenantSummary } from '../lib/tenant-context.js'

const originalList = deleteOperationDispatcher.list
const TEST_TENANT: RequestTenantSummary = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }

afterEach(() => {
  deleteOperationDispatcher.list = originalList
})

test('delete operations require authentication once auth is enabled', async () => {
  deleteOperationDispatcher.list = () => []

  await withDeleteOperationsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/delete-operations`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('delete operations return 403 without a matching delete permission', async () => {
  deleteOperationDispatcher.list = () => [
    createJob('library.delete', 'Library file'),
    createJob('printer.storage.delete', 'SD file')
  ]

  await withDeleteOperationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/delete-operations`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('delete operations only include job kinds allowed for the caller', async () => {
  deleteOperationDispatcher.list = () => [
    createJob('library.delete', 'Library file'),
    createJob('printer.storage.delete', 'SD file')
  ]

  await withDeleteOperationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/delete-operations`)
    const body = await response.json() as { jobs: DeleteOperationJob[] }

    assert.equal(response.status, 200)
    assert.deepEqual(body.jobs.map((job) => job.kind), ['library.delete'])
  })
})

test('delete operations include printer storage jobs for printers.manage callers', async () => {
  deleteOperationDispatcher.list = () => [
    createJob('library.delete', 'Library file'),
    createJob('printer.storage.delete', 'SD file')
  ]

  await withDeleteOperationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/delete-operations`)
    const body = await response.json() as { jobs: DeleteOperationJob[] }

    assert.equal(response.status, 200)
    assert.deepEqual(body.jobs.map((job) => job.kind), ['printer.storage.delete'])
  })
})

test('delete operations request the active tenant job slice', async () => {
  let requestedTenantId: string | null | undefined
  deleteOperationDispatcher.list = ((tenantId?: string | null) => {
    requestedTenantId = tenantId
    return []
  }) as typeof deleteOperationDispatcher.list

  await withDeleteOperationsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [LIBRARY_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/delete-operations`)

    assert.equal(response.status, 200)
  }, TEST_TENANT)

  assert.equal(requestedTenantId, 'tenant-1')
})

function createJob(kind: DeleteOperationJob['kind'], targetName: string): DeleteOperationJob {
  return {
    id: `${kind}:${targetName}`,
    kind,
    targetName,
    summaryLabel: 'Deleting items',
    printerId: kind === 'printer.storage.delete' ? 'printer-1' : null,
    status: 'running',
    totalItems: 1,
    completedItems: 0,
    progressPercent: 0,
    progressMessage: 'Queued',
    error: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    startedAt: '2026-05-01T00:00:00.000Z',
    finishedAt: null
  }
}

async function withDeleteOperationsApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>,
  tenant?: RequestTenantSummary | null
): Promise<void> {
  const app = express()
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = tenant ?? null
    next()
  })
  app.use('/api/delete-operations', deleteOperationsRouter)
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