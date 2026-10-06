/**
 * Normalize and unpack files produced by the slicer CLI.
 *
 * An engine may choose its own printable output name or wrap G-code in a ZIP/3MF. Keep the
 * response at the caller-selected path, repair legacy packaged metadata only when requested,
 * and extract plain G-code only for callers that selected that output format.
 */
import { createWriteStream } from 'node:fs'
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isDirectPrintableFileName } from '@printstream/shared'
import yauzl, { type Entry } from 'yauzl'
import yazl from 'yazl'
import { parseProjectSettings, rewriteProjectSettingsMetadata, rewriteSliceInfoMetadata, type SlicedArtifactMetadata } from './output-metadata.js'
import { openZip, readZipEntryBuffer } from './zip-io.js'

/** Move a unique printable CLI result to the requested path and optionally restamp legacy metadata. */
export async function normalizeCliOutput(input: {
  outputPath: string
  outputDir: string
  outputFileName: string
  metadata: SlicedArtifactMetadata | null
}): Promise<void> {
  let outputReady = await isRegularFile(input.outputPath)
  if (!outputReady) {
    const entries = await readdir(input.outputDir, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isFile() && isDirectPrintableFileName(entry.name))
      .map((entry) => path.join(input.outputDir, entry.name))
      .filter((candidate) => candidate !== input.outputPath)
    if (candidates.length !== 1) return
    await rename(candidates[0] as string, input.outputPath)
    outputReady = true
  }
  if (!outputReady) return
  if (input.outputFileName.toLowerCase().endsWith('.3mf') && input.metadata) {
    await rewritePackagedOutputMetadata(input.outputPath, input.metadata)
  }
}

async function rewritePackagedOutputMetadata(filePath: string, metadata: SlicedArtifactMetadata): Promise<void> {
  const inputBuffer = await readFile(filePath)
  if (inputBuffer.length < 4 || inputBuffer[0] !== 0x50 || inputBuffer[1] !== 0x4b) return

  const tempPath = `${filePath}.normalized`
  await rm(tempPath, { force: true })

  const sourceZip = await openZip(filePath)
  const outputZip = new yazl.ZipFile()
  const output = createWriteStream(tempPath)
  outputZip.outputStream.pipe(output)

  await new Promise<void>((resolve, reject) => {
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

    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('finish', () => finish())
    sourceZip.on('error', finish)
    sourceZip.on('end', () => outputZip.end())
    sourceZip.on('entry', (entry: Entry) => {
      if (/\/$/.test(entry.fileName)) {
        outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
        sourceZip.readEntry()
        return
      }
      if (entry.fileName === 'Metadata/project_settings.config') {
        readZipEntryBuffer(sourceZip, entry).then(
          (buffer) => {
            outputZip.addBuffer(
              Buffer.from(JSON.stringify(rewriteProjectSettingsMetadata(parseProjectSettings(buffer), metadata), null, 2), 'utf8'),
              entry.fileName,
              { mtime: entry.getLastModDate() }
            )
            sourceZip.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      if (entry.fileName === 'Metadata/slice_info.config') {
        readZipEntryBuffer(sourceZip, entry).then(
          (buffer) => {
            outputZip.addBuffer(
              Buffer.from(rewriteSliceInfoMetadata(buffer.toString('utf8'), metadata), 'utf8'),
              entry.fileName,
              { mtime: entry.getLastModDate() }
            )
            sourceZip.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      sourceZip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          finish(error ?? new Error(`Failed to read ${entry.fileName}`))
          return
        }
        stream.on('error', finish)
        stream.on('end', () => sourceZip.readEntry())
        outputZip.addReadStream(stream, entry.fileName, { mtime: entry.getLastModDate() })
      })
    })
    sourceZip.readEntry()
  })

  await rename(tempPath, filePath)
}

/** Replace a packaged result with its first G-code entry; return false when none is available. */
export async function extractGcodeFromPackagedOutput(filePath: string): Promise<boolean> {
  if (!await isRegularFile(filePath)) return false
  const inputBuffer = await readFile(filePath)
  if (inputBuffer.length < 4 || inputBuffer[0] !== 0x50 || inputBuffer[1] !== 0x4b) {
    // Not a zip payload; likely already plain gcode.
    return true
  }

  const tempPath = `${filePath}.plain-gcode`
  await rm(tempPath, { force: true })

  const extracted = await extractFirstGcodeEntry(filePath, tempPath)
  if (!extracted) {
    await rm(tempPath, { force: true })
    return false
  }

  await rename(tempPath, filePath)
  return true
}

async function extractFirstGcodeEntry(zipPath: string, outputPath: string): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Failed to open packaged slicer output'))
        return
      }

      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        zipFile.close()
        resolve(value)
      }
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        zipFile.close()
        reject(err)
      }

      zipFile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry()
          return
        }
        if (!entry.fileName.toLowerCase().endsWith('.gcode')) {
          zipFile.readEntry()
          return
        }

        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('Failed to read gcode entry from packaged slicer output'))
            return
          }
          const writer = createWriteStream(outputPath)
          stream.on('error', (err) => fail(err as Error))
          writer.on('error', (err) => fail(err as Error))
          writer.on('finish', () => finish(true))
          stream.pipe(writer)
        })
      })

      zipFile.once('end', () => finish(false))
      zipFile.once('error', (zipError) => fail(zipError as Error))
      zipFile.readEntry()
    })
  })
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

/** Name the default printable package for a source 3MF. */
export function buildDefaultOutputFileName(sourceFileName: string): string {
  return sourceFileName.replace(/\.3mf$/i, '.gcode.3mf')
}

/** Keep readable punctuation but remove path and filesystem-reserved characters. */
export function normalizeOutputFileName(fileName: string): string {
  // Spaces, brackets, and most ASCII punctuation are valid in the output file name
  // (BambuStudio itself exports names like "Mount (landscape).gcode.3mf"); the name is
  // passed to the slicer CLI as a single argv token (spawn is invoked without a shell,
  // and the args template is tokenized before {outputFileName} is substituted). Strip
  // only path separators, FAT-reserved characters, and non-printable/non-ASCII: the
  // same set as the API's normalizeOutputFileName and sanitizeRemoteName; this name is
  // reported back and REPLACES the caller's requested output name, so anything stripped
  // here disfigures the library file name (e.g. "(ABS)" used to become "_ABS_").
  const safe = fileName.replace(/[\\/<>:"|?*]/g, '_').replace(/[^\x20-\x7e]+/g, '_')
  return isDirectPrintableFileName(safe) ? safe : `${safe.replace(/\.3mf$/i, '')}.gcode.3mf`
}
