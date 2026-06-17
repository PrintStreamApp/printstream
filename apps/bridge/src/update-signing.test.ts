import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { resolveBridgeReleaseUrl, sha256Hex, verifyDetachedSha256Signature } from './update-signing.js'
import { OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY } from './update-trust.js'

test('resolveBridgeReleaseUrl accepts release assets from the configured cloud origin', () => {
  assert.equal(
    resolveBridgeReleaseUrl('https://printstream.example.com/releases/bridge.zip', 'https://printstream.example.com').href,
    'https://printstream.example.com/releases/bridge.zip'
  )
})

test('resolveBridgeReleaseUrl rejects release assets from other origins', () => {
  assert.throws(
    () => resolveBridgeReleaseUrl('https://cdn.example.com/releases/bridge.zip', 'https://printstream.example.com'),
    /origin is not trusted/
  )
})

test('verifyDetachedSha256Signature accepts a valid Ed25519 signature over the sha256 hex', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const sha256 = sha256Hex(Buffer.from('bridge artifact bytes'))
  const signature = sign(null, Buffer.from(sha256, 'utf8'), privateKey).toString('base64')

  assert.doesNotThrow(() => verifyDetachedSha256Signature({
    sha256,
    signature,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    artifactName: 'Bridge artifact'
  }))
})

test('verifyDetachedSha256Signature rejects a signature over different bytes', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, Buffer.from(sha256Hex(Buffer.from('original')), 'utf8'), privateKey).toString('base64')

  assert.throws(() => verifyDetachedSha256Signature({
    sha256: sha256Hex(Buffer.from('tampered')),
    signature,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    artifactName: 'Bridge artifact'
  }), /signature is invalid/)
})

test('official bridge update public key is a valid Ed25519 public key', () => {
  const key = createPublicKey(OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY)
  assert.equal(key.asymmetricKeyType, 'ed25519')
})
