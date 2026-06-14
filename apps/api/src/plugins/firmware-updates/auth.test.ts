process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION
} from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { printerManager } from '../../lib/printer-manager.js'
import { firmwareUpdatesPlugin } from './index.js'

afterEach(() => {
  mock.restoreAll()
})

test('firmware reports require authentication once auth is enabled', async () => {
  await withFirmwareUpdatesApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('firmware upload status returns 403 without printers.view permission', async () => {
  await withFirmwareUpdatesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/printer-1/upload/status`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('firmware upload status is visible to printers.view callers', async () => {
  await withFirmwareUpdatesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/printer-1/upload/status`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      status: 'idle',
      progress: 0,
      message: '',
      error: null,
      firmwareFilename: null,
      firmwareVersion: null
    })
  })
})

test('firmware upload returns 403 without printers.manage permission', async () => {
  await withFirmwareUpdatesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/printer-1/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('firmware upload reaches the handler for printers.manage callers', async () => {
  mock.method(printerManager, 'getPrinter', () => null)

  await withFirmwareUpdatesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/printer-1/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Printer not connected' })
  })
})

test('firmware upload cancel reaches the handler for printers.manage callers', async () => {
  await withFirmwareUpdatesApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/firmware-updates/updates/printer-1/upload/cancel`, {
      method: 'POST'
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      status: 'idle',
      progress: 0,
      message: '',
      error: null,
      firmwareFilename: null,
      firmwareVersion: null
    })
  })
})

async function withFirmwareUpdatesApp(
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
  app.use('/api/plugins/firmware-updates', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  await firmwareUpdatesPlugin.register({
    pluginName: 'firmware-updates',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      printer: {
        findMany: async () => [{ id: 'printer-1' }]
      }
    },
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