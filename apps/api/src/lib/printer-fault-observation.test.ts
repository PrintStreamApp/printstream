import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { readFaultSourceObservation } from './printer-fault-observation.js'
import { printerEvents, type PrinterEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

const printer: Printer = {
  id: 'fault-ingestion', name: 'Fixture', serial: '094fixture', host: '127.0.0.1', accessCode: 'fixture',
  model: 'P1S', currentPlateType: null, currentNozzleDiameters: [], position: 0,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
}
const state = printerManager as unknown as {
  managed: Map<string, unknown>; workspaceIds: Map<string, string>; bridgeIds: Map<string, string | null>
  pendingOfflineTimers: Map<string, ReturnType<typeof setTimeout>>
}
afterEach(() => {
  state.managed.clear(); state.workspaceIds.clear(); state.bridgeIds.clear()
  for (const timer of state.pendingOfflineTimers.values()) clearTimeout(timer)
  state.pendingOfflineTimers.clear()
})

test('partial and malformed sources cannot imply clear; unknown HMS codes remain evidence', () => {
  assert.deepEqual(readFaultSourceObservation({ print: { mc_percent: 20 } }, printer.serial), {})
  assert.deepEqual(readFaultSourceObservation({ print: { hms: null, print_error: 'bad' } }, printer.serial), {})
  assert.deepEqual(readFaultSourceObservation({ print: { hms: [{ code: 'bad' }], print_error: 0 } }, printer.serial), { device_error: [] })
  assert.deepEqual(readFaultSourceObservation({ print: { hms: [{ attr: null, code: 2 }] } }, printer.serial), {})
  assert.deepEqual(readFaultSourceObservation({ print: { hms: [] } }, printer.serial), { hms: [] })
  assert.deepEqual(readFaultSourceObservation({ print: { hms: [{ attr: 1, code: 2 }] } }, printer.serial).hms, [{ code: '0000000100000002', message: null }])
})

test('fresh confirming clears survive status dedupe and reject an unrelated bridge', () => {
  printerManager.add(printer, 'w', 'bridge')
  const observations: Parameters<PrinterEvents['fault.observed']>[0][] = []
  const capture: PrinterEvents['fault.observed'] = (event) => observations.push(event)
  printerEvents.on('fault.observed', capture)
  try {
    const report = { print: { hms: [], print_error: 0 } }
    printerManager.ingestBridgeReport(printer.id, report, 'foreign')
    assert.equal(observations.length, 0)
    printerManager.ingestBridgeReport(printer.id, report, 'bridge')
    printerManager.ingestBridgeReport(printer.id, report, 'bridge')
    assert.equal(observations.length, 2)
    assert.deepEqual(observations[1]?.sources, { hms: [], device_error: [] })
    assert.equal(observations[1]?.workspaceId, 'w')
    printerManager.ingestBridgeReport(printer.id, { print: { mc_percent: 1 } }, 'bridge')
    assert.deepEqual(observations[2]?.sources, {})
  } finally { printerEvents.off('fault.observed', capture) }
})

test('normalized status requires explicit source freshness, rather than treating cached values as authoritative', () => {
  printerManager.add(printer, 'w', 'bridge')
  const sources: unknown[] = []
  const capture: PrinterEvents['fault.observed'] = (event) => sources.push(event.sources)
  printerEvents.on('fault.observed', capture)
  try {
    const status = printerManager.getStatus(printer.id)!
    printerManager.ingestBridgeStatus(status, 'bridge')
    printerManager.ingestBridgeStatus(status, 'bridge', ['hms'])
    assert.deepEqual(sources, [{}, { hms: [] }])
  } finally { printerEvents.off('fault.observed', capture) }
})

test('bridge loss opens an observation gap immediately, including inside the live-status grace window', () => {
  printerManager.add(printer, 'w', 'bridge')
  printerManager.ingestBridgeReport(printer.id, { print: { print_error: 0 } }, 'bridge')
  const gaps: unknown[] = []
  const capture: PrinterEvents['fault.gap'] = (event) => gaps.push(event)
  printerEvents.on('fault.gap', capture)
  try {
    printerManager.markBridgeDisconnected('bridge')
    assert.equal(gaps.length, 1)
    assert.equal(printerManager.getStatus(printer.id)?.online, true)
  } finally { printerEvents.off('fault.gap', capture) }
})
