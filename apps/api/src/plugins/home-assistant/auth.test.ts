process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { PRINTERS_VIEW_PERMISSION } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { createHomeAssistantPlugin } from './index.js'

test('home assistant snapshot requires authentication once auth is enabled', async () => {
  await withHomeAssistantApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/home-assistant/snapshot`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('home assistant bridge info returns 403 without printers.view permission', async () => {
  await withHomeAssistantApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/home-assistant`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('home assistant snapshot is visible to printers.view callers', async () => {
  await withHomeAssistantApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/home-assistant/snapshot`)

    assert.equal(response.status, 200)
    const body = await response.json() as {
      printers: Array<{ id: string }>
    }
    assert.deepEqual(body.printers.map((printer) => printer.id), ['printer-1'])
  })
})

async function withHomeAssistantApp(
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
  app.use('/api/plugins/home-assistant', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  await createHomeAssistantPlugin({
    async listPrinters() {
      return [{
        id: 'printer-1',
        name: 'Printer 1',
        host: '192.168.1.44',
        serial: 'SERIAL-1',
        accessCode: 'secret',
        model: 'P1S',
        currentPlateType: null,
        currentNozzleDiameters: [],
        position: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      }]
    },
    getStatus() {
      return undefined
    }
  }).register({
    pluginName: 'home-assistant',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {
      printer: {
        async findMany() {
          return []
        }
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