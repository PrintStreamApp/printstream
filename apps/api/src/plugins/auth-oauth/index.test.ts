import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { WsEvent } from '@printstream/shared'
import type { RegisteredAuthProvider } from '../../lib/auth-registry.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { prisma } from '../../lib/prisma.js'
import { installTenantContext } from '../../lib/tenant-context.js'
import { createAuthOauthPlugin } from './index.js'

test('auth-oauth authorize redirects to the provider authorization endpoint with PKCE state cookies', async () => {
  const router = express.Router()
  const registeredProvider: { current: RegisteredAuthProvider | null } = { current: null }
  const plugin = createAuthOauthPlugin({
    async ensureDefaultGroups() {},
    fetch: (async () => new Response(JSON.stringify({
        authorization_endpoint: 'https://issuer.example/authorize',
        token_endpoint: 'https://issuer.example/token',
        userinfo_endpoint: 'https://issuer.example/userinfo'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })) as unknown as typeof fetch
  })

  await plugin.register({
    pluginName: 'auth-oauth',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {} as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        switch (key) {
          case 'platform:enabled': return 'true'
          case 'platform:displayName': return 'Work SSO'
          case 'platform:issuerUrl': return 'https://issuer.example'
          case 'platform:clientId': return 'client-123'
          case 'platform:clientSecret': return 'secret-xyz'
          case 'platform:scopes': return JSON.stringify(['openid', 'profile', 'email'])
          case 'displayName': return 'Work SSO'
          case 'issuerUrl': return 'https://issuer.example'
          case 'clientId': return 'client-123'
          case 'clientSecret': return 'secret-xyz'
          case 'scopes': return JSON.stringify(['openid', 'profile', 'email'])
          default: return null
        }
      },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider(provider) {
      void Promise.resolve(typeof provider === 'function' ? provider() : provider)
        .then((resolved) => {
          registeredProvider.current = resolved
        })
      return () => undefined
    }
  })

  const app = express()
  app.set('trust proxy', true)
  app.use('/api/plugins/auth-oauth', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/auth-oauth/authorize?redirectTo=%2Fprinters`, {
      redirect: 'manual',
      headers: { Host: `127.0.0.1:${address.port}` }
    })

    assert.ok(registeredProvider.current)
    assert.equal(registeredProvider.current.id, 'auth-oauth')
    assert.equal(registeredProvider.current.setupRequired, true)
    assert.equal(response.status, 302)
    const location = response.headers.get('location')
    assert.ok(location)
    assert.match(location ?? '', /^https:\/\/issuer\.example\/authorize\?/)
    assert.match(location ?? '', /client_id=client-123/)
    assert.match(location ?? '', /redirect_uri=/)
    assert.match(location ?? '', /code_challenge_method=S256/)
    const cookies = response.headers.get('set-cookie') ?? ''
    assert.match(cookies, /printstream_oauth_state=/)
    assert.match(cookies, /printstream_oauth_verifier=/)
    assert.match(cookies, /printstream_oauth_redirect=%2Fprinters/)
  } finally {
    await close(server)
  }
})

test('auth-oauth provider metadata clears setupRequired once the workspace setup is complete', async () => {
  const router = express.Router()
  let registeredProvider: { id: string; setupRequired: boolean } | null = null
  const plugin = createAuthOauthPlugin({
    async ensureDefaultGroups() {},
    fetch: globalThis.fetch.bind(globalThis)
  })

  await plugin.register({
    pluginName: 'auth-oauth',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {} as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        switch (key) {
          case 'platform:enabled': return 'true'
          case 'platform:setupComplete': return 'true'
          case 'platform:displayName': return 'Work SSO'
          case 'platform:issuerUrl': return 'https://issuer.example'
          case 'platform:clientId': return 'client-123'
          case 'platform:clientSecret': return 'secret-xyz'
          case 'platform:scopes': return JSON.stringify(['openid', 'profile', 'email'])
          default: return null
        }
      },
      async set() {},
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider(provider) {
      void Promise.resolve(typeof provider === 'function' ? provider() : provider)
        .then((resolved) => {
          registeredProvider = { id: resolved.id, setupRequired: resolved.setupRequired }
        })
      return () => undefined
    }
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(registeredProvider, {
    id: 'auth-oauth',
    setupRequired: false
  })
})

test('auth-oauth config reads and writes tenant-scoped settings independently from platform settings', async () => {
  const router = express.Router()
  const originalTenantFindUnique = prisma.tenant.findUnique
  const reads: string[] = []
  const writes: Array<{ key: string; value: string }> = []

  prisma.tenant.findUnique = ((async (input: { where: { slug?: string } }) => {
    if (input.where.slug === 'alpha') {
      return { id: 'tenant-1', slug: 'alpha', name: 'Alpha' }
    }
    return null
  }) as unknown) as typeof prisma.tenant.findUnique

  const plugin = createAuthOauthPlugin({
    async ensureDefaultGroups() {},
    fetch: globalThis.fetch.bind(globalThis)
  })

  await plugin.register({
    pluginName: 'auth-oauth',
    logger: { info() {}, warn() {}, error() {} },
    prisma: {} as never,
    printerEvents: new PrinterEventBus(),
    ws: { broadcast(_event: WsEvent) {} } as never,
    router,
    settings: {
      async get(key) {
        reads.push(key)
        switch (key) {
          case 'tenant:tenant-1:displayName': return 'Tenant SSO'
          case 'tenant:tenant-1:issuerUrl': return 'https://tenant-issuer.example'
          case 'tenant:tenant-1:clientId': return 'tenant-client'
          case 'tenant:tenant-1:clientSecret': return 'tenant-secret'
          case 'tenant:tenant-1:scopes': return JSON.stringify(['openid', 'email'])
          case 'displayName': return 'Legacy Platform SSO'
          default: return null
        }
      },
      async set(key, value) {
        writes.push({ key, value })
      },
      async delete() {},
      forTenant() { return this },
    },
    onShutdown() {},
    registerPrintGuard() { return () => undefined },
    registerAuthProvider() { return () => undefined }
  })

  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: true,
      actor: { type: 'user', userId: 'user-1' },
      permissions: ['auth.providers.manage'],
      runtimePolicy: { demoMode: false }
    }
    next()
  })
  app.use(installTenantContext())
  app.use('/api/plugins/auth-oauth', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await listen(app)
  const address = server.address() as AddressInfo
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/api/plugins/auth-oauth/config`
    const headers = {
      'Content-Type': 'application/json',
      'x-printstream-tenant': 'alpha'
    }

    const getResponse = await fetch(baseUrl, { headers })
    assert.equal(getResponse.status, 200)
    assert.deepEqual(await getResponse.json(), {
      configured: true,
      displayName: 'Tenant SSO',
      issuerUrl: 'https://tenant-issuer.example',
      clientId: 'tenant-client',
      clientSecretConfigured: true,
      scopes: ['openid', 'email']
    })
    assert.equal(reads.includes('displayName'), false)

    const putResponse = await fetch(baseUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        displayName: 'Updated Tenant SSO',
        issuerUrl: 'https://tenant-issuer-2.example',
        clientId: 'tenant-client-2',
        clientSecret: 'tenant-secret-2',
        scopes: ['openid', 'profile', 'email']
      })
    })

    assert.equal(putResponse.status, 200)
    assert.deepEqual(
      writes.map((entry) => entry.key),
      [
        'tenant:tenant-1:displayName',
        'tenant:tenant-1:issuerUrl',
        'tenant:tenant-1:clientId',
        'tenant:tenant-1:clientSecret',
        'tenant:tenant-1:scopes'
      ]
    )
  } finally {
    prisma.tenant.findUnique = originalTenantFindUnique
    await close(server)
  }
})

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