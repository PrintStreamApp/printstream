process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  JOBS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION
} from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { createOrdersPlugin } from './index.js'

test('orders templates require authentication once auth is enabled', async () => {
  await withOrdersApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/templates`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('orders listing returns 403 without jobs.view permission', async () => {
  await withOrdersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/orders`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('orders listing is visible to jobs.view callers', async () => {
  await withOrdersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [JOBS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/orders`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { orders: [] })
  })
})

test('orders template mutation returns 403 without prints.dispatch permission', async () => {
  await withOrdersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [JOBS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('orders print start reaches the handler for prints.dispatch callers', async () => {
  await withOrdersApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTS_DISPATCH_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/orders/order-1/prints/print-1/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ printerId: 'printer-1' })
    })

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Order not found' })
  })
})

async function withOrdersApp(
  auth: RequestAuthContext,
  run: (context: { baseUrl: string }) => Promise<void>
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    next()
  })

  const router = express.Router()
  app.use('/api/plugins/orders', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  await createOrdersPlugin({
    enqueueLibraryPrint: async () => {
      throw new Error('not used in auth test')
    },
    inspectBridgeLibraryThreeMf: async () => ({ plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null, geometryOnly: false, objectExport: false, needsSettingsRepair: false, projectVersion: null }),
    resolveLibraryFileToLocalPath: async () => '/tmp/file.gcode',
    readPlateIndex: async () => ({ plates: [] }) as never
  }).register({
    pluginName: 'orders',
    logger: { info() {}, warn() {}, error() {} },
    prisma: createAuthPrismaStub(),
    printerEvents: new PrinterEventBus(),
    ws: { broadcast() {} },
    router,
    settings: {
      async get() { return null },
      async set() {},
      async delete() {}
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => {}
    },
    registerAuthProvider() {
      return () => {}
    }
  } as never)

  const server = await listen(app)
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run({ baseUrl })
  } finally {
    await close(server)
  }
}

function createAuthPrismaStub() {
  return {
    orderTemplate: {
      async findMany() { return [] },
      async findUnique() { return null }
    },
    orderPrint: {
      async findMany() { return [] },
      async count() { return 0 },
      async findFirst() { return null },
      async findUnique() { return null }
    },
    order: {
      async findMany() { return [] },
      async findUnique() { return null }
    },
    printJob: {
      async findFirst() { return null }
    }
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
