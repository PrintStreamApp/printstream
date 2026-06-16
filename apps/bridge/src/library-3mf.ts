/**
 * Bridge-local 3MF inspection helpers.
 *
 * These keep bridge-owned archives on the bridge and only return normalized metadata or selected
 * derived media to the API. Library files are bridge-owned by default, so this is what normally
 * produces the 3MF index the web sees, via the `library.inspect3mf` RPC (the API parses locally
 * only as a fallback).
 *
 * The 3MF index parsing itself lives in the shared `@printstream/shared/three-mf` module, which the
 * API consumes too — so there is no longer a hand-kept mirror to keep in step. This module owns the
 * bridge-side ZIP I/O, the in-memory index cache, and the single-plate 3MF slimming used for
 * dispatch. The result is validated by `bridgeLibraryThreeMfIndexSchema`, which strips any field the
 * schema omits.
 */
import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { BridgeLibraryThreeMfIndex } from '@printstream/shared'
import { MemoryLruCache } from '@printstream/shared'
import {
  THREE_MF_INDEX_PARSER_VERSION,
  buildThreeMfIndex,
  parseModelSettingsPlates,
  type ModelSettingsPlateMetadata
} from '@printstream/shared/three-mf'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import yazl from 'yazl'
import { env } from './env.js'

interface CacheEntry {
  mtimeMs: number
  parserVersion: number
  index: BridgeLibraryThreeMfIndex
}

const THREE_MF_PARSER_CACHE_VERSION = THREE_MF_INDEX_PARSER_VERSION
const THREE_MF_PARSER_CACHE_MAX_ENTRIES = 128
const THREE_MF_PARSER_CACHE_TTL_MS = 5 * 60 * 1000
const cache = new MemoryLruCache<string, CacheEntry>({
  maxEntries: THREE_MF_PARSER_CACHE_MAX_ENTRIES,
  ttlMs: THREE_MF_PARSER_CACHE_TTL_MS,
  enabled: env.NODE_ENV !== 'development'
})
const MINIMAL_THREE_MF_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <resources/>',
  '  <build/>',
  '</model>'
].join('\n')

export async function readBridgeLibraryThreeMfIndex(filePath: string): Promise<BridgeLibraryThreeMfIndex> {
  const info = await stat(filePath)
  const cached = cache.get(filePath)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.parserVersion === THREE_MF_PARSER_CACHE_VERSION) return cached.index

  let xml: string | null = null
  try {
    xml = (await readEntry(filePath, 'Metadata/slice_info.config')).toString('utf8')
  } catch {
    xml = null
  }

  let projectSettingsJson: string | null = null
  try {
    projectSettingsJson = (await readEntry(filePath, 'Metadata/project_settings.config')).toString('utf8')
  } catch {
    projectSettingsJson = null
  }

  let modelSettingsPlates: ModelSettingsPlateMetadata[] = []
  try {
    modelSettingsPlates = parseModelSettingsPlates((await readEntry(filePath, 'Metadata/model_settings.config')).toString('utf8'), projectSettingsJson)
  } catch {
    modelSettingsPlates = []
  }

  const thumbnailPlateFiles = await readPlateThumbnailFiles(filePath).catch(() => new Map<number, string>())
  const index = buildThreeMfIndex(xml, projectSettingsJson, modelSettingsPlates, thumbnailPlateFiles)
  cache.set(filePath, { mtimeMs: info.mtimeMs, parserVersion: THREE_MF_PARSER_CACHE_VERSION, index })
  return index
}

export async function readBridgeLibraryThumbnail(filePath: string, plateIndex: number | null): Promise<Buffer | null> {
  const index = await readBridgeLibraryThreeMfIndex(filePath).catch(() => null)
  for (const entryPath of buildCoverThumbnailCandidates(index, plateIndex)) {
    try {
      return await readEntry(filePath, entryPath)
    } catch {
      // Try the next embedded thumbnail candidate.
    }
  }
  return null
}

export function createSinglePlateBridgeThreeMf(sourcePath: string, outputPath: string, plate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true }, (openError, sourceZip) => {
      if (openError || !sourceZip) {
        reject(openError ?? new Error('Failed to open 3MF'))
        return
      }

      const outputZip = new yazl.ZipFile()
      const output = createWriteStream(outputPath)
      let settled = false
      let copiedEntries = 0

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
      output.on('finish', () => {
        if (copiedEntries === 0) finish(new Error('No entries copied into slim 3MF'))
        else finish()
      })

      sourceZip.on('error', finish)
      sourceZip.on('end', () => outputZip.end())
      sourceZip.on('entry', (entry: Entry) => {
        if (entry.fileName === '3D/3dmodel.model') {
          outputZip.addBuffer(Buffer.from(MINIMAL_THREE_MF_MODEL_XML, 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
          copiedEntries += 1
          sourceZip.readEntry()
          return
        }
        if (shouldDropPlateEntry(entry.fileName, plate)) {
          sourceZip.readEntry()
          return
        }
        if (entry.fileName === 'Metadata/slice_info.config') {
          readZipEntryBuffer(sourceZip, entry).then(
            (buffer) => {
              outputZip.addBuffer(Buffer.from(filterSliceInfoXml(buffer.toString('utf8'), plate), 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
              copiedEntries += 1
              sourceZip.readEntry()
            },
            finish
          )
          return
        }
        if (entry.fileName === 'Metadata/model_settings.config') {
          readZipEntryBuffer(sourceZip, entry).then(
            (buffer) => {
              outputZip.addBuffer(Buffer.from(filterModelSettingsXml(buffer.toString('utf8'), plate), 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
              copiedEntries += 1
              sourceZip.readEntry()
            },
            finish
          )
          return
        }
        if (entry.fileName.endsWith('/')) {
          outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
          copiedEntries += 1
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
          copiedEntries += 1
        })
      })
      sourceZip.readEntry()
    })
  })
}

function buildCoverThumbnailCandidates(index: BridgeLibraryThreeMfIndex | null, plateIndex: number | null): string[] {
  const preferredThumbnail = (plateIndex != null
    ? index?.plates.find((entry) => entry.index === plateIndex)?.thumbnailFile
    : null)
    ?? index?.plates[0]?.thumbnailFile
    ?? 'Metadata/plate_1.png'

  return Array.from(new Set([preferredThumbnail, 'Metadata/plate_1.png', 'Metadata/top_1.png']))
}

function shouldDropPlateEntry(entryPath: string, selectedPlate: number): boolean {
  if (entryPath.startsWith('3D/') && entryPath !== '3D/3dmodel.model') {
    return true
  }
  const match = /^Metadata\/(?:plate|top|pick)_(\d+)(?:_[^/.]+)?\.(?:gcode(?:\.md5)?|png|json|config)$/i.exec(entryPath)
    ?? /^Metadata\/plate_no_light_(\d+)\.png$/i.exec(entryPath)
    ?? /^Metadata\/process_settings_(\d+)\.config$/i.exec(entryPath)
  if (!match) return false
  return Number(match[1]) !== selectedPlate
}

function filterSliceInfoXml(xml: string, selectedPlate: number): string {
  let keptPlate: string | null = null
  const filtered = xml.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>/g, (block) => {
    const indexMatch = /<metadata\s+key="index"\s+value="(\d+)"\s*\/>/.exec(block)
    if (Number(indexMatch?.[1]) === selectedPlate) {
      keptPlate = block
      return block
    }
    return ''
  })
  return keptPlate ? filtered : xml
}

function filterModelSettingsXml(xml: string, selectedPlate: number): string {
  let keptPlate: string | null = null
  const filtered = xml.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>/g, (block) => {
    const plateIdMatch = /<metadata\s+key="plater_id"\s+value="(\d+)"\s*\/>/.exec(block)
    if (Number(plateIdMatch?.[1]) === selectedPlate) {
      keptPlate = block
      return block
    }
    return ''
  })
  return keptPlate ? filtered : xml
}

function readEntry(filePath: string, entryPath: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open zip'))
        return
      }
      let resolved = false
      const finish = (error: Error | null, value: Buffer | null) => {
        if (resolved) return
        resolved = true
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
        readZipEntryBuffer(zipFile, entry).then(
          (buffer) => finish(null, buffer),
          (error) => finish(error, null)
        )
      })
      zipFile.readEntry()
    })
  })
}

function readZipEntryBuffer(zipFile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('Failed to open entry stream'))
        return
      }
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  })
}

function readPlateThumbnailFiles(filePath: string): Promise<Map<number, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open zip'))
        return
      }
      const thumbnails = new Map<number, string>()
      let resolved = false
      const finish = (error?: Error) => {
        if (resolved) return
        resolved = true
        zipFile.close()
        if (error) reject(error)
        else resolve(new Map([...thumbnails].sort(([left], [right]) => left - right)))
      }
      zipFile.on('error', finish)
      zipFile.on('end', () => finish())
      zipFile.on('entry', (entry: Entry) => {
        const match = /^Metadata\/plate_(\d+)\.png$/i.exec(entry.fileName)
        const plateIndex = Number(match?.[1])
        if (Number.isInteger(plateIndex) && plateIndex > 0) thumbnails.set(plateIndex, entry.fileName)
        zipFile.readEntry()
      })
      zipFile.readEntry()
    })
  })
}
