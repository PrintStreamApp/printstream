import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleFaultIdlePeriods } from './printer-fault-periods.js'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 16, minute))
test('job-span order cannot change history fragment identities or times', () => {
  const periods = [{ id: 'idle', startedAt: at(0), endedAt: at(6) }]
  const jobs = [{ startedAt: at(1), endedAt: at(2) }, { startedAt: at(3), endedAt: at(4) }]
  const expected = visibleFaultIdlePeriods(periods, jobs)
  assert.deepEqual(visibleFaultIdlePeriods(periods, [...jobs].reverse()), expected)
  assert.deepEqual(expected.map((period) => [period.startedAt, period.endedAt]), [[at(0), at(1)], [at(2), at(3)], [at(4), at(6)]])
  assert.deepEqual(periods, [{ id: 'idle', startedAt: at(0), endedAt: at(6) }], 'projection never mutates the source evidence')
})
