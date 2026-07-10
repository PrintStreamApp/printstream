import type { OrderTemplate, OrderTemplateVariantInput } from '@printstream/shared'
import { randomUUID } from '../../lib/randomId'

/**
 * Helpers for the orders template editor's grouped per-file draft state.
 */
export interface TemplateDraftPlateQuantity {
  plate: number
  quantity: number
}

export interface TemplateDraftItem {
  /**
   * Stable client-generated id, used as the React list key. Insertion and
   * mid-list deletion are supported, so an array-index key would migrate a row's
   * local state (file picker, plates query) onto the wrong remaining row.
   */
  id: string
  libraryFileId: string
  libraryFileName: string
  notes: string
  plateQuantities: TemplateDraftPlateQuantity[]
}

export interface TemplateDraftVariant {
  /** Stable client-generated id for the React list key (see TemplateDraftItem). */
  id: string
  name: string
  items: TemplateDraftItem[]
}

export function createEmptyTemplateDraftVariant(name = 'Default'): TemplateDraftVariant {
  return {
    id: randomUUID(),
    name,
    items: [createEmptyTemplateDraftItem()]
  }
}

export function createEmptyTemplateDraftItem(): TemplateDraftItem {
  return {
    id: randomUUID(),
    libraryFileId: '',
    libraryFileName: '',
    notes: '',
    plateQuantities: [{ plate: 1, quantity: 1 }]
  }
}

export function groupTemplateItems(items: OrderTemplate['items']): TemplateDraftItem[] {
  const grouped = new Map<string, { item: Omit<TemplateDraftItem, 'plateQuantities' | 'id'>; plateTotals: Map<number, number> }>()

  for (const entry of items) {
    const key = [entry.libraryFileId ?? '', entry.libraryFileName, entry.notes ?? ''].join('\u0000')
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, {
        item: {
          libraryFileId: entry.libraryFileId ?? '',
          libraryFileName: entry.libraryFileName,
          notes: entry.notes ?? ''
        },
        plateTotals: new Map([[normalizePlate(entry.plate), normalizeQuantity(entry.quantity)]])
      })
      continue
    }

    const plate = normalizePlate(entry.plate)
    existing.plateTotals.set(plate, (existing.plateTotals.get(plate) ?? 0) + normalizeQuantity(entry.quantity))
  }

  return Array.from(grouped.values(), ({ item, plateTotals }) => ({
    id: randomUUID(),
    ...item,
    plateQuantities: Array.from(plateTotals.entries())
      .map(([plate, quantity]) => ({ plate, quantity }))
      .sort((left, right) => left.plate - right.plate)
  }))
}

export function groupTemplateVariants(variants: OrderTemplate['variants']): TemplateDraftVariant[] {
  if (variants.length === 0) {
    return [createEmptyTemplateDraftVariant()]
  }

  return variants.map((variant) => ({
    id: randomUUID(),
    name: variant.name,
    items: groupTemplateItems(variant.items)
  }))
}

export function flattenTemplateDraftItems(items: TemplateDraftItem[]): OrderTemplateVariantInput['items'] {
  return items.flatMap((item) => item.plateQuantities
    .map((entry) => ({
      libraryFileId: item.libraryFileId,
      plate: normalizePlate(entry.plate),
      quantity: normalizeQuantity(entry.quantity),
      notes: item.notes || null
    }))
    .filter((entry) => entry.quantity > 0))
}

export function flattenTemplateDraftVariants(variants: TemplateDraftVariant[]): OrderTemplateVariantInput[] {
  return variants.map((variant) => ({
    name: variant.name.trim(),
    items: flattenTemplateDraftItems(variant.items)
  }))
}

export function getTemplateDraftItemQuantity(item: TemplateDraftItem, plate: number): number {
  return item.plateQuantities.find((entry) => entry.plate === normalizePlate(plate))?.quantity ?? 0
}

export function getTemplateDraftItemTotalQuantity(item: TemplateDraftItem): number {
  return item.plateQuantities.reduce((total, entry) => total + normalizeQuantity(entry.quantity), 0)
}

export function setTemplateDraftItemPlateQuantity(item: TemplateDraftItem, plate: number, quantity: number): TemplateDraftItem {
  const normalizedPlate = normalizePlate(plate)
  const normalizedQuantity = normalizeQuantity(quantity)
  const next = item.plateQuantities.filter((entry) => entry.plate !== normalizedPlate)
  if (normalizedQuantity > 0) {
    next.push({ plate: normalizedPlate, quantity: normalizedQuantity })
  }
  return {
    ...item,
    plateQuantities: next.sort((left, right) => left.plate - right.plate)
  }
}

export function renameTemplateDraftItemPlate(item: TemplateDraftItem, previousPlate: number, nextPlate: number): TemplateDraftItem {
  const previous = normalizePlate(previousPlate)
  const next = normalizePlate(nextPlate)
  if (previous === next) return item

  const movingQuantity = getTemplateDraftItemQuantity(item, previous)
  const withoutPrevious = removeTemplateDraftItemPlate(item, previous)
  if (movingQuantity <= 0) return withoutPrevious

  return setTemplateDraftItemPlateQuantity(
    withoutPrevious,
    next,
    getTemplateDraftItemQuantity(withoutPrevious, next) + movingQuantity
  )
}

export function addTemplateDraftItemPlate(item: TemplateDraftItem): TemplateDraftItem {
  const existing = new Set(item.plateQuantities.map((entry) => entry.plate))
  let nextPlate = 1
  while (existing.has(nextPlate)) {
    nextPlate += 1
  }
  return setTemplateDraftItemPlateQuantity(item, nextPlate, 1)
}

export function removeTemplateDraftItemPlate(item: TemplateDraftItem, plate: number): TemplateDraftItem {
  const normalizedPlate = normalizePlate(plate)
  return {
    ...item,
    plateQuantities: item.plateQuantities.filter((entry) => entry.plate !== normalizedPlate)
  }
}

function normalizePlate(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.trunc(value))
}

function normalizeQuantity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(999, Math.trunc(value)))
}