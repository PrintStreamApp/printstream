import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  computeStartupTransition,
  formatCrashReason,
  initCrashTracker,
  markCleanShutdown,
  readRunState,
  recordFatalReason,
  writeRunState,
  type BridgeRunState
} from './crash-tracker.js'

const HOUR_MS = 60 * 60 * 1000
const T0 = Date.parse('2026-07-02T18:00:00.000Z')

function tempMarker(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'crash-tracker-'))
  return path.join(dir, 'bridge-run-state.json')
}

// --- Pure transition logic ---

test('a first-ever start (no marker) reports no crash', () => {
  const { next, pendingReport } = computeStartupTransition(null, T0)
  assert.equal(pendingReport, null)
  assert.equal(next.cleanShutdown, false)
  assert.deepEqual(next.recentCrashes, [])
})

test('a clean previous shutdown reports no crash', () => {
  const previous: BridgeRunState = { startedAt: new Date(T0 - HOUR_MS).toISOString(), cleanShutdown: true, lastReason: null, recentCrashes: [] }
  const { pendingReport } = computeStartupTransition(previous, T0)
  assert.equal(pendingReport, null)
})

test('a previous run that did not shut down cleanly is reported as a crash, carrying its reason', () => {
  const crashedStart = new Date(T0 - 30_000).toISOString()
  const previous: BridgeRunState = { startedAt: crashedStart, cleanShutdown: false, lastReason: 'Error: connack timeout', recentCrashes: [] }
  const { next, pendingReport } = computeStartupTransition(previous, T0)
  assert.ok(pendingReport)
  assert.equal(pendingReport.reason, 'Error: connack timeout')
  assert.equal(pendingReport.crashedRunStartedAt, crashedStart)
  assert.equal(pendingReport.recentCrashCount, 1)
  assert.equal(pendingReport.detectedAt, new Date(T0).toISOString())
  // The new run records the crash and resets its own reason/clean flag.
  assert.equal(next.cleanShutdown, false)
  assert.equal(next.lastReason, null)
  assert.equal(next.recentCrashes.length, 1)
})

test('consecutive crashes accumulate the windowed count (crash-loop detection)', () => {
  let state: BridgeRunState | null = null
  let report = null
  for (let i = 0; i < 4; i += 1) {
    // Each run "crashed" (never marked clean) then restarts 10s later.
    const result = computeStartupTransition(state ? { ...state, cleanShutdown: false } : null, T0 + i * 10_000)
    report = result.pendingReport
    state = result.next
  }
  // 3 detected crashes (the very first start had no prior run to blame).
  assert.ok(report)
  assert.equal(report.recentCrashCount, 3)
})

test('crashes older than the rolling window age out of the count', () => {
  const stale = new Date(T0 - 2 * HOUR_MS).toISOString() // outside the 1h window
  const recent = new Date(T0 - 5 * 60_000).toISOString() // inside
  const previous: BridgeRunState = { startedAt: new Date(T0 - 20_000).toISOString(), cleanShutdown: false, lastReason: null, recentCrashes: [stale, recent] }
  const { pendingReport } = computeStartupTransition(previous, T0)
  assert.ok(pendingReport)
  // stale pruned; recent kept; plus this crash => 2, not 3.
  assert.equal(pendingReport.recentCrashCount, 2)
})

// --- Marker persistence round-trip ---

test('initCrashTracker writes a running marker and detects the previous run\'s crash', () => {
  const marker = tempMarker()
  try {
    // First boot: nothing to report, marker persisted as "running".
    assert.equal(initCrashTracker(marker, T0), null)
    const afterBoot = readRunState(marker)
    assert.equal(afterBoot?.cleanShutdown, false)

    // The run crashes: the fatal handler records a reason (no clean marker).
    recordFatalReason(marker, 'Error: boom\n  at x')

    // Next boot detects the crash and reports the reason.
    const report = initCrashTracker(marker, T0 + 20_000)
    assert.ok(report)
    assert.equal(report.recentCrashCount, 1)
    assert.match(report.reason ?? '', /boom/)

    // A clean shutdown of this run means the following boot reports nothing.
    markCleanShutdown(marker)
    assert.equal(initCrashTracker(marker, T0 + 40_000), null)
  } finally {
    rmSync(path.dirname(marker), { recursive: true, force: true })
  }
})

test('writeRunState/readRunState round-trip and readRunState tolerates a corrupt file', () => {
  const marker = tempMarker()
  try {
    const state: BridgeRunState = { startedAt: new Date(T0).toISOString(), cleanShutdown: true, lastReason: 'x', recentCrashes: [new Date(T0).toISOString()] }
    writeRunState(marker, state)
    assert.deepEqual(readRunState(marker), state)
    // Overwrite with garbage; readRunState must not throw.
    writeRunState(marker, { ...state })
    assert.doesNotThrow(() => readRunState(`${marker}.does-not-exist`))
    assert.equal(readRunState(`${marker}.does-not-exist`), null)
  } finally {
    rmSync(path.dirname(marker), { recursive: true, force: true })
  }
})

test('formatCrashReason renders errors and non-errors', () => {
  assert.match(formatCrashReason(new Error('connack timeout')), /connack timeout/)
  assert.equal(formatCrashReason('a string reason'), 'a string reason')
  assert.equal(typeof formatCrashReason({ weird: true }), 'string')
})
