/**
 * Resolves bridge update bundle assets published beside release manifest
 * fragments. Only zip files directly under the configured release directory are
 * served so release URLs cannot read arbitrary API container files.
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { badRequest, notFound } from './http-error.js'

export async function resolveBridgeReleaseAssetPath(input: {
  releasesDir: string
  fileName: string
}): Promise<string> {
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(input.fileName)) {
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
  return resolvedPath
}