import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatClockTime,
  formatDateTime,
  formatEtaFromNow,
  formatMinutesDuration,
  formatSecondsDuration
} from './time.js'

const reference = new Date('2026-04-29T12:00:00Z')

test('formatDateTime uses time-only formatting for same-day values', () => {
  const sameDay = new Date('2026-04-29T18:30:00Z')
  assert.equal(formatDateTime(sameDay, reference), formatClockTime(sameDay))
})

test('formatDateTime includes the year for older dates and omits it for same-year dates', () => {
  const sameYear = formatDateTime(new Date('2026-03-01T08:15:00Z'), reference)
  const olderYear = formatDateTime(new Date('2025-03-01T08:15:00Z'), reference)

  assert.equal(sameYear.includes('2026'), false)
  assert.equal(olderYear.includes('2025'), true)
})

test('ETA and duration helpers produce compact display strings', () => {
  assert.equal(formatEtaFromNow(90, reference), `~${formatDateTime(new Date(reference.getTime() + 90 * 60_000), reference)}`)
  assert.equal(formatMinutesDuration(135), '2h 15m')
  assert.equal(formatSecondsDuration(45), '45s')
  assert.equal(formatSecondsDuration(120), '2m')
})

test('formatMinutesDuration rolls into days past 24 hours', () => {
  assert.equal(formatMinutesDuration(23 * 60 + 59), '23h 59m')
  assert.equal(formatMinutesDuration(24 * 60), '1d')
  assert.equal(formatMinutesDuration(30 * 60), '1d 6h')
  assert.equal(formatMinutesDuration(52 * 60 + 13), '2d 4h')
  assert.equal(formatSecondsDuration(30 * 3600), '1d 6h')
})

test('formatEtaFromNow omits the date for next-morning ETAs shown from the prior evening', () => {
  const eveningReference = new Date('2026-04-29T21:53:00Z')
  const nextMorning = new Date('2026-04-30T05:53:00Z')

  assert.equal(formatEtaFromNow(8 * 60, eveningReference), `~${formatClockTime(nextMorning)}`)
})

test('formatEtaFromNow keeps the date when a next-day ETA is not obviously tomorrow morning', () => {
  const eveningReference = new Date('2026-04-29T21:53:00Z')
  const nextAfternoon = new Date('2026-04-30T13:53:00Z')

  assert.equal(formatEtaFromNow(16 * 60, eveningReference), `~${formatDateTime(nextAfternoon, eveningReference)}`)
})