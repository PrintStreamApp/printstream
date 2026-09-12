/**
 * Hostile ZIP validation immediately before a project enters the native slicer.
 *
 * The API performs equivalent checks for prepared projects, but the slicer is its own security
 * boundary and must remain safe if another caller reaches it. Central-directory sizes are treated
 * only as an early refusal; every inflated byte is counted again while streaming.
 */
import yauzl, { type Entry } from 'yauzl'
import { openZip, readZipEntryBuffer } from './zip-io.js'

export interface SlicerInputArchiveLimits {
  maxEntries: number
  maxInflatedBytes: number
}

/** Reject oversized, path-ambiguous, or duplicate-entry archives without extracting them. */
export function validateSlicerInputArchive(
  filePath: string,
  limits: SlicerInputArchiveLimits
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: false }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Slice input is not a readable ZIP archive'))
        return
      }
      let settled = false
      let entryCount = 0
      let declaredBytes = 0
      let inflatedBytes = 0
      const names = new Set<string>()
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        zipFile.close()
        if (error) reject(error)
        else resolve()
      }

      zipFile.on('error', finish)
      zipFile.on('end', () => finish())
      zipFile.on('entry', (entry: Entry) => {
        entryCount += 1
        const normalizedName = entry.fileName
          .split('/')
          .filter((segment) => segment !== '.')
          .join('/')
          .toLowerCase()
        if (entryCount > limits.maxEntries) return finish(new Error('Slice input archive has too many entries'))
        if (names.has(normalizedName)) return finish(new Error('Slice input archive contains duplicate entry names'))
        names.add(normalizedName)

        declaredBytes += entry.uncompressedSize
        if (declaredBytes > limits.maxInflatedBytes) return finish(new Error('Slice input archive expands beyond the configured limit'))
        if (entry.fileName.endsWith('/')) {
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return finish(streamError ?? new Error('Could not read slice input entry'))
          stream.on('error', finish)
          stream.on('data', (chunk: Buffer) => {
            inflatedBytes += chunk.byteLength
            if (inflatedBytes > limits.maxInflatedBytes) {
              stream.destroy(new Error('Slice input archive expands beyond the configured limit'))
            }
          })
          stream.on('end', () => {
            if (!settled) zipFile.readEntry()
          })
        })
      })
      zipFile.readEntry()
    })
  })
}

/** Reject host-side scripts even when a caller bypasses the API's prepared-project validator. */
export async function assertNoSlicerHostScripts(filePath: string): Promise<void> {
  const zipFile = await openZip(filePath)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      zipFile.close()
      if (error) reject(error)
      else resolve()
    }
    zipFile.on('error', finish)
    zipFile.on('end', () => finish())
    zipFile.on('entry', (entry: Entry) => {
      if (entry.fileName !== 'Metadata/project_settings.config') {
        zipFile.readEntry()
        return
      }
      if (entry.uncompressedSize > 8 * 1024 * 1024) return finish(new Error('Project settings exceed the configured limit'))
      readZipEntryBuffer(zipFile, entry, 8 * 1024 * 1024).then((buffer) => {
        try {
          const parsed = JSON.parse(buffer.toString('utf8')) as { post_process?: unknown }
          const value = parsed.post_process
          const present = typeof value === 'string'
            ? value.trim().length > 0
            : Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim().length > 0)
          finish(present ? new Error('Post-processing scripts cannot run on this slicer service') : undefined)
        } catch {
          finish(new Error('Project settings are not valid JSON'))
        }
      }, (error) => finish(error instanceof Error ? error : new Error(String(error))))
    })
    zipFile.readEntry()
  })
}
