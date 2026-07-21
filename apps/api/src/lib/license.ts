/**
 * License key verification (core/public). Reads compact self-hosted license
 * tokens: `PSL1.<base64url(payload)>.<base64url(ed25519 signature)>`, validating
 * them against the embedded vendor public key so any build — including OSS — can
 * check a key but never mint one.
 *
 * **This module verifies only, deliberately.** The signing half lives in
 * `src/private/cloud/license-signing.ts`, which the public export strips, so no
 * shipped build carries working key-minting code. Do not add a signer here: an
 * export leak guard (`CLOUD_LEAK_PATTERNS`) fails the OSS snapshot on any
 * `license-signing` path outside `private/`, and re-exporting one from core
 * would hand every fork a two-line forgery recipe. The crypto would still hold
 * (a forged key needs the vendor private key), but the bar is the point.
 */
import crypto from 'node:crypto'
import { type LicensePayload, type LicenseStatus, licensePayloadSchema } from '@printstream/shared'

/**
 * Token format prefix. Public by construction (it is the first field of every
 * key); shared with the cloud signer so both halves agree on the signing input.
 */
export const LICENSE_TOKEN_PREFIX = 'PSL1'
const TOKEN_PREFIX = LICENSE_TOKEN_PREFIX

/**
 * Vendor license public key (production). Keys issued by the hosted service are
 * signed with the matching private key (`PRINTSTREAM_LICENSE_SIGNING_KEY`, a
 * cloud-only secret that never ships); embedding only the public half lets any
 * build — including OSS — validate a key but never forge one.
 */
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAASSkRDutYm4lun9jOAAaqHB++LHub6ChS5Zufa4LCMQ=
-----END PUBLIC KEY-----`

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

/**
 * Derive a public license status from a token string (null/absent/mis-signed →
 * invalid).
 *
 * `valid` folds in expiry: a correctly-signed but expired key reads
 * `valid: false, expired: true`, so a caller that checks only `valid` fails
 * closed. Lapsed *updates* are reported separately and never clear `valid` —
 * the addon buys newer builds and support, not the right to run.
 */
export function readLicenseStatus(token: string | null | undefined, nowSeconds = Math.floor(Date.now() / 1000)): LicenseStatus {
  const payload = token ? verifyLicenseToken(token) : null
  if (!payload) {
    return {
      edition: null,
      licensee: null,
      valid: false,
      expired: false,
      expiresAt: null,
      updatesExpired: false,
      updatesUntil: null,
      maxPrinters: null
    }
  }
  const expired = payload.expiresAt != null && payload.expiresAt < nowSeconds
  return {
    edition: payload.edition,
    licensee: payload.licensee,
    valid: !expired,
    expired,
    expiresAt: payload.expiresAt,
    updatesExpired: payload.updatesUntil != null && payload.updatesUntil < nowSeconds,
    updatesUntil: payload.updatesUntil,
    maxPrinters: payload.maxPrinters
  }
}
