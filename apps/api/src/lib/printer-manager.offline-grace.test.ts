import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { Printer, PrinterStatus } from '@printstream/shared'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

// A bridge-session disconnect must not blank the whole fleet offline the instant
// the socket drops: sessions reconnect within seconds (proxy idle reap, redeploy,
// brief network blip) and the printers never actually left. These tests cover the
// grace window in markBridgeDisconnected and its cancellation on the next report.

const printer: Printer = {
  id: 'grace-printer-1',
  name: 'Grace Printer',
  host: '192.168.1.60',
  serial: 'GRACE-SERIAL-1',
  accessCode: 'secret',
  model: 'P1S',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
}

afterEach(() => {
  mock.timers.reset()
  mock.restoreAll()
  const manager = printerManager as unknown as {
    managed: Map<string, unknown>
    bridgeIds: Map<string, string | null>
    tenantIds: Map<string, string>
    pendingOfflineTimers: Map<string, ReturnType<typeof setTimeout>>
  }
  for (const timer of manager.pendingOfflineTimers.values()) clearTimeout(timer)
  manager.pendingOfflineTimers.clear()
  manager.managed.clear()
  manager.bridgeIds.clear()
  manager.tenantIds.clear()
})

/** Register the printer on a bridge, bring it online, and start capturing offline emits. */
function setupOnlinePrinter() {
  printerManager.add(printer, 'tenant-1', 'bridge-1')
  printerManager.ingestBridgeStatus({ printerId: printer.id, online: true } as PrinterStatus, 'bridge-1')
  assert.equal(printerManager.getStatus(printer.id)?.online, true, 'precondition: printer is online')

  const offlineEmits: PrinterStatus[] = []
  const listener = (status: PrinterStatus) => {
    if (status.printerId === printer.id && status.online === false) offlineEmits.push(status)
  }
  printerEvents.on('status', listener)
  return { offlineEmits, stop: () => printerEvents.off('status', listener) }
}

test('a bridge disconnect defers offline until the grace window elapses', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { offlineEmits, stop } = setupOnlinePrinter()

  printerManager.markBridgeDisconnected('bridge-1')
  assert.equal(printerManager.getStatus(printer.id)?.online, true, 'still online immediately after disconnect')
  assert.equal(offlineEmits.length, 0, 'no offline emitted inside the grace window')

  mock.timers.tick(14_000)
  assert.equal(offlineEmits.length, 0, 'still online just before the window closes')

  mock.timers.tick(2_000)
  assert.equal(printerManager.getStatus(printer.id)?.online, false, 'offline once the window elapses')
  assert.equal(offlineEmits.length, 1, 'exactly one offline transition')

  stop()
})

test('a report from the reconnected bridge cancels the pending offline (no flicker)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { offlineEmits, stop } = setupOnlinePrinter()

  printerManager.markBridgeDisconnected('bridge-1')
  mock.timers.tick(10_000) // partway through the grace window
  printerManager.ingestBridgeReport(printer.id, {}, 'bridge-1') // bridge is back
  mock.timers.tick(60_000) // well past the original window

  assert.equal(printerManager.getStatus(printer.id)?.online, true, 'printer stayed online — no flicker')
  assert.equal(offlineEmits.length, 0, 'a recovered session never surfaces offline')

  stop()
})
