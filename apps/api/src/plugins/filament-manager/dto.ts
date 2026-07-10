/**
 * Mapping between `FilamentSpool` Prisma rows and the shared `FilamentSpool`
 * DTO, plus the derived fields (`remainPercent`, `status`) the wire shape
 * exposes but the table does not store. Kept separate so both the HTTP routes
 * and the event-driven observers serialize spools identically.
 */
import type { FilamentSpool as FilamentSpoolRow } from '@prisma/client'
import type { FilamentSpool, FilamentSpoolStatus, FilamentRemainSource } from '@printstream/shared'

/** At or below this remaining percentage a spool is flagged "low". */
export const LOW_REMAIN_PERCENT = 25

/** Row shape this module needs, plus the optional denormalized printer name. */
export type SpoolRowWithPrinter = FilamentSpoolRow & {
  loadedPrinter?: { name: string } | null
}

export function parseColors(colorsJson: string | null): string[] {
  if (!colorsJson) return []
  try {
    const parsed: unknown = JSON.parse(colorsJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

export function serializeColors(colors: string[] | undefined): string | null {
  if (!colors || colors.length === 0) return null
  return JSON.stringify(colors)
}

export function computeRemainPercent(remainingGrams: number, netWeightGrams: number): number | null {
  if (!netWeightGrams || netWeightGrams <= 0) return null
  const pct = (remainingGrams / netWeightGrams) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

export function deriveStatus(row: {
  archivedAt: Date | null
  remainingGrams: number
  loadedPrinterId: string | null
  remainPercent: number | null
}): FilamentSpoolStatus {
  // Fill level takes precedence over location so a loaded-but-low spool still
  // reads (and filters) as "low" rather than being masked by "loaded".
  if (row.archivedAt) return 'archived'
  if (row.remainingGrams <= 0) return 'empty'
  if (row.remainPercent != null && row.remainPercent <= LOW_REMAIN_PERCENT) return 'low'
  if (row.loadedPrinterId) return 'loaded'
  return 'available'
}

export function toSpoolDto(row: SpoolRowWithPrinter): FilamentSpool {
  const remainPercent = computeRemainPercent(row.remainingGrams, row.netWeightGrams)
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    brand: row.brand,
    filamentType: row.filamentType,
    materialSubtype: row.materialSubtype,
    colorName: row.colorName,
    colorHex: row.colorHex,
    colors: parseColors(row.colorsJson),
    trayInfoIdx: row.trayInfoIdx,
    bambuUuid: row.bambuUuid,
    slicingPresetName: row.slicingPresetName,
    serial: row.serial,
    nozzleTempMin: row.nozzleTempMin,
    nozzleTempMax: row.nozzleTempMax,
    diameterMm: row.diameterMm,
    netWeightGrams: row.netWeightGrams,
    spoolCoreGrams: row.spoolCoreGrams,
    remainingGrams: row.remainingGrams,
    remainPercent,
    remainSource: row.remainSource as FilamentRemainSource,
    status: deriveStatus({
      archivedAt: row.archivedAt,
      remainingGrams: row.remainingGrams,
      loadedPrinterId: row.loadedPrinterId,
      remainPercent
    }),
    costCents: row.costCents,
    currency: row.currency,
    purchasedAt: row.purchasedAt ? row.purchasedAt.toISOString() : null,
    vendor: row.vendor,
    notes: row.notes,
    loadedPrinterId: row.loadedPrinterId,
    loadedPrinterName: row.loadedPrinter?.name ?? null,
    loadedAmsId: row.loadedAmsId,
    loadedSlotId: row.loadedSlotId,
    loadedAt: row.loadedAt ? row.loadedAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null
  }
}
