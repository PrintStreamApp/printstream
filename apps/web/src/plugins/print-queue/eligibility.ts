/**
 * Web-side eligibility for the print-queue view. Reuses the shared pure matcher so
 * the row's "Ready -> printer" / "Blocked: needs ..." badge recomputes live from the
 * WS-fed printer-status cache, with no extra server round-trips.
 */
import {
  summarizeQueueItemEligibility,
  type Printer,
  type PrinterStatus,
  type QueueItem,
  type QueueItemEligibilitySummary,
  type QueueItemPlacement,
  type QueuePrinterContext
} from '@printstream/shared'

export interface WebPrinterContext extends QueuePrinterContext {
  name: string
}

/** Build matcher contexts from the printers list and the live status cache (connected printers only). */
export function buildPrinterContexts(printers: Printer[], statuses: Record<string, PrinterStatus>): WebPrinterContext[] {
  const contexts: WebPrinterContext[] = []
  for (const printer of printers) {
    const status = statuses[printer.id]
    if (status) contexts.push({ printerId: printer.id, name: printer.name, model: printer.model, status })
  }
  return contexts
}

/** Adapt a queue-item DTO to the shared matcher's placement input. */
export function toQueuePlacement(item: QueueItem): QueueItemPlacement {
  return {
    targetKind: item.target.kind,
    targetPrinterId: item.target.printerId ?? null,
    targetModel: item.target.model ?? null,
    requiredFilaments: item.requiredFilaments,
    compatibleModels: item.compatibleModels
  }
}

export function summarizeItemEligibility(
  item: QueueItem,
  contexts: WebPrinterContext[],
  allowTypeOnlyMatch: boolean
): QueueItemEligibilitySummary {
  return summarizeQueueItemEligibility(toQueuePlacement(item), contexts, { allowTypeOnlyMatch })
}

export function printerNameById(contexts: WebPrinterContext[], printerId: string | null): string | null {
  if (!printerId) return null
  return contexts.find((context) => context.printerId === printerId)?.name ?? null
}
