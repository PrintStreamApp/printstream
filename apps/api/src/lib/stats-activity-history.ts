/**
 * Builds the 30-day activity timeline used by the tenant and platform stats
 * cards.
 *
 * Each point captures the total printer count for that UTC day alongside how
 * many unique printers had a print job active during that day, plus the total
 * print hours used versus the day's theoretical printer-hour capacity.
 */
import type { StatsActivityHistory } from '@printstream/shared'
import { prisma, rootPrisma } from './prisma.js'

const ACTIVITY_WINDOW_DAYS = 30
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date)
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function buildStatsActivityHistory(input: {
  printerCreatedAt: readonly Date[]
  printerActivity: ReadonlyArray<{
    printerId: string
    startedAt: Date
    finishedAt: Date | null
  }>
  now?: Date
}): StatsActivityHistory {
  const now = input.now ?? new Date()
  const today = startOfUtcDay(now)
  const windowStart = addUtcDays(today, -(ACTIVITY_WINDOW_DAYS - 1))
  const printerDates = [...input.printerCreatedAt].sort((left, right) => left.getTime() - right.getTime())
  const activePrinterSets = new Map<string, Set<string>>()
  const usedPrintSeconds = new Map<string, number>()

  for (const job of input.printerActivity) {
    const activityStartDay = startOfUtcDay(job.startedAt)
    const activityEnd = job.finishedAt ?? now
    const activityEndDay = startOfUtcDay(activityEnd)
    if (activityEndDay < windowStart || activityStartDay > today) continue

    const boundedStart = activityStartDay < windowStart ? windowStart : activityStartDay
    const boundedEnd = activityEndDay > today ? today : activityEndDay
    for (let day = boundedStart; day <= boundedEnd; day = addUtcDays(day, 1)) {
      const nextDay = addUtcDays(day, 1)
      const key = toUtcDateKey(day)
      const activePrinters = activePrinterSets.get(key) ?? new Set<string>()
      activePrinters.add(job.printerId)
      activePrinterSets.set(key, activePrinters)

      const overlapStart = Math.max(job.startedAt.getTime(), day.getTime())
      const overlapEnd = Math.min(activityEnd.getTime(), nextDay.getTime())
      if (overlapEnd > overlapStart) {
        const overlapSeconds = (overlapEnd - overlapStart) / 1000
        usedPrintSeconds.set(key, (usedPrintSeconds.get(key) ?? 0) + overlapSeconds)
      }
    }
  }

  const history: StatsActivityHistory = []
  let printerIndex = 0
  let totalPrinterCount = 0
  for (let offset = 0; offset < ACTIVITY_WINDOW_DAYS; offset += 1) {
    const day = addUtcDays(windowStart, offset)
    const nextDay = addUtcDays(day, 1)
    while (printerIndex < printerDates.length) {
      const createdAt = printerDates[printerIndex]
      if (createdAt == null || createdAt >= nextDay) break
      totalPrinterCount += 1
      printerIndex += 1
    }

    history.push({
      date: toUtcDateKey(day),
      activePrinterCount: activePrinterSets.get(toUtcDateKey(day))?.size ?? 0,
      totalPrinterCount,
      usedPrintHours: (usedPrintSeconds.get(toUtcDateKey(day)) ?? 0) / 3600,
      capacityPrintHours: totalPrinterCount * 24
    })
  }

  return history
}

export async function readTenantStatsActivityHistory(): Promise<StatsActivityHistory> {
  const today = startOfUtcDay(new Date())
  const windowStart = addUtcDays(today, -(ACTIVITY_WINDOW_DAYS - 1))
  const tomorrow = addUtcDays(today, 1)
  const [printers, jobs] = await Promise.all([
    prisma.printer.findMany({
      select: { createdAt: true }
    }),
    prisma.printJob.findMany({
      where: {
        startedAt: { lt: tomorrow },
        OR: [
          { finishedAt: null },
          { finishedAt: { gte: windowStart } }
        ]
      },
      select: {
        printerId: true,
        startedAt: true,
        finishedAt: true
      }
    })
  ])

  return buildStatsActivityHistory({
    printerCreatedAt: printers.map((printer) => printer.createdAt),
    printerActivity: jobs
  })
}

export async function readPlatformStatsActivityHistory(visibleTenantIds?: readonly string[]): Promise<StatsActivityHistory> {
  if (visibleTenantIds != null && visibleTenantIds.length === 0) {
    return buildStatsActivityHistory({ printerCreatedAt: [], printerActivity: [] })
  }

  const today = startOfUtcDay(new Date())
  const windowStart = addUtcDays(today, -(ACTIVITY_WINDOW_DAYS - 1))
  const tomorrow = addUtcDays(today, 1)
  const tenantFilter = visibleTenantIds == null ? {} : { tenantId: { in: [...visibleTenantIds] } }
  const [printers, jobs] = await Promise.all([
    rootPrisma.printer.findMany({
      where: tenantFilter,
      select: { createdAt: true }
    }),
    rootPrisma.printJob.findMany({
      where: {
        ...tenantFilter,
        startedAt: { lt: tomorrow },
        OR: [
          { finishedAt: null },
          { finishedAt: { gte: windowStart } }
        ]
      },
      select: {
        printerId: true,
        startedAt: true,
        finishedAt: true
      }
    })
  ])

  return buildStatsActivityHistory({
    printerCreatedAt: printers.map((printer) => printer.createdAt),
    printerActivity: jobs
  })
}