process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { rootPrisma } from './prisma.js'
import { printerEvents } from './printer-events.js'
import { getLogs } from './logs.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { ingestBridgeCrashReport } from './bridge-crash-reports.js'
import type { BridgeCrashReport } from '@printstream/shared'

const bridge = (rootPrisma as unknown as { bridge: Record<string, unknown> }).bridge
restorePrismaMethodsAfterEach([
  [bridge, 'findUnique'],
  [bridge, 'update']
])

const crashEvents: Array<{ bridgeId: string; recentCrashCount: number; tenantId: string | null }> = []
const onCrashed = (event: { bridgeId: string; bridgeName: string; tenantId: string | null; recentCrashCount: number }) => {
  crashEvents.push({ bridgeId: event.bridgeId, recentCrashCount: event.recentCrashCount, tenantId: event.tenantId })
}
printerEvents.on('bridge.crashed', onCrashed)
afterEach(() => { crashEvents.length = 0 })

function report(overrides: Partial<BridgeCrashReport> = {}): BridgeCrashReport {
  return {
    reason: 'Error: connack timeout\n  at Timeout._onTimeout',
    crashedRunStartedAt: '2026-07-02T18:00:00.000Z',
    detectedAt: '2026-07-02T18:01:00.000Z',
    recentCrashCount: 1,
    windowSeconds: 3600,
    ...overrides
  }
}

function stubBridge(row: { name: string; tenantId: string | null; lastCrashNotifiedAt: Date | null }): { updateArgs: unknown } {
  const captured: { updateArgs: unknown } = { updateArgs: undefined }
  bridge.findUnique = (async () => row) as never
  bridge.update = (async (args: unknown) => { captured.updateArgs = args; return {} }) as never
  return captured
}

test('records the crash summary, logs it for the tenant, and notifies on the first crash', async () => {
  const captured = stubBridge({ name: 'Store', tenantId: 'tenant-a', lastCrashNotifiedAt: null })
  await ingestBridgeCrashReport({ bridgeId: 'bridge-a', sessionTenantId: 'tenant-a', report: report() })

  const data = (captured.updateArgs as { data: Record<string, unknown> }).data
  assert.equal(data.recentCrashCount, 1)
  assert.equal(data.lastCrashReason, 'Error: connack timeout')
  assert.ok(data.lastCrashAt instanceof Date)
  assert.ok(data.lastCrashNotifiedAt instanceof Date, 'first crash sets the notified marker')

  const logged = getLogs(50, { tenantId: 'tenant-a' }).find((entry) => entry.message.includes('Store'))
  assert.ok(logged, 'a tenant-scoped log entry was written')
  assert.equal(logged?.level, 'error')

  assert.deepEqual(crashEvents, [{ bridgeId: 'bridge-a', recentCrashCount: 1, tenantId: 'tenant-a' }])
})

test('rate-limits the notification within the cooldown but still logs the crash', async () => {
  const justNotified = new Date('2026-07-02T18:00:30.000Z') // 30s before detectedAt < 15m cooldown
  const captured = stubBridge({ name: 'Store', tenantId: 'tenant-b', lastCrashNotifiedAt: justNotified })
  await ingestBridgeCrashReport({ bridgeId: 'bridge-b', sessionTenantId: 'tenant-b', report: report({ recentCrashCount: 5 }) })

  const data = (captured.updateArgs as { data: Record<string, unknown> }).data
  assert.equal(data.recentCrashCount, 5, 'summary still updated')
  assert.equal(data.lastCrashNotifiedAt, undefined, 'notified marker not advanced while suppressed')

  const logged = getLogs(50, { tenantId: 'tenant-b' }).find((entry) => entry.message.includes('crash-looping'))
  assert.ok(logged, 'a looping crash is still logged')
  assert.equal(crashEvents.length, 0, 'no notification within cooldown')
})

test('an unpaired bridge (no tenant) is recorded but not notified', async () => {
  const captured = stubBridge({ name: 'Lonely', tenantId: null, lastCrashNotifiedAt: null })
  await ingestBridgeCrashReport({ bridgeId: 'bridge-c', sessionTenantId: null, report: report() })

  assert.ok((captured.updateArgs as { data: Record<string, unknown> }).data.lastCrashAt instanceof Date)
  assert.equal(crashEvents.length, 0, 'no tenant to notify')
})

test('an unknown bridge id is ignored without throwing or emitting', async () => {
  bridge.findUnique = (async () => null) as never
  let updated = false
  bridge.update = (async () => { updated = true; return {} }) as never
  await assert.doesNotReject(() => ingestBridgeCrashReport({ bridgeId: 'ghost', sessionTenantId: 'tenant-a', report: report() }))
  assert.equal(updated, false)
  assert.equal(crashEvents.length, 0)
})
