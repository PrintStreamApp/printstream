import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BACKUP_RETENTION, selectBackupsToPrune } from './backup-retention.js'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-11T12:00:00.000Z')

function daysAgo(days: number): number {
  return NOW - days * DAY_MS
}

test('keeps every snapshot inside the keep-all window', () => {
  const times = [daysAgo(0), daysAgo(1), daysAgo(3.5), daysAgo(6.9)]
  assert.deepEqual(selectBackupsToPrune(times, NOW), [])
})

test('keeps a future-dated snapshot (clock skew) instead of pruning it', () => {
  assert.deepEqual(selectBackupsToPrune([NOW + DAY_MS], NOW), [])
})

test('thins a weekly bucket to its oldest snapshot', () => {
  // Three snapshots in the first weekly bucket (age 7-14 days): keep the oldest.
  const oldest = daysAgo(13)
  const times = [daysAgo(8), daysAgo(10), oldest]
  const pruned = selectBackupsToPrune(times, NOW)
  assert.deepEqual(pruned.sort(), [daysAgo(8), daysAgo(10)].sort())
})

test('bucket keeper does not depend on input order', () => {
  const oldest = daysAgo(13)
  const forward = selectBackupsToPrune([oldest, daysAgo(10), daysAgo(8)], NOW)
  const backward = selectBackupsToPrune([daysAgo(8), daysAgo(10), oldest], NOW)
  assert.deepEqual(new Set(forward), new Set(backward))
  assert.ok(!forward.includes(oldest))
})

test('separate weekly buckets each keep one snapshot', () => {
  const times = [daysAgo(8), daysAgo(16), daysAgo(23), daysAgo(30)]
  assert.deepEqual(selectBackupsToPrune(times, NOW), [])
})

test('monthly region thins to one per 30-day bucket', () => {
  // Weekly region ends at 7 + 28 = 35 days; ages 35-64 share the first monthly bucket.
  const oldest = daysAgo(60)
  const times = [daysAgo(40), daysAgo(50), oldest]
  const pruned = selectBackupsToPrune(times, NOW)
  assert.deepEqual(new Set(pruned), new Set([daysAgo(40), daysAgo(50)]))
})

test('drops snapshots older than the monthly region entirely', () => {
  // Monthly region ends at 35 + 360 = 395 days.
  const ancient = daysAgo(400)
  const pruned = selectBackupsToPrune([daysAgo(1), ancient], NOW)
  assert.deepEqual(pruned, [ancient])
})

test('a realistic daily series ages into the documented ladder', () => {
  // A year and a half of daily backups.
  const times = Array.from({ length: 550 }, (_, i) => daysAgo(i))
  const pruned = new Set(selectBackupsToPrune(times, NOW))
  const kept = times.filter((t) => !pruned.has(t))
  // 7 daily (ages 0-6) + 4 weekly + 12 monthly survivors.
  assert.equal(kept.length, 7 + DEFAULT_BACKUP_RETENTION.weeklyBuckets + DEFAULT_BACKUP_RETENTION.monthlyBuckets)
  // Nothing kept is older than the ladder's end.
  for (const t of kept) {
    assert.ok(NOW - t < 395 * DAY_MS)
  }
})
