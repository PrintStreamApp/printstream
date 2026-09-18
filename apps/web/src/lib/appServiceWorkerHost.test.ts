import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldManageAppServiceWorker } from './appServiceWorkerHost.js'

test('only a production browser/PWA manages the app service worker', () => {
  assert.equal(shouldManageAppServiceWorker({ devMode: false, nativeAndroid: false }), true)
  assert.equal(shouldManageAppServiceWorker({ devMode: true, nativeAndroid: false }), false)
  assert.equal(shouldManageAppServiceWorker({ devMode: false, nativeAndroid: true }), false)
  assert.equal(shouldManageAppServiceWorker({ devMode: true, nativeAndroid: true }), false)
})
