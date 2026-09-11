/**
 * Shared scaffolding for the 3MF read/write modules.
 *
 * This is the dependency-free base of the three-mf family: low-level ZIP I/O
 * ({@link readEntry}, {@link readZipEntryBuffer}), abort-signal helpers, XML/regex
 * escaping, and the generic copy-with-transform pass {@link rewriteThreeMfEntries}.
 * Everything here is mechanical (no 3MF domain knowledge) so the reader, scene-builder,
 * and output modules can share it without forming an import cycle. Dependencies flow
 * one way: output/scene-builder -> reader -> internal.
 *
 * A 3MF file is a ZIP; these helpers open, read, and re-stream entries.
 */
import { createWriteStream } from 'node:fs'
import { createAbortError, throwIfAborted } from '@printstream/shared'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import yazl from 'yazl'

// The XML-write primitives moved to `@printstream/shared/three-mf` when the bake became
// dual-surface (api ZIP I/O + browser ZIP I/O over one implementation). Re-exported here so api
// call sites keep importing them from the three-mf family, exactly as the reader re-exports the
// shared parsers.
export { escapeRegExp, escapeXmlAttribute } from '@printstream/shared/three-mf'

/**
 * Read one entry from the archive into a `Buffer`. Throws if the entry
 * is missing or larger than `maxBytes` (default 8 MiB: enough for any
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
      const onAbort = () => finish(createAbortError('Aborted'), null)
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
        readZipEntryBuffer(zipFile, entry, signal, maxBytes).then(
          (buffer) => finish(null, buffer),
          (error) => finish(error, null)
        )
      })
      zipFile.readEntry()
    })
  })
}

/**
 * Fully walk an untrusted ZIP under both structural and inflated-size limits.
 *
 * Central-directory sizes are attacker-controlled, so the aggregate is checked once from metadata
 * and again against bytes actually emitted by every inflate stream. Prepared slicing calls this
 * before it treats a browser archive as an engine-ready authority.
 */
export function validateZipArchiveLimits(
  filePath: string,
  options: { maxEntries: number; maxUncompressedBytes: number }
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: false }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open zip'))
        return
      }
      let settled = false
      let entryCount = 0
      let declaredBytes = 0
      let inflatedBytes = 0
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
        declaredBytes += entry.uncompressedSize
        if (entryCount > options.maxEntries) {
          finish(new Error('Archive has too many entries'))
          return
        }
        if (declaredBytes > options.maxUncompressedBytes) {
          finish(new Error('Archive expands beyond the allowed size'))
          return
        }
        if (entry.fileName.endsWith('/')) {
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error('Failed to open entry stream'))
            return
          }
          stream.on('error', finish)
          stream.on('data', (chunk: Buffer) => {
            inflatedBytes += chunk.length
            if (inflatedBytes > options.maxUncompressedBytes) {
              stream.destroy(new Error('Archive expands beyond the allowed size'))
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

/**
 * Stream one entry's UTF-8 text through `onChunk` without ever holding the whole thing.
 *
 * The counterpart to {@link readEntry} for entries too big to buffer: a sliced plate's G-code is
 * routinely hundreds of megabytes decompressed, so a consumer that only scans forward (the pause
 * scan in `print-pause-schedule-scan.ts`) must not pay for a `Buffer.concat` of it.
 *
 * Resolves `false` when the archive has no such entry, rather than throwing, because "this file
 * does not contain that plate" is an ordinary answer for callers probing a hint. Chunks are split
 * on decoder boundaries, never on line boundaries; the consumer owns its own line buffering.
 *
 * `maxBytes` is checked BOTH against the entry's declared size and as a running total of what the
 * inflate actually produces, exactly as {@link readZipEntryBuffer} does: the central directory is
 * attacker-controlled and can under-declare `uncompressedSize`, so the declared check alone would
 * let a zip bomb through. Streaming does not make that guard unnecessary; it only changes the
 * resource being spent from memory to time.
 */
export function streamEntryText(
  filePath: string,
  entryPath: string,
  onChunk: (text: string) => void,
  options: { signal?: AbortSignal; maxBytes?: number } = {}
): Promise<boolean> {
  const { signal, maxBytes = Number.POSITIVE_INFINITY } = options
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open zip'))
        return
      }
      let settled = false
      const onAbort = () => finish(createAbortError('Aborted'), false)
      const finish = (error: Error | null, found: boolean) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        zipFile.close()
        if (error) reject(error)
        else resolve(found)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      zipFile.on('error', (error) => finish(error, false))
      zipFile.on('end', () => finish(null, false))
      zipFile.on('entry', (entry: Entry) => {
        if (entry.fileName !== entryPath) {
          zipFile.readEntry()
          return
        }
        if (entry.uncompressedSize > maxBytes) {
          finish(new Error(`Entry too large: ${entryPath}`), false)
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error('Failed to open entry stream'), false)
            return
          }
          stream.setEncoding('utf8')
          let received = 0
          stream.on('data', (chunk: string) => {
            // Byte length, not string length: the declared size this is defending against is in
            // bytes, and a multi-byte character would otherwise undercount against the cap.
            received += Buffer.byteLength(chunk, 'utf8')
            if (received > maxBytes) {
              stream.destroy()
              finish(new Error('Entry exceeds the maximum decoded size'), false)
              return
            }
            try {
              onChunk(chunk)
            } catch (error) {
              stream.destroy()
              finish(error as Error, false)
            }
          })
          stream.on('end', () => finish(null, true))
          stream.on('error', (error: Error) => finish(error, false))
        })
      })
      zipFile.readEntry()
    })
  })
}

/**
 * Copies every archive entry verbatim except those named in `transforms`, each of which is read as
 * UTF-8 text and passed through its transform. Generalizes the single-entry rewrite so one copy pass
 * can edit several entries at once (e.g. `Metadata/model_settings.config` AND `3D/3dmodel.model` for
 * slice-time object customization). An empty `transforms` map produces a verbatim copy.
 * `appendEntries` are added after the copy pass, but ONLY the ones the source did not already
 * contain (a transform still wins for an existing entry): use it to upsert an entry that may be
 * absent, e.g. `project_settings.config` on a settings-less new-project scaffold.
 */
export function rewriteThreeMfEntries(
  sourcePath: string,
  outputPath: string,
  transforms: Record<string, (xml: string) => string>,
  appendEntries: Array<{ name: string; content: string }> = []
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

      // A 3MF reader rejects archives with duplicate entry names, so track what the copy
      // pass wrote and only append the entries the source did not already contain.
      const writtenNames = new Set<string>()
      sourceZip.on('error', finish)
      sourceZip.on('end', () => {
        for (const extra of appendEntries) {
          if (writtenNames.has(extra.name)) continue
          writtenNames.add(extra.name)
          outputZip.addBuffer(Buffer.from(extra.content, 'utf8'), extra.name)
        }
        outputZip.end()
      })
      sourceZip.on('entry', (entry: Entry) => {
        writtenNames.add(entry.fileName)
        const transform = transforms[entry.fileName]
        if (transform) {
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

/**
 * Copies every archive entry verbatim except `entryName` (default
 * `Metadata/model_settings.config`), which is passed through `transform`. Thin single-entry wrapper
 * over {@link rewriteThreeMfEntries}; used by the machine-retarget project_settings rewrite.
 */
export function rewriteModelSettingsThreeMf(
  sourcePath: string,
  outputPath: string,
  transform: (xml: string) => string,
  entryName = 'Metadata/model_settings.config'
): Promise<void> {
  return rewriteThreeMfEntries(sourcePath, outputPath, { [entryName]: transform })
}

/**
 * Object-level `model_settings.config` `<metadata>` keys that are STRUCTURAL (identity/placement),
 * not per-object PROCESS overrides. Used to tell the two apart when reading object overrides back
 * (so they don't surface in the editor's per-object gear) and when rewriting them (so a structural
 * key is never stripped/replaced as if it were an override). `module` is BambuStudio's cut/assembly
 * module name; `source_file` the import origin; `name`/`extruder` the object name + base filament.
 */
export const OBJECT_STRUCTURAL_METADATA_KEYS: ReadonlySet<string> = new Set([
  'name', 'extruder', 'source_file', 'module'
])

export function readZipEntryBuffer(zipFile: ZipFile, entry: Entry, signal?: AbortSignal, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
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
        stream.destroy(createAbortError('Aborted'))
        finish(createAbortError('Aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const chunks: Buffer[] = []
      // Running decoded-byte guard: defense-in-depth against a zip whose central
      // directory under-declares uncompressedSize (the pre-stream check at the
      // caller trusts that field). Abort the inflate the moment it overruns.
      let received = 0
      stream.on('data', (chunk: Buffer) => {
        received += chunk.byteLength
        if (received > maxBytes) {
          stream.destroy()
          finish(new Error('Entry exceeds the maximum decoded size'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => finish(null, Buffer.concat(chunks)))
      stream.on('error', (caught) => finish(caught))
    })
  })
}
