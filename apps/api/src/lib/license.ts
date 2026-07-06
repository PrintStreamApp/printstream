/**
 * License key cryptography (core/public). Signs and verifies compact self-hosted
 * license tokens: `PSL1.<base64url(payload)>.<base64url(ed25519 signature)>`.
 * Verification uses the embedded vendor public key so any build (including OSS)
 * can validate a key but never forge one. Signing takes a private key supplied by
 * the cloud issuer (`src/private/cloud/license-issuer.ts`) — it never ships.
 */
import crypto from 'node:crypto'
import { type LicensePayload, type LicenseStatus, licensePayloadSchema } from '@printstream/shared'

const TOKEN_PREFIX = 'PSL1'

/**
 * Vendor license public key (production). Keys issued by the hosted service are
 * signed with the matching private key (`PRINTSTREAM_LICENSE_SIGNING_KEY`, a
 * cloud-only secret that never ships); embedding only the public half lets any
 * build — including OSS — validate a key but never forge one.
 */
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAASSkRDutYm4lun9jOAAaqHB++LHub6ChS5Zufa4LCMQ=
-----END PUBLIC KEY-----`

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Sign a license payload with an Ed25519 private key (PEM / PKCS8), returning the token. */
export function signLicenseToken(payload: LicensePayload, privateKeyPem: string): string {
  const payloadPart = base64url(JSON.stringify(payload))
  const signingInput = `${TOKEN_PREFIX}.${payloadPart}`
  const signature = crypto.sign(null, Buffer.from(signingInput), crypto.createPrivateKey(privateKeyPem))
  return `${signingInput}.${base64url(signature)}`
}

/**
 * Verify a license token against a public key (defaults to the embedded vendor
 * key) and return the validated payload, or null when malformed / mis-signed.
 */
export function verifyLicenseToken(token: string, publicKeyPem: string = LICENSE_PUBLIC_KEY_PEM): LicensePayload | null {
  const parts = token.trim().split('.')
  const [prefix, payloadPart, signaturePart] = parts
  if (parts.length !== 3 || prefix !== TOKEN_PREFIX || !payloadPart || !signaturePart) return null
  try {
    const signatureOk = crypto.verify(
      null,
      Buffer.from(`${TOKEN_PREFIX}.${payloadPart}`),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signaturePart, 'base64url')
    )
    if (!signatureOk) return null
    return licensePayloadSchema.parse(JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

/** Derive a public license status from a token string (null/absent key → invalid). */
export function readLicenseStatus(token: string | null | undefined, nowSeconds = Math.floor(Date.now() / 1000)): LicenseStatus {
  const payload = token ? verifyLicenseToken(token) : null
  if (!payload) {
    return { edition: null, licensee: null, valid: false, updatesExpired: false, updatesUntil: null }
  }
  return {
    edition: payload.edition,
    licensee: payload.licensee,
    valid: true,
    updatesExpired: payload.updatesUntil != null && payload.updatesUntil < nowSeconds,
    updatesUntil: payload.updatesUntil
  }
}
