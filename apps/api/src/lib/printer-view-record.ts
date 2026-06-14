/**
 * Printer-view row serialization helpers.
 *
 * Saved printer views persist structured UI preferences in the database as a
 * mix of scalar columns and JSON strings. These helpers normalize that
 * storage into the shared DTO contracts consumed by the web app.
 */
import {
  defaultPrinterCardContentSettings,
  defaultPrinterViewSort,
  printerCardContentSettingsSchema,
  printerViewModelFilterSchema,
  printerViewNozzleDiameterFilterSchema,
  printerViewPlateTypeFilterSchema,
  printerViewSortSchema,
  printerViewStateFilterSchema,
  type PrinterCardContentSettings,
  type PrinterView,
  type PrinterViewInput,
  type PrinterViewModelFilter,
  type PrinterViewNozzleDiameterFilter,
  type PrinterViewPlateTypeFilter,
  type PrinterViewSort,
  type PrinterViewStateFilter
} from '@printstream/shared'

interface PrinterViewRowLike {
  id: string
  name: string
  printerIds?: string | null
  cardsPerRow: number
  stateFilter: string
  modelFilter: string
  nozzleDiameterFilter: string
  plateTypeFilter: string
  sortKey: string
  sortDirection: string
  cardContentSettings: string
  createdAt: Date
  updatedAt: Date
}

export function parseStoredPrinterViewIds(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .filter((entry, index, array) => index === array.indexOf(entry))
  } catch {
    return []
  }
}

export function serializePrinterViewIds(value: readonly string[] | undefined): string | null {
  const normalized = (value ?? [])
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .filter((entry, index, array) => index === array.indexOf(entry))

  return normalized.length > 0 ? JSON.stringify(normalized) : null
}

export function parseStoredPrinterCardContentSettings(value: string | null | undefined): PrinterCardContentSettings {
  if (!value) return defaultPrinterCardContentSettings
  try {
    const parsed = JSON.parse(value) as unknown
    const result = printerCardContentSettingsSchema.safeParse(parsed)
    return result.success ? result.data : defaultPrinterCardContentSettings
  } catch {
    return defaultPrinterCardContentSettings
  }
}

export function serializePrinterCardContentSettings(value: PrinterViewInput['cardContentSettings']): string {
  return JSON.stringify(printerCardContentSettingsSchema.parse(value))
}

export function parseStoredPrinterViewSort(
  sortKey: string | null | undefined,
  sortDirection: string | null | undefined
): PrinterViewSort {
  const result = printerViewSortSchema.safeParse({
    key: sortKey ?? defaultPrinterViewSort.key,
    direction: sortDirection ?? defaultPrinterViewSort.direction
  })
  return result.success ? result.data : defaultPrinterViewSort
}

export function parseStoredPrinterViewStateFilter(value: string | null | undefined): PrinterViewStateFilter {
  const result = printerViewStateFilterSchema.safeParse(value ?? 'all')
  return result.success ? result.data : 'all'
}

export function parseStoredPrinterViewModelFilter(value: string | null | undefined): PrinterViewModelFilter {
  return parseStoredFilterArray(value, printerViewModelFilterSchema)
}

export function serializePrinterViewModelFilter(value: PrinterViewInput['modelFilter']): string {
  return JSON.stringify(printerViewModelFilterSchema.parse(value))
}

export function parseStoredPrinterViewNozzleDiameterFilter(value: string | null | undefined): PrinterViewNozzleDiameterFilter {
  return parseStoredFilterArray(value, printerViewNozzleDiameterFilterSchema)
}

export function serializePrinterViewNozzleDiameterFilter(value: PrinterViewInput['nozzleDiameterFilter']): string {
  return JSON.stringify(printerViewNozzleDiameterFilterSchema.parse(value))
}

export function parseStoredPrinterViewPlateTypeFilter(value: string | null | undefined): PrinterViewPlateTypeFilter {
  return parseStoredFilterArray(value, printerViewPlateTypeFilterSchema)
}

export function serializePrinterViewPlateTypeFilter(value: PrinterViewInput['plateTypeFilter']): string {
  return JSON.stringify(printerViewPlateTypeFilterSchema.parse(value))
}

function parseStoredFilterArray<T>(value: string | null | undefined, schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false } }): T {
  const empty = schema.safeParse([])
  const fallback = empty.success ? empty.data : ([] as unknown as T)
  if (!value) return fallback
  try {
    const result = schema.safeParse(JSON.parse(value))
    return result.success ? result.data : fallback
  } catch {
    return fallback
  }
}

export function toPrinterViewDto(row: PrinterViewRowLike): PrinterView {
  return {
    id: row.id,
    name: row.name,
    printerIds: parseStoredPrinterViewIds(row.printerIds),
    cardsPerRow: row.cardsPerRow,
    stateFilter: parseStoredPrinterViewStateFilter(row.stateFilter),
    modelFilter: parseStoredPrinterViewModelFilter(row.modelFilter),
    nozzleDiameterFilter: parseStoredPrinterViewNozzleDiameterFilter(row.nozzleDiameterFilter),
    plateTypeFilter: parseStoredPrinterViewPlateTypeFilter(row.plateTypeFilter),
    sort: parseStoredPrinterViewSort(row.sortKey, row.sortDirection),
    cardContentSettings: parseStoredPrinterCardContentSettings(row.cardContentSettings),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}
