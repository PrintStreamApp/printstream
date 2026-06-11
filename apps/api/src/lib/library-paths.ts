/**
 * Library file path helpers.
 *
 * `LibraryFile.storedPath` rows are persisted as a basename (relative
 * to `LIBRARY_DIR`) so the project can be moved or renamed without
 * stranding the library. Older rows may still hold an absolute path
 * (the value `multer` produced at upload time); we keep them working
 * by falling back to `<LIBRARY_DIR>/<basename>` when the absolute
 * path no longer resolves on disk.
 */

import path from 'node:path'
import { stat } from 'node:fs/promises'
import { env } from './env.js'

export const libraryDir = path.resolve(env.LIBRARY_DIR)
export const publicDemoLibraryDir = path.resolve(env.PUBLIC_DEMO_BRIDGE_LIBRARY_DIR)

/** Resolve a stored path string to its expected on-disk location. */
export function resolveLibraryPath(storedPath: string): string {
  if (path.isAbsolute(storedPath)) return storedPath
  return path.join(libraryDir, storedPath)
}

/**
 * Locate the actual file on disk for a stored path, falling back to
 * `<libraryDir>/<basename>` when an absolute path no longer resolves
 * (e.g. project renamed since upload). Throws if neither exists.
 */
export async function locateLibraryFile(storedPath: string): Promise<string> {
  const candidates = [resolveLibraryPath(storedPath)]
  const baseName = path.basename(storedPath)
  const libraryFallback = path.join(libraryDir, baseName)
  if (!candidates.includes(libraryFallback)) {
    candidates.push(libraryFallback)
  }

  const demoFallback = path.join(publicDemoLibraryDir, baseName)
  if (!candidates.includes(demoFallback)) {
    candidates.push(demoFallback)
  }

  for (const candidate of candidates) {
    try {
      await stat(candidate)
      return candidate
    } catch {
      continue
    }
  }

  throw new Error('ENOENT')
}
