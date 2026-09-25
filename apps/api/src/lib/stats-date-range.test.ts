import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpError } from './http-error.js'
import { parseStatsDateRangeQuery } from './stats-date-range.js'

test('Stats date range uses inclusive UTC dates and keeps legacy calls available', () => {
  assert.equal(parseStatsDateRangeQuery({}), null)
  assert.deepEqual(parseStatsDateRangeQuery({ from: '2026-09-01', to: '2026-09-24' }), {
    from: new Date('2026-09-01T00:00:00.000Z'),
    until: new Date('2026-09-25T00:00:00.000Z')
  })
})

test('Stats date range rejects invalid, partial, oversized, and future windows', () => {
  for (const query of [
    { from: '2026-09-01' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-09-24', to: '2026-09-01' },
    { from: '2024-01-01', to: '2026-01-01' },
    { from: '2099-01-01', to: '2099-01-02' }
  ]) {
    assert.throws(() => parseStatsDateRangeQuery(query), HttpError)
  }
})
