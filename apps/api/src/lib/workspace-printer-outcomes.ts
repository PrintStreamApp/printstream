/**
 * Reads durable per-printer outcome totals for the workspace Stats card.
 * PrinterStats is keyed by workspace and serial so totals survive re-adoption;
 * only current printer rows are shown, and manual lifetime adjustments are
 * deliberately excluded because they have no known outcome.
 */
import type { WorkspacePrinterOutcome } from '@printstream/shared'
import { prisma } from './prisma.js'
import type { StatsDateRange } from './stats-date-range.js'

/** Return current printers and their tracked, terminal print outcomes. */
export async function readWorkspacePrinterOutcomes(workspaceId: string, range?: StatsDateRange | null): Promise<WorkspacePrinterOutcome[]> {
  const printers = await prisma.printer.findMany({
    where: { workspaceId },
    select: { id: true, name: true, model: true, serial: true },
    orderBy: [{ position: 'asc' }, { name: 'asc' }]
  })
  if (printers.length === 0) return []

  if (range) {
    const rows = await prisma.printJob.groupBy({
      by: ['printerId', 'result'],
      where: {
        workspaceId,
        printerId: { in: printers.map((printer) => printer.id) },
        finishedAt: { gte: range.from, lt: range.until },
        result: { in: ['success', 'failed', 'cancelled'] }
      },
      _count: { _all: true }
    })
    const byPrinter = new Map<string, { successfulPrints: number; failedPrints: number; cancelledPrints: number }>()
    for (const row of rows) {
      const totals = byPrinter.get(row.printerId) ?? { successfulPrints: 0, failedPrints: 0, cancelledPrints: 0 }
      if (row.result === 'success') totals.successfulPrints = row._count._all
      if (row.result === 'failed') totals.failedPrints = row._count._all
      if (row.result === 'cancelled') totals.cancelledPrints = row._count._all
      byPrinter.set(row.printerId, totals)
    }
    return printers.map((printer) => ({
      printerId: printer.id,
      name: printer.name,
      model: printer.model,
      successfulPrints: byPrinter.get(printer.id)?.successfulPrints ?? 0,
      failedPrints: byPrinter.get(printer.id)?.failedPrints ?? 0,
      cancelledPrints: byPrinter.get(printer.id)?.cancelledPrints ?? 0
    }))
  }

  const rows = await prisma.printerStats.findMany({
    where: {
      workspaceId,
      printerSerial: { in: printers.map((printer) => printer.serial) }
    },
    select: {
      printerSerial: true,
      successfulPrints: true,
      failedPrints: true,
      cancelledPrints: true
    }
  })
  const bySerial = new Map(rows.map((row) => [row.printerSerial, row]))

  return printers.map((printer) => {
    const totals = bySerial.get(printer.serial)
    return {
      printerId: printer.id,
      name: printer.name,
      model: printer.model,
      successfulPrints: totals?.successfulPrints ?? 0,
      failedPrints: totals?.failedPrints ?? 0,
      cancelledPrints: totals?.cancelledPrints ?? 0
    }
  })
}
