/**
 * Per-printer lifetime stats keyed by tenant and printer serial.
 *
 * Stats are recorded once per finished print job and survive printer
 * removal/re-adoption because the physical printer identity is the serial,
 * not the transient printer row id.
 */
import { isPrinterActiveJobStage, type PrinterStatsResponse } from '@printstream/shared'
import { buildFilamentSummary } from './filament-summary.js'
import { readTenantPrintOutcomeBreakdown } from './print-outcome-breakdown.js'
import { prisma, rootPrisma } from './prisma.js'
import { isMissingColumnError } from './prisma-errors.js'
import { printerManager } from './printer-manager.js'

function secondsToHours(seconds: number): number {
  return seconds / 3600
}

function isRecordedPrinterResult(result: string): result is 'success' | 'failed' | 'cancelled' {
  return result === 'success' || result === 'failed' || result === 'cancelled'
}

export async function recordFinishedPrinterStats(jobId: string): Promise<void> {
  const job = await rootPrisma.printJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      printerId: true,
      result: true,
      durationSeconds: true,
      filamentUsedGrams: true,
      filamentUsedMeters: true,
      printerStatsRecordedAt: true
    }
  })
  if (!job || job.printerStatsRecordedAt || !isRecordedPrinterResult(job.result)) return

  const printer = await rootPrisma.printer.findUnique({
    where: { id: job.printerId },
    select: {
      tenantId: true,
      serial: true
    }
  })
  if (!printer) return

  const trackedFilament = job.filamentUsedGrams != null || job.filamentUsedMeters != null ? 1 : 0

  await rootPrisma.$transaction(async (tx) => {
    const claimed = await tx.printJob.updateMany({
      where: {
        id: job.id,
        printerStatsRecordedAt: null
      },
      data: {
        printerStatsRecordedAt: new Date()
      }
    })
    if (claimed.count === 0) return

    await tx.printerStats.upsert({
      where: {
        tenantId_printerSerial: {
          tenantId: printer.tenantId,
          printerSerial: printer.serial
        }
      },
      create: {
        tenantId: printer.tenantId,
        printerSerial: printer.serial,
        totalPrints: 1,
        successfulPrints: job.result === 'success' ? 1 : 0,
        failedPrints: job.result === 'failed' ? 1 : 0,
        cancelledPrints: job.result === 'cancelled' ? 1 : 0,
        successfulPrintDurationSeconds: job.result === 'success' ? job.durationSeconds ?? 0 : 0,
        failedPrintDurationSeconds: job.result === 'failed' ? job.durationSeconds ?? 0 : 0,
        cancelledPrintDurationSeconds: job.result === 'cancelled' ? job.durationSeconds ?? 0 : 0,
        wastedPrintDurationSeconds: job.result === 'failed' || job.result === 'cancelled' ? job.durationSeconds ?? 0 : 0,
        trackedFilamentPrints: trackedFilament,
        filamentUsedGrams: job.filamentUsedGrams ?? 0,
        successfulFilamentUsedGrams: job.result === 'success' ? job.filamentUsedGrams ?? 0 : 0,
        failedFilamentUsedGrams: job.result === 'failed' ? job.filamentUsedGrams ?? 0 : 0,
        cancelledFilamentUsedGrams: job.result === 'cancelled' ? job.filamentUsedGrams ?? 0 : 0,
        wastedFilamentUsedGrams: job.result === 'failed' || job.result === 'cancelled' ? job.filamentUsedGrams ?? 0 : 0,
        filamentUsedMeters: job.filamentUsedMeters ?? 0,
        successfulFilamentUsedMeters: job.result === 'success' ? job.filamentUsedMeters ?? 0 : 0,
        failedFilamentUsedMeters: job.result === 'failed' ? job.filamentUsedMeters ?? 0 : 0,
        cancelledFilamentUsedMeters: job.result === 'cancelled' ? job.filamentUsedMeters ?? 0 : 0,
        wastedFilamentUsedMeters: job.result === 'failed' || job.result === 'cancelled' ? job.filamentUsedMeters ?? 0 : 0
      },
      update: {
        totalPrints: { increment: 1 },
        successfulPrints: { increment: job.result === 'success' ? 1 : 0 },
        failedPrints: { increment: job.result === 'failed' ? 1 : 0 },
        cancelledPrints: { increment: job.result === 'cancelled' ? 1 : 0 },
        successfulPrintDurationSeconds: { increment: job.result === 'success' ? job.durationSeconds ?? 0 : 0 },
        failedPrintDurationSeconds: { increment: job.result === 'failed' ? job.durationSeconds ?? 0 : 0 },
        cancelledPrintDurationSeconds: { increment: job.result === 'cancelled' ? job.durationSeconds ?? 0 : 0 },
        wastedPrintDurationSeconds: { increment: job.result === 'failed' || job.result === 'cancelled' ? job.durationSeconds ?? 0 : 0 },
        trackedFilamentPrints: { increment: trackedFilament },
        filamentUsedGrams: { increment: job.filamentUsedGrams ?? 0 },
        successfulFilamentUsedGrams: { increment: job.result === 'success' ? job.filamentUsedGrams ?? 0 : 0 },
        failedFilamentUsedGrams: { increment: job.result === 'failed' ? job.filamentUsedGrams ?? 0 : 0 },
        cancelledFilamentUsedGrams: { increment: job.result === 'cancelled' ? job.filamentUsedGrams ?? 0 : 0 },
        wastedFilamentUsedGrams: { increment: job.result === 'failed' || job.result === 'cancelled' ? job.filamentUsedGrams ?? 0 : 0 },
        filamentUsedMeters: { increment: job.filamentUsedMeters ?? 0 },
        successfulFilamentUsedMeters: { increment: job.result === 'success' ? job.filamentUsedMeters ?? 0 : 0 },
        failedFilamentUsedMeters: { increment: job.result === 'failed' ? job.filamentUsedMeters ?? 0 : 0 },
        cancelledFilamentUsedMeters: { increment: job.result === 'cancelled' ? job.filamentUsedMeters ?? 0 : 0 },
        wastedFilamentUsedMeters: { increment: job.result === 'failed' || job.result === 'cancelled' ? job.filamentUsedMeters ?? 0 : 0 }
      }
    })
  })
}

export async function readPrinterStats(printerId: string): Promise<PrinterStatsResponse['stats'] | null> {
  const printer = await prisma.printer.findFirst({
    where: { id: printerId },
    select: {
      id: true,
      tenantId: true,
      serial: true
    }
  })
  if (!printer) return null

  let row: {
    totalPrints: number
    successfulPrints: number
    failedPrints: number
    cancelledPrints: number
    successfulPrintDurationSeconds: number
    failedPrintDurationSeconds: number
    cancelledPrintDurationSeconds: number
    trackedFilamentPrints: number
    filamentUsedGrams: unknown
    successfulFilamentUsedGrams: unknown
    failedFilamentUsedGrams: unknown
    cancelledFilamentUsedGrams: unknown
    filamentUsedMeters: unknown
    successfulFilamentUsedMeters: unknown
    failedFilamentUsedMeters: unknown
    cancelledFilamentUsedMeters: unknown
  } | null

  try {
    row = await prisma.printerStats.findUnique({
      where: {
        tenantId_printerSerial: {
          tenantId: printer.tenantId,
          printerSerial: printer.serial
        }
      },
      select: {
        totalPrints: true,
        successfulPrints: true,
        failedPrints: true,
        cancelledPrints: true,
        successfulPrintDurationSeconds: true,
        failedPrintDurationSeconds: true,
        cancelledPrintDurationSeconds: true,
        trackedFilamentPrints: true,
        filamentUsedGrams: true,
        successfulFilamentUsedGrams: true,
        failedFilamentUsedGrams: true,
        cancelledFilamentUsedGrams: true,
        filamentUsedMeters: true,
        successfulFilamentUsedMeters: true,
        failedFilamentUsedMeters: true,
        cancelledFilamentUsedMeters: true
      }
    })
  } catch (error) {
    if (!isMissingColumnError(error)) throw error
    console.warn('Falling back to legacy printer stats query; failed/cancelled breakdown columns are missing')
    const [legacyRow, legacyBreakdown] = await Promise.all([
      prisma.printerStats.findUnique({
        where: {
          tenantId_printerSerial: {
            tenantId: printer.tenantId,
            printerSerial: printer.serial
          }
        },
        select: {
          totalPrints: true,
          successfulPrints: true,
          failedPrints: true,
          cancelledPrints: true,
          successfulPrintDurationSeconds: true,
          trackedFilamentPrints: true,
          filamentUsedGrams: true,
          filamentUsedMeters: true
        }
      }),
      readTenantPrintOutcomeBreakdown({
        printer: {
          is: { serial: printer.serial }
        }
      })
    ])
    row = legacyRow == null
      ? null
      : {
          ...legacyRow,
          failedPrintDurationSeconds: legacyBreakdown.failedPrintDurationSeconds,
          cancelledPrintDurationSeconds: legacyBreakdown.cancelledPrintDurationSeconds,
          successfulFilamentUsedGrams: legacyBreakdown.successfulFilamentUsedGrams,
          failedFilamentUsedGrams: legacyBreakdown.failedFilamentUsedGrams,
          cancelledFilamentUsedGrams: legacyBreakdown.cancelledFilamentUsedGrams,
          successfulFilamentUsedMeters: legacyBreakdown.successfulFilamentUsedMeters,
          failedFilamentUsedMeters: legacyBreakdown.failedFilamentUsedMeters,
          cancelledFilamentUsedMeters: legacyBreakdown.cancelledFilamentUsedMeters
        }
  }

  const failedPrintHours = secondsToHours(row?.failedPrintDurationSeconds ?? 0)
  const cancelledPrintHours = secondsToHours(row?.cancelledPrintDurationSeconds ?? 0)
  const filamentSummary = buildFilamentSummary({
    trackedFilamentPrints: row?.trackedFilamentPrints ?? 0,
    filamentUsedGrams: Number(row?.filamentUsedGrams ?? 0),
    successfulFilamentUsedGrams: Number(row?.successfulFilamentUsedGrams ?? 0),
    failedFilamentUsedGrams: Number(row?.failedFilamentUsedGrams ?? 0),
    cancelledFilamentUsedGrams: Number(row?.cancelledFilamentUsedGrams ?? 0),
    filamentUsedMeters: Number(row?.filamentUsedMeters ?? 0),
    successfulFilamentUsedMeters: Number(row?.successfulFilamentUsedMeters ?? 0),
    failedFilamentUsedMeters: Number(row?.failedFilamentUsedMeters ?? 0),
    cancelledFilamentUsedMeters: Number(row?.cancelledFilamentUsedMeters ?? 0)
  })

  return {
    printsInProgress: isPrinterActiveJobStage(printerManager.getStatus(printer.id)?.stage) ? 1 : 0,
    totalPrints: row?.totalPrints ?? 0,
    successfulPrints: row?.successfulPrints ?? 0,
    failedPrints: row?.failedPrints ?? 0,
    cancelledPrints: row?.cancelledPrints ?? 0,
    failedOrCancelledPrints: (row?.failedPrints ?? 0) + (row?.cancelledPrints ?? 0),
    totalPrintHours: secondsToHours((row?.successfulPrintDurationSeconds ?? 0) + (row?.failedPrintDurationSeconds ?? 0) + (row?.cancelledPrintDurationSeconds ?? 0)),
    successfulPrintHours: secondsToHours(row?.successfulPrintDurationSeconds ?? 0),
    failedPrintHours,
    cancelledPrintHours,
    wastedPrintHours: failedPrintHours + cancelledPrintHours,
    ...filamentSummary
  }
}