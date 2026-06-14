/**
 * Shared scaffolding for the 3MF read/write modules.
 *
 * This is the dependency-free base of the three-mf family: low-level ZIP I/O
 * ({@link readEntry}, {@link readZipEntryBuffer}), abort-signal helpers, XML/regex
 * escaping, and the generic copy-with-transform pass {@link rewriteModelSettingsThreeMf}.
 * Everything here is mechanical (no 3MF domain knowledge) so the reader, scene-builder,
 * and output modules can share it without forming an import cycle. Dependencies flow
 * one way: output/scene-builder -> reader -> internal.
 *
 * A 3MF file is a ZIP; these helpers open, read, and re-stream entries.
 */
import { createWriteStream } from 'node:fs'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import yazl from 'yazl'

export function createAbortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}

/**
 * Read one entry from the archive into a `Buffer`. Throws if the entry
 * is missing or larger than `maxBytes` (default 8 MiB — enough for any
 * realistic plate thumbnail or slice-info XML).
 */
export function readEntry(
  filePath: string,
  entryPath: string,
  signal?: AbortSignal,
  maxBytes = 8 * 1024 * 1024
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open zip'))
        return
      }
      let resolved = false
      const onAbort = () => finish(createAbortError(), null)
      signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (error: Error | null, value: Buffer | null) => {
        if (resolved) return
        resolved = true
        signal?.removeEventListener('abort', onAbort)
        zipFile.close()
        if (error || !value) reject(error ?? new Error('Entry not found'))
        else resolve(value)
      }
      zipFile.on('error', (error) => finish(error, null))
      zipFile.on('end', () => finish(new Error(`Entry not found: ${entryPath}`), null))
      zipFile.on('entry', (entry: Entry) => {
        if (entry.fileName !== entryPath) {
          zipFile.readEntry()
          return
        }
        if (entry.uncompressedSize > maxBytes) {
          finish(new Error(`Entry too large: ${entryPath}`), null)
          return
        }
        readZipEntryBuffer(zipFile, entry, signal).then(
          (buffer) => finish(null, buffer),
          (error) => finish(error, null)
        )
      })
      zipFile.readEntry()
    })
  })
}

/**
 * Copies every archive entry verbatim except `Metadata/model_settings.config`, which is passed
 * through `transform`. Shared by the object-filter and per-object-override rewrites.
 */
export function rewriteModelSettingsThreeMf(
  sourcePath: string,
  outputPath: string,
  transform: (xml: string) => string
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true }, (openError, sourceZip) => {
      if (openError || !sourceZip) {
        reject(openError ?? new Error('Failed to open 3MF'))
        return
      }

      const outputZip = new yazl.ZipFile()
      const output = createWriteStream(outputPath)
      let settled = false

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        sourceZip.close()
        if (error) {
          output.destroy()
          reject(error)
        } else {
          resolve()
        }
      }

      outputZip.outputStream.pipe(output)
      outputZip.outputStream.on('error', finish)
      output.on('error', finish)
      output.on('finish', () => finish())

      sourceZip.on('error', finish)
      sourceZip.on('end', () => outputZip.end())
      sourceZip.on('entry', (entry: Entry) => {
        if (entry.fileName === 'Metadata/model_settings.config') {
          readZipEntryBuffer(sourceZip, entry).then(
            (buffer) => {
              outputZip.addBuffer(Buffer.from(transform(buffer.toString('utf8')), 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
              sourceZip.readEntry()
            },
            finish
          )
          return
        }
        if (entry.fileName.endsWith('/')) {
          outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
          sourceZip.readEntry()
          return
        }
        sourceZip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`Failed to read ${entry.fileName}`))
            return
          }
          stream.on('error', finish)
          stream.on('end', () => sourceZip.readEntry())
          outputZip.addReadStream(stream, entry.fileName, { mtime: entry.getLastModDate() })
        })
      })
      sourceZip.readEntry()
    })
  })
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function readZipEntryBuffer(zipFile: ZipFile, entry: Entry, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('Failed to open entry stream'))
        return
      }
      let settled = false
      const finish = (caught: Error | null, buffer?: Buffer) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (caught) reject(caught)
        else resolve(buffer ?? Buffer.alloc(0))
      }
      const onAbort = () => {
        stream.destroy(createAbortError())
        finish(createAbortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => finish(null, Buffer.concat(chunks)))
      stream.on('error', (caught) => finish(caught))
    })
  })
}
