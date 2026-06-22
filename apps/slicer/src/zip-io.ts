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

/** Read a single named entry from a 3MF (ZIP) file on disk as UTF-8 text. Rejects if absent. */
export async function readZipEntryText(filePath: string, entryName: string): Promise<string> {
  const zipFile = await openZip(filePath)
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      zipFile.close()
      if (error) reject(error)
      else resolve(value ?? '')
    }
    zipFile.on('error', finish)
    zipFile.on('end', () => finish(new Error(`Entry not found: ${entryName}`)))
    zipFile.on('entry', (entry: Entry) => {
      if (entry.fileName !== entryName) {
        zipFile.readEntry()
        return
      }
      readZipEntryBuffer(zipFile, entry).then(
        (buffer) => finish(undefined, buffer.toString('utf8')),
        (error) => finish(error instanceof Error ? error : new Error(String(error)))
      )
    })
    zipFile.readEntry()
  })
}
