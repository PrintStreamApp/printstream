process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { PRINTERS_VIEW_PERMISSION } from '@printstream/shared'
import { printerViewsRouter } from './printer-views.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

const p = prisma as unknown as Record<string, Record<string, unknown>>
// Auto-restore the prisma/rootPrisma methods these tests override (was a per-method save/restore block).
restorePrismaMethodsAfterEach([
  [p.printerView, 'findMany']
])

afterEach(() => {
})

test('printer views require authentication once auth is enabled', async () => {
  await withPrinterViewsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printer-views`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('printer views list allows actors with printers.view permission', async () => {
  prisma.printerView.findMany = ((async () => []) as unknown) as typeof prisma.printerView.findMany

  await withPrinterViewsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PRINTERS_VIEW_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printer-views`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { views: [] })
  })
})

test('printer view creation returns 403 without printers.view permission', async () => {
  await withPrinterViewsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/printer-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'My view',
        printerIds: [],
        cardsPerRow: 2,
        stateFilter: 'all',
        sort: { key: 'name', direction: 'asc' },
        cardContentSettings: {}
      })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

async function withPrinterViewsApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    next()
  })
  app.use('/api/printer-views', printerViewsRouter)
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