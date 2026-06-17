/**
 * Signed bridge release-asset primitives shared across packagings.
 *
 * Resolves a same-origin download URL for a release asset and verifies the
 * release signing scheme (an Ed25519 signature over the artifact's sha256 hex).
 * The standalone (SEA) self-updater uses these to download and verify its own
 * binary; the Docker bridge updates by image pull and has no self-update, so
 * nothing here stages or activates anything on disk.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

export function resolveBridgeReleaseUrl(bundleUrl: string, cloudUrl: string): URL {
  const releaseUrl = new URL(bundleUrl)
  const allowedOrigin = new URL(cloudUrl).origin

  if (releaseUrl.origin !== allowedOrigin) {
    throw new Error('Bridge release bundle origin is not trusted.')
  }
  return releaseUrl
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Verifies the release signing scheme shared by app bundles and standalone
 * binaries: an Ed25519 signature over the artifact's sha256 hex string.
 */
export function verifyDetachedSha256Signature(input: {
  sha256: string
  signature: string
  publicKeyPem: string | undefined
  artifactName: string
}): void {
  if (!input.publicKeyPem) {
    throw new Error('Bridge update public key is not configured.')
  }
  const publicKey = createPublicKey(input.publicKeyPem)
  const ok = verify(
    null,
    Buffer.from(input.sha256, 'utf8'),
    publicKey,
    Buffer.from(input.signature, 'base64')
  )
  if (!ok) {
    throw new Error(`${input.artifactName} signature is invalid.`)
  }
}
