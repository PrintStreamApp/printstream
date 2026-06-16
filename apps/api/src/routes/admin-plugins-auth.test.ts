process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { PLUGINS_MANAGE_PERMISSION } from '@printstream/shared'
import { adminPluginsRouter } from './admin-plugins.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { pluginRegistry } from '../plugin/registry.js'
import { HttpError } from '../lib/http-error.js'

afterEach(() => {
  pluginRegistry.list = originalList
})

const originalList = pluginRegistry.list.bind(pluginRegistry)

test('admin plugin routes still require authentication when platform auth is enforced', async () => {
  pluginRegistry.list = () => []

  await withAdminPluginsApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('admin plugin routes require authentication once auth is enabled', async () => {
  pluginRegistry.list = () => []

  await withAdminPluginsApp({
    authEnabled: true,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`)

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Authentication required.' })
  })
})

test('admin plugin routes return 403 when the actor lacks plugin management permission', async () => {
  pluginRegistry.list = () => []

  await withAdminPluginsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  })
})

test('admin plugin routes allow actors with plugin management permission', async () => {
  pluginRegistry.list = () => []

  await withAdminPluginsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PLUGINS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { plugins: [] })
  })
})

test('admin plugin routes reject tenant-context requests even for platform admins', async () => {
  pluginRegistry.list = () => []

  await withAdminPluginsApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [PLUGINS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`)

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'Switch to the platform workspace to manage plugin installation and tenant availability.' })
  }, {
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }
  })
})

async function withAdminPluginsApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>,
  input: {
    tenant?: { id: string; slug: string; name: string } | null
  } = {}
): Promise<void> {
  const app = express()
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = input.tenant ?? null
    next()
  })
  app.use(adminPluginsRouter)
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