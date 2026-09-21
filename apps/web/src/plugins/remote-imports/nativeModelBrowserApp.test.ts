import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveNativeModelBrowserApp } from './nativeModelBrowserApp.js'

test('resolves the released Android store destination', () => {
  assert.equal(
    resolveNativeModelBrowserApp({ userAgent: 'Mozilla/5.0 (Linux; Android 16)' }).storeLabel,
    'Get it on Google Play'
  )
})

test('does not recommend an older Windows client or invent unpublished downloads', () => {
  assert.deepEqual(resolveNativeModelBrowserApp({ uaDataPlatform: 'Windows' }), {
    platformLabel: 'Windows',
    storeLabel: null,
    storeUrl: null
  })
  assert.deepEqual(resolveNativeModelBrowserApp({ uaDataPlatform: 'macOS' }), {
    platformLabel: 'macOS',
    storeLabel: null,
    storeUrl: null
  })
  assert.deepEqual(resolveNativeModelBrowserApp({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), {
    platformLabel: 'Linux',
    storeLabel: null,
    storeUrl: null
  })
})
