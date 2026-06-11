/**
 * Locale-aware time formatting helpers for the web app.
 *
 * Rules:
 * - same-day timestamps show only the time, e.g. `3:42 PM`
 * - same-year timestamps show month, day, and time, e.g. `Apr 27, 3:42 PM`
 * - older timestamps also include the year, e.g. `Apr 27, 2025, 3:42 PM`
 * - ETAs reuse the same clock format with a leading `~`
 * - next-day morning ETAs shown from the prior afternoon/evening stay time-only
 * - durations use compact `h`, `m`, `s` units
 */

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
})

const monthDayTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const monthDayYearTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

function normalizeDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function getBrowserTimeZone(): string | undefined {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone?.trim()
  return timeZone || undefined
}

function isSameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function isNextDay(left: Date, right: Date): boolean {
  const nextDay = new Date(right)
  nextDay.setHours(0, 0, 0, 0)
  nextDay.setDate(nextDay.getDate() + 1)

  return left.getFullYear() === nextDay.getFullYear()
    && left.getMonth() === nextDay.getMonth()
    && left.getDate() === nextDay.getDate()
}

export function formatClockTime(value: Date | string | number): string {
  const date = normalizeDate(value)
  return date ? timeFormatter.format(date) : ''
}

export function formatDateTime(value: Date | string | number, referenceDate: Date = new Date()): string {
  const date = normalizeDate(value)
  if (!date) return ''
  if (isSameDay(date, referenceDate)) return timeFormatter.format(date)
  if (date.getFullYear() === referenceDate.getFullYear()) return monthDayTimeFormatter.format(date)
  return monthDayYearTimeFormatter.format(date)
}

export function formatEtaFromNow(minutes: number, referenceDate: Date = new Date()): string {
  const completion = new Date(referenceDate.getTime() + minutes * 60_000)
  const shouldUseClockOnly = isSameDay(completion, referenceDate)
    || (isNextDay(completion, referenceDate) && referenceDate.getHours() >= 12 && completion.getHours() < 12)

  return `~${shouldUseClockOnly ? formatClockTime(completion) : formatDateTime(completion, referenceDate)}`
}

export function formatMinutesDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainderMinutes = minutes % 60
  if (hours < 24) {
    return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`
  }
  // Roll into days past 24h, showing the two most-significant units (`1d 6h`, `2d`).
  const days = Math.floor(hours / 24)
  const remainderHours = hours % 24
  return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`
}

export function formatSecondsDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return formatMinutesDuration(minutes)
}