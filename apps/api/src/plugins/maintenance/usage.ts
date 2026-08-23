/**
 * Reads the usage counters the maintenance intervals are measured against.
 *
 * Owns one job: turn `PrinterStats` rows into `{ printHours, filamentKilograms }`
 * per printer serial, in ONE query for a set of printers, because the printers
 * grid asks about every printer at once.
 *
 * Two contracts callers depend on:
 *
 * - The totals match what the printer detail page's stats card shows
 *   (`lib/printer-stats.ts`): print hours include the user's manual
 *   pre-PrintStream adjustment, so a maintenance interval and the stat above it
 *   cannot disagree.
 * - `filamentKilograms` is **null, not zero**, when no print has recorded
 *   filament use, mirroring `buildFilamentSummary`. A roll-count interval read
 *   against a zero would look permanently fresh; read against null it reports
 *   itself unavailable instead.
 */
import type { WorkspaceScopedPrismaClient } from '../../lib/prisma.js'

export interface PrinterUsageCounters {
  printHours: number | null
  filamentKilograms: number | null
}

const SECONDS_PER_HOUR = 3600
const GRAMS_PER_KILOGRAM = 1000

/** Usage with nothing recorded: hours are genuinely zero, filament is unknown. */
export const EMPTY_PRINTER_USAGE: PrinterUsageCounters = { printHours: 0, filamentKilograms: null }

/**
 * Load usage for every given printer serial, keyed by serial. Serials with no
 * stats row are absent from the map; callers substitute {@link EMPTY_PRINTER_USAGE}.
 */
export async function readPrinterUsageBySerial(
  prisma: WorkspaceScopedPrismaClient,
  printerSerials: string[]
): Promise<Map<string, PrinterUsageCounters>> {
  const usage = new Map<string, PrinterUsageCounters>()
  if (printerSerials.length === 0) return usage

  const rows = await prisma.printerStats.findMany({
    where: { printerSerial: { in: printerSerials } },
    select: {
      printerSerial: true,
      manualPrintDurationSeconds: true,
      successfulPrintDurationSeconds: true,
      failedPrintDurationSeconds: true,
      cancelledPrintDurationSeconds: true,
      trackedFilamentPrints: true,
      filamentUsedGrams: true
    }
  })

  for (const row of rows) {
    const seconds = row.manualPrintDurationSeconds
      + row.successfulPrintDurationSeconds
      + row.failedPrintDurationSeconds
      + row.cancelledPrintDurationSeconds
    usage.set(row.printerSerial, {
      printHours: seconds / SECONDS_PER_HOUR,
      filamentKilograms: row.trackedFilamentPrints > 0
        ? Number(row.filamentUsedGrams) / GRAMS_PER_KILOGRAM
        : null
    })
  }

  return usage
}
