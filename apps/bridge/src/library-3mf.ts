/**
 * Bridge-local 3MF inspection helpers.
 *
 * These keep bridge-owned archives on the bridge and only return normalized
 * metadata or selected derived media to the API.
 *
 * IMPORTANT — DUPLICATED PARSER: library files are bridge-owned by default, so this parser (not
 * the API's) is what normally produces the 3MF index the web sees, via the `library.inspect3mf`
 * RPC. It is a hand-kept mirror of `apps/api/src/lib/three-mf-reader.ts` (the API only parses
 * locally as a fallback). Any change to the index shape or per-plate fields (e.g. `objects`) MUST be applied in
 * BOTH files, both `THREE_MF_PARSER_CACHE_VERSION`s bumped, and the API's
 * `BRIDGE_LIBRARY_DERIVED_CACHE_VERSION` bumped so stale cached indexes are dropped. The result is
 * validated by `bridgeLibraryThreeMfIndexSchema`, which strips any field the schema omits.
 */
import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type {
  BridgeLibraryThreeMfFilament,
  BridgeLibraryThreeMfIndex,
  BridgeLibraryThreeMfObject,
  BridgeLibraryThreeMfPlate,
  BridgeLibraryThreeMfProjectFilament,
  PrinterModel
} from '@printstream/shared'
import { MemoryLruCache } from '@printstream/shared'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import yazl from 'yazl'
import { env } from './env.js'

interface CacheEntry {
  mtimeMs: number
  parserVersion: number
  index: BridgeLibraryThreeMfIndex
}

interface ModelSettingsPlateMetadata {
  index: number
  name: string | null
  thumbnailFile: string | null
  /** Filament ids (extruders) consumed by the objects on this plate, used to back-fill plate
   * filaments for UNSLICED projects whose plates carry no slice_info filament metadata yet. */
  usedFilamentIds: number[]
  /** Objects (by Bambu `object_id`) placed on this plate, for slice-time object selection. */
  objects: BridgeLibraryThreeMfObject[]
}

interface ModelSettingsSupportConfig {
  enabled: boolean
  supportFilamentId: number | null
  supportInterfaceFilamentId: number | null
}

const THREE_MF_PARSER_CACHE_VERSION = 8
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

function buildThreeMfIndex(
  sliceInfoXml: string | null,
  projectSettingsJson: string | null,
  modelSettingsPlates: ModelSettingsPlateMetadata[],
  thumbnailPlateFiles: Map<number, string> = new Map()
): BridgeLibraryThreeMfIndex {
  const projectFilaments = projectSettingsJson ? parseProjectFilaments(projectSettingsJson) : []
  const parsedPlates = sliceInfoXml ? parseSliceInfo(sliceInfoXml) : []
  const plates = parsedPlates.length > 0
    ? parsedPlates
    : modelSettingsPlates.length > 0
      ? buildModelSettingsOnlyPlates(modelSettingsPlates)
    : thumbnailPlateFiles.size > 0
      ? buildThumbnailOnlyPlates(thumbnailPlateFiles)
      : [defaultPlate()]
  const nozzleMap = extractNozzleMapping(projectSettingsJson, sliceInfoXml)
  const compatiblePrinterModels = extractCompatiblePrinterModels(projectSettingsJson, sliceInfoXml)
  const bakedProfiles = extractBakedProfileNames(projectSettingsJson)
  const plateType = extractPlateType(projectSettingsJson)
  const projectNozzleSizes = extractProjectNozzleSizes(projectSettingsJson)
  const projectFilamentMap = new Map(projectFilaments.map((filament) => [filament.id, filament]))

  for (const filament of projectFilaments) {
    filament.nozzleId = nozzleMap.get(filament.id) ?? null
  }

  const modelSettingsPlateMap = new Map(modelSettingsPlates.map((plate) => [plate.index, plate]))

  for (const plate of plates) {
    const metadata = modelSettingsPlateMap.get(plate.index)
    if (metadata?.name) plate.name = metadata.name
    if (metadata?.thumbnailFile && !plate.thumbnailFile) plate.thumbnailFile = metadata.thumbnailFile
    // Prefer model_settings objects over slice_info's: their ids are the model `object_id`
    // used everywhere downstream (scene instances, slice-time model_instance removal, and
    // per-object overrides), whereas slice_info lists objects by `identify_id` — a different
    // id space that wouldn't match the instances, breaking the per-object print toggle and
    // ghosting the whole model. Fall back to slice_info objects only when model_settings has none.
    if ((metadata?.objects.length ?? 0) > 0) {
      plate.objects = metadata!.objects
    }
    // Unsliced plates have no slice_info filament metadata; back-fill from the model_settings
    // object→extruder mapping so 3MFs get the same filament chips as sliced files. The names and
    // colors come from the project filament map below.
    if (plate.filaments.length === 0 && (metadata?.usedFilamentIds.length ?? 0) > 0) {
      plate.filaments = metadata?.usedFilamentIds.map((id) => ({
        id,
        filamentType: null,
        filamentName: null,
        color: null,
        nozzleId: null,
        nozzleDiameter: null,
        chamberTemperature: null,
        usedGrams: null,
        usedMeters: null
      })) ?? []
    }
    plate.plateType = plateType
    // Unsliced plates have no slice_info nozzle metadata; show the project's configured
    // nozzle diameters instead so 3MFs get the same nozzle chips as sliced files.
    if (plate.nozzleSizes.length === 0 && projectNozzleSizes.length > 0) {
      plate.nozzleSizes = [...projectNozzleSizes]
    }
    for (const filament of plate.filaments) {
      if (!filament.filamentName) {
        filament.filamentName = projectFilamentMap.get(filament.id)?.filamentName ?? null
      }
      filament.nozzleId = nozzleMap.get(filament.id) ?? null
      filament.chamberTemperature = projectFilamentMap.get(filament.id)?.chamberTemperature ?? null
    }
  }

  return { plates, projectFilaments, compatiblePrinterModels, ...bakedProfiles }
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

function defaultPlate(): BridgeLibraryThreeMfPlate {
  return {
    index: 1,
    name: null,
    gcodeFile: 'Metadata/plate_1.gcode',
    pickFile: 'Metadata/pick_1.png',
    thumbnailFile: 'Metadata/plate_1.png',
    plateType: null,
    nozzleSizes: [],
    filaments: [],
    objects: []
  }
}

function buildThumbnailOnlyPlates(thumbnailPlateFiles: Map<number, string>): BridgeLibraryThreeMfPlate[] {
  return [...thumbnailPlateFiles].map(([index, thumbnailFile]) => ({
    index,
    name: null,
    gcodeFile: `Metadata/plate_${index}.gcode`,
    pickFile: buildDefaultPickFilePath(index),
    thumbnailFile,
    plateType: null,
    nozzleSizes: [],
    filaments: [],
    objects: []
  }))
}

function buildModelSettingsOnlyPlates(plates: ModelSettingsPlateMetadata[]): BridgeLibraryThreeMfPlate[] {
  return plates.map((plate) => ({
    index: plate.index,
    name: plate.name,
    gcodeFile: `Metadata/plate_${plate.index}.gcode`,
    pickFile: buildDefaultPickFilePath(plate.index),
    thumbnailFile: plate.thumbnailFile ?? `Metadata/plate_${plate.index}.png`,
    plateType: null,
    nozzleSizes: [],
    filaments: plate.usedFilamentIds.map((id) => ({
      id,
      filamentType: null,
      filamentName: null,
      color: null,
      nozzleId: null,
      nozzleDiameter: null,
      chamberTemperature: null,
      usedGrams: null,
      usedMeters: null
    })),
    objects: plate.objects
  }))
}

function parseSliceInfo(xml: string): BridgeLibraryThreeMfPlate[] {
  const plates: BridgeLibraryThreeMfPlate[] = []
  const plateBlocks = xml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []
  for (const block of plateBlocks) {
    const meta = new Map<string, string>()
    for (const match of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
      const key = match[1]
      const value = match[2]
      if (key != null && value != null) meta.set(key, decodeXmlAttributeValue(value))
    }
    const filaments: BridgeLibraryThreeMfFilament[] = []
    for (const match of block.matchAll(/<filament\b([^/>]*)\/?>(?:<\/filament>)?/g)) {
      const attrs = parseAttrs(match[1] ?? '')
      filaments.push({
        id: parseInt(attrs.id ?? '0', 10) || filaments.length + 1,
        filamentType: attrs.type ?? null,
        filamentName: null,
        color: normalizeColor(attrs.color),
        nozzleId: null,
        nozzleDiameter: normalizeNozzleDiameter(attrs.nozzle_diameter),
        chamberTemperature: null,
        usedGrams: numOrNull(attrs.used_g),
        usedMeters: numOrNull(attrs.used_m)
      })
    }
    const objects: BridgeLibraryThreeMfObject[] = []
    for (const match of block.matchAll(/<object\b([^/>]*)\/?>(?:<\/object>)?/g)) {
      const attrs = parseAttrs(match[1] ?? '')
      const idValue = parseInt(attrs.identify_id ?? attrs.id ?? '', 10)
      const name = attrs.name?.trim()
      if (!name) continue
      objects.push({
        id: Number.isFinite(idValue) ? idValue : objects.length + 1,
        name
      })
    }
    const indexValue = parseInt(meta.get('index') ?? '0', 10)
    const index = Number.isFinite(indexValue) && indexValue > 0 ? indexValue : plates.length + 1
    plates.push({
      index,
      name: meta.get('plater_name') || meta.get('name') || null,
      gcodeFile: meta.get('gcode_file') ?? `Metadata/plate_${index}.gcode`,
      pickFile: meta.get('pick_file') ?? buildDefaultPickFilePath(index),
      thumbnailFile: meta.get('thumbnail_file') ?? `Metadata/plate_${index}.png`,
      plateType: null,
      nozzleSizes: collectPlateNozzleSizes(meta.get('nozzle_diameters'), filaments),
      filaments,
      objects,
      prediction: numOrNull(meta.get('prediction')),
      weight: numOrNull(meta.get('weight'))
    })
  }
  plates.sort((left, right) => left.index - right.index)
  return plates
}

function parseProjectFilaments(json: string): BridgeLibraryThreeMfProjectFilament[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const colors = stringArray(record.filament_colour)
  const types = stringArray(record.filament_type)
  const names = stringArray(record.filament_settings_id)
  const chamberTemperatures = nullableNumberArray(record.chamber_temperatures)
  const length = Math.max(colors.length, types.length, names.length, chamberTemperatures.length)
  const out: BridgeLibraryThreeMfProjectFilament[] = []
  for (let index = 0; index < length; index += 1) {
    out.push({
      id: index + 1,
      filamentType: types[index] ?? null,
      filamentName: cleanFilamentName(names[index]) ?? null,
      color: normalizeColor(colors[index]),
      nozzleId: null,
      chamberTemperature: chamberTemperatures[index] ?? null
    })
  }
  return out
}

function nullableNumberArray(value: unknown): Array<number | null> {
  return Array.isArray(value)
    ? value.map((entry) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) return entry
      if (typeof entry === 'string') {
        const parsed = Number.parseFloat(entry)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    })
    : []
}

function extractPlateType(projectSettingsJson: string | null): string | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  return typeof record.curr_bed_type === 'string'
    ? normalizePlateType(record.curr_bed_type)
    : null
}

/**
 * Project-level nozzle diameters (`nozzle_diameter`, one entry per extruder) from
 * project settings. Used to backfill plate nozzle sizes for UNSLICED projects, whose
 * plates carry no slice_info `nozzle_diameters` metadata yet.
 */
function extractProjectNozzleSizes(projectSettingsJson: string | null): string[] {
  if (!projectSettingsJson) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const raw = Array.isArray(record.nozzle_diameter) ? record.nozzle_diameter : []
  const sizes = new Set<string>()
  for (const entry of raw) {
    const normalized = normalizeNozzleDiameter(typeof entry === 'string' || typeof entry === 'number' ? String(entry) : undefined)
    if (normalized) sizes.add(normalized)
  }
  return [...sizes]
}

function extractBakedProfileNames(projectSettingsJson: string | null): { printerProfileName: string | null; processProfileName: string | null } {
  if (!projectSettingsJson) return { printerProfileName: null, processProfileName: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return { printerProfileName: null, processProfileName: null }
  }
  if (!parsed || typeof parsed !== 'object') return { printerProfileName: null, processProfileName: null }
  const record = parsed as Record<string, unknown>
  return {
    printerProfileName: firstStringValue(record.printer_settings_id),
    processProfileName: firstStringValue(record.print_settings_id) ?? firstStringValue(record.default_print_profile)
  }
}

function firstStringValue(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function collectPlateNozzleSizes(metaValue: string | undefined, filaments: BridgeLibraryThreeMfFilament[]): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()

  const push = (value: string | null) => {
    if (!value || seen.has(value)) return
    seen.add(value)
    ordered.push(value)
  }

  for (const match of (metaValue ?? '').match(/\d+(?:\.\d+)?/g) ?? []) {
    push(normalizeNozzleDiameter(match))
  }
  for (const filament of filaments) {
    push(filament.nozzleDiameter)
  }
  return ordered
}

function extractNozzleMapping(projectSettingsJson: string | null, sliceInfoXml: string | null): Map<number, number> {
  if (!projectSettingsJson) return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return new Map()
  }
  if (!parsed || typeof parsed !== 'object') return new Map()

  const record = parsed as Record<string, unknown>
  const physicalExtruderMap = stringArray(record.physical_extruder_map)
  const normalizeTarget = (target: number) => normalizeProjectNozzleTarget(target, physicalExtruderMap)
  if (physicalExtruderMap.length <= 1) return new Map()
  const filamentNozzleMap = stringArray(record.filament_nozzle_map)
  const sliceFilamentIds = sliceInfoXml ? extractSliceFilamentIds(sliceInfoXml) : []
  const hasSliceFilamentAssignments = sliceFilamentIds.length > 0

  const mapping = new Map<number, number>()
  const activeExtruders = stringArray(record.extruder_nozzle_stats).map((stats) =>
    stats
      .split('|')
      .map((entry) => entry.split('#')[1] ?? '')
      .some((count) => count !== '' && count !== '0')
  )

  if (activeExtruders.filter(Boolean).length === 1) {
    const activeIndex = activeExtruders.findIndex(Boolean)
    const target = numberAt(physicalExtruderMap, activeIndex)
    if (target !== null) {
      if (sliceFilamentIds.length > 0) {
        for (const filamentId of sliceFilamentIds) mapping.set(filamentId, normalizeTarget(target))
        return mapping
      }
      const fallbackLength = filamentNozzleMap.length
      for (let index = 0; index < fallbackLength; index += 1) mapping.set(index + 1, normalizeTarget(target))
      return mapping
    }
  }

  const mappingFromFilamentNozzleMap = new Map<number, number>()
  for (let index = 0; index < filamentNozzleMap.length; index += 1) {
    const filamentTarget = numberAt(filamentNozzleMap, index)
    const target = filamentTarget === null
      ? null
      : hasSliceFilamentAssignments
        ? numberAt(physicalExtruderMap, filamentTarget)
        : filamentTarget
    if (target !== null) mappingFromFilamentNozzleMap.set(index + 1, normalizeTarget(target))
  }

  if (sliceInfoXml) {
    for (const match of sliceInfoXml.matchAll(/<filament\b([^/>]*)\/?>(?:<\/filament>)?/g)) {
      const attrs = parseAttrs(match[1] ?? '')
      const filamentId = parseInt(attrs.id ?? '', 10)
      const groupId = parseInt(attrs.group_id ?? '', 10)
      const target = numberAt(physicalExtruderMap, groupId)
      if (Number.isFinite(filamentId) && filamentId > 0 && target !== null) {
        mapping.set(filamentId, normalizeTarget(target))
      }
    }
  }
  if (mapping.size > 0) {
    if (shouldPreferFilamentNozzleMap(physicalExtruderMap, mapping, mappingFromFilamentNozzleMap, sliceInfoXml)) {
      return mappingFromFilamentNozzleMap
    }
    return mapping
  }

  if (mappingFromFilamentNozzleMap.size > 0) return mappingFromFilamentNozzleMap

  return new Map()
}

/**
 * Some dual-nozzle BambuStudio exports keep identity `physical_extruder_map`
 * while filament assignment arrays are emitted in left-to-right UI order.
 * Convert those targets into runtime nozzle ids (right=0, left=1).
 */
function normalizeProjectNozzleTarget(target: number, physicalExtruderMap: string[]): number {
  if (target !== 0 && target !== 1) return target
  if (!usesUiOrderedDualNozzleTargets(physicalExtruderMap)) return target
  return target === 0 ? 1 : 0
}

function usesUiOrderedDualNozzleTargets(physicalExtruderMap: string[]): boolean {
  if (physicalExtruderMap.length !== 2) return false
  return numberAt(physicalExtruderMap, 0) === 0 && numberAt(physicalExtruderMap, 1) === 1
}

function shouldPreferFilamentNozzleMap(
  physicalExtruderMap: string[],
  mappingFromSliceInfo: ReadonlyMap<number, number>,
  mappingFromFilamentNozzleMap: ReadonlyMap<number, number>,
  sliceInfoXml: string | null
): boolean {
  if (mappingFromFilamentNozzleMap.size === 0) return false
  if (!hasNonIdentityPhysicalExtruderMap(physicalExtruderMap)) return false
  if (sliceInfoHasConcreteFilamentUsage(sliceInfoXml)) return false

  for (const [filamentId, sliceTarget] of mappingFromSliceInfo.entries()) {
    const filamentTarget = mappingFromFilamentNozzleMap.get(filamentId)
    if (filamentTarget != null && filamentTarget !== sliceTarget) return true
  }
  return false
}

function hasNonIdentityPhysicalExtruderMap(physicalExtruderMap: string[]): boolean {
  for (let index = 0; index < physicalExtruderMap.length; index += 1) {
    const target = numberAt(physicalExtruderMap, index)
    if (target != null && target !== index) return true
  }
  return false
}

function sliceInfoHasConcreteFilamentUsage(sliceInfoXml: string | null): boolean {
  if (!sliceInfoXml) return false
  for (const match of sliceInfoXml.matchAll(/<filament\b([^/>]*)\/?>(?:<\/filament>)?/g)) {
    const attrs = parseAttrs(match[1] ?? '')
    if (
      attrs.used_g != null
      || attrs.used_m != null
      || attrs.used_for_object != null
      || attrs.used_for_support != null
      || attrs.tray_info_idx != null
    ) {
      return true
    }
  }
  return false
}

function extractSliceFilamentIds(xml: string): number[] {
  const ids = new Set<number>()
  for (const match of xml.matchAll(/<filament\b([^/>]*)\/?>(?:<\/filament>)?/g)) {
    const attrs = parseAttrs(match[1] ?? '')
    const filamentId = parseInt(attrs.id ?? '', 10)
    if (Number.isFinite(filamentId) && filamentId > 0) ids.add(filamentId)
  }
  return Array.from(ids.values()).sort((left, right) => left - right)
}

function extractCompatiblePrinterModels(projectSettingsJson: string | null, sliceInfoXml: string | null): PrinterModel[] {
  const models = new Set<PrinterModel>()

  if (projectSettingsJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(projectSettingsJson)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      collectNormalizedModels(record.printer_model, models)
      collectNormalizedModels(record.printer_settings_id, models)
      collectNormalizedModels(record.compatible_printers, models)
      collectNormalizedModels(record.print_compatible_printers, models)
      collectNormalizedModels(record.models, models)
    }
  }

  if (sliceInfoXml) {
    for (const match of sliceInfoXml.matchAll(/<metadata\s+key="printer_model_id"\s+value="([^"]+)"\s*\/>/g)) {
      const normalized = normalizePrinterModelId(match[1])
      if (normalized) models.add(normalized)
    }
  }

  return Array.from(models)
}

function collectNormalizedModels(value: unknown, models: Set<PrinterModel>): void {
  if (typeof value === 'string') {
    for (const entry of parseSerializedModelValues(value)) {
      const normalized = normalizePrinterModelName(entry)
      if (normalized) models.add(normalized)
    }
    return
  }
  if (!Array.isArray(value)) return
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    for (const candidate of parseSerializedModelValues(entry)) {
      const normalized = normalizePrinterModelName(candidate)
      if (normalized) models.add(normalized)
    }
  }
}

function parseSerializedModelValues(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []

  const bracketedMatches = Array.from(trimmed.matchAll(/\[([^\]]+)\]/g), (match) => match[1]?.trim() ?? '')
    .filter(Boolean)
    .map((entry) => entry.replace(/\+\+.*$/, '').trim())
    .filter(Boolean)
  if (bracketedMatches.length > 0) return bracketedMatches

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
      }
    } catch {
      // Fall through to delimiter-based parsing.
    }
  }

  return trimmed
    .split(/[;\n,]+/)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

function normalizePrinterModelId(value: string | undefined): PrinterModel | null {
  if (!value) return null
  const key = value.trim().toUpperCase()
  const mapped: Partial<Record<string, PrinterModel>> = {
    C11: 'X1C',
    C13: 'X1E',
    N6: 'X2D',
    P1S: 'P1S',
    P2S: 'P2S',
    P1P: 'P1P',
    A11: 'A1',
    N1: 'A1',
    A12: 'A1mini',
    A04: 'A1mini',
    N2S: 'A1mini',
    N9: 'A2L',
    O1D: 'H2D',
    'BL-D001': 'H2D',
    H2DPRO: 'H2DPRO',
    O1C: 'H2C',
    O1C2: 'H2C',
    H2S: 'H2S'
  }
  return mapped[key] ?? null
}

function normalizePrinterModelName(value: string | undefined): PrinterModel | null {
  if (!value) return null
  const canonical = value
    .replace(/^#\s*/, '')
    .replace(/@BBL\b.*$/i, '')
    .replace(/\b\d+(?:\.\d+)?\s*NOZZLE\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

  if (!canonical) return null
  if (canonical.includes('X1E')) return 'X1E'
  if (canonical.includes('X1 CARBON') || canonical.includes('X1C')) return 'X1C'
  if (canonical.includes('X2D')) return 'X2D'
  if (canonical.includes('P1S')) return 'P1S'
  if (canonical.includes('P2S')) return 'P2S'
  if (canonical.includes('P1P')) return 'P1P'
  if (canonical.includes('A2L')) return 'A2L'
  // A1 mini MUST be tested before A1: "BAMBU LAB A1 MINI" contains " A1 " and would
  // otherwise classify as A1 — which made the slice dialog auto-match A1 filament
  // profiles against the project's A1-mini machine profile and fail the CLI (#28).
  if (canonical.includes('A1 MINI') || canonical.includes('A1MINI')) return 'A1mini'
  if (/(^|[^A-Z0-9])A1($|[^A-Z0-9])/.test(canonical)) return 'A1'
  if (canonical.includes('H2C')) return 'H2C'
  if (canonical.includes('H2D PRO') || canonical.includes('H2DPRO')) return 'H2DPRO'
  if (canonical.includes('H2S')) return 'H2S'
  if (canonical.includes('H2D')) return 'H2D'
  return normalizePrinterModelId(canonical)
}

function parseModelSettingsPlates(xml: string, projectSettingsJson: string | null = null): ModelSettingsPlateMetadata[] {
  const supportConfig = parseProjectSupportConfig(projectSettingsJson)
  const objectExtrudersById = parseModelSettingsObjectFilamentIds(xml, supportConfig)
  const objectNamesById = parseModelSettingsObjectNames(xml)
  const out: ModelSettingsPlateMetadata[] = []
  const plateBlocks = xml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []
  for (const block of plateBlocks) {
    const meta = new Map<string, string>()
    for (const match of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
      const key = match[1]
      const value = match[2]
      if (key != null && value != null) meta.set(key, decodeXmlAttributeValue(value))
    }
    const id = parseInt(meta.get('plater_id') ?? '0', 10)
    if (!Number.isFinite(id) || id <= 0) continue
    const name = meta.get('plater_name')?.trim() ?? ''
    // One entry per object (object_id) placed on the plate, for slice-time object selection.
    const usedFilamentIds = new Set<number>()
    const objects: BridgeLibraryThreeMfObject[] = []
    const seenObjectIds = new Set<number>()
    for (const match of block.matchAll(/<model_instance\b[^>]*>[\s\S]*?<metadata\s+key="object_id"\s+value="(\d+)"\s*\/>[\s\S]*?<\/model_instance>/g)) {
      const objectId = Number.parseInt(match[1] ?? '', 10)
      if (!Number.isInteger(objectId) || objectId <= 0) continue
      for (const extruderId of objectExtrudersById.get(objectId) ?? []) {
        if (extruderId > 0) usedFilamentIds.add(extruderId)
      }
      if (seenObjectIds.has(objectId)) continue
      seenObjectIds.add(objectId)
      objects.push({ id: objectId, name: objectNamesById.get(objectId) ?? `Object ${objectId}` })
    }
    out.push({
      index: id,
      name: name || null,
      thumbnailFile: meta.get('thumbnail_file') ?? null,
      usedFilamentIds: [...usedFilamentIds].sort((left, right) => left - right),
      objects
    })
  }
  return out.sort((left, right) => left.index - right.index)
}

/** Map each `<object id="N">` in `model_settings.config` to its display name. */
function parseModelSettingsObjectNames(xml: string): Map<number, string> {
  const names = new Map<number, string>()
  for (const block of xml.match(/<object\b[^>]*>[\s\S]*?<\/object>/g) ?? []) {
    const objectId = Number.parseInt(parseAttrs(block.match(/^<object\b([^>]*)>/)?.[1] ?? '').id ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue
    const nameMatch = /<metadata\s+key="name"\s+value="([^"]*)"\s*\/>/.exec(block)
    const name = nameMatch ? decodeXmlAttributeValue(nameMatch[1] ?? '').trim() : ''
    if (name) names.set(objectId, name)
  }
  return names
}

/**
 * Map each `<object id="N">` in `model_settings.config` to the filament (extruder) ids it uses,
 * including support/interface filaments when support is enabled. Mirrors the API reader so
 * UNSLICED projects get filament chips without an API-side reparse fallback.
 */
function parseModelSettingsObjectFilamentIds(
  xml: string,
  projectSupportConfig: ModelSettingsSupportConfig
): Map<number, number[]> {
  const objectExtrudersById = new Map<number, number[]>()
  const objectBlocks = xml.match(/<object\b[^>]*>[\s\S]*?<\/object>/g) ?? []
  for (const block of objectBlocks) {
    const attrs = parseAttrs(block.match(/^<object\b([^>]*)>/)?.[1] ?? '')
    const objectId = Number.parseInt(attrs.id ?? '', 10)
    if (!Number.isInteger(objectId) || objectId <= 0) continue
    const extruderIds = new Set<number>()
    for (const match of block.matchAll(/<metadata\s+key="extruder"\s+value="(\d+)"\s*\/>/g)) {
      const extruderId = Number.parseInt(match[1] ?? '', 10)
      if (Number.isInteger(extruderId) && extruderId > 0) extruderIds.add(extruderId)
    }

    const enableSupport = readModelSettingsMetadataInt(block, 'enable_support')
    const supportEnabled = enableSupport == null
      ? projectSupportConfig.enabled
      : enableSupport > 0
    if (supportEnabled) {
      const supportFilamentId = readModelSettingsMetadataInt(block, 'support_filament')
      const supportInterfaceFilamentId = readModelSettingsMetadataInt(block, 'support_interface_filament')
      const supportFilamentIds = [
        supportFilamentId ?? projectSupportConfig.supportFilamentId,
        supportInterfaceFilamentId ?? projectSupportConfig.supportInterfaceFilamentId
      ]
      for (const filamentId of supportFilamentIds) {
        if (filamentId != null && filamentId > 0) extruderIds.add(filamentId)
      }
    }

    if (extruderIds.size > 0) objectExtrudersById.set(objectId, [...extruderIds].sort((left, right) => left - right))
  }
  return objectExtrudersById
}

function parseProjectSupportConfig(projectSettingsJson: string | null): ModelSettingsSupportConfig {
  const disabled: ModelSettingsSupportConfig = {
    enabled: false,
    supportFilamentId: null,
    supportInterfaceFilamentId: null
  }
  if (!projectSettingsJson) return disabled

  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return disabled
  }
  if (!parsed || typeof parsed !== 'object') return disabled

  const record = parsed as Record<string, unknown>
  const enabledValue = configIntValue(record.enable_support)
  return {
    enabled: enabledValue != null
      ? enabledValue > 0
      : configBooleanValue(record.enable_support),
    supportFilamentId: positiveConfigIntValue(record.support_filament),
    supportInterfaceFilamentId: positiveConfigIntValue(record.support_interface_filament)
  }
}

function readModelSettingsMetadataInt(block: string, key: string): number | null {
  const match = new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"\\s*\\/>`).exec(block)
  return match ? parseIntegerValue(match[1] ?? null) : null
}

function positiveConfigIntValue(value: unknown): number | null {
  const parsed = configIntValue(value)
  return parsed != null && parsed > 0 ? parsed : null
}

function configIntValue(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  return parseIntegerValue(raw)
}

function configBooleanValue(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw > 0
  if (typeof raw === 'string') return /^(?:1|true|yes)$/i.test(raw.trim())
  return false
}

function parseIntegerValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value !== 'string') return null
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) ? parsed : null
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry : ''))
}

function numberAt(values: string[], index: number): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) return null
  const parsed = Number(values[index])
  return Number.isFinite(parsed) ? parsed : null
}

function parseAttrs(input: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of input.matchAll(/(\w+)="([^"]*)"/g)) {
    const key = match[1]
    const value = match[2]
    if (key != null && value != null) out[key] = decodeXmlAttributeValue(value)
  }
  return out
}

function decodeXmlAttributeValue(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|apos|quot|amp|lt|gt);/g, (entity, body: string) => {
    switch (body) {
      case 'apos':
        return '\''
      case 'quot':
        return '"'
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      default: {
        const radix = body.startsWith('#x') ? 16 : 10
        const codePoint = Number.parseInt(body.replace(/^#x?/i, ''), radix)
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
      }
    }
  })
}

function numOrNull(value: string | undefined): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function cleanFilamentName(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().replace(/\s*@BBL\b.*$/i, '').trim()
  return trimmed || null
}

function normalizePlateType(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized || null
}

function normalizeNozzleDiameter(value: string | null | undefined): string | null {
  if (!value) return null
  const numeric = Number.parseFloat(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return numeric.toString()
}

function normalizeColor(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(trimmed)) {
    const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
    return `#${hex.slice(0, 6).toUpperCase()}`
  }
  return null
}

function buildDefaultPickFilePath(plateIndex: number): string {
  return `Metadata/pick_${plateIndex}.png`
}