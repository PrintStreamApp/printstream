/**
 * Pure, module-level helpers, constants, and shared types extracted from
 * `OrdersView.tsx`.
 *
 * Owns the orders-plugin data transforms that carry no React state: the order
 * date comparator and sort options, the template/order search matchers, the
 * template copy/variant/file counters, the order print grouping + recency
 * comparator, the order-create variant/print selection builders, and the
 * project-filament draft normalization and color-option derivations shared by
 * `OrdersView`, the order/template cards, and the order/template dialogs. It
 * also holds the cross-file types those surfaces pass around
 * (`PrintTargetState`, the print launchers, `OrderPrintGroup`,
 * `SelectedTemplatePrint*`, etc.).
 *
 * Invariant: nothing here may touch React (no hooks, JSX, or component
 * state/props). These are deterministic helpers and constant tables so the
 * view and its sub-components can import them without pulling in render
 * concerns; keep new pure helpers here rather than re-growing the view.
 *
 * Note: `stopEventPropagation` is a trivial per-plugin copy. Date formatting is
 * NOT duplicated here, order views use the shared `formatDateTime` from
 * `lib/time` so dates render consistently with the rest of the app.
 */
import type {
  LibraryFile,
  Order,
  OrderCreateInput,
  OrderTemplate,
  ThreeMfProjectFilament,
  ThreeMfIndex
} from '@printstream/shared'
import { type DirectorySortDirection } from '../../components/DirectoryControls'
import {
  commonFilamentColorName,
  resolveFilamentColorSwatches,
  resolveProjectFilamentColorName
} from '../../lib/filamentColor'
import { bambuMaterialFromPresetName, bambuMaterialFromType } from '../../data/bambuColors'
import { brandFromPresetName } from '../../data/bambuFilamentPresets'

export interface PrintTargetState {
  orderId: string
  printId: string
  file: LibraryFile
  plate: number
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
}

export type OrderPrintLauncher = (
  file: LibraryFile,
  printId: string,
  plate: number,
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
) => void

export type OrderListPrintLauncher = (
  orderId: string,
  file: LibraryFile,
  printId: string,
  plate: number,
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
) => void

export const LIST_PAGE_SIZE_OPTIONS = [5, 10, 25] as const
export const ORDER_SORT_OPTIONS = [
  { value: 'updated', label: 'Updated' },
  { value: 'created', label: 'Created' }
] as const

export type OrderSortValue = (typeof ORDER_SORT_OPTIONS)[number]['value']

/** A started slicing run for an unsliced-3MF order item, awaiting its print. */
export interface SliceThenPrintState {
  orderId: string
  printId: string
  sourceFile: LibraryFile
  jobId: string
}

export function compareOrderDates(left: Order, right: Order, sortValue: OrderSortValue, sortDirection: DirectorySortDirection): number {
  const leftDate = sortValue === 'created' ? left.createdAt : left.updatedAt
  const rightDate = sortValue === 'created' ? right.createdAt : right.updatedAt
  return sortDirection === 'desc'
    ? rightDate.localeCompare(leftDate)
    : leftDate.localeCompare(rightDate)
}

export function matchesTemplateSearch(template: OrderTemplate, search: string): boolean {
  const normalizedSearch = search.trim().toLowerCase()
  if (!normalizedSearch) return true

  const haystack = [
    template.name,
    template.code,
    template.description,
    template.notesTemplate,
    ...template.variants.map((variant) => variant.name),
    ...template.items.map((item) => [item.libraryFileName, item.notes].join(' '))
  ].filter(Boolean).join(' ').toLowerCase()

  return haystack.includes(normalizedSearch)
}

export function matchesOrderSearch(order: Order, search: string): boolean {
  const normalizedSearch = search.trim().toLowerCase()
  if (!normalizedSearch) return true

  const haystack = [
    order.name,
    order.templateName,
    order.templateCode,
    order.templateDescription,
    order.notes,
    ...order.selectedVariants.map((variant) => variant.templateVariantName),
    ...order.prints.map((print) => [print.libraryFileName, print.notes, print.startedPrinterName].join(' '))
  ].filter(Boolean).join(' ').toLowerCase()

  return haystack.includes(normalizedSearch)
}

export function countTemplateCopies(template: OrderTemplate): number {
  return template.items.reduce((sum, item) => sum + item.quantity, 0)
}

export function countTemplateVariantCopies(variant: OrderTemplate['variants'][number]): number {
  return variant.items.reduce((sum, item) => sum + item.quantity, 0)
}

export function countTemplateFiles(template: OrderTemplate): number {
  return new Set(template.items.map((item) => item.libraryFileName)).size
}

export function getVisibleOrderSelectedVariants(order: Order): Order['selectedVariants'] {
  if (order.selectedVariants.length === 0) return []

  if (
    order.selectedVariants.length === 1
    && order.selectedVariants[0]?.quantity === 1
    && order.selectedVariants[0].templateVariantName === 'Default'
  ) {
    return []
  }

  return order.selectedVariants
}

export function stopEventPropagation(event: { stopPropagation(): void }): void {
  event.stopPropagation()
}

export interface OrderPrintGroup {
  key: string
  groupPosition: number
  libraryFileId: string | null
  libraryFileName: string
  plate: number
  notes: string | null
  projectFilamentOverrides: Order['prints'][number]['projectFilamentOverrides']
  total: number
  completed: number
  awaitingConfirmation: number
  active: number
  pending: number
  fileAvailable: boolean
  startablePrint: Order['prints'][number] | null
  confirmablePrint: Order['prints'][number] | null
  manuallyCompletablePrint: Order['prints'][number] | null
  reopenablePrint: Order['prints'][number] | null
  latestStartedPrinterName: string | null
  latestFinishedAt: string | null
}

export function groupOrderPrints(prints: Order['prints']): OrderPrintGroup[] {
  const groups = new Map<string, Order['prints']>()

  for (const print of prints) {
    const key = [
      print.groupPosition,
      print.templatePrintId ?? '',
      print.libraryFileId ?? '',
      print.libraryFileName,
      print.plate,
      print.notes ?? ''
    ].join('\u0000')
    const existing = groups.get(key)
    if (existing) {
      existing.push(print)
      continue
    }
    groups.set(key, [print])
  }

  return Array.from(groups.entries(), ([key, groupedPrints]) => {
    const sorted = [...groupedPrints].sort((left, right) => left.sequenceNumber - right.sequenceNumber)
    const startablePrint = sorted.find((print) => (
      print.activityState === 'pending'
      || print.activityState === 'failed'
      || print.activityState === 'cancelled'
    )) ?? null
    const confirmablePrint = sorted.find((print) => print.activityState === 'awaiting-confirmation') ?? null
    const reopenablePrint = [...sorted].reverse().find((print) => print.status === 'completed') ?? null
    const latestActivityPrint = [...sorted].sort(compareOrderPrintRecency)[0] ?? null

    return {
      key,
      groupPosition: sorted[0]?.groupPosition ?? 0,
      libraryFileId: sorted[0]?.libraryFileId ?? null,
      libraryFileName: sorted[0]?.libraryFileName ?? '',
      plate: sorted[0]?.plate ?? 1,
      notes: sorted[0]?.notes ?? null,
      projectFilamentOverrides: sorted[0]?.projectFilamentOverrides ?? null,
      total: sorted.length,
      completed: sorted.filter((print) => print.status === 'completed').length,
      awaitingConfirmation: sorted.filter((print) => print.activityState === 'awaiting-confirmation').length,
      active: sorted.filter((print) => print.activityState === 'queued' || print.activityState === 'printing').length,
      pending: sorted.filter((print) => (
        print.activityState === 'pending'
        || print.activityState === 'failed'
        || print.activityState === 'cancelled'
      )).length,
      fileAvailable: sorted.some((print) => print.fileAvailable),
      startablePrint,
      confirmablePrint,
      manuallyCompletablePrint: startablePrint,
      reopenablePrint,
      latestStartedPrinterName: latestActivityPrint?.startedPrinterName ?? null,
      latestFinishedAt: latestActivityPrint?.lastPrintFinishedAt ?? null
    }
  }).sort((left, right) => left.groupPosition - right.groupPosition)
}

export function compareOrderPrintRecency(left: Order['prints'][number], right: Order['prints'][number]): number {
  const leftTime = Date.parse(left.lastPrintFinishedAt ?? left.startedAt ?? '')
  const rightTime = Date.parse(right.lastPrintFinishedAt ?? right.startedAt ?? '')
  return (Number.isFinite(rightTime) ? rightTime : -Infinity) - (Number.isFinite(leftTime) ? leftTime : -Infinity)
}

export function formatTemplateDraftPlateSummary(plate: ThreeMfIndex['plates'][number]): string {
  const uniqueObjects = Array.from(new Set(plate.objects.map((object) => object.name.trim()).filter(Boolean)))
  if (uniqueObjects.length > 0) {
    return uniqueObjects.join(', ')
  }
  if (plate.filaments.length > 0) {
    return `${plate.filaments.length} filament${plate.filaments.length === 1 ? '' : 's'}`
  }
  return 'No indexed objects'
}

export interface SelectedTemplatePrint {
  variantId: string
  variantName: string
  variantQuantity: number
  item: OrderTemplate['variants'][number]['items'][number]
}

export interface SelectedTemplatePrintWithFilaments extends SelectedTemplatePrint {
  plateInfo: ThreeMfIndex['plates'][number] | undefined
  projectFilaments: ThreeMfProjectFilament[]
}

export function createInitialOrderVariantQuantities(template: OrderTemplate | null): Record<string, number> {
  if (!template || template.variants.length <= 1) return {}

  return Object.fromEntries(template.variants.map((variant) => [variant.id, 0]))
}

export function buildSelectedOrderVariantSelections(
  template: OrderTemplate | null,
  variantQuantities: Record<string, number>
): NonNullable<OrderCreateInput['variants']> {
  if (!template) return []

  return template.variants.flatMap((variant) => {
    const quantity = Math.max(0, Math.trunc(variantQuantities[variant.id] ?? 0))
    return quantity > 0
      ? [{ variantId: variant.id, quantity }]
      : []
  })
}

export function buildSelectedTemplatePrints(
  template: OrderTemplate | null,
  variantQuantities: Record<string, number>
): SelectedTemplatePrint[] {
  if (!template) return []

  return template.variants.flatMap((variant) => {
    const variantQuantity = template.variants.length <= 1
      ? 1
      : Math.max(0, Math.trunc(variantQuantities[variant.id] ?? 0))
    if (variantQuantity <= 0) return []

    return variant.items.map((item) => ({
      variantId: variant.id,
      variantName: variant.name,
      variantQuantity,
      item
    }))
  })
}

export function buildTemplatePrintVariantCopyKey(templatePrintId: string, variantCopyIndex: number): string {
  return `${templatePrintId}:${variantCopyIndex}`
}

export function buildTemplatePrintProjectFilaments(
  item: OrderTemplate['variants'][number]['items'][number],
  fileIndex: ThreeMfIndex | undefined
): ThreeMfProjectFilament[] {
  if (!fileIndex) return []
  const plate = fileIndex.plates.find((entry) => entry.index === item.plate)

  if (fileIndex.projectFilaments.length > 0) {
    const plateFilamentIds = new Set((plate?.filaments ?? []).map((filament) => filament.id))
    const relevantProjectFilaments = plateFilamentIds.size > 0
      ? fileIndex.projectFilaments.filter((filament) => plateFilamentIds.has(filament.id))
      : fileIndex.projectFilaments

    return relevantProjectFilaments.map(normalizeProjectFilamentDraft)
  }

  return (plate?.filaments ?? []).map((filament) => normalizeProjectFilamentDraft({
    id: filament.id,
    filamentType: filament.filamentType,
    filamentName: filament.filamentName,
    color: filament.color,
    nozzleId: filament.nozzleId ?? null,
    chamberTemperature: filament.chamberTemperature ?? null
  }))
}

export function buildOrderPrintFilamentOverrides(
  selectedTemplatePrints: Array<SelectedTemplatePrint & { projectFilaments: ThreeMfProjectFilament[] }>,
  printFilamentOverrides: Record<string, ThreeMfProjectFilament[]>
): NonNullable<OrderCreateInput['printFilamentOverrides']> {
  return selectedTemplatePrints.flatMap((templatePrint) => (
    Array.from({ length: templatePrint.variantQuantity }, (_unused, variantCopyIndex) => {
      const projectFilaments = printFilamentOverrides[
        buildTemplatePrintVariantCopyKey(templatePrint.item.id, variantCopyIndex)
      ]
      return projectFilaments && projectFilaments.length > 0
        ? [{
          templatePrintId: templatePrint.item.id,
          variantCopyIndex,
          projectFilaments: projectFilaments.map(normalizeProjectFilamentDraft)
        }]
        : []
    })
  )).flat()
}

export function mergeProjectFilamentDrafts(
  sourceProjectFilaments: readonly ThreeMfProjectFilament[],
  existingProjectFilaments: readonly ThreeMfProjectFilament[] | undefined
): ThreeMfProjectFilament[] {
  const existingById = new Map((existingProjectFilaments ?? []).map((filament) => [filament.id, filament] as const))
  return sourceProjectFilaments.map((filament) => normalizeProjectFilamentDraft(existingById.get(filament.id) ?? filament))
}

export function updateProjectFilamentDraft(
  filaments: readonly ThreeMfProjectFilament[],
  filamentId: number,
  update: (filament: ThreeMfProjectFilament) => ThreeMfProjectFilament
): ThreeMfProjectFilament[] {
  return filaments.map((filament) => filament.id === filamentId
    ? normalizeProjectFilamentDraft(update(filament))
    : normalizeProjectFilamentDraft(filament))
}

export function normalizeProjectFilamentDraft(filament: ThreeMfProjectFilament): ThreeMfProjectFilament {
  return {
    id: filament.id,
    filamentType: filament.filamentType?.trim() || null,
    filamentName: filament.filamentName?.trim() || null,
    color: filament.color?.trim() || null,
    nozzleId: filament.nozzleId ?? null,
    chamberTemperature: filament.chamberTemperature ?? null
  }
}

export function resolveProjectFilamentColorOptions(filament: Pick<ThreeMfProjectFilament, 'filamentName' | 'filamentType'>) {
  const presetBrand = filament.filamentName?.trim()
    ? brandFromPresetName(filament.filamentName.trim())
    : null
  const material = bambuMaterialFromPresetName(filament.filamentName?.trim() ?? '')
    ?? (filament.filamentType ? bambuMaterialFromType(filament.filamentType) : null)
    ?? filament.filamentType

  return resolveFilamentColorSwatches(material, { presetBrand })
}

export function describeProjectFilamentColorOptions(filament: Pick<ThreeMfProjectFilament, 'filamentName' | 'filamentType'>): string {
  const presetBrand = filament.filamentName?.trim()
    ? brandFromPresetName(filament.filamentName.trim())
    : null
  const material = bambuMaterialFromPresetName(filament.filamentName?.trim() ?? '')
    ?? (filament.filamentType ? bambuMaterialFromType(filament.filamentType) : null)
    ?? filament.filamentType
    ?? 'filament'
  const { usesCommonFallback } = resolveProjectFilamentColorOptions(filament)

  return !usesCommonFallback && presetBrand === 'Bambu'
    ? `Bambu ${material} colors`
    : `${material} color suggestions`
}

export function formatProjectFilamentLabel(filament: ThreeMfProjectFilament): string {
  const name = filament.filamentName?.trim() || filament.filamentType?.trim() || `Filament #${filament.id}`
  const color = formatProjectFilamentColorLabel(filament)
  return [name, color].filter(Boolean).join(' · ')
}

export function formatProjectFilamentColorLabel(filament: Pick<ThreeMfProjectFilament, 'color' | 'filamentName' | 'filamentType'>): string | null {
  return resolveProjectFilamentColorName(filament)
    ?? commonFilamentColorName(filament.color)
    ?? filament.color?.toUpperCase()
    ?? null
}

export function toColorPickerValue(color: string | null | undefined): string {
  return /^#[0-9a-fA-F]{6}$/.test(color ?? '')
    ? (color ?? '').toUpperCase()
    : '#808080'
}
