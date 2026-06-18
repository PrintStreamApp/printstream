/**
 * SEA packaging helpers. Thin wrapper over `node:sea` so the rest of the server
 * entry never touches the API directly and stays runnable from plain compiled
 * sources in dev (where `isSeaPackaged()` is false and asset lookups return null).
 */
import { getAsset, isSea } from 'node:sea'

export function isSeaPackaged(): boolean {
  try {
    return isSea()
  } catch {
    return false
  }
}

/** Returns an embedded SEA asset as a Buffer, or null when not packaged. */
export function getSeaAssetBuffer(key: string): Buffer | null {
  if (!isSeaPackaged()) return null
  try {
    return Buffer.from(getAsset(key))
  } catch {
    return null
  }
}

/**
 * Returns the byte length of an embedded SEA asset without materializing it, or
 * null when not packaged / absent. `getAsset` hands back an ArrayBuffer view
 * over the executable's blob, so `.byteLength` is O(1) — cheap enough to read
 * for every asset on each boot to detect a changed binary.
 */
export function getSeaAssetByteLength(key: string): number | null {
  if (!isSeaPackaged()) return null
  try {
    return getAsset(key).byteLength
  } catch {
    return null
  }
}
