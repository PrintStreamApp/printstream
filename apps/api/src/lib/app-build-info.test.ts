import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAppVersionPayload, type AppBuildInfo } from './app-build-info.js'
import type { AppUpdateInfo } from '@printstream/shared'

const PUBLISHED: AppBuildInfo = { revision: 'a'.repeat(40), shortRevision: 'aaaaaaa', published: true }
const CLOUD: AppBuildInfo = { revision: 'b'.repeat(40), shortRevision: 'bbbbbbb', published: false }
const DEV: AppBuildInfo = { revision: null, shortRevision: null, published: false }

const UPDATE: AppUpdateInfo = {
  status: 'updateAvailable',
  latestRevision: 'c'.repeat(40),
  latestShortRevision: 'ccccccc',
  checkedAt: '2026-06-16T00:00:00.000Z',
  imageRef: 'ghcr.io/printstreamapp/printstream:latest'
}

test('published image shows the build and update to everyone', () => {
  const anon = resolveAppVersionPayload({ build: PUBLISHED, isPlatformUser: false, update: UPDATE })
  assert.equal(anon.revision, PUBLISHED.revision)
  assert.equal(anon.shortRevision, 'aaaaaaa')
  assert.equal(anon.published, true)
  assert.deepEqual(anon.update, UPDATE)
})

test('cloud image shows the build only to platform users and never an update hint', () => {
  const admin = resolveAppVersionPayload({ build: CLOUD, isPlatformUser: true, update: UPDATE })
  assert.equal(admin.revision, CLOUD.revision)
  assert.equal(admin.published, false)
  // No update channel for the non-published image even if one was passed.
  assert.equal(admin.update, null)

  const member = resolveAppVersionPayload({ build: CLOUD, isPlatformUser: false, update: UPDATE })
  assert.equal(member.revision, null)
  assert.equal(member.shortRevision, null)
  assert.equal(member.update, null)
})

test('source/dev run with no baked revision shows nothing', () => {
  const result = resolveAppVersionPayload({ build: DEV, isPlatformUser: true, update: null })
  assert.equal(result.revision, null)
  assert.equal(result.published, false)
  assert.equal(result.update, null)
})
