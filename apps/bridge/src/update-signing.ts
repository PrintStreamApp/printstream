/**
 * Signed bridge release-asset primitives shared across packagings.
 *
 * Resolves a same-origin download URL for a release asset; the signature
 * scheme itself (an Ed25519 signature over the artifact's sha256 hex) lives in
 * `@printstream/sea-runtime` so the self-hosted server app verifies the exact
 * same way, and is re-exported here for the bridge's consumers. Nothing here
 * stages or activates anything on disk.
 */
export { sha256Hex, verifyDetachedSha256Signature } from '@printstream/sea-runtime'

export function resolveBridgeReleaseUrl(bundleUrl: string, cloudUrl: string): URL {
  const releaseUrl = new URL(bundleUrl)
  const allowedOrigin = new URL(cloudUrl).origin

  if (releaseUrl.origin !== allowedOrigin) {
    throw new Error('Bridge release bundle origin is not trusted.')
  }
  return releaseUrl
}
