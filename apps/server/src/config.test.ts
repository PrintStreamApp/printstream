import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { resolveServerPaths } from './app-identity.js'
import { applyServerEnvDefaults } from './config.js'

/**
 * `applyServerEnvDefaults` mutates the global `process.env`, so snapshot it and
 * fully restore (including keys it adds) after every test.
 */
let envSnapshot: NodeJS.ProcessEnv

beforeEach(() => {
  envSnapshot = { ...process.env }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
  Object.assign(process.env, envSnapshot)
  mock.restoreAll()
})

test('the native build always enables embedded Postgres', () => {
  delete process.env.EMBEDDED_POSTGRES
  applyServerEnvDefaults(resolveServerPaths())
  assert.equal(process.env.EMBEDDED_POSTGRES, 'true')
})

test('a now-unsupported EMBEDDED_POSTGRES opt-out is overridden to true with a warning', () => {
  const warn = mock.method(console, 'warn', () => undefined)
  for (const optOut of ['false', '0', 'no', 'FALSE']) {
    process.env.EMBEDDED_POSTGRES = optOut
    applyServerEnvDefaults(resolveServerPaths())
    assert.equal(process.env.EMBEDDED_POSTGRES, 'true', `expected '${optOut}' to be forced on`)
  }
  assert.equal(warn.mock.calls.length, 4)
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /no longer supported/i)
})

test('only the database is forced — other operator-set vars are preserved', () => {
  process.env.API_PORT = '9999'
  process.env.LIBRARY_DIR = '/custom/library'
  applyServerEnvDefaults(resolveServerPaths())
  assert.equal(process.env.API_PORT, '9999')
  assert.equal(process.env.LIBRARY_DIR, '/custom/library')
})
