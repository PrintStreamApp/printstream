process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import {
  PRINTERS_CLEAR_PLATE_PERMISSION,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  SETTINGS_MANAGE_PERMISSION
} from '@printstream/shared'
import { PrinterEventBus } from '../../lib/printer-events.js'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { plateClearingPlugin } from './index.js'

test('plate-clearing state requires authentication once auth is enabled', async () => {
  await withPlateClearingApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/plate-clearing/state`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('plate-clearing settings require settings.manage permission', async () => {
  await withPlateClearingApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/plate-clearing`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('plate-clearing state allows printers.view callers', async () => {
  await withPlateClearingApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/plate-clearing/state`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      printers: [{ printerId: 'printer-1', cleared: true }]
    })
  })
})

test('plate-clearing clear requires printers.clearPlate permission', async () => {
  await withPlateClearingApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CONTROL_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/plate-clearing/state/printer-1/clear`, {
      method: 'POST'
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('plate-clearing clear updates state for printers.clearPlate callers', async () => {
  await withPlateClearingApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_CLEAR_PLATE_PERMISSION, PRINTERS_VIEW_PERMISSION, SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const clearResponse = await fetch(`${baseUrl}/api/plugins/plate-clearing/state/printer-1/clear`, {
      method: 'POST'
    })
    assert.equal(clearResponse.status, 200)
    assert.deepEqual(await clearResponse.json(), { printerId: 'printer-1', cleared: true })

    const stateResponse = await fetch(`${baseUrl}/api/plugins/plate-clearing/state`)
    assert.equal(stateResponse.status, 200)
    assert.deepEqual(await stateResponse.json(), {
      printers: [{ printerId: 'printer-1', cleared: true }]
    })

    const settingsResponse = await fetch(`${baseUrl}/api/plugins/plate-clearing`)
    assert.equal(settingsResponse.status, 200)
    assert.deepEqual(await settingsResponse.json(), { clearLastJobOnClear: true })
  })
})

async function withPlateClearingApp(
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
  app.use('/api/plugins/plate-clearing', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const settings = new Map<string, string>()
  await plateClearingPlugin.register({
    pluginName: 'plate-clearing',
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
      async get(key: string) {
        return settings.get(key) ?? null
      },
      async set(key: string, value: string) {
        settings.set(key, value)
      },
      async delete(key: string) {
        settings.delete(key)
      }
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