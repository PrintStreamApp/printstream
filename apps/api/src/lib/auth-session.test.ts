process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveRequestAuthFromSession } from './auth-session.js'
import { createAnonymousAuthContext } from './auth-context.js'
import express from 'express'
import { setCookieHeader } from './auth-session.js'

test('setCookieHeader omits Secure for plain HTTP requests', async () => {
  const app = express()
  app.get('/cookie', (_request, response) => {
    setCookieHeader(response, 'printstream_auth', 'secret', 60)
    response.status(204).end()
  })

  const server = await app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address.')

    const response = await fetch(`http://127.0.0.1:${address.port}/cookie`)
    const setCookie = response.headers.get('set-cookie') ?? ''

    assert.match(setCookie, /printstream_auth=secret/)
    assert.doesNotMatch(setCookie, /; Secure/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('setCookieHeader adds Secure for proxied HTTPS requests', async () => {
  const app = express()
  app.set('trust proxy', true)
  app.get('/cookie', (_request, response) => {
    setCookieHeader(response, 'printstream_auth', 'secret', 60)
    response.status(204).end()
  })

  const server = await app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address.')

    const response = await fetch(`http://127.0.0.1:${address.port}/cookie`, {
      headers: { 'X-Forwarded-Proto': 'https' }
    })
    const setCookie = response.headers.get('set-cookie') ?? ''

    assert.match(setCookie, /printstream_auth=secret/)
    assert.match(setCookie, /; Secure/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('resolveRequestAuthFromSession grants permissions for a single-tenant user before a tenant cookie exists', async () => {
  const prisma = {
    authSession: {
      findUnique: async () => ({
        id: 'session-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        lastSeenAt: new Date(),
        user: {
          id: 'user-1',
          isPlatformUser: false,
          tenantMemberships: [
            {
              loginDisabled: false,
              tenant: {
                id: 'tenant-1',
                slug: 'alpha',
                name: 'Alpha'
              }
            }
          ],
          memberships: [
            {
              group: {
                tenantId: 'tenant-1',
                permissions: ['printers.view']
              }
            }
          ]
        },
        serviceAccount: null
      }),
      updateMany: async () => ({ count: 0 })
    },
    authServiceAccount: {
      updateMany: async () => ({ count: 0 })
    },
    authUserGroupMembership: {
      findMany: async () => []
    },
    setting: {
      findMany: async () => []
    }
  }

  const request = {
    headers: {
      cookie: 'printstream_auth=secret'
    }
  } as never

  const auth = await resolveRequestAuthFromSession(
    prisma as never,
    request,
    createAnonymousAuthContext({ demoMode: false, authEnabled: true })
  )

  assert.equal(auth.actor.type, 'user')
  if (auth.actor.type !== 'user') {
    throw new Error('Expected a signed-in user actor.')
  }
  assert.equal(auth.actor.tenant?.id, 'tenant-1')
  assert.deepEqual(auth.permissions, ['printers.view'])
})