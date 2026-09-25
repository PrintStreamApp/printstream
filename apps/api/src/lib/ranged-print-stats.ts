/**
 * Terminal print totals for a selected Stats window. The query aggregates in
 * PostgreSQL, while lifetime cards continue to read the durable rollups.
 * Manual adjustments have no dates and cannot belong to a selected window.
 */
import { prisma } from './prisma.js'
import type { StatsDateRange } from './stats-date-range.js'

export type RangedPrintStats = {
  totalPrints: number
  successfulPrints: number
  failedPrints: number
  cancelledPrints: number
  successfulPrintDurationSeconds: number
  failedPrintDurationSeconds: number
  cancelledPrintDurationSeconds: number
  trackedFilamentPrints: number
  filamentUsedGrams: number
  successfulFilamentUsedGrams: number
  failedFilamentUsedGrams: number
  cancelledFilamentUsedGrams: number
  filamentUsedMeters: number
  successfulFilamentUsedMeters: number
  failedFilamentUsedMeters: number
  cancelledFilamentUsedMeters: number
}

/** Aggregate completed jobs by result inside the workspace and date window. */
export async function readRangedPrintStats(input: {
  workspaceId: string
  range: StatsDateRange
  printerId?: string
}): Promise<RangedPrintStats> {
  const rows = await prisma.printJob.groupBy({
    by: ['result'],
    where: {
      workspaceId: input.workspaceId,
      ...(input.printerId ? { printerId: input.printerId } : {}),
      finishedAt: { gte: input.range.from, lt: input.range.until },
      result: { in: ['success', 'failed', 'cancelled'] }
    },
    _count: { _all: true, filamentUsedGrams: true, filamentUsedMeters: true },
    _sum: { durationSeconds: true, filamentUsedGrams: true, filamentUsedMeters: true }
  })

  const successful = rows.find((row) => row.result === 'success')
  const failed = rows.find((row) => row.result === 'failed')
  const cancelled = rows.find((row) => row.result === 'cancelled')
  const count = (row: typeof successful) => row?._count._all ?? 0
  const seconds = (row: typeof successful) => row?._sum.durationSeconds ?? 0
  const grams = (row: typeof successful) => Number(row?._sum.filamentUsedGrams ?? 0)
  const meters = (row: typeof successful) => Number(row?._sum.filamentUsedMeters ?? 0)
  const successfulPrints = count(successful)
  const failedPrints = count(failed)
  const cancelledPrints = count(cancelled)

  return {
    totalPrints: successfulPrints + failedPrints + cancelledPrints,
    successfulPrints,
    failedPrints,
    cancelledPrints,
    successfulPrintDurationSeconds: seconds(successful),
    failedPrintDurationSeconds: seconds(failed),
    cancelledPrintDurationSeconds: seconds(cancelled),
    trackedFilamentPrints: rows.reduce((total, row) => (
      total + Math.max(row._count.filamentUsedGrams, row._count.filamentUsedMeters)
    ), 0),
    filamentUsedGrams: grams(successful) + grams(failed) + grams(cancelled),
    successfulFilamentUsedGrams: grams(successful),
    failedFilamentUsedGrams: grams(failed),
    cancelledFilamentUsedGrams: grams(cancelled),
    filamentUsedMeters: meters(successful) + meters(failed) + meters(cancelled),
    successfulFilamentUsedMeters: meters(successful),
    failedFilamentUsedMeters: meters(failed),
    cancelledFilamentUsedMeters: meters(cancelled)
  }
}
