import assert from 'node:assert/strict'
import { test } from 'node:test'

// No SECRETS_KEY: encryption must be a safe pass-through (dev / single-box default).
// Set before the dynamic import; this file runs in its own test process.
delete process.env.SECRETS_KEY
const { encryptSecret, decryptSecret, isEncryptedSecret } = await import('./secret-encryption.js')

test('encryptSecret is a pass-through when SECRETS_KEY is unset', () => {
  const out = encryptSecret('value')
  assert.equal(out, 'value')
  assert.ok(!isEncryptedSecret(out))
})

test('decryptSecret returns plaintext unchanged when SECRETS_KEY is unset', () => {
  assert.equal(decryptSecret('plain'), 'plain')
})

test('decrypting an encrypted value without a key throws instead of garbling', () => {
  assert.throws(() => decryptSecret('enc:1:aaaa:bbbb:cccc'), /SECRETS_KEY is not set/)
})
