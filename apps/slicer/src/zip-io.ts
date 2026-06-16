/**
 * Slicer-local ZIP I/O helpers for reading 3MF (ZIP) archives with yauzl.
 *
 * `openZip` opens an archive in lazy-entry mode; `readZipEntryBuffer` drains a
 * single entry's read stream into a Buffer. Both the main slice pipeline
 * (`index.ts`) and the all-plate merge fallback (`all-plate-fallback.ts`) read
 * 3MF entries, so this is the single shared copy. Kept slicer-local on purpose:
 * the slicer is a separate workspace and must not import from `apps/api`.
 */
import yauzl, { type Entry, type ZipFile } from 'yauzl'

export async function openZip(filePath: string): Promise<ZipFile> {
  return await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error('Failed to open 3MF'))
      else resolve(zipFile)
    })
  })
}

export async function readZipEntryBuffer(zipFile: ZipFile, entry: Entry): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Failed to read ${entry.fileName}`))
        return
      }
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}
