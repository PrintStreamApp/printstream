import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBrowserEnv } from './browserEnv.js'

test('parseBrowserEnv defaults to empty api base url', () => {
  assert.deepEqual(parseBrowserEnv({}), {
    apiBaseUrl: '',
    devMode: false
  })
})

test('parseBrowserEnv preserves the configured api base url', () => {
  assert.equal(parseBrowserEnv({ VITE_API_BASE_URL: 'https://demo.example/api' }).apiBaseUrl, 'https://demo.example/api')
})

test('parseBrowserEnv detects development mode from Vite runtime flags', () => {
  assert.equal(parseBrowserEnv({ DEV: true }).devMode, true)
  assert.equal(parseBrowserEnv({ DEV: 'true' }).devMode, true)
  assert.equal(parseBrowserEnv({ MODE: 'development' }).devMode, true)
  assert.equal(parseBrowserEnv({ MODE: 'production' }).devMode, false)
})
