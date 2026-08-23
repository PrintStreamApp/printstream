/**
 * Unpack a zip to a directory.
 *
 * Its own module because the slicing engine's Windows archive is ~6,700 entries
 * and 1.7 GB unpacked, which rules out the read-it-all-into-memory shape used
 * elsewhere for small assets: entries are streamed one at a time.
 *
 * Not shared with `sea-assets.ts`, which extracts the SEA's own embedded zips
 * from a Buffer already in memory. Same library, genuinely different input.
 */
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'

/**
 * Extract `zipPath` into `destination`, creating it.
 *
 * Entry paths are resolved against the destination and rejected if they escape
 * it. The archive comes from a checksum-pinned download, so a traversal entry
 * would mean the pin was already defeated, but an extractor that writes outside
 * its target on request is the wrong thing to have in the tree regardless.
 */
export function extractZip(zipPath: string, destination: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error(`Could not open ${path.basename(zipPath)}`))
        return
      }
      void extractEntries(zipFile, destination).then(resolve, reject)
    })
  })
}

function extractEntries(zipFile: ZipFile, destination: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zipFile.close()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    zipFile.on('error', fail)
    zipFile.on('end', resolve)
    zipFile.on('entry', (entry: Entry) => {
      const target = path.join(destination, entry.fileName)
      const relative = path.relative(destination, target)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        fail(new Error(`Refusing to extract outside the target directory: ${entry.fileName}`))
        return
      }

      // Directory entries are named with a trailing slash by the spec.
      if (entry.fileName.endsWith('/')) {
        mkdir(target, { recursive: true }).then(() => zipFile.readEntry(), fail)
        return
      }

      zipFile.openReadStream(entry, (streamError, readStream) => {
        if (streamError || !readStream) {
          fail(streamError ?? new Error(`Could not read ${entry.fileName}`))
          return
        }
        mkdir(path.dirname(target), { recursive: true })
          .then(() => pipeline(readStream, createWriteStream(target)))
          .then(() => zipFile.readEntry(), fail)
      })
    })

    zipFile.readEntry()
  })
}
