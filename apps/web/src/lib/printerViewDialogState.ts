/** Resolve the initial saved-view form state from committed or displayed content. */
import type { PrinterView, PrinterViewInput } from '@printstream/shared'

/** Settings ignore the toolbar draft; creation and Overview use the visible values. */
export function savedViewDialogState(
  mode: 'settings' | 'create',
  activeView: PrinterView | null,
  displayedState: PrinterViewInput
): PrinterViewInput {
  if (mode !== 'settings' || !activeView) return displayedState

  return {
    name: activeView.name,
    printerIds: activeView.printerIds,
    cardsPerRow: activeView.cardsPerRow,
    stateFilter: activeView.stateFilter,
    modelFilter: activeView.modelFilter,
    nozzleDiameterFilter: activeView.nozzleDiameterFilter,
    plateTypeFilter: activeView.plateTypeFilter,
    sort: activeView.sort,
    group: activeView.group,
    cardContentSettings: activeView.cardContentSettings
  }
}
