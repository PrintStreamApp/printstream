/**
 * Reads per-result print duration and filament totals directly from jobs.
 *
 * Used as a compatibility fallback while persisted rollup columns evolve so
 * the API can still return split failed versus cancelled waste stats.
 */
import { Prisma } from '@prisma/client'
import { prisma, rootPrisma } from './prisma.js'

const RECORDED_PRINT_RESULTS = ['success', 'failed', 'cancelled'] as const

type PrintJobGroupByRow = {
  result: string
  _sum: {
    durationSeconds: number | null
    filamentUsedGrams: Prisma.Decimal | number | null
    filamentUsedMeters: Prisma.Decimal | number | null
  }
}

export type PrintOutcomeBreakdown = {
  successfulPrintDurationSeconds: number
  failedPrintDurationSeconds: number
  cancelledPrintDurationSeconds: number
  successfulFilamentUsedGrams: number
  failedFilamentUsedGrams: number
  cancelledFilamentUsedGrams: number
  successfulFilamentUsedMeters: number
  failedFilamentUsedMeters: number
  cancelledFilamentUsedMeters: number
}

const EMPTY_PRINT_OUTCOME_BREAKDOWN: PrintOutcomeBreakdown = {
  successfulPrintDurationSeconds: 0,
  failedPrintDurationSeconds: 0,
  cancelledPrintDurationSeconds: 0,
  successfulFilamentUsedGrams: 0,
  failedFilamentUsedGrams: 0,
  cancelledFilamentUsedGrams: 0,
  successfulFilamentUsedMeters: 0,
  failedFilamentUsedMeters: 0,
  cancelledFilamentUsedMeters: 0
}

function isRecordedPrintResult(result: string): result is (typeof RECORDED_PRINT_RESULTS)[number] {
  return RECORDED_PRINT_RESULTS.includes(result as (typeof RECORDED_PRINT_RESULTS)[number])
}

async function readPrintOutcomeBreakdown(
  groupBy: (args: unknown) => Promise<unknown>,
  where: Prisma.PrintJobWhereInput = {}
): Promise<PrintOutcomeBreakdown> {
  const rows = await groupBy({
    by: ['result'],
    where: {
      ...where,
      result: { in: [...RECORDED_PRINT_RESULTS] }
    },
    _sum: {
      durationSeconds: true,
      filamentUsedGrams: true,
      filamentUsedMeters: true
    }
  }) as PrintJobGroupByRow[]

  const breakdown = { ...EMPTY_PRINT_OUTCOME_BREAKDOWN }
  for (const row of rows) {
    if (!isRecordedPrintResult(row.result)) continue
    const durationSeconds = row._sum.durationSeconds ?? 0
    const filamentUsedGrams = Number(row._sum.filamentUsedGrams ?? 0)
    const filamentUsedMeters = Number(row._sum.filamentUsedMeters ?? 0)

    if (row.result === 'success') {
      breakdown.successfulPrintDurationSeconds = durationSeconds
      breakdown.successfulFilamentUsedGrams = filamentUsedGrams
      breakdown.successfulFilamentUsedMeters = filamentUsedMeters
      continue
    }

    if (row.result === 'failed') {
      breakdown.failedPrintDurationSeconds = durationSeconds
      breakdown.failedFilamentUsedGrams = filamentUsedGrams
      breakdown.failedFilamentUsedMeters = filamentUsedMeters
      continue
    }

    breakdown.cancelledPrintDurationSeconds = durationSeconds
    breakdown.cancelledFilamentUsedGrams = filamentUsedGrams
    breakdown.cancelledFilamentUsedMeters = filamentUsedMeters
  }

  return breakdown
}

export async function readTenantPrintOutcomeBreakdown(
  where: Prisma.PrintJobWhereInput = {}
): Promise<PrintOutcomeBreakdown> {
  return await readPrintOutcomeBreakdown((args) => prisma.printJob.groupBy(args as never), where)
}

export async function readPlatformPrintOutcomeBreakdown(
  where: Prisma.PrintJobWhereInput = {}
): Promise<PrintOutcomeBreakdown> {
  return await readPrintOutcomeBreakdown((args) => rootPrisma.printJob.groupBy(args as never), where)
}