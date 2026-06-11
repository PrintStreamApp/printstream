process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { CAMERA_VIEW_PERMISSION } from '@printstream/shared'
import { cameraRouter } from './camera.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

const p = prisma as unknown as Record<string, Record<string, unknown>>
// Auto-restore the prisma/rootPrisma methods these tests override (was a per-method save/restore block).
restorePrismaMethodsAfterEach([
  [p.printer, 'findUnique']
])

afterEach(() => {
  mock.restoreAll()
})

test('camera snapshot requires authentication once auth is enabled', async () => {
  await withCameraApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/camera/printer-1/snapshot`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('camera stream returns 403 without camera.view permission', async () => {
  await withCameraApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/camera/printer-1/stream`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('camera snapshot reaches the handler for actors with camera.view permission', async () => {
  prisma.printer.findUnique = ((async () => ({
    id: 'printer-1',
    name: 'Printer 1',
    host: 'printer.local',
    serial: 'SERIAL-1',
    accessCode: 'CODE',
    model: 'NO_CAMERA_MODEL',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: JSON.stringify([{ extruderId: 0, diameter: '0.4' }]),
    position: 0,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z')
  } as never)) as unknown) as typeof prisma.printer.findUnique

  await withCameraApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [CAMERA_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/camera/printer-1/snapshot`)

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'Camera not supported for model NO_CAMERA_MODEL' })
  })
})

async function withCameraApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express()
  app.use((request, _response, next) => {
    request.auth = auth
    next()
  })
  app.use('/api/camera', cameraRouter)
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