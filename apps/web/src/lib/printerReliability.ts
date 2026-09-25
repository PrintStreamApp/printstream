/**
 * Builds the printer and model outcome rows shown on the workspace Stats page.
 * Each model rate is based on its summed print counts, so a busy printer has
 * more weight than an idle one. Cancelled jobs remain visible but do not enter
 * the success-rate denominator.
 */
import type { WorkspacePrinterOutcome } from '@printstream/shared'
import { formatPrinterModelLabel } from './slicingPresetMatching'

export type ReliabilityOutcome = {
  key: string
  name: string
  model?: string
  printerCount?: number
  successfulPrints: number
  failedPrints: number
  cancelledPrints: number
}

/** Sort by recorded failure rate, then by sample size and name. */
export function compareOutcomes(left: ReliabilityOutcome, right: ReliabilityOutcome): number {
  const leftCompleted = left.successfulPrints + left.failedPrints
  const rightCompleted = right.successfulPrints + right.failedPrints
  if (leftCompleted === 0) return rightCompleted === 0 ? left.name.localeCompare(right.name) : 1
  if (rightCompleted === 0) return -1

  const rateDifference = left.successfulPrints / leftCompleted - right.successfulPrints / rightCompleted
  return rateDifference || rightCompleted - leftCompleted || left.name.localeCompare(right.name)
}

/** Group current printers by their stored model identity and sum their outcomes. */
export function groupOutcomesByModel(printers: readonly WorkspacePrinterOutcome[]): ReliabilityOutcome[] {
  const models = new Map<string, ReliabilityOutcome>()
  for (const printer of printers) {
    const existing = models.get(printer.model)
    if (existing) {
      existing.printerCount = (existing.printerCount ?? 0) + 1
      existing.successfulPrints += printer.successfulPrints
      existing.failedPrints += printer.failedPrints
      existing.cancelledPrints += printer.cancelledPrints
      continue
    }

    models.set(printer.model, {
      key: printer.model,
      name: formatPrinterModelLabel(printer.model),
      printerCount: 1,
      successfulPrints: printer.successfulPrints,
      failedPrints: printer.failedPrints,
      cancelledPrints: printer.cancelledPrints
    })
  }
  return [...models.values()].sort(compareOutcomes)
}
