process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { type Printer } from '@printstream/shared'
import { printersRouter } from './printers.js'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { HttpError } from '../lib/http-error.js'
import { printerManager } from '../lib/printer-manager.js'
import { rootPrisma } from '../lib/prisma.js'

const TEST_TENANT = { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }
const originalPrinterFindUnique = rootPrisma.printer.findUnique
const originalBridgeIsConnected = bridgeSessionManager.isConnected
const originalBridgeRequestRpc = bridgeSessionManager.requestRpc

const printer: Printer = {
  id: 'printer-1',
  name: 'Printer 1',
  host: 'printer.local',
  serial: 'SERIAL-1',
  accessCode: 'CODE',
  model: 'X1C',
  currentPlateType: 'Textured PEI Plate',
  currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
  position: 0,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z'
}

afterEach(() => {
  rootPrisma.printer.findUnique = originalPrinterFindUnique
  bridgeSessionManager.isConnected = originalBridgeIsConnected
  bridgeSessionManager.requestRpc = originalBridgeRequestRpc
  mock.restoreAll()
})

test('printer storage upload stores the file in the requested printer directory', async () => {
  rootPrisma.printer.findUnique = ((async () => ({ bridgeId: 'bridge-1' })) as unknown) as typeof rootPrisma.printer.findUnique
  bridgeSessionManager.isConnected = (() => true) as typeof bridgeSessionManager.isConnected
  bridgeSessionManager.requestRpc = (async (_bridgeId, method) => {
    assert.equal(method, 'storage.upload')
    return { path: '/cache/benchy.gcode.3mf' }
  }) as typeof bridgeSessionManager.requestRpc
  mock.method(printerManager, 'getPrinter', () => printer)

  await withPrintersApp(async (baseUrl) => {
    const form = new FormData()
    form.append('file', new Blob(['gcode payload']), 'benchy.gcode.3mf')

    const response = await fetch(`${baseUrl}/api/printers/${printer.id}/storage/upload?path=/cache`, {
      method: 'POST',
      body: form
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { path: '/cache/benchy.gcode.3mf' })
  })
})

async function withPrintersApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use((request, _response, next) => {
    request.tenant = TEST_TENANT
    request.auth = {
      authEnabled: false,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    }
    next()
  })
  app.use('/api/printers', printersRouter)
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