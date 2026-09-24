/**
 * Encrypts self-hosted notification data for one Android Keystore key.
 *
 * The cloud relay receives only the device binding and this hybrid RSA/AES
 * envelope. Plaintext validation happens before encryption and again after
 * device decryption; malformed or oversized envelopes fail closed.
 */
import {
  constants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes
} from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import {
  mobileRelayDataSchema,
  mobileRelayEncryptedDataSchema,
  type MobileRelayEncryptedData
} from '@printstream/shared'

const AAD = Buffer.from('printstream-mobile-relay-v1')
const MAX_COMPRESSED_BYTES = 2200
const OAEP_HASH_BYTES = 32

/** Expand one seed with MGF1-SHA1, Android Keystore's portable OAEP mask profile. */
function mgf1Sha1(seed: Buffer, length: number): Buffer {
  const chunks: Buffer[] = []
  let generated = 0
  for (let counter = 0; generated < length; counter += 1) {
    const encodedCounter = Buffer.alloc(4)
    encodedCounter.writeUInt32BE(counter)
    const chunk = createHash('sha1').update(seed).update(encodedCounter).digest()
    chunks.push(chunk)
    generated += chunk.byteLength
  }
  return Buffer.concat(chunks).subarray(0, length)
}

function xor(left: Buffer, right: Buffer): Buffer {
  if (left.byteLength !== right.byteLength) throw new Error('Relay encryption mask length mismatch.')
  return Buffer.from(left.map((value, index) => value ^ right[index]!))
}

/**
 * Wrap an AES key with OAEP SHA-256 and MGF1-SHA1.
 *
 * Android Keystore used MGF1-SHA1 exclusively before API 35. Node's OAEP helper
 * cannot select the MGF digest separately, so the standards-defined encoding is
 * assembled here before the raw RSA public operation. SHA-1 is used only as the
 * OAEP mask generator, not for integrity or content hashing.
 */
function wrapContentKey(contentKey: Buffer, encodedPublicKey: string): Buffer {
  const key = parseRelayEncryptionPublicKey(encodedPublicKey)
  const modulusBytes = Math.ceil((key.asymmetricKeyDetails?.modulusLength ?? 0) / 8)
  if (contentKey.byteLength > modulusBytes - (2 * OAEP_HASH_BYTES) - 2) {
    throw new Error('Relay content key is too large for the enrolled public key.')
  }

  const labelHash = createHash('sha256').digest()
  const padding = Buffer.alloc(modulusBytes - contentKey.byteLength - (2 * OAEP_HASH_BYTES) - 2)
  const dataBlock = Buffer.concat([labelHash, padding, Buffer.from([1]), contentKey])
  const seed = randomBytes(OAEP_HASH_BYTES)
  const maskedDataBlock = xor(dataBlock, mgf1Sha1(seed, dataBlock.byteLength))
  const maskedSeed = xor(seed, mgf1Sha1(maskedDataBlock, seed.byteLength))
  const encoded = Buffer.concat([Buffer.from([0]), maskedSeed, maskedDataBlock])

  return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, encoded)
}

/** Validate a device key early so a broken enrollment is never persisted. */
export function parseRelayEncryptionPublicKey(encoded: string) {
  const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('Relay encryption requires an RSA key of at least 2048 bits.')
  }
  return key
}

/** Encrypt one validated native notification without exposing its content to the relay. */
export function encryptMobileRelayData(
  input: Record<string, string>,
  encodedPublicKey: string
): MobileRelayEncryptedData {
  const data = mobileRelayDataSchema.parse(input)
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(data)), { level: 9 })
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error('Native notification is too large for encrypted Firebase delivery.')
  }

  const contentKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()])
  const encryptedKey = wrapContentKey(contentKey, encodedPublicKey)

  return mobileRelayEncryptedDataSchema.parse({
    kind: 'relay-message',
    version: '1',
    bindingId: data.bindingId,
    encryptedKey: encryptedKey.toString('base64url'),
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url')
  })
}
