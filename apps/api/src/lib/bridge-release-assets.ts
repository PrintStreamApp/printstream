/**
 * Resolves bridge update assets published beside release manifest fragments.
 * Only update bundles (.zip) and standalone bridge binaries directly under the
 * configured release directory are served, so release URLs cannot read
 * arbitrary API container files (manifest fragments themselves stay private).
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { badRequest, notFound } from './http-error.js'

export interface BridgeReleaseAsset {
  filePath: string
  contentType: 'application/zip' | 'application/octet-stream'
}

export async function resolveBridgeReleaseAsset(input: {
  releasesDir: string
  fileName: string
}): Promise<BridgeReleaseAsset> {
  if (!isServableBridgeReleaseAssetName(input.fileName)) {
    throw badRequest('Bridge release asset name is invalid.')
  }

  const releasesDir = path.resolve(input.releasesDir)
  const resolvedPath = path.resolve(releasesDir, input.fileName)
  if (resolvedPath !== path.join(releasesDir, input.fileName)) {
    throw badRequest('Bridge release asset name is invalid.')
  }

  const info = await stat(resolvedPath).catch(() => null)
  if (!info?.isFile()) {
    throw notFound('Bridge release asset was not found.')
  }
  return {
    filePath: resolvedPath,
    contentType: input.fileName.endsWith('.zip') ? 'application/zip' : 'application/octet-stream'
  }
}

export function isServableBridgeReleaseAssetName(fileName: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName)) return false
  // Release JSON fragments live in the same directory but are not assets.
  if (fileName.endsWith('.json')) return false
  return true
}
