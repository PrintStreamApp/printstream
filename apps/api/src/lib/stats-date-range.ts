/** Parses optional Stats query windows, preserving legacy all-time calls without a range. */
import { statsDateRangeQuerySchema } from '@printstream/shared'
import { badRequest } from './http-error.js'

export type StatsDateRange = { from: Date; until: Date }

/** Return an inclusive date choice as a half-open UTC timestamp interval. */
export function parseStatsDateRangeQuery(query: unknown): StatsDateRange | null {
  if (!query || typeof query !== 'object') return null
  const values = query as Record<string, unknown>
  if (values.from == null && values.to == null) return null

  const parsed = statsDateRangeQuerySchema.safeParse(values)
  if (!parsed.success) throw badRequest('Choose a valid date range of up to 366 days')
  if (parsed.data.to > new Date().toISOString().slice(0, 10)) {
    throw badRequest('The date range cannot end in the future')
  }
  const until = new Date(`${parsed.data.to}T00:00:00.000Z`)
  until.setUTCDate(until.getUTCDate() + 1)
  return { from: new Date(`${parsed.data.from}T00:00:00.000Z`), until }
}
