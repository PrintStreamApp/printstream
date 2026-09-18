import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { withEphemeralServer } from '../test-utils/http-test-server.js'
import {
  buildMobileDiscoveryResponse,
  createMobileDiscoveryRouter
} from './mobile-discovery.js'

const dependencies = {
  deployment: () => 'self-hosted' as const,
  serverVersion: () => '1.0.6',
  notificationTransport: () => 'relay' as const
}

test('mobile discovery collapses native packaging into self-hosted', () => {
  const response = buildMobileDiscoveryResponse('https://self-hosted.example/', {
    ...dependencies,
    deployment: () => 'native'
  })
  assert.equal(response.deployment, 'selfHosted')
})

test('well-known mobile discovery is uncacheable and exposes no actor state', async () => {
  const app = express()
  app.set('trust proxy', true)
  app.use('/.well-known', createMobileDiscoveryRouter(dependencies))
  await withEphemeralServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/.well-known/printstream-mobile.json`, {
      headers: {
        'x-forwarded-proto': 'https'
      }
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      product: 'printstream',
      protocolVersion: 1,
      nativeNavigationVersion: 1,
      canonicalOrigin: `https://${new URL(baseUrl).host}`,
      deployment: 'selfHosted',
      serverVersion: '1.0.6',
      nativeNotifications: { transport: 'relay' }
    })
  })
})
