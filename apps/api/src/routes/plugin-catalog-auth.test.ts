process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { pluginCatalogRouter } from './plugin-catalog.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { pluginRegistry } from '../plugin/registry.js'
import { HttpError } from '../lib/http-error.js'

const originalListCatalog = pluginRegistry.listCatalog.bind(pluginRegistry)
const originalSetTenantEnabled = pluginRegistry.setTenantEnabled.bind(pluginRegistry)

afterEach(() => {
  pluginRegistry.listCatalog = originalListCatalog
  pluginRegistry.setTenantEnabled = originalSetTenantEnabled
})

test('plugin catalog stays accessible while auth is disabled', async () => {
  pluginRegistry.listCatalog = () => []

  await withPluginCatalogApp({
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { plugins: [] })
  })
})

test('plugin catalog requires authentication once auth is enabled', async () => {
  pluginRegistry.listCatalog = () => []

  await withPluginCatalogApp({
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

test('tenant plugin toggles require settings.manage permission', async () => {
  pluginRegistry.setTenantEnabled = (async () => {
    throw new Error('should not be called')
  }) as typeof pluginRegistry.setTenantEnabled

  await withPluginCatalogApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/orders/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'You do not have permission to perform this action.' })
  }, {
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }
  })
})

test('tenant plugin toggles reject platform-workspace requests', async () => {
  pluginRegistry.setTenantEnabled = (async () => {
    throw new Error('should not be called')
  }) as typeof pluginRegistry.setTenantEnabled

  await withPluginCatalogApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/orders/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'Switch to a tenant workspace to manage plugins for this workspace.' })
  })
})

test('tenant settings managers can toggle workspace plugins', async () => {
  let call: { name: string; tenantId: string; enabled: boolean } | null = null
  pluginRegistry.setTenantEnabled = (async (name, tenantId, enabled) => {
    call = { name, tenantId, enabled }
    return {
      name,
      source: 'builtin',
      installed: true,
      enabled,
      platformEnabled: null,
      runtimeSurfaces: ['tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'controlled',
      availableInCurrentContext: true
    }
  }) as typeof pluginRegistry.setTenantEnabled

  await withPluginCatalogApp({
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    permissions: [SETTINGS_MANAGE_PERMISSION],
    runtimePolicy: { demoMode: false }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/orders/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      plugin: {
        name: 'orders',
        source: 'builtin',
        installed: true,
        enabled: false,
        platformEnabled: null,
        runtimeSurfaces: ['tenant'],
        managerSurfaces: ['platform', 'tenant'],
        tenantAccess: 'controlled',
        availableInCurrentContext: true
      }
    })
  }, {
    tenant: { id: 'tenant-1', slug: 'tenant-1', name: 'Tenant 1' }
  })

  assert.deepEqual(call, { name: 'orders', tenantId: 'tenant-1', enabled: false })
})

function withPluginCatalogApp(
  auth: RequestAuthContext,
  run: (baseUrl: string) => Promise<void>,
  input: {
    tenant?: { id: string; slug: string; name: string } | null
  } = {}
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.tenant = input.tenant ?? null
    next()
  })
  app.use(pluginCatalogRouter)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  return withServer(app, run)
}

function withServer(app: express.Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      const address = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${address.port}`
      try {
        await run(baseUrl)
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      } catch (error) {
        server.close(() => reject(error))
      }
    }) as Server
  })
}