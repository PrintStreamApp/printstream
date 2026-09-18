import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { withEphemeralServer } from '../test-utils/http-test-server.js'
import { createAndroidAssetLinksRouter } from './android-asset-links.js'
import { buildAndroidAssetLinks } from '../lib/android-passkeys.js'

test('well-known asset links are public JSON with bounded caching', async () => {
  const statements = buildAndroidAssetLinks(['AA:BB'], ['app.printstream'])
  const app = express()
  app.use('/.well-known', createAndroidAssetLinksRouter({ statements: () => statements }))

  await withEphemeralServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/.well-known/assetlinks.json`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300')
    assert.deepEqual(await response.json(), statements)
    assert.ok(statements[0]?.relation.includes('delegate_permission/common.handle_all_urls'))
  })
})
