import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeMetricsSnapshotSchema } from '@printstream/shared'
import { collectBridgeMetrics, recordApiReconnect } from './bridge-metrics.js'

test('collect returns a schema-valid snapshot carrying the passed printer counts', () => {
  const snapshot = collectBridgeMetrics({ printersMonitored: 3, printersConnected: 2 })
  assert.equal(bridgeMetricsSnapshotSchema.safeParse(snapshot).success, true)
  assert.equal(snapshot.printersMonitored, 3)
  assert.equal(snapshot.printersConnected, 2)
  assert.ok(snapshot.memoryRssBytes > 0)
  assert.ok(snapshot.eventLoopLagSeconds >= 0)
})

test('recordApiReconnect increments the cumulative reconnect counter', () => {
  const before = collectBridgeMetrics({ printersMonitored: 0, printersConnected: 0 }).apiReconnectsTotal
  recordApiReconnect()
  recordApiReconnect()
  const after = collectBridgeMetrics({ printersMonitored: 0, printersConnected: 0 }).apiReconnectsTotal
  assert.equal(after - before, 2)
})
