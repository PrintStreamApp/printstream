import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearBridgeMetrics,
  initMetrics,
  isMetricsEnabled,
  recordBridgeMessageDropped,
  recordBridgeMetricsSnapshot,
  recordHttpRequest,
  recordPrintDispatch,
  recordSliceJob,
  recordWsEventBroadcast
} from './metrics.js'

// METRICS_ENABLED defaults off in the test env, so this exercises the no-op
// path: every call site must stay safe and cheap when telemetry is disabled.

test('metrics are disabled by default in tests', () => {
  assert.equal(isMetricsEnabled(), false)
})

test('initMetrics is a no-op (returns false) when disabled', async () => {
  assert.equal(await initMetrics({ wsClients: () => 0, bridgesConnected: () => 0 }), false)
  assert.equal(isMetricsEnabled(), false)
})

test('record helpers are safe no-ops before/without initialization', () => {
  assert.doesNotThrow(() => {
    recordHttpRequest({ method: 'GET', route: '/api/printers/:id', statusCode: 200, durationMs: 12.5 })
    recordPrintDispatch({ outcome: 'success', durationMs: 4200 })
    recordSliceJob({ outcome: 'failed', durationMs: 9100 })
    recordWsEventBroadcast('printer.status')
    recordBridgeMessageDropped('schema')
    recordBridgeMetricsSnapshot('bridge-1', 'tenant-1', {
      printersMonitored: 2,
      printersConnected: 1,
      eventLoopLagSeconds: 0.001,
      memoryRssBytes: 1234,
      apiReconnectsTotal: 0
    })
    clearBridgeMetrics('bridge-1')
  })
})
