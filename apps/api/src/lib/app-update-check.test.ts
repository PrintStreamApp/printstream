import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import {
  compareRevisions,
  fetchLatestRevisionFromRegistry,
  getAppUpdateInfo,
  resetAppUpdateCheckState
} from './app-update-check.js'

test('compareRevisions classifies the verdict', () => {
  assert.equal(compareRevisions('abc', 'abc'), 'current')
  assert.equal(compareRevisions('abc', 'def'), 'updateAvailable')
  assert.equal(compareRevisions(null, 'def'), 'unknown')
  assert.equal(compareRevisions('abc', null), 'unknown')
})

test('fetchLatestRevisionFromRegistry walks index -> manifest -> config label', async (t) => {
  t.after(() => mock.restoreAll())
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/token')) {
      return new Response(JSON.stringify({ token: 'anon-token' }), { status: 200 })
    }
    if (url.endsWith('/manifests/latest')) {
      return new Response(JSON.stringify({
        manifests: [
          { digest: 'sha256:attest', platform: { os: 'unknown', architecture: 'unknown' } },
          { digest: 'sha256:linux-amd64', platform: { os: 'linux', architecture: 'amd64' } }
        ]
      }), { status: 200 })
    }
    if (url.endsWith('/manifests/sha256:linux-amd64')) {
      return new Response(JSON.stringify({ config: { digest: 'sha256:config-blob' } }), { status: 200 })
    }
    if (url.endsWith('/blobs/sha256:config-blob')) {
      return new Response(JSON.stringify({
        config: { Labels: { 'org.opencontainers.image.revision': 'deadbeefcafe' } }
      }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const revision = await fetchLatestRevisionFromRegistry('printstreamapp/printstream')
  assert.equal(revision, 'deadbeefcafe')
})

test('getAppUpdateInfo returns null when the run is not the published image', () => {
  // The test process has no app-build-metadata.json, so published is false.
  resetAppUpdateCheckState()
  assert.equal(getAppUpdateInfo(), null)
})
