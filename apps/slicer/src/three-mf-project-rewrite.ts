/**
 * Rewrite selected entries of a slicer input 3MF without changing untouched entry bytes.
 *
 * The legacy input path uses this to retarget project settings, remove stale nozzle groups,
 * or update model/plate metadata. The caller chooses transforms and receives whether the
 * archive actually contained embedded project settings. A transform failure rejects the write.
 */
import { createWriteStream } from 'node:fs'
import { readZipEntryBuffer, openZip } from './zip-io.js'
import { type Entry } from 'yauzl'
import yazl from 'yazl'
import { parseProjectSettings } from './output-metadata.js'

/** Copy an archive while transforming only the selected project, model, or plate entries. */
export async function rewriteThreeMfProjectSettings(
  inputPath: string,
  outputPath: string,
  transform: (settings: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  options?: {
    /** Copy project settings exactly while still requiring the entry to exist. */
    preserveProjectSettingsBytes?: boolean
    modelSettingsTransform?: (modelSettingsXml: string) => string
    model3dTransform?: (modelXml: string) => string
    sliceInfoTransform?: (sliceInfoXml: string) => string
    /** Entries this returns true for are dropped from the rewritten copy entirely. */
    omitEntry?: (fileName: string) => boolean
  }
): Promise<boolean> {
  const { preserveProjectSettingsBytes, modelSettingsTransform, model3dTransform, sliceInfoTransform, omitEntry } = options ?? {}
  const sourceZip = await openZip(inputPath)
  const outputZip = new yazl.ZipFile()
  const output = createWriteStream(outputPath)
  outputZip.outputStream.pipe(output)

  return await new Promise<boolean>((resolve, reject) => {
    let settled = false
    let hasEmbeddedProjectSettings = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      sourceZip.close()
      if (error) {
        output.destroy()
        reject(error)
      } else {
        resolve(hasEmbeddedProjectSettings)
      }
    }
    const fail = (error: unknown) => finish(error instanceof Error ? error : new Error(String(error)))

    /** Advance lazy ZIP reads only after this entry has been written or a transform has failed. */
    const copyEntry = (
      entry: Entry,
      transformEntry?: (buffer: Buffer) => Buffer | Promise<Buffer>
    ): void => {
      void readZipEntryBuffer(sourceZip, entry).then(async (buffer) => {
        const next = transformEntry ? await transformEntry(buffer) : buffer
        if (settled) return
        outputZip.addBuffer(next, entry.fileName, { mtime: entry.getLastModDate() })
        sourceZip.readEntry()
      }).catch(fail)
    }

    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('close', () => finish())
    sourceZip.on('error', finish)
    sourceZip.on('end', () => outputZip.end())
    sourceZip.on('entry', (entry: Entry) => {
      try {
        if (/\/$/.test(entry.fileName)) {
          outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
          sourceZip.readEntry()
          return
        }
        if (omitEntry?.(entry.fileName)) {
          sourceZip.readEntry()
          return
        }
        if (entry.fileName === 'Metadata/project_settings.config') {
          hasEmbeddedProjectSettings = true
          copyEntry(entry, async (buffer) => preserveProjectSettingsBytes
            ? buffer
            : Buffer.from(JSON.stringify(await transform(parseProjectSettings(buffer)), null, 2), 'utf8'))
          return
        }
        if (sliceInfoTransform && entry.fileName === 'Metadata/slice_info.config') {
          copyEntry(entry, (buffer) => Buffer.from(sliceInfoTransform(buffer.toString('utf8')), 'utf8'))
          return
        }
        if (modelSettingsTransform && entry.fileName === 'Metadata/model_settings.config') {
          copyEntry(entry, (buffer) => Buffer.from(modelSettingsTransform(buffer.toString('utf8')), 'utf8'))
          return
        }
        if (model3dTransform && entry.fileName === '3D/3dmodel.model') {
          copyEntry(entry, (buffer) => Buffer.from(model3dTransform(buffer.toString('utf8')), 'utf8'))
          return
        }
        copyEntry(entry)
      } catch (error) {
        fail(error)
      }
    })
    sourceZip.readEntry()
  })
}
