/**
 * Data-access helpers for filament spools and their consumption ledger.
 *
 * Every function takes an explicit `db` (the tenant-scoped request client or
 * `rootPrisma` for event/startup code) and `tenantId`, and filters by tenant on
 * every operation, so the same path is correct in and out of a request context.
 * Single-row writes use `updateMany`/`deleteMany` with `{ id, tenantId }` rather
 * than `update({ where: { id } })` so the tenant filter is enforced atomically.
 */
import type { Prisma } from '@prisma/client'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import {
  buildFilamentUsageSlices,
  type SpoolCreateInput,
  type SpoolUpdateInput,
  type SpoolAssignInput,
  type FilamentUsageSource,
  type FilamentUsageStats
} from '@printstream/shared'
import { serializeColors, type SpoolRowWithPrinter } from './dto.js'

const loadedPrinterInclude = { loadedPrinter: { select: { name: true } } }

export type ListSpoolsOptions = {
  includeArchived?: boolean
  includeDeleted?: boolean
}

export async function listSpoolRows(
  db: AnyPrismaClient,
  tenantId: string,
  options: ListSpoolsOptions = {}
): Promise<SpoolRowWithPrinter[]> {
  const where: Prisma.FilamentSpoolWhereInput = { tenantId }
  if (!options.includeDeleted) where.deletedAt = null
  if (!options.includeArchived) where.archivedAt = null
  return db.filamentSpool.findMany({
    where,
    include: loadedPrinterInclude,
    orderBy: [{ updatedAt: 'desc' }]
  }) as Promise<SpoolRowWithPrinter[]>
}

export async function getSpoolRow(
  db: AnyPrismaClient,
  tenantId: string,
  id: string
): Promise<SpoolRowWithPrinter | null> {
  return db.filamentSpool.findFirst({
    where: { id, tenantId },
    include: loadedPrinterInclude
  }) as Promise<SpoolRowWithPrinter | null>
}

/** Translate the shared writable shape into Prisma create/update data. */
function writableData(input: Partial<SpoolCreateInput>): Prisma.FilamentSpoolUncheckedUpdateInput {
  const data: Prisma.FilamentSpoolUncheckedUpdateInput = {}
  const assign = <K extends keyof typeof data>(key: K, value: (typeof data)[K] | undefined) => {
    if (value !== undefined) data[key] = value
  }
  assign('brand', input.brand ?? undefined)
  assign('filamentType', input.filamentType)
  assign('materialSubtype', input.materialSubtype ?? undefined)
  assign('colorName', input.colorName ?? undefined)
  assign('colorHex', input.colorHex ?? undefined)
  if (input.colors !== undefined) data.colorsJson = serializeColors(input.colors)
  assign('trayInfoIdx', input.trayInfoIdx ?? undefined)
  assign('bambuUuid', input.bambuUuid ?? undefined)
  assign('serial', input.serial ?? undefined)
  assign('nozzleTempMin', input.nozzleTempMin ?? undefined)
  assign('nozzleTempMax', input.nozzleTempMax ?? undefined)
  assign('diameterMm', input.diameterMm)
  assign('netWeightGrams', input.netWeightGrams)
  assign('spoolCoreGrams', input.spoolCoreGrams ?? undefined)
  assign('remainingGrams', input.remainingGrams)
  assign('remainSource', input.remainSource)
  assign('costCents', input.costCents ?? undefined)
  assign('currency', input.currency ?? undefined)
  if (input.purchasedAt !== undefined) data.purchasedAt = input.purchasedAt ? new Date(input.purchasedAt) : null
  assign('vendor', input.vendor ?? undefined)
  assign('notes', input.notes ?? undefined)
  return data
}

export async function createSpoolRow(
  db: AnyPrismaClient,
  tenantId: string,
  input: SpoolCreateInput
): Promise<SpoolRowWithPrinter> {
  const netWeightGrams = input.netWeightGrams ?? 1000
  const created = await db.filamentSpool.create({
    data: {
      ...(writableData(input) as Prisma.FilamentSpoolUncheckedCreateInput),
      tenantId,
      filamentType: input.filamentType,
      netWeightGrams,
      remainingGrams: input.remainingGrams ?? netWeightGrams,
      remainSource: input.remainSource ?? 'manual'
    },
    include: loadedPrinterInclude
  })
  return created as SpoolRowWithPrinter
}

export async function updateSpoolRow(
  db: AnyPrismaClient,
  tenantId: string,
  id: string,
  input: SpoolUpdateInput
): Promise<SpoolRowWithPrinter | null> {
  const data = writableData(input)
  if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null
  const result = await db.filamentSpool.updateMany({ where: { id, tenantId }, data })
  if (result.count === 0) return null
  return getSpoolRow(db, tenantId, id)
}

/**
 * Apply a manual quantity correction and append a `manual` ledger row. Returns
 * null when the spool is missing. `deltaGrams` is signed; `remainingGrams` sets
 * an absolute value (a weigh-in / refill).
 */
export async function adjustSpoolRow(
  db: AnyPrismaClient,
  tenantId: string,
  id: string,
  input: { remainingGrams?: number; deltaGrams?: number; note?: string }
): Promise<SpoolRowWithPrinter | null> {
  const current = await getSpoolRow(db, tenantId, id)
  if (!current) return null
  const next = input.remainingGrams != null
    ? input.remainingGrams
    : Math.max(0, current.remainingGrams + (input.deltaGrams ?? 0))
  const delta = next - current.remainingGrams
  await db.filamentSpool.updateMany({ where: { id, tenantId }, data: { remainingGrams: next } })
  await recordUsage(db, tenantId, id, { grams: -delta, source: 'manual', note: input.note ?? null })
  return getSpoolRow(db, tenantId, id)
}

export async function assignSpoolRow(
  db: AnyPrismaClient,
  tenantId: string,
  id: string,
  input: SpoolAssignInput
): Promise<SpoolRowWithPrinter | null> {
  const now = new Date()
  const result = await db.filamentSpool.updateMany({
    where: { id, tenantId },
    data: {
      loadedPrinterId: input.printerId,
      loadedAmsId: input.amsId,
      loadedSlotId: input.slotId ?? null,
      loadedAt: now,
      lastSeenAt: now,
      archivedAt: null
    }
  })
  if (result.count === 0) return null
  return getSpoolRow(db, tenantId, id)
}

export async function unassignSpoolRow(
  db: AnyPrismaClient,
  tenantId: string,
  id: string
): Promise<SpoolRowWithPrinter | null> {
  const result = await db.filamentSpool.updateMany({
    where: { id, tenantId },
    data: { loadedPrinterId: null, loadedAmsId: null, loadedSlotId: null, loadedAt: null }
  })
  if (result.count === 0) return null
  return getSpoolRow(db, tenantId, id)
}

export async function recycleSpoolRow(db: AnyPrismaClient, tenantId: string, id: string): Promise<boolean> {
  const result = await db.filamentSpool.updateMany({
    where: { id, tenantId, deletedAt: null },
    data: { deletedAt: new Date(), loadedPrinterId: null, loadedAmsId: null, loadedSlotId: null, loadedAt: null }
  })
  return result.count > 0
}

export async function restoreSpoolRow(db: AnyPrismaClient, tenantId: string, id: string): Promise<SpoolRowWithPrinter | null> {
  const result = await db.filamentSpool.updateMany({ where: { id, tenantId }, data: { deletedAt: null } })
  if (result.count === 0) return null
  return getSpoolRow(db, tenantId, id)
}

export async function deleteSpoolRow(db: AnyPrismaClient, tenantId: string, id: string): Promise<boolean> {
  const result = await db.filamentSpool.deleteMany({ where: { id, tenantId } })
  return result.count > 0
}

export async function listUsageRows(db: AnyPrismaClient, tenantId: string, spoolId: string, limit = 200) {
  return db.filamentSpoolUsage.findMany({
    where: { tenantId, spoolId },
    orderBy: { recordedAt: 'desc' },
    take: limit
  })
}

/** Fallback label for spools that have no brand recorded. */
const UNBRANDED_LABEL = 'Unbranded'

/** One filament-usage groupBy row: the grouped key field plus summed weights. */
type UsageGroupRow = {
  filamentType?: string
  brand?: string | null
  _sum: { netWeightGrams: number | null; remainingGrams: number | null }
}

/**
 * `groupBy` is not callable on the `AnyPrismaClient` union (its conditional
 * overloads don't unify), so bind it to a concrete signature for the two
 * filament-usage groupings — same workaround as `print-outcome-breakdown.ts`.
 */
type UsageGroupBy = (args: {
  by: ['filamentType'] | ['brand']
  where: Prisma.FilamentSpoolWhereInput
  _sum: { netWeightGrams: true; remainingGrams: true }
}) => Promise<UsageGroupRow[]>

/**
 * Aggregate filament *used* (net weight minus remaining, per spool) across the
 * workspace's inventory, grouped by filament type and by brand. Reads the
 * inventory delta rather than the consumption ledger so it counts both
 * printer-tracked (Bambu remain%) and per-job-tracked spools — the ledger has
 * no rows for the Bambu half. Recycled (soft-deleted) spools are excluded;
 * archived/used-up spools are kept so their past usage still counts. Slice
 * shaping is shared with the platform-wide aggregation via `buildFilamentUsageSlices`.
 */
export async function readFilamentUsageStats(
  db: AnyPrismaClient,
  tenantId: string
): Promise<FilamentUsageStats> {
  const where: Prisma.FilamentSpoolWhereInput = { tenantId, deletedAt: null }
  const groupBy = db.filamentSpool.groupBy as unknown as UsageGroupBy
  const [byTypeRows, byBrandRows] = await Promise.all([
    groupBy({ by: ['filamentType'], where, _sum: { netWeightGrams: true, remainingGrams: true } }),
    groupBy({ by: ['brand'], where, _sum: { netWeightGrams: true, remainingGrams: true } })
  ])

  const byType = buildFilamentUsageSlices(
    byTypeRows.map((row) => ({ label: row.filamentType, netWeightGrams: row._sum.netWeightGrams, remainingGrams: row._sum.remainingGrams })),
    'Unknown'
  )
  const byBrand = buildFilamentUsageSlices(
    byBrandRows.map((row) => ({ label: row.brand, netWeightGrams: row._sum.netWeightGrams, remainingGrams: row._sum.remainingGrams })),
    UNBRANDED_LABEL
  )
  const totalGramsUsed = byType.reduce((total, slice) => total + slice.gramsUsed, 0)
  return { totalGramsUsed, byType, byBrand }
}

/**
 * Identity of the spool currently loaded in a specific AMS slot, or `null` when
 * no tracked spool maps to it. Backs the shared slot-filament resolver so other
 * plugins (e.g. calibration) can tie work to the loaded spool without importing
 * this one. Most-recently-loaded row wins if more than one somehow claims a slot.
 */
export async function findLoadedSpoolIdentity(
  db: AnyPrismaClient,
  tenantId: string,
  printerId: string,
  amsId: number,
  slotId: number
): Promise<{ spoolId: string; brand: string | null; filamentType: string; materialSubtype: string | null; colorName: string | null } | null> {
  const spool = await db.filamentSpool.findFirst({
    where: { tenantId, loadedPrinterId: printerId, loadedAmsId: amsId, loadedSlotId: slotId, deletedAt: null },
    select: { id: true, brand: true, filamentType: true, materialSubtype: true, colorName: true },
    orderBy: { loadedAt: 'desc' }
  })
  if (!spool) return null
  return {
    spoolId: spool.id,
    brand: spool.brand,
    filamentType: spool.filamentType,
    materialSubtype: spool.materialSubtype,
    colorName: spool.colorName
  }
}

/** Append a consumption-ledger row. Positive `grams` = filament consumed. */
export async function recordUsage(
  db: AnyPrismaClient,
  tenantId: string,
  spoolId: string,
  entry: { grams: number; source: FilamentUsageSource; jobId?: string | null; note?: string | null }
): Promise<void> {
  await db.filamentSpoolUsage.create({
    data: {
      tenantId,
      spoolId,
      grams: entry.grams,
      source: entry.source,
      jobId: entry.jobId ?? null,
      note: entry.note ?? null
    }
  })
}
