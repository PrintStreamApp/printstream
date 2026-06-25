/**
 * Pure search / filter / sort / group logic and display helpers for the spool
 * library. Kept out of the view so it stays testable and the components stay
 * focused on rendering.
 */
import type { FilamentSpool, FilamentSpoolStatus } from '@printstream/shared'
import { resolveProjectFilamentColorName } from '../../lib/filamentColor'

export type SpoolSort = 'used' | 'remaining' | 'brand' | 'type' | 'name'
export type SpoolGroupBy = 'none' | 'type' | 'brand' | 'color' | 'status'

export type SpoolFilterState = {
  search: string
  types: string[]
  brands: string[]
  statuses: FilamentSpoolStatus[]
}

export const EMPTY_FILTERS: SpoolFilterState = { search: '', types: [], brands: [], statuses: [] }

export const SPOOL_SORT_OPTIONS: ReadonlyArray<{ value: SpoolSort; label: string }> = [
  { value: 'used', label: 'Recently used' },
  { value: 'remaining', label: 'Remaining' },
  { value: 'brand', label: 'Brand' },
  { value: 'type', label: 'Material' },
  { value: 'name', label: 'Name' }
]

export const SPOOL_GROUP_OPTIONS: ReadonlyArray<{ value: SpoolGroupBy; label: string }> = [
  { value: 'none', label: 'No grouping' },
  { value: 'type', label: 'Material' },
  { value: 'brand', label: 'Brand' },
  { value: 'color', label: 'Colour' },
  { value: 'status', label: 'Status' }
]

export const STATUS_LABELS: Record<FilamentSpoolStatus, string> = {
  available: 'Available',
  loaded: 'Loaded',
  low: 'Low',
  empty: 'Empty',
  archived: 'Archived'
}

export const STATUS_COLORS: Record<FilamentSpoolStatus, 'success' | 'primary' | 'warning' | 'danger' | 'neutral'> = {
  available: 'success',
  loaded: 'primary',
  low: 'warning',
  empty: 'danger',
  archived: 'neutral'
}

export function friendlyColorName(spool: Pick<FilamentSpool, 'colorName' | 'colorHex' | 'filamentType'>): string | null {
  if (spool.colorName) return spool.colorName
  return resolveProjectFilamentColorName({ color: spool.colorHex, filamentName: null, filamentType: spool.filamentType })
    ?? spool.colorHex
}

/** Human title for a spool, e.g. "Bambu PLA Basic — Scarlet Red". */
export function spoolTitle(spool: FilamentSpool): string {
  const material = spool.materialSubtype ?? spool.filamentType
  const left = [spool.brand, material].filter(Boolean).join(' ')
  const color = friendlyColorName(spool)
  return color ? `${left || material} — ${color}` : (left || material)
}

export function formatGrams(grams: number): string {
  return `${Math.round(grams)} g`
}

/** Where a spool is currently loaded, e.g. "X1C · AMS A slot 2", or null. */
export function formatLoadedLocation(spool: FilamentSpool): string | null {
  if (spool.loadedAmsId == null && !spool.loadedPrinterId) return null
  let slotDesc: string
  if (spool.loadedAmsId === 255) slotDesc = 'External spool (right)'
  else if (spool.loadedAmsId === 254) slotDesc = 'External spool (left)'
  else if (spool.loadedAmsId != null) {
    const unit = String.fromCharCode(65 + spool.loadedAmsId)
    slotDesc = `AMS ${unit}${spool.loadedSlotId != null ? ` slot ${spool.loadedSlotId + 1}` : ''}`
  } else slotDesc = ''
  const printer = spool.loadedPrinterName ?? 'a printer'
  return slotDesc ? `${printer} · ${slotDesc}` : printer
}

export function deriveFacets(spools: FilamentSpool[]): { types: string[]; brands: string[] } {
  const types = new Set<string>()
  const brands = new Set<string>()
  for (const spool of spools) {
    if (spool.filamentType) types.add(spool.filamentType)
    if (spool.brand) brands.add(spool.brand)
  }
  return {
    types: [...types].sort((a, b) => a.localeCompare(b)),
    brands: [...brands].sort((a, b) => a.localeCompare(b))
  }
}

export function countActiveFilters(filters: SpoolFilterState): number {
  return filters.types.length + filters.brands.length + filters.statuses.length
}

function matchesSearch(spool: FilamentSpool, query: string): boolean {
  if (!query) return true
  const haystack = [
    spool.brand, spool.filamentType, spool.materialSubtype, friendlyColorName(spool),
    spool.vendor, spool.serial, spool.notes, spool.loadedPrinterName
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(query.toLowerCase())
}

export function applyFilters(spools: FilamentSpool[], filters: SpoolFilterState): FilamentSpool[] {
  return spools.filter((spool) => {
    if (!matchesSearch(spool, filters.search.trim())) return false
    if (filters.types.length > 0 && !filters.types.includes(spool.filamentType)) return false
    if (filters.brands.length > 0 && !(spool.brand && filters.brands.includes(spool.brand))) return false
    if (filters.statuses.length > 0 && !filters.statuses.includes(spool.status)) return false
    return true
  })
}

export function sortSpools(spools: FilamentSpool[], sort: SpoolSort, direction: 'asc' | 'desc'): FilamentSpool[] {
  const factor = direction === 'asc' ? 1 : -1
  const compare = (a: FilamentSpool, b: FilamentSpool): number => {
    switch (sort) {
      case 'remaining':
        return (a.remainingGrams - b.remainingGrams) * factor
      case 'brand':
        return (a.brand ?? '').localeCompare(b.brand ?? '') * factor
      case 'type':
        return a.filamentType.localeCompare(b.filamentType) * factor
      case 'name':
        return spoolTitle(a).localeCompare(spoolTitle(b)) * factor
      case 'used':
      default: {
        // "Recently used" = last seen loaded in a slot, falling back to the last edit.
        const av = a.lastSeenAt ?? a.updatedAt
        const bv = b.lastSeenAt ?? b.updatedAt
        return (av < bv ? -1 : av > bv ? 1 : 0) * factor
      }
    }
  }
  return [...spools].sort(compare)
}

export type SpoolGroup = { key: string; label: string; spools: FilamentSpool[] }

export function groupSpools(spools: FilamentSpool[], group: SpoolGroupBy): SpoolGroup[] {
  if (group === 'none') return [{ key: 'all', label: '', spools }]
  const buckets = new Map<string, SpoolGroup>()
  for (const spool of spools) {
    let label: string
    switch (group) {
      case 'type': label = spool.filamentType; break
      case 'brand': label = spool.brand ?? 'Unbranded'; break
      case 'color': label = friendlyColorName(spool) ?? 'No colour'; break
      case 'status': label = STATUS_LABELS[spool.status]; break
      default: label = ''
    }
    const key = label.toLowerCase()
    const bucket = buckets.get(key) ?? { key, label, spools: [] }
    bucket.spools.push(spool)
    buckets.set(key, bucket)
  }
  return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label))
}
