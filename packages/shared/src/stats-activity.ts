/**
 * Shared contract for the time-series activity history behind the stats charts
 * (per-day active/total printer counts and print activity). Consumed by both the
 * workspace and platform stats surfaces.
 */
import { z } from 'zod'

export const statsActivityPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activePrinterCount: z.number().int().nonnegative(),
  totalPrinterCount: z.number().int().nonnegative(),
  usedPrintHours: z.number().nonnegative(),
  capacityPrintHours: z.number().nonnegative()
})

export type StatsActivityPoint = z.infer<typeof statsActivityPointSchema>

/** Workspace ranges can be shorter or longer; platform stats still request 30 days. */
export const statsActivityHistorySchema = z.array(statsActivityPointSchema).min(1).max(366)

export type StatsActivityHistory = z.infer<typeof statsActivityHistorySchema>
