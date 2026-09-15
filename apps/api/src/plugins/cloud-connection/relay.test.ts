/** Privacy contract for the self-hosted cloud-support relay. */
process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import type { LicenseStatus, SelfHostedSupportContext } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { withEphemeralServer } from '../../test-utils/http-test-server.js'
import {
  registerCloudSuggestionRelay,
  registerCloudSupportRelay,
  type CloudSupportRelayDependencies
} from './relay.js'

const CONTEXT: SelfHostedSupportContext = {
  workspaceId: 'local-workspace',
  workspaceName: 'Workshop',
  appVersion: 'build-123',
  userAgent: 'test-agent'
}

function status(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    edition: 'commercial',
    licensee: 'Test Customer',
    valid: true,
    expired: false,
    expiresAt: null,
    updatesExpired: false,
    updatesUntil: 2_000_000_000,
    maxPrinters: null,
    metered: false,
    ...overrides
  }
}

async function withRelay(
  dependencies: CloudSupportRelayDependencies,
  run: (baseUrl: string) => Promise<void>,
  auth: RequestAuthContext = {
    authEnabled: true,
    actor: { type: 'user', userId: 'local-user' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  }
): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = auth
    request.workspace = { id: 'local-workspace', slug: 'workshop', name: 'Workshop' }
    next()
  })
  const router = express.Router()
  registerCloudSupportRelay(router, {
    getInstallationId: async () => 'installation-secret',
    resolveContext: async () => CONTEXT,
    resolveOrigin: () => 'https://cloud.example.test',
    ...dependencies
  })
  app.use('/api/plugins/cloud-connection', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })
  await withEphemeralServer(app, run)
}

test('unlicensed and community installs make zero vendor requests', async (t) => {
  for (const example of [
    { name: 'unlicensed', key: null, licenseStatus: status({ valid: false, edition: null }) },
    { name: 'community', key: 'community-key', licenseStatus: status({ edition: 'community' }) }
  ]) {
    await t.test(example.name, async () => {
      let vendorRequests = 0
      await withRelay({
        getLicenseKey: async () => example.key,
        getLicenseStatus: async () => example.licenseStatus,
        fetch: async () => {
          vendorRequests += 1
          return new Response('{}')
        }
      }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/plugins/cloud-connection/support/conversations`)
        assert.equal(response.status, 403)
      })
      assert.equal(vendorRequests, 0)
    })
  }
})

test('an eligible request is relayed with install credentials outside the browser payload', async () => {
  const upstream = { url: '', headers: new Headers() }
  await withRelay({
    getLicenseKey: async () => 'commercial-key',
    getLicenseStatus: async () => status(),
    fetch: async (input, init) => {
      upstream.url = String(input)
      upstream.headers = new Headers(init?.headers)
      return new Response(JSON.stringify({ conversations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/plugins/cloud-connection/support/conversations?workspace=workshop&status=open`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { conversations: [] })
  })

  assert.equal(upstream.url, 'https://cloud.example.test/api/self-hosted/support/conversations?status=open')
  assert.equal(upstream.headers.get('x-printstream-license-key'), 'commercial-key')
  assert.equal(upstream.headers.get('x-printstream-installation-id'), 'installation-secret')
  const encodedContext = upstream.headers.get('x-printstream-support-context')
  assert.ok(encodedContext)
  assert.deepEqual(JSON.parse(Buffer.from(encodedContext, 'base64url').toString('utf8')), CONTEXT)
})

test('an auth-disabled install relays support as its implicit administrator', async () => {
  let encodedContext: string | null = null
  await withRelay({
    getLicenseKey: async () => 'commercial-key',
    getLicenseStatus: async () => status(),
    resolveContext: undefined,
    fetch: async (_input, init) => {
      encodedContext = new Headers(init?.headers).get('x-printstream-support-context')
      return new Response(JSON.stringify({ conversations: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/plugins/cloud-connection/support/conversations`)
    assert.equal(response.status, 200)
  }, {
    authEnabled: false,
    actor: { type: 'anonymous' },
    permissions: [],
    runtimePolicy: { demoMode: false }
  })

  assert.ok(encodedContext)
  const context = JSON.parse(Buffer.from(encodedContext, 'base64url').toString('utf8')) as SelfHostedSupportContext
  assert.equal('userName' in context, false)
  assert.equal('userEmail' in context, false)
  assert.equal(context.workspaceId, 'local-workspace')
  assert.equal(context.workspaceName, 'Workshop')
})

test('anonymous actors cannot relay when authentication or public-demo policy is active', async (t) => {
  const examples: Array<{ name: string; auth: RequestAuthContext }> = [
    {
      name: 'authentication enabled',
      auth: {
        authEnabled: true,
        actor: { type: 'anonymous' },
        permissions: [],
        runtimePolicy: { demoMode: false }
      }
    },
    {
      name: 'public demo guest',
      auth: {
        authEnabled: false,
        publicDemoGuest: true,
        actor: { type: 'anonymous' },
        permissions: [],
        runtimePolicy: { demoMode: true }
      }
    },
    {
      name: 'service account',
      auth: {
        authEnabled: true,
        actor: { type: 'service-account', serviceAccountId: 'automation' },
        permissions: [],
        runtimePolicy: { demoMode: false }
      }
    }
  ]

  for (const example of examples) {
    await t.test(example.name, async () => {
      let vendorRequests = 0
      await withRelay({
        getLicenseKey: async () => 'commercial-key',
        getLicenseStatus: async () => status(),
        fetch: async () => {
          vendorRequests += 1
          return new Response('{}')
        }
      }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/plugins/cloud-connection/support/conversations`)
        assert.equal(response.status, 401)
      }, example.auth)
      assert.equal(vendorRequests, 0)
    })
  }
})

test('auth-disabled suggestions relay with Customer credentials but no local support context', async () => {
  const upstream = { url: '', headers: new Headers(), body: '' }
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    }
    next()
  })
  const router = express.Router()
  registerCloudSuggestionRelay(router, {
    getLicenseKey: async () => 'commercial-key',
    getLicenseStatus: async () => status(),
    getInstallationId: async () => 'installation-secret',
    resolveContext: async () => { throw new Error('suggestions must not resolve local context') },
    resolveOrigin: () => 'https://cloud.example.test',
    fetch: async (input, init) => {
      upstream.url = String(input)
      upstream.headers = new Headers(init?.headers)
      upstream.body = String(init?.body)
      return new Response(JSON.stringify({ suggestion: { id: 'suggestion-1' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      })
    }
  })
  app.use('/api/plugins/cloud-connection', router)

  await withEphemeralServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/plugins/cloud-connection/suggestions?workspace=workshop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Customer suggestion' })
    })
    assert.equal(response.status, 201)
  })

  assert.equal(upstream.url, 'https://cloud.example.test/api/self-hosted/suggestions/')
  assert.equal(upstream.headers.get('x-printstream-license-key'), 'commercial-key')
  assert.equal(upstream.headers.get('x-printstream-installation-id'), 'installation-secret')
  assert.equal(upstream.headers.get('x-printstream-support-context'), null)
  assert.equal(upstream.body, JSON.stringify({ title: 'Customer suggestion' }))
})

test('decoded upstream bodies are not framed with the encoded content length', async () => {
  await withRelay({
    getLicenseKey: async () => 'commercial-key',
    getLicenseStatus: async () => status(),
    fetch: async () => new Response('decoded response body', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'content-length': '4'
      }
    })
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/plugins/cloud-connection/support/conversations`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), null)
    assert.equal(await response.text(), 'decoded response body')
  })
})
