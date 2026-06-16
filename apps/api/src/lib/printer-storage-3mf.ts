/**
 * Read 3MF metadata from files that already live on the printer's SD card.
 *
 * We first try to read the needed ZIP members from a remote suffix over FTPS
 * so thumbnails and metadata do not require a full archive download. If that
 * fails, we fall back to the older whole-file temp download path.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Printer, PrinterActivePrintObject } from '@printstream/shared'
import type { ThreeMfIndex } from './three-mf.js'
import { buildCoverThumbnailCandidates } from './cover-thumbnail.js'
import * as printerFtp from './printer-ftp.js'
import * as printerRemoteZip from './printer-remote-zip.js'
import { buildPlateObjectsWithPreview, buildThreeMfIndex, readEntry, readPlateIndex, readPlateObjectsWithPreview } from './three-mf.js'

const PRINTER_STORAGE_3MF_CACHE_TTL_MS = 30_000
const SLOW_PRINTER_STORAGE_3MF_LOG_THRESHOLD_MS = 250

interface PrinterStorageThreeMfInspection {
  index: ThreeMfIndex | null
  thumbnail: Buffer | null
}

interface PrinterStorageThreeMfDeps {
  downloadFileFromPrinter: typeof printerFtp.downloadFileFromPrinter
  readPrinterZipEntries: typeof printerRemoteZip.readPrinterZipEntries
}

const defaultDeps: PrinterStorageThreeMfDeps = {
  downloadFileFromPrinter: printerFtp.downloadFileFromPrinter,
  readPrinterZipEntries: printerRemoteZip.readPrinterZipEntries
}

let deps: PrinterStorageThreeMfDeps = defaultDeps

const inspectionCache = new Map<string, { expiresAt: number; result: PrinterStorageThreeMfInspection }>()

export function setPrinterStorageThreeMfDepsForTests(overrides: Partial<PrinterStorageThreeMfDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}

export function clearPrinterStorageThreeMfInspectionCache(printerId?: string): void {
  if (!printerId) {
    inspectionCache.clear()
    return
  }

  const prefix = `${printerId}\u0000`
  for (const key of inspectionCache.keys()) {
    if (key.startsWith(prefix)) inspectionCache.delete(key)
  }
}

export async function inspectPrinterStorageThreeMf(
  printer: Printer,
  printerPath: string,
  options: { plateIndex?: number | null; signal?: AbortSignal } = {}
): Promise<PrinterStorageThreeMfInspection | null> {
  if (!/\.(3mf|gcode)$/i.test(printerPath)) return null

  const plateIndex = options.plateIndex ?? null
  const cacheKey = buildInspectionCacheKey(printer.id, printerPath, plateIndex)
  const cached = inspectionCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.result
  if (cached) inspectionCache.delete(cacheKey)
  const startedAt = Date.now()

  const partial = await inspectPrinterStorageThreeMfBySuffix(printer, printerPath, plateIndex, options.signal).catch(() => null)
  if (partial && (partial.index || partial.thumbnail)) {
    logPrinterStorageInspection(printer, {
      printerPath,
      plateIndex,
      mode: 'partial',
      totalMs: Date.now() - startedAt,
      hasIndex: partial.index != null,
      hasThumbnail: partial.thumbnail != null
    })
    inspectionCache.set(cacheKey, {
      expiresAt: Date.now() + PRINTER_STORAGE_3MF_CACHE_TTL_MS,
      result: partial
    })
    return partial
  }

  const archive = await deps.downloadFileFromPrinter(printer, [printerPath], undefined, { signal: options.signal }).catch(() => null)
  if (!archive) {
    logPrinterStorageInspection(printer, {
      printerPath,
      plateIndex,
      mode: 'miss',
      totalMs: Date.now() - startedAt,
      hasIndex: false,
      hasThumbnail: false
    })
    return null
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-storage-3mf-'))
  const tempFile = path.join(tempDir, 'archive.3mf')
  try {
    await writeFile(tempFile, archive)
    const index = await readPlateIndex(tempFile, options.signal).catch(() => null)
    const thumbnail = await readThumbnailFromArchive(tempFile, index, plateIndex, options.signal)
    const result = { index, thumbnail }
    logPrinterStorageInspection(printer, {
      printerPath,
      plateIndex,
      mode: 'full-download',
      totalMs: Date.now() - startedAt,
      hasIndex: index != null,
      hasThumbnail: thumbnail != null,
      bytesRead: archive.byteLength
    })
    if (index || thumbnail) {
      inspectionCache.set(cacheKey, {
        expiresAt: Date.now() + PRINTER_STORAGE_3MF_CACHE_TTL_MS,
        result
      })
    }
    return result
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function logPrinterStorageInspection(printer: Printer, details: {
  printerPath: string
  plateIndex: number | null
  mode: 'partial' | 'full-download' | 'miss'
  totalMs: number
  hasIndex: boolean
  hasThumbnail: boolean
  bytesRead?: number
}): void {
  if (details.totalMs < SLOW_PRINTER_STORAGE_3MF_LOG_THRESHOLD_MS && details.mode === 'partial') return

  const parts = [
    `[printer-3mf:${printer.name}]`,
    `mode=${details.mode}`,
    `totalMs=${details.totalMs}`,
    `plate=${details.plateIndex ?? 'n/a'}`,
    `hasIndex=${details.hasIndex}`,
    `hasThumbnail=${details.hasThumbnail}`,
    `path=${details.printerPath}`
  ]
  if (details.bytesRead != null) parts.push(`bytesRead=${details.bytesRead}`)
  console.info(parts.join(' '))
}

export async function readPrinterStorageThreeMfIndex(
  printer: Printer,
  printerPath: string,
  signal?: AbortSignal
): Promise<ThreeMfIndex | null> {
  return (await inspectPrinterStorageThreeMf(printer, printerPath, { signal }))?.index ?? null
}

export async function readPrinterStorageThumbnail(
  printer: Printer,
  printerPath: string,
  options: { plateIndex?: number | null; signal?: AbortSignal } = {}
): Promise<Buffer | null> {
  return (await inspectPrinterStorageThreeMf(printer, printerPath, options))?.thumbnail ?? null
}

export async function readPrinterStorageActivePrintObjects(
  printer: Printer,
  printerPath: string,
  plateIndex: number | null,
  signal?: AbortSignal
): Promise<PrinterActivePrintObject[] | null> {
  if (!/\.(3mf|gcode)$/i.test(printerPath)) return null

  const partial = await readPrinterStorageActivePrintObjectsBySuffix(printer, printerPath, plateIndex, signal).catch(() => null)
  if (partial) return partial

  const archive = await deps.downloadFileFromPrinter(printer, [printerPath], undefined, { signal }).catch(() => null)
  if (!archive) return null

  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-storage-objects-'))
  const tempFile = path.join(tempDir, 'archive.3mf')
  try {
    await writeFile(tempFile, archive)
    return await readPlateObjectsWithPreview(tempFile, plateIndex, signal).catch(() => null)
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function readPrinterStorageActivePrintObjectsFromMetadata(
  printer: Printer,
  options: { plateIndex?: number | null; gcodeFile?: string | null; signal?: AbortSignal } = {}
): Promise<PrinterActivePrintObject[] | null> {
  const sliceInfoBuffer = await downloadPrinterMetadataFile(printer, 'Metadata/slice_info.config', options.gcodeFile, options.signal)
  if (!sliceInfoBuffer) return null

  const projectSettingsBuffer = await downloadPrinterMetadataFile(
    printer,
    'Metadata/project_settings.config',
    options.gcodeFile,
    options.signal
  )
  const modelSettingsBuffer = await downloadPrinterMetadataFile(
    printer,
    'Metadata/model_settings.config',
    options.gcodeFile,
    options.signal
  )

  const index = buildThreeMfIndex(
    sliceInfoBuffer.toString('utf8'),
    projectSettingsBuffer?.toString('utf8') ?? null,
    modelSettingsBuffer ? parsePlateNames(modelSettingsBuffer.toString('utf8')) : new Map()
  )
  const plate = (options.plateIndex != null
    ? index.plates.find((entry) => entry.index === options.plateIndex)
    : null) ?? index.plates[0]
  if (!plate) return []

  const pickBuffer = await downloadPrinterMetadataFile(
    printer,
    plate.pickFile ?? `Metadata/pick_${plate.index}.png`,
    options.gcodeFile,
    options.signal
  )

  return buildPlateObjectsWithPreview(index, plate.index, null, pickBuffer)
}

async function readPrinterStorageActivePrintObjectsBySuffix(
  printer: Printer,
  printerPath: string,
  plateIndex: number | null,
  signal?: AbortSignal
): Promise<PrinterActivePrintObject[] | null> {
  const suffixEntries = await deps.readPrinterZipEntries(printer, printerPath, [
    'Metadata/slice_info.config',
    'Metadata/project_settings.config',
    'Metadata/model_settings.config'
  ], signal)
  if (suffixEntries.size === 0) return null
  if (!suffixEntries.has('Metadata/slice_info.config')) return null

  const index = buildIndexFromSuffixEntries(suffixEntries)
  const plate = (plateIndex != null
    ? index.plates.find((entry) => entry.index === plateIndex)
    : null) ?? index.plates[0]
  if (!plate) return []
  const pickFile = plate.pickFile ?? `Metadata/pick_${plate.index}.png`
  if (!plate.gcodeFile && !pickFile) return buildPlateObjectsWithPreview(index, plateIndex, null)

  let pickBuffer: Buffer | null = null
  if (pickFile) {
    const pickEntries = await deps.readPrinterZipEntries(printer, printerPath, [pickFile], signal).catch(() => new Map<string, Buffer>())
    pickBuffer = pickEntries.get(pickFile) ?? null
    if (pickBuffer) {
      const objectsWithPickPreview = buildPlateObjectsWithPreview(index, plateIndex, null, pickBuffer)
      if (objectsWithPickPreview.some((object) => object.previewPath && object.previewBounds)) {
        return objectsWithPickPreview
      }
    }
  }

  let gcodeBuffer: Buffer | null = null
  if (plate.gcodeFile) {
    const gcodeEntries = await deps.readPrinterZipEntries(printer, printerPath, [plate.gcodeFile], signal).catch(() => new Map<string, Buffer>())
    gcodeBuffer = gcodeEntries.get(plate.gcodeFile) ?? null
  }
  return buildPlateObjectsWithPreview(index, plateIndex, gcodeBuffer, pickBuffer)
}

async function readThumbnailFromArchive(
  filePath: string,
  index: ThreeMfIndex | null,
  plateIndex: number | null,
  signal?: AbortSignal
): Promise<Buffer | null> {
  for (const entry of buildCoverThumbnailCandidates(index, plateIndex)) {
    try {
      const png = await readEntry(filePath, entry, signal)
      if (png) return png
    } catch {
      // Try the next embedded preview candidate.
    }
  }
  return null
}

function buildInspectionCacheKey(printerId: string, printerPath: string, plateIndex: number | null): string {
  return `${printerId}\u0000${printerPath}\u0000${plateIndex ?? 1}`
}

async function downloadPrinterMetadataFile(
  printer: Printer,
  relativePath: string,
  gcodeFile: string | null | undefined,
  signal?: AbortSignal
): Promise<Buffer | null> {
  const candidates = buildDirectMetadataCandidates(relativePath, gcodeFile)
  return deps.downloadFileFromPrinter(printer, candidates, undefined, { signal }).catch(() => null)
}

function buildDirectMetadataCandidates(relativePath: string, gcodeFile: string | null | undefined): string[] {
  const normalizedRelativePath = relativePath.replace(/^\/+/, '')
  const candidates = new Set<string>()
  candidates.add(`/${normalizedRelativePath}`)

  const metadataMarker = '/metadata/'
  const normalizedGcodePath = gcodeFile?.replace(/\\/g, '/') ?? null
  const metadataIndex = normalizedGcodePath?.toLowerCase().lastIndexOf(metadataMarker) ?? -1
  if (metadataIndex >= 0 && normalizedGcodePath) {
    const prefix = normalizedGcodePath.slice(0, metadataIndex).replace(/\/+$/, '')
    if (prefix) candidates.add(`${prefix}/${normalizedRelativePath}`)
  } else if (normalizedGcodePath && /\.(3mf|gcode)$/i.test(normalizedGcodePath)) {
    const archiveDir = path.posix.dirname(normalizedGcodePath).replace(/\/+$/, '')
    if (archiveDir && archiveDir !== '.') {
      candidates.add(`${archiveDir}/${normalizedRelativePath}`)
    }
  }

  return [...candidates]
}

async function inspectPrinterStorageThreeMfBySuffix(
  printer: Printer,
  printerPath: string,
  plateIndex: number | null,
  signal?: AbortSignal
): Promise<PrinterStorageThreeMfInspection | null> {
  const directThumbnailCandidates = buildDirectThumbnailProbeCandidates(plateIndex)
  const suffixEntries = await deps.readPrinterZipEntries(printer, printerPath, [
    'Metadata/slice_info.config',
    'Metadata/project_settings.config',
    'Metadata/model_settings.config',
    'Metadata/plate_1.png',
    'Metadata/top_1.png',
    ...directThumbnailCandidates
  ], signal)
  if (suffixEntries.size === 0) return null

  const index = buildIndexFromSuffixEntries(suffixEntries)

  const thumbnailCandidates = buildCoverThumbnailCandidates(index, plateIndex)
  let thumbnail = thumbnailCandidates
    .map((entry) => suffixEntries.get(entry) ?? null)
    .find((entry) => entry != null) ?? null

  if (!thumbnail) {
    const discoveredDirectThumbnail = pickDiscoveredDirectThumbnail(suffixEntries, plateIndex)
    if (discoveredDirectThumbnail) thumbnail = discoveredDirectThumbnail
  }

  if (!thumbnail) {
    const exactEntries = await deps.readPrinterZipEntries(
      printer,
      printerPath,
      Array.from(new Set([...thumbnailCandidates, ...directThumbnailCandidates])),
      signal
    )
    thumbnail = thumbnailCandidates
      .map((entry) => exactEntries.get(entry) ?? null)
      .find((entry) => entry != null) ?? null
    if (!thumbnail) {
      thumbnail = pickDiscoveredDirectThumbnail(exactEntries, plateIndex)
    }
  }

  return { index, thumbnail }
}

function buildDirectThumbnailProbeCandidates(plateIndex: number | null): string[] {
  if (plateIndex != null) return [`Metadata/plate_${plateIndex}.png`]
  return Array.from({ length: 8 }, (_value, index) => `Metadata/plate_${index + 1}.png`)
}

function pickDiscoveredDirectThumbnail(entries: Map<string, Buffer>, plateIndex: number | null): Buffer | null {
  if (plateIndex != null) return entries.get(`Metadata/plate_${plateIndex}.png`) ?? null

  const discovered = Array.from(entries.entries())
    .filter(([entryPath]) => /^Metadata\/plate_\d+\.png$/i.test(entryPath))
    .map(([_entryPath, buffer]) => buffer)

  return discovered.length === 1 ? discovered[0] ?? null : null
}

function buildIndexFromSuffixEntries(entries: Map<string, Buffer>): ThreeMfIndex {
  const sliceInfoXml = entries.get('Metadata/slice_info.config')?.toString('utf8') ?? null
  const projectSettingsJson = entries.get('Metadata/project_settings.config')?.toString('utf8') ?? null
  const modelSettingsXml = entries.get('Metadata/model_settings.config')?.toString('utf8') ?? null
  const plateNames = modelSettingsXml ? parsePlateNames(modelSettingsXml) : new Map<number, string>()
  return buildThreeMfIndex(sliceInfoXml, projectSettingsJson, plateNames)
}

function parsePlateNames(xml: string): Map<number, string> {
  const out = new Map<number, string>()
  const plateBlocks = xml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []
  for (const block of plateBlocks) {
    const meta = new Map<string, string>()
    for (const match of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
      const key = match[1]
      const value = match[2]
      if (key != null && value != null) meta.set(key, decodeXmlAttributeValue(value))
    }
    const id = Number.parseInt(meta.get('plater_id') ?? '', 10)
    const name = meta.get('plater_name')?.trim()
    if (Number.isFinite(id) && id > 0 && name) out.set(id, name)
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