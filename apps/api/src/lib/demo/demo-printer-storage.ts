/**
 * Demo-only printer storage source.
 *
 * Public demo printers do not expose a real FTPS filesystem, but the web app's
 * Browse files / Browse models / Browse timelapses dialogs should still feel
 * populated. This module projects a small synthetic printer filesystem backed by
 * real local demo 3MF archives plus a few placeholder timelapse entries.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCoverThumbnailCandidates } from '../cover-thumbnail.js'
import { locateLibraryFile } from '../library-paths.js'
import type { PrinterFsEntry } from '../printer-ftp.js'
import { readEntry, readPlateIndex, type ThreeMfIndex } from '../three-mf.js'

interface DemoStorageFile {
  path: string
  kind: 'library-3mf' | 'timelapse'
  storedPath?: string
  modifiedAt: string
}

const bundledDemoLibraryDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/library'
)

const DEMO_TIMELAPSE_THUMBNAIL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64'
)

const DEMO_STORAGE_FILES: DemoStorageFile[] = [
  {
    path: '/Storage_Box.gcode.3mf',
    kind: 'library-3mf',
    storedPath: '1777174072904-Storage_Box.gcode.3mf',
    modifiedAt: '2026-04-30T18:12:00.000Z'
  },
  {
    path: '/Needle_Lift_Tool.gcode.3mf',
    kind: 'library-3mf',
    storedPath: 'a53055631186f61f-Needle_Lift_Tool.gcode.3mf',
    modifiedAt: '2026-04-29T09:15:00.000Z'
  },
  {
    path: '/projects/Tests_H2D.gcode.3mf',
    kind: 'library-3mf',
    storedPath: '1777267246678-Tests_H2D.gcode.3mf',
    modifiedAt: '2026-04-30T08:45:00.000Z'
  },
  {
    path: '/projects/Tests_P1S.gcode.3mf',
    kind: 'library-3mf',
    storedPath: '1777267246680-Tests_P1S.gcode.3mf',
    modifiedAt: '2026-04-30T08:43:00.000Z'
  },
  {
    path: '/projects/Latch_Needle_Handle.gcode.3mf',
    kind: 'library-3mf',
    storedPath: '1777174072916-Latch_Needle_Handle.gcode.3mf',
    modifiedAt: '2026-04-28T16:10:00.000Z'
  },
  {
    path: '/cache/Simpler_Cablecuff.gcode.3mf',
    kind: 'library-3mf',
    storedPath: '1777174072917-Simpler_Cablecuff.gcode.3mf',
    modifiedAt: '2026-04-28T16:15:00.000Z'
  },
  {
    path: '/cache/Setup_Bonnet_Tags.gcode.3mf',
    kind: 'library-3mf',
    storedPath: '1777174072939-Setup_Bonnet_Tags.gcode.3mf',
    modifiedAt: '2026-04-27T13:22:00.000Z'
  },
  {
    path: '/timelapse/Prototype_X1C_Benchy_2026-04-26_1420.mp4',
    kind: 'timelapse',
    modifiedAt: '2026-04-26T14:20:00.000Z'
  },
  {
    path: '/timelapse/Farm_P1S_Cablecuff_2026-04-27_0915.mp4',
    kind: 'timelapse',
    modifiedAt: '2026-04-27T09:15:00.000Z'
  },
  {
    path: '/timelapse/Lab_H2D_Dual_Color_2026-04-30_1842.mp4',
    kind: 'timelapse',
    modifiedAt: '2026-04-30T18:42:00.000Z'
  }
]

export async function listDemoPrinterStorage(
  dirPath: string,
  options: { recursive?: boolean; maxDepth?: number; skipDirectories?: ReadonlySet<string> } = {}
): Promise<PrinterFsEntry[]> {
  return options.recursive
    ? await listRecursive(dirPath, options.maxDepth ?? 4, options.skipDirectories ?? new Set())
    : await listImmediate(dirPath)
}

export async function readDemoPrinterStorageThreeMfIndex(
  filePath: string,
  signal?: AbortSignal
): Promise<ThreeMfIndex | null> {
  const file = findDemoStorageFile(filePath)
  if (!file || file.kind !== 'library-3mf' || !file.storedPath) return null
  return await readPlateIndex(await resolveDemoLibraryFile(file.storedPath), signal)
}

export async function readDemoPrinterStorageThumbnail(
  filePath: string,
  options: { plateIndex?: number | null; signal?: AbortSignal } = {}
): Promise<{ buffer: Buffer; mimeType: 'image/png' } | null> {
  const file = findDemoStorageFile(filePath)
  if (!file) return null
  if (file.kind === 'timelapse') {
    return { buffer: DEMO_TIMELAPSE_THUMBNAIL_PNG, mimeType: 'image/png' }
  }
  if (!file.storedPath) return null

  const onDisk = await resolveDemoLibraryFile(file.storedPath)
  const index = await readPlateIndex(onDisk, options.signal).catch(() => null)
  for (const entryPath of buildCoverThumbnailCandidates(index, options.plateIndex ?? null)) {
    const png = await readEntry(onDisk, entryPath, options.signal).catch(() => null)
    if (png) return { buffer: png, mimeType: 'image/png' }
  }
  return null
}

export async function readDemoPrinterStorageDownload(filePath: string): Promise<Buffer | null> {
  const file = findDemoStorageFile(filePath)
  if (!file) return null
  if (file.kind === 'timelapse') {
    return Buffer.from(
      `Demo timelapse placeholder for ${path.posix.basename(file.path)}.\n`,
      'utf8'
    )
  }
  if (!file.storedPath) return null
  return await readFile(await resolveDemoLibraryFile(file.storedPath))
}

function findDemoStorageFile(filePath: string): DemoStorageFile | undefined {
  return DEMO_STORAGE_FILES.find((entry) => entry.path === filePath)
}

async function listImmediate(dirPath: string): Promise<PrinterFsEntry[]> {
  const directories = new Set<string>()
  const files: PrinterFsEntry[] = []

  for (const entry of DEMO_STORAGE_FILES) {
    const relative = relativePrinterPath(dirPath, entry.path)
    if (!relative) continue
    const segments = relative.split('/').filter(Boolean)
    if (segments.length === 0) continue
    if (segments.length === 1) {
      files.push(await toPrinterFsEntry(entry, false))
      continue
    }
    directories.add(segments[0] ?? '')
  }

  return [
    ...Array.from(directories)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name, type: 'directory' as const, sizeBytes: 0, modifiedAt: null })),
    ...files.sort((left, right) => left.name.localeCompare(right.name))
  ]
}

async function listRecursive(
  dirPath: string,
  maxDepth: number,
  skipDirectories: ReadonlySet<string>
): Promise<PrinterFsEntry[]> {
  const results: PrinterFsEntry[] = []
  for (const entry of DEMO_STORAGE_FILES) {
    const relative = relativePrinterPath(dirPath, entry.path)
    if (!relative) continue
    const segments = relative.split('/').filter(Boolean)
    if (segments.length === 0) continue
    const directorySegments = segments.slice(0, -1)
    if (directorySegments.length > maxDepth) continue
    if (directorySegments.some((segment) => skipDirectories.has(segment.toLowerCase()))) continue
    results.push(await toPrinterFsEntry(entry, true))
  }
  return results.sort((left, right) => {
    const leftTime = Date.parse(left.modifiedAt ?? '') || 0
    const rightTime = Date.parse(right.modifiedAt ?? '') || 0
    if (leftTime !== rightTime) return rightTime - leftTime
    return left.name.localeCompare(right.name)
  })
}

async function toPrinterFsEntry(entry: DemoStorageFile, includePath: boolean): Promise<PrinterFsEntry> {
  return {
    name: path.posix.basename(entry.path),
    path: includePath ? entry.path : undefined,
    type: 'file',
    sizeBytes: await getDemoStorageFileSize(entry),
    modifiedAt: entry.modifiedAt
  }
}

async function getDemoStorageFileSize(entry: DemoStorageFile): Promise<number> {
  if (entry.kind === 'timelapse') {
    return Buffer.byteLength(`Demo timelapse placeholder for ${path.posix.basename(entry.path)}.\n`)
  }
  if (!entry.storedPath) return 0
  const file = await resolveDemoLibraryFile(entry.storedPath)
  return (await stat(file)).size
}

async function resolveDemoLibraryFile(storedPath: string): Promise<string> {
  try {
    return await locateLibraryFile(storedPath)
  } catch {
    return path.join(bundledDemoLibraryDir, path.basename(storedPath))
  }
}

function relativePrinterPath(rootPath: string, filePath: string): string | null {
  const relative = path.posix.relative(rootPath, filePath)
  if (relative === '') return ''
  if (relative.startsWith('../') || relative === '..') return null
  return relative
}