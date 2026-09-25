import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatsActivityHistory } from './stats-activity-history.js'

test('a print ending at midnight does not mark the next day active', () => {
  const history = buildStatsActivityHistory({
    now: new Date('2026-09-24T12:00:00.000Z'),
    range: {
      from: new Date('2026-09-23T00:00:00.000Z'),
      until: new Date('2026-09-25T00:00:00.000Z')
    },
    printerCreatedAt: [new Date('2026-09-01T00:00:00.000Z')],
    printerActivity: [{
      printerId: 'printer-1',
      startedAt: new Date('2026-09-23T23:00:00.000Z'),
      finishedAt: new Date('2026-09-24T00:00:00.000Z')
    }]
  })

  assert.deepEqual(history.map((day) => ({ date: day.date, active: day.activePrinterCount, hours: day.usedPrintHours })), [
    { date: '2026-09-23', active: 1, hours: 1 },
    { date: '2026-09-24', active: 0, hours: 0 }
  ])
})
