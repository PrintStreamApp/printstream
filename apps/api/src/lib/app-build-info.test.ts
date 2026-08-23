import assert from 'node:assert/strict'
import { test } from 'node:test'
import { env } from './env.js'
import { getAppBuildInfo, resetAppBuildInfoCache, resolveAppVersionPayload, type AppBuildInfo } from './app-build-info.js'
import type { AppUpdateInfo } from '@printstream/shared'

test('the native binary revision env feeds the build identity when no metadata file exists', () => {
  // The native app has no Docker build ARGs to write app-build-metadata.json;
  // its host publishes the baked revision as env. Without this fallback the
  // native footer rendered nothing at all: update notice included.
  const previous = env.PRINTSTREAM_SERVER_BUILD_REVISION
  resetAppBuildInfoCache()
  env.PRINTSTREAM_SERVER_BUILD_REVISION = 'nativerev1234'
  try {
    const build = getAppBuildInfo()
    assert.equal(build.revision, 'nativerev1234')
    assert.equal(build.shortRevision, 'nativer')
    // `published` means the GHCR image channel specifically, never the native app.
    assert.equal(build.published, false)
  } finally {
    env.PRINTSTREAM_SERVER_BUILD_REVISION = previous
    resetAppBuildInfoCache()
  }
})

const PUBLISHED: AppBuildInfo = { revision: 'a'.repeat(40), shortRevision: 'aaaaaaa', published: true }
const CLOUD: AppBuildInfo = { revision: 'b'.repeat(40), shortRevision: 'bbbbbbb', published: false }
const DEV: AppBuildInfo = { revision: null, shortRevision: null, published: false }

const UPDATE: AppUpdateInfo = {
  status: 'updateAvailable',
  latestRevision: 'c'.repeat(40),
  latestShortRevision: 'ccccccc',
  checkedAt: '2026-06-16T00:00:00.000Z',
  imageRef: 'ghcr.io/printstreamapp/printstream:latest',
  downloadUrl: null
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

test('canApplyUpdate needs native + an available update + a platform binary', () => {
  const NATIVE: AppBuildInfo = { revision: 'd'.repeat(40), shortRevision: 'ddddddd', published: false }
  const nativeUpdate: AppUpdateInfo = {
    ...UPDATE,
    imageRef: null,
    downloadUrl: 'https://printstream.app/api/server-runtime/release-assets/x'
  }
  const payload = (update: AppUpdateInfo, canApplyUpdate: boolean, build = NATIVE, native = true) =>
    resolveAppVersionPayload({ build, isPlatformUser: false, update, native, canApplyUpdate }).canApplyUpdate

  assert.equal(payload(nativeUpdate, true), true)
  // The route's permission verdict is respected...
  assert.equal(payload(nativeUpdate, false), false)
  // ...but cannot force the button where nothing is applicable:
  assert.equal(payload({ ...nativeUpdate, downloadUrl: null }, true), false, 'no binary for this platform')
  assert.equal(payload({ ...nativeUpdate, status: 'updatesLapsed' }, true), false, 'a lapsed window is a renewal prompt, not a button')
  assert.equal(payload({ ...nativeUpdate, status: 'current' }, true), false)
  assert.equal(payload(UPDATE, true, PUBLISHED, false), false, 'the Docker image never applies itself in place')
})
