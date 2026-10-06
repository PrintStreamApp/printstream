/**
 * Saved printer-view toolbar drafts.
 *
 * Overview owns local defaults, while a saved view holds toolbar changes until
 * Save. Set-valued filters compare without ordering so a reordered selection
 * does not show a false unsaved-change warning.
 */
import type { PrinterView, PrinterViewInput } from '@printstream/shared'
import { sameStringSet } from './printersViewHelpers.js'

export type PrinterViewContent = Pick<
  PrinterViewInput,
  'sort' | 'group' | 'stateFilter' | 'modelFilter' |
  'nozzleDiameterFilter' | 'plateTypeFilter' | 'printerIds'
>

export type PrinterViewDraft = Partial<PrinterViewContent>

/** Resolve the toolbar's displayed content from saved values or Overview defaults. */
export function resolvePrinterViewContent(
  activeView: PrinterView | null,
  draft: PrinterViewDraft | null,
  defaults: PrinterViewContent
): PrinterViewContent {
  if (!activeView) return defaults

  return {
    sort: draft?.sort ?? activeView.sort,
    group: draft?.group ?? activeView.group,
    stateFilter: draft?.stateFilter ?? activeView.stateFilter,
    modelFilter: draft?.modelFilter ?? activeView.modelFilter,
    nozzleDiameterFilter: draft?.nozzleDiameterFilter ?? activeView.nozzleDiameterFilter,
    plateTypeFilter: draft?.plateTypeFilter ?? activeView.plateTypeFilter,
    printerIds: draft?.printerIds ?? activeView.printerIds
  }
}

/** A saved view is dirty only when displayed toolbar content actually differs. */
export function isPrinterViewDraftDirty(activeView: PrinterView | null, content: PrinterViewContent): boolean {
  if (!activeView) return false

  return content.sort.key !== activeView.sort.key
    || content.sort.direction !== activeView.sort.direction
    || content.group !== activeView.group
    || content.stateFilter !== activeView.stateFilter
    || !sameStringSet(content.modelFilter, activeView.modelFilter)
    || !sameStringSet(content.nozzleDiameterFilter, activeView.nozzleDiameterFilter)
    || !sameStringSet(content.plateTypeFilter, activeView.plateTypeFilter)
    || !sameStringSet(content.printerIds, activeView.printerIds)
}

/** Preserve dialog-owned layout and identity while saving toolbar content. */
export function printerViewInputWithContent(activeView: PrinterView, content: PrinterViewContent): PrinterViewInput {
  return {
    name: activeView.name,
    cardsPerRow: activeView.cardsPerRow,
    cardContentSettings: activeView.cardContentSettings,
    ...content
  }
}
