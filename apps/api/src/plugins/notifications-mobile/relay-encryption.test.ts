import assert from 'node:assert/strict'
import {
  constants,
  createHash,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject
} from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import test from 'node:test'
import { encryptMobileRelayData, parseRelayEncryptionPublicKey } from './relay-encryption.js'

const bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function mgf1Sha1(seed: Buffer, length: number): Buffer {
  const output: Buffer[] = []
  let generated = 0
  for (let counter = 0; generated < length; counter += 1) {
    const encodedCounter = Buffer.alloc(4)
    encodedCounter.writeUInt32BE(counter)
    const chunk = createHash('sha1').update(seed).update(encodedCounter).digest()
    output.push(chunk)
    generated += chunk.byteLength
  }
  return Buffer.concat(output).subarray(0, length)
}

function xor(left: Buffer, right: Buffer): Buffer {
  return Buffer.from(left.map((value, index) => value ^ right[index]!))
}

/** Decode the Android-compatible OAEP profile independently of production code. */
function unwrapContentKey(encryptedKey: string, privateKey: KeyObject): Buffer {
  const encoded = privateDecrypt({
    key: privateKey,
    padding: constants.RSA_NO_PADDING
  }, Buffer.from(encryptedKey, 'base64url'))
  if (encoded[0] !== 0) throw new Error('Invalid OAEP prefix.')

  const maskedSeed = encoded.subarray(1, 33)
  const maskedDataBlock = encoded.subarray(33)
  const seed = xor(maskedSeed, mgf1Sha1(maskedDataBlock, maskedSeed.byteLength))
  const dataBlock = xor(maskedDataBlock, mgf1Sha1(seed, maskedDataBlock.byteLength))
  assert.deepEqual(dataBlock.subarray(0, 32), createHash('sha256').digest())
  const separator = dataBlock.indexOf(1, 32)
  if (separator < 0 || dataBlock.subarray(32, separator).some((value) => value !== 0)) {
    throw new Error('Invalid OAEP padding.')
  }
  return dataBlock.subarray(separator + 1)
}

test('relay notification content is readable only with the enrolled private key', () => {
  const enrolled = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKey = enrolled.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const source = {
    kind: 'notification', id: 'notification', bindingId, origin: 'https://self.example', scope: 'default', title: 'Ready',
    body: 'Print finished', level: 'info', tag: 'job', url: '/workspaces/default/printers',
    image: '', timestamp: new Date().toISOString()
  }

  const envelope = encryptMobileRelayData(source, publicKey)
  assert.equal(JSON.stringify(envelope).includes(source.title), false)
  assert.throws(() => unwrapContentKey(envelope.encryptedKey, other.privateKey))

  const contentKey = unwrapContentKey(envelope.encryptedKey, enrolled.privateKey)
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64url'))
  decipher.setAAD(Buffer.from('printstream-mobile-relay-v1'))
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'))
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final()
  ])

  assert.deepEqual(JSON.parse(inflateRawSync(compressed).toString()), source)
})

test('relay encrypts notification retractions with the same opaque envelope', () => {
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const source = {
    kind: 'dismiss', id: 'notification', bindingId,
    origin: 'https://self.example', tag: 'printer:p1:job'
  }

  const envelope = encryptMobileRelayData(source, publicKey)
  assert.equal(JSON.stringify(envelope).includes(source.tag), false)
  assert.equal(unwrapContentKey(envelope.encryptedKey, keyPair.privateKey).byteLength, 32)
})

test('relay enrollment rejects keys that are malformed or too weak', () => {
  assert.throws(() => parseRelayEncryptionPublicKey('not a key'))
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64')
  assert.throws(() => parseRelayEncryptionPublicKey(weak), /at least 2048 bits/)
})
