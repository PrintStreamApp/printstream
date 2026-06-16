process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { env } from './env.js'
import { bridgeUnavailableMessage, ensureManagedBridgeToken, isManagedBridgeMode, managedBridgeSecretMatches } from './managed-bridge.js'

const originalManagedBridge = env.MANAGED_BRIDGE
const originalTokenFile = env.MANAGED_BRIDGE_TOKEN_FILE
let tokenDir: string | null = null

function useTokenFile(seed?: string): string {
  tokenDir = mkdtempSync(path.join(tmpdir(), 'managed-bridge-'))
  const file = path.join(tokenDir, 'token')
  if (seed !== undefined) writeFileSync(file, seed)
  env.MANAGED_BRIDGE_TOKEN_FILE = file
  return file
}

afterEach(() => {
  env.MANAGED_BRIDGE = originalManagedBridge
  env.MANAGED_BRIDGE_TOKEN_FILE = originalTokenFile
  if (tokenDir) {
    rmSync(tokenDir, { recursive: true, force: true })
    tokenDir = null
  }
})

test('managedBridgeSecretMatches accepts an exact match', () => {
  assert.equal(managedBridgeSecretMatches('a-long-shared-token', 'a-long-shared-token'), true)
})

test('managedBridgeSecretMatches rejects a mismatch', () => {
  assert.equal(managedBridgeSecretMatches('a-long-shared-token', 'a-different-token'), false)
})

test('managedBridgeSecretMatches rejects differing lengths without throwing', () => {
  assert.equal(managedBridgeSecretMatches('short', 'a-much-longer-token-value'), false)
})

test('managedBridgeSecretMatches rejects when no token is configured', () => {
  assert.equal(managedBridgeSecretMatches('anything', null), false)
  assert.equal(managedBridgeSecretMatches('anything', undefined), false)
  assert.equal(managedBridgeSecretMatches('anything', ''), false)
})

test('isManagedBridgeMode reflects the MANAGED_BRIDGE flag', () => {
  env.MANAGED_BRIDGE = false
  assert.equal(isManagedBridgeMode(), false)
  env.MANAGED_BRIDGE = true
  assert.equal(isManagedBridgeMode(), true)
})

test('ensureManagedBridgeToken returns null when managed mode is off', () => {
  env.MANAGED_BRIDGE = false
  useTokenFile()
  assert.equal(ensureManagedBridgeToken(), null)
})

test('ensureManagedBridgeToken generates and persists a token on first use', () => {
  env.MANAGED_BRIDGE = true
  const file = useTokenFile()
  const token = ensureManagedBridgeToken()
  assert.ok(token && token.length >= 32)
  assert.equal(readFileSync(file, 'utf8'), token)
  // A second call returns the same persisted token, not a fresh one.
  assert.equal(ensureManagedBridgeToken(), token)
})

test('ensureManagedBridgeToken reuses an existing token file', () => {
  env.MANAGED_BRIDGE = true
  useTokenFile('preexisting-token-value')
  assert.equal(ensureManagedBridgeToken(), 'preexisting-token-value')
})

test('bridgeUnavailableMessage uses the caller fallback outside managed mode', () => {
  env.MANAGED_BRIDGE = false
  assert.equal(bridgeUnavailableMessage(), 'Bridge is not connected')
  assert.equal(bridgeUnavailableMessage('Selected bridge is not connected.'), 'Selected bridge is not connected.')
})

test('bridgeUnavailableMessage speaks of an internal service in managed mode', () => {
  env.MANAGED_BRIDGE = true
  const message = bridgeUnavailableMessage('Selected bridge is not connected.')
  assert.match(message, /printer connection service is offline/)
  assert.doesNotMatch(message, /bridge/i)
})
