/**
 * At-rest encryption for sensitive settings (e.g. OAuth client secrets) stored in
 * the plain `Setting` key/value table.
 *
 * Uses AES-256-GCM with a key derived (SHA-256) from the `SECRETS_KEY` env var, so
 * any non-empty string is a valid key. Ciphertext is stored as a self-describing
 * string: `enc:1:<iv>:<tag>:<ciphertext>` (each part base64). Values without that
 * prefix are treated as legacy plaintext and returned unchanged, so existing rows
 * keep working and are transparently re-encrypted the next time they are written.
 *
 * When `SECRETS_KEY` is unset (common in dev / single-box self-hosting), encryption
 * is a no-op pass-through and a one-time warning is logged — the security posture is
 * unchanged from before this module existed, but production should set the key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from './env.js'

const ENC_PREFIX = 'enc:1:'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

let warnedMissingKey = false

/** Derives a stable 32-byte AES key from the configured `SECRETS_KEY`, or null when unset. */
function resolveKey(): Buffer | null {
  const raw = env.SECRETS_KEY
  if (!raw) return null
  return createHash('sha256').update(raw, 'utf8').digest()
}

/** True when this value was produced by `encryptSecret` with a key configured. */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENC_PREFIX)
}

/**
 * Encrypts a secret for storage. Returns an `enc:1:...` string when `SECRETS_KEY`
 * is set, otherwise returns the plaintext unchanged (logging a one-time warning).
 */
export function encryptSecret(plaintext: string): string {
  const key = resolveKey()
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true
      console.warn('[secrets] SECRETS_KEY is not set; storing sensitive settings unencrypted. Set SECRETS_KEY in production.')
    }
    return plaintext
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

/**
 * Decrypts a stored secret. Legacy plaintext (no `enc:` prefix) is returned as-is.
 * Throws if an encrypted value is encountered without a usable `SECRETS_KEY`, or if
 * authentication fails (tampering / wrong key) — callers should treat that as a
 * configuration error rather than silently dropping the secret.
 */
export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) return stored

  const key = resolveKey()
  if (!key) {
    throw new Error('A stored secret is encrypted but SECRETS_KEY is not set; cannot decrypt.')
  }

  const parts = stored.slice(ENC_PREFIX.length).split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret.')
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string]
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ctB64, 'base64')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
