/**
 * UTC calendar-day helpers shared by the durable stats/rollup code. Every
 * day-bucketed rollup in the API buckets on UTC days (the `stats-activity-*`
 * timelines, the feature-usage counters), so the bucketing math lives once
 * here rather than as per-module copies that could drift by a timezone.
 */

/** Midnight UTC of the given instant's UTC calendar day. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date)
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

/** `YYYY-MM-DD` of the instant's UTC calendar day: the wire form for day buckets. */
export function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}
