import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { AddressInfo } from 'node:net'
import { createRateLimitMiddleware } from './rate-limit.js'

test('rate limiter returns 429 with retry metadata after the window budget is exhausted', async () => {
  let now = 1_000
  const app = express()
  app.use(createRateLimitMiddleware({ name: 'test', windowMs: 10_000, max: 2, now: () => now }))
  app.get('/limited', (_request, response) => response.json({ ok: true }))

  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/limited`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/limited`)).status, 200)

    const limited = await fetch(`${baseUrl}/limited`)
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '10')
    assert.deepEqual(await limited.json(), { error: 'Too many requests. Try again later.' })

    now += 10_001
    assert.equal((await fetch(`${baseUrl}/limited`)).status, 200)
  })
})

test('rate limiter advertises the remaining budget on every response', async () => {
  const app = express()
  app.use(createRateLimitMiddleware({ name: 'budget', windowMs: 10_000, max: 3 }))
  app.get('/limited', (_request, response) => response.json({ ok: true }))

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/limited`)
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('ratelimit-limit'), '3')
    assert.equal(first.headers.get('ratelimit-remaining'), '2')
    assert.ok(Number(first.headers.get('ratelimit-reset')) >= 1)

    await fetch(`${baseUrl}/limited`)
    await fetch(`${baseUrl}/limited`)
    const limited = await fetch(`${baseUrl}/limited`)
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('ratelimit-remaining'), '0')
  })
})

test('stacked rate limiters keep the most restrictive budget headers', async () => {
  const app = express()
  // Tighter limiter first: the looser one running later must not overwrite it.
  app.use(createRateLimitMiddleware({ name: 'tight', windowMs: 10_000, max: 2 }))
  app.use(createRateLimitMiddleware({ name: 'loose', windowMs: 10_000, max: 100 }))
  app.get('/limited', (_request, response) => response.json({ ok: true }))

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/limited`)
    assert.equal(response.headers.get('ratelimit-limit'), '2')
    assert.equal(response.headers.get('ratelimit-remaining'), '1')
  })
})

test('rate limiter separates authenticated actors from anonymous IP buckets', async () => {
  const app = express()
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const userId = request.header('x-test-user-id')
    if (userId) {
      request.auth = {
        authEnabled: true,
        actor: { type: 'user', userId },
        permissions: [],
        runtimePolicy: { demoMode: false }
      }
    }
    next()
  })
  app.use(createRateLimitMiddleware({ name: 'test-actors', windowMs: 10_000, max: 1 }))
  app.get('/limited', (_request, response) => response.json({ ok: true }))

  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/limited`, { headers: { 'x-test-user-id': 'user-1' } })).status, 200)
    assert.equal((await fetch(`${baseUrl}/limited`, { headers: { 'x-test-user-id': 'user-2' } })).status, 200)
    assert.equal((await fetch(`${baseUrl}/limited`, { headers: { 'x-test-user-id': 'user-1' } })).status, 429)
  })
})

async function withServer(app: express.Express, callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0)
  try {
    const address = server.address() as AddressInfo
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}