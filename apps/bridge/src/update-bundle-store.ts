/**
 * Signed Docker app-bundle staging and activation.
 *
 * The Docker bridge ships as ONE esbuild-bundled CJS file, so a release is a
 * single self-contained file: `<releases>/<fp12>/bridge.cjs` plus a
 * `manifest.json` copy of the release fragment (the launcher injects the
 * fragment's identity env from it). Bundles are published gzipped; the
 * manifest's `sha256`/`sizeBytes`/`signature` describe the DECOMPRESSED file
 * (same convention as the standalone binaries), so verification happens after
 * gunzip. No zip extraction, no node_modules symlink — the bundle carries
 * everything, which is what makes this revival safe where the old dist-tree
 * scheme was not.
 */
import { mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { BridgeBuild } from '@printstream/shared'
import { sha256Hex, verifyDetachedSha256Signature } from './update-signing.js'

export const BUNDLE_ENTRYPOINT_NAME = 'bridge.cjs'

/**
 * Verify + gunzip downloaded bundle bytes. Throws on any mismatch; returns the
 * decompressed bundle ready to stage.
 */
export function verifyBridgeBundleBytes(input: {
  release: BridgeBuild
  downloadedBytes: Buffer
  publicKeyPem: string | undefined
}): Buffer {
  const bundle = input.release.bundle
  if (!bundle) {
    throw new Error('Bridge release does not include an app bundle.')
  }
  const bytes = gunzipBundle(input.downloadedBytes)
  if (bundle.sizeBytes !== bytes.byteLength) {
    throw new Error('Bridge bundle size does not match the manifest.')
  }
  if (sha256Hex(bytes) !== bundle.sha256) {
    throw new Error('Bridge bundle checksum does not match the manifest.')
  }
  verifyDetachedSha256Signature({
    sha256: bundle.sha256,
    signature: bundle.signature,
    publicKeyPem: input.publicKeyPem,
    artifactName: 'Bridge app bundle'
  })
  return bytes
}

function gunzipBundle(bytes: Buffer): Buffer {
  // Gzip magic: 0x1f 0x8b. Accept an uncompressed bundle too so a manually
  // placed asset still verifies (the hash check catches any corruption).
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes)
  }
  return bytes
}

/** Stage a verified bundle under `.staging/<fp12>`; returns the staged dir. */
export async function stageBridgeBundle(input: {
  release: BridgeBuild
  verifiedBytes: Buffer
  releasesDir: string
}): Promise<string> {
  const shortFingerprint = input.release.sourceFingerprint.slice(0, 12)
  const stagingDir = path.join(input.releasesDir, '.staging', shortFingerprint)
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  await writeFile(path.join(stagingDir, BUNDLE_ENTRYPOINT_NAME), input.verifiedBytes)
  await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(input.release, null, 2) + '\n', 'utf8')
  return stagingDir
}

/**
 * Promote a staged bundle to the active release: move it into place, save the
 * current pointer as the rollback target, and write the new pointer with
 * `pendingHealthCheck: true` (the launcher rolls back to `previous.json` if
 * the new bundle dies before its first successful registration).
 */
export async function activateBridgeBundle(input: {
  releaseDirName: string
  releasesDir: string
  stagedDir: string
}): Promise<void> {
  const releaseDir = path.join(input.releasesDir, input.releaseDirName)
  await mkdir(input.releasesDir, { recursive: true })
  await rm(releaseDir, { recursive: true, force: true })
  await rename(input.stagedDir, releaseDir)

  const currentPath = path.join(input.releasesDir, 'current.json')
  const previousPath = path.join(input.releasesDir, 'previous.json')
  const existing = await readFile(currentPath, 'utf8').catch(() => null)
  if (existing) {
    await writeFile(previousPath, existing, 'utf8')
  }
  await writeFile(currentPath, JSON.stringify({
    releasePath: input.releaseDirName,
    entrypoint: BUNDLE_ENTRYPOINT_NAME,
    activatedAt: new Date().toISOString(),
    pendingHealthCheck: true
  }, null, 2) + '\n', 'utf8')
}
