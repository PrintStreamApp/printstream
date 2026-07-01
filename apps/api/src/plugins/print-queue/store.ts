/**
 * Persistence + DTO mapping for the print-queue plugin.
 *
 * Owns the `QueueItem` Prisma shape: the include used everywhere, the row -> DTO
 * mapper, the JSON-column parsers, and the add-time 3MF inspection that snapshots a
 * plate's required filaments so eligibility never re-inspects the file per listing.
 */
import {
  isDirectPrintableFileName,
  queuePrintOptionsSchema,
  queueRequiredFilamentSchema,
  type QueueItem as QueueItemDto,
  type QueueItemPlacement,
  type QueuePrintOptions,
  type QueueRequiredFilament,
  type QueueTargetKind
} from '@printstream/shared'
import type { LibraryFile, Prisma } from '@prisma/client'
import { z } from 'zod'
import { inspectBridgeLibraryThreeMf, resolveLibraryFileToLocalPath } from '../../lib/bridge-library-files.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { unhideSlicedOutput } from '../../lib/library-files.js'
import { getPrintSourceKind } from '../../lib/print-dispatcher.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { readPlateIndex } from '../../lib/three-mf.js'
import type { PluginLogger } from '../../plugin/types.js'

/**
 * Resolve the library file to queue from its id.
 *
 * Accepts a hidden slice-to-queue output and "keeps" it (un-hide) so it survives the
 * 24h unreferenced-slice cleanup and becomes a real queued artifact. Keeping may fold
 * the output into an existing same-name file, yielding a new surviving row id, so the
 * survivor is re-read. Looks up by explicit id (a hidden output is unreachable through
 * the visible-files scope) but rejects recycled (soft-deleted) files, non-slice hidden
 * transients, and anything that isn't a directly printable file.
 *
 * `deps.unhide` is injectable for tests; production uses the real keep path.
 */
export async function resolveQueueableLibraryFile(
  prisma: AnyPrismaClient,
  fileId: string,
  deps: { unhide: typeof unhideSlicedOutput } = { unhide: unhideSlicedOutput }
): Promise<LibraryFile> {
  let file = await prisma.libraryFile.findFirst({ where: { id: fileId, deletedAt: null } })
  if (!file) throw notFound('Library file not found')
  if (file.hidden) {
    if (file.origin !== 'slice') throw notFound('Library file not found')
    const kept = await deps.unhide(file.id)
    const survivor = await prisma.libraryFile.findUnique({ where: { id: kept.id } })
    if (!survivor) throw notFound('Library file not found')
    file = survivor
  }
  if (!isDirectPrintableFileName(file.name)) {
    throw badRequest('Only .gcode or .gcode.3mf files can be queued')
  }
  return file
}

export const queueItemInclude = {
  libraryFile: { select: { id: true } },
  targetPrinter: { select: { id: true, name: true } },
  lastPrinter: { select: { id: true, name: true } }
} satisfies Prisma.QueueItemInclude

export type QueueItemRow = Prisma.QueueItemGetPayload<{ include: typeof queueItemInclude }>

const requiredFilamentsArraySchema = z.array(queueRequiredFilamentSchema)

/** A 3MF index from either the bridge RPC or the local parser (structurally identical here). */
interface InspectedThreeMfIndex {
  plates: Array<{
    index: number
    name: string | null
    plateType: string | null
    nozzleSizes: string[]
    filaments: Array<{ id: number; filamentType: string | null; filamentName: string | null; color: string | null; usedGrams: number | null }>
  }>
  compatiblePrinterModels: string[]
}

export interface InspectedQueuePlate {
  /** False only when a 3MF was readable but the requested plate index is absent. */
  plateExists: boolean
  plateName: string | null
  requiredFilaments: QueueRequiredFilament[]
  /** Printer models the file is compatible with (empty = no constraint / plain gcode). */
  compatibleModels: string[]
  /** Bed/plate type the plate was sliced for (e.g. "Textured PEI Plate"); null when unknown. */
  plateType: string | null
  /** Nozzle diameters the plate was sliced for (e.g. ["0.4"]); empty when unknown. */
  nozzleDiameters: string[]
}

/**
 * Backfill each filament's `usedGrams` from `source` (matched by filament id) when it doesn't already
 * carry it. Grams are authoritative slice data tied to the filament slot — they don't change when the
 * user overrides a material's type/color/brand — so an explicit material override (which omits grams)
 * gets them filled in from the inspected plate (or the prior stored row).
 */
export function withUsedGramsFrom(
  filaments: QueueRequiredFilament[],
  source: QueueRequiredFilament[]
): QueueRequiredFilament[] {
  const gramsById = new Map(source.map((filament) => [filament.id, filament.usedGrams ?? null]))
  return filaments.map((filament) => ({
    ...filament,
    usedGrams: filament.usedGrams ?? gramsById.get(filament.id) ?? null
  }))
}

export function parseRequiredFilaments(json: string | null): QueueRequiredFilament[] {
  if (!json) return []
  try {
    const parsed = requiredFilamentsArraySchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function parsePrintOptions(json: string | null): QueuePrintOptions {
  let raw: unknown = {}
  if (json) {
    try {
      raw = JSON.parse(json)
    } catch {
      raw = {}
    }
  }
  const parsed = queuePrintOptionsSchema.safeParse(raw)
  return parsed.success ? parsed.data : queuePrintOptionsSchema.parse({})
}

export function parseCompatibleModels(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function parseNozzleDiameters(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function parseAmsMapping(json: string | null): number[] | null {
  if (!json) return null
  try {
    const parsed = z.array(z.number().int()).safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Combine an explicit per-filament tray mapping with the matcher's computed mapping for the
 * dispatched printer. An explicit slot (>= 0) wins; an entry left at the `-1` "auto" sentinel — a
 * material-mode filament the user pinned to a library / custom material rather than a fixed slot —
 * takes the computed (material-matched) slot. Lets a specific-printer queue item mix slot-mapped and
 * material-matched filaments. `null`/empty override → use the computed mapping as-is.
 */
export function mergeAmsMapping(override: number[] | null, computed: number[] | undefined): number[] | undefined {
  if (!override || override.length === 0) return computed && computed.length > 0 ? computed : undefined
  if (!computed || computed.length === 0) return override
  const length = Math.max(override.length, computed.length)
  const merged: number[] = []
  for (let index = 0; index < length; index += 1) {
    const explicit = override[index]
    merged[index] = explicit != null && explicit >= 0 ? explicit : computed[index] ?? -1
  }
  return merged
}

function normalizeStatus(value: string): QueueItemDto['status'] {
  switch (value) {
    case 'queued':
    case 'held':
    case 'dispatching':
    case 'printing':
    case 'done':
    case 'failed':
      return value
    default:
      return 'queued'
  }
}

function normalizeResult(value: string | null): QueueItemDto['lastResult'] {
  return value === 'success' || value === 'failed' || value === 'cancelled' ? value : null
}

export function toQueueItemDto(row: QueueItemRow): QueueItemDto {
  return {
    id: row.id,
    libraryFileId: row.libraryFileId,
    fileAvailable: Boolean(row.libraryFileId && row.libraryFile),
    fileName: row.fileName,
    kind: row.kind === '3mf' ? '3mf' : 'gcode',
    plateIndex: row.plateIndex,
    plateName: row.plateName,
    quantity: row.quantity,
    completedCount: row.completedCount,
    remaining: Math.max(0, row.quantity - row.completedCount),
    sortKey: row.sortKey,
    target: {
      kind: row.targetKind as QueueTargetKind,
      printerId: row.targetPrinterId,
      model: row.targetModel
    },
    targetPrinterName: row.targetPrinter?.name ?? null,
    requiredFilaments: parseRequiredFilaments(row.requiredFilamentsJson),
    compatibleModels: parseCompatibleModels(row.compatibleModelsJson),
    plateType: row.plateType ?? null,
    nozzleDiameters: parseNozzleDiameters(row.nozzleDiametersJson),
    amsMapping: parseAmsMapping(row.amsMappingJson),
    options: parsePrintOptions(row.printOptionsJson),
    status: normalizeStatus(row.status),
    label: row.label,
    orderId: row.orderId,
    orderPrintId: row.orderPrintId,
    lastPrinterId: row.lastPrinterId,
    lastPrinterName: row.lastPrinter?.name ?? null,
    lastResult: normalizeResult(row.lastResult),
    lastDispatchedAt: row.lastDispatchedAt?.toISOString() ?? null,
    lastFinishedAt: row.lastFinishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

/** Reduce a row to just what the shared matcher needs to place it on a printer. */
export function toQueueItemPlacement(row: Pick<QueueItemRow, 'targetKind' | 'targetPrinterId' | 'targetModel' | 'requiredFilamentsJson' | 'compatibleModelsJson'>): QueueItemPlacement {
  return {
    targetKind: row.targetKind as QueueTargetKind,
    targetPrinterId: row.targetPrinterId,
    targetModel: row.targetModel,
    requiredFilaments: parseRequiredFilaments(row.requiredFilamentsJson),
    compatibleModels: parseCompatibleModels(row.compatibleModelsJson)
  }
}

/**
 * Inspect a plate at add time for its name and required filaments. Library files are
 * bridge-owned by default, so this goes through the same inspection path the UI uses
 * (bridge `library.inspect3mf`, with a local-copy fallback) rather than parsing on the
 * API filesystem. A plain `.gcode` (single plate, unknown materials) is always plate 1
 * with no constraint. A failed 3MF inspection is treated as readable-but-unconstrained
 * (plate assumed present) rather than blocking the add.
 */
export async function inspectQueuePlate(
  file: { name: string; ownerBridgeId: string | null; storedPath: string },
  plate: number,
  logger: PluginLogger
): Promise<InspectedQueuePlate> {
  if (getPrintSourceKind(file.name) !== '3mf') {
    return { plateExists: plate === 1, plateName: null, requiredFilaments: [], compatibleModels: [], plateType: null, nozzleDiameters: [] }
  }
  try {
    const index: InspectedThreeMfIndex = file.ownerBridgeId
      ? await inspectBridgeLibraryThreeMf(file)
      : await readPlateIndex(await resolveLibraryFileToLocalPath(file))
    const compatibleModels = index.compatiblePrinterModels ?? []
    const plateEntry = index.plates.find((entry) => entry.index === plate)
    if (!plateEntry) return { plateExists: false, plateName: null, requiredFilaments: [], compatibleModels, plateType: null, nozzleDiameters: [] }
    return {
      plateExists: true,
      plateName: plateEntry.name?.trim() || null,
      requiredFilaments: plateEntry.filaments.map((filament) => ({
        id: filament.id,
        filamentType: filament.filamentType,
        filamentName: filament.filamentName,
        color: filament.color,
        usedGrams: filament.usedGrams
      })),
      compatibleModels,
      plateType: plateEntry.plateType?.trim() || null,
      nozzleDiameters: plateEntry.nozzleSizes ?? []
    }
  } catch (error) {
    logger.warn('Could not inspect 3MF for queued plate; treating as unconstrained', {
      libraryFileName: file.name,
      plate,
      error
    })
    return { plateExists: true, plateName: null, requiredFilaments: [], compatibleModels: [], plateType: null, nozzleDiameters: [] }
  }
}
