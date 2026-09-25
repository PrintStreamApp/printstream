/** Date-only UTC window accepted by workspace and printer Stats endpoints. */
import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const statsDateRangeQuerySchema = z.object({
  from: isoDate,
  to: isoDate
}).refine(({ from, to }) => {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`)
  const toTime = Date.parse(`${to}T00:00:00.000Z`)
  return Number.isFinite(fromTime)
    && Number.isFinite(toTime)
    && new Date(fromTime).toISOString().slice(0, 10) === from
    && new Date(toTime).toISOString().slice(0, 10) === to
    && toTime >= fromTime
    && toTime - fromTime <= 365 * 24 * 60 * 60 * 1000
}, 'Choose a valid date range of up to 366 days')

export type StatsDateRangeQuery = z.infer<typeof statsDateRangeQuerySchema>
