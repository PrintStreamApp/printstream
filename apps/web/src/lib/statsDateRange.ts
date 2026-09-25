/** Date-only range helpers shared by workspace and printer Stats views. */
import type { StatsDateRangeQuery } from '@printstream/shared'

export type StatsDateRangeSelection = StatsDateRangeQuery | null

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Include today and the preceding days in a UTC date-only window. */
export function recentStatsDateRange(days: number, now = new Date()): StatsDateRangeQuery {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(today)
  start.setUTCDate(start.getUTCDate() - days + 1)
  return { from: utcDateKey(start), to: utcDateKey(today) }
}

/** Keep query keys and request URLs tied to the same selected dates. */
export function statsDateRangeSearch(range: StatsDateRangeSelection): string {
  if (!range) return ''
  const params = new URLSearchParams({ from: range.from, to: range.to })
  return `?${params.toString()}`
}
