import assert from 'node:assert/strict'
import { test } from 'node:test'

// The env module captures process.env at first import, so set the key before the
// dynamic import below (this file runs in its own test process).
process.env.SECRETS_KEY = 'test-master-key'
const { encryptSecret, decryptSecret, isEncryptedSecret } = await import('./secret-encryption.js')

test('round-trips a secret and the ciphertext does not contain the plaintext', () => {
  const encrypted = encryptSecret('super-secret-value')
  assert.ok(isEncryptedSecret(encrypted))
  assert.ok(!encrypted.includes('super-secret-value'))
  assert.equal(decryptSecret(encrypted), 'super-secret-value')
})

test('two encryptions of the same plaintext differ (random IV)', () => {
  assert.notEqual(encryptSecret('same'), encryptSecret('same'))
})

test('legacy plaintext (no enc prefix) is returned unchanged on decrypt', () => {
  assert.equal(decryptSecret('plain-legacy-secret'), 'plain-legacy-secret')
})

test('a tampered ciphertext fails authentication', () => {
  const encrypted = encryptSecret('value')
  const tampered = encrypted.slice(0, -1) + (encrypted.endsWith('A') ? 'B' : 'A')
  assert.throws(() => decryptSecret(tampered))
})
