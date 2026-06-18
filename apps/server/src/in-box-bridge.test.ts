import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { ensureProvisionToken, isManagedBridgeEnabled } from './in-box-bridge.js'

const original = process.env.MANAGED_BRIDGE
afterEach(() => {
  if (original === undefined) delete process.env.MANAGED_BRIDGE
  else process.env.MANAGED_BRIDGE = original
})

test('isManagedBridgeEnabled reads the MANAGED_BRIDGE flag', () => {
  process.env.MANAGED_BRIDGE = 'true'
  assert.equal(isManagedBridgeEnabled(), true)
  process.env.MANAGED_BRIDGE = 'false'
  assert.equal(isManagedBridgeEnabled(), false)
  delete process.env.MANAGED_BRIDGE
  assert.equal(isManagedBridgeEnabled(), false)
})

test('ensureProvisionToken creates a token once and is idempotent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-token-'))
  try {
    const file = path.join(dir, 'sub', 'managed-bridge-token')
    ensureProvisionToken(file)
    const first = readFileSync(file, 'utf8')
    assert.ok(first.length >= 32, 'token should be a long random string')
    // POSIX: created owner-only.
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600)
    }
    ensureProvisionToken(file)
    assert.equal(readFileSync(file, 'utf8'), first, 'an existing token is preserved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
