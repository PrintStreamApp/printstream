import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { printerManager } from './printer-manager.js'

const printerManagerState = printerManager as unknown as {
  managed: Map<string, {
    printer: Printer
    status: { online: boolean }
    offlineSince?: number | null
    recycleTimer?: ReturnType<typeof setTimeout> | null
  }>
  bridgeIds: Map<string, string | null>
}
const printerManagerPrototype = Object.getPrototypeOf(printerManager) as typeof printerManager

afterEach(() => {
  printerManagerState.managed.clear()
  printerManagerState.bridgeIds.clear()
  mock.restoreAll()
})

function makePrinter(id: string, serial: string): Printer {
  return {
    id,
    name: id,
    host: `${id}.local`,
    serial,
    accessCode: 'secret',
    model: 'P1S',
    currentPlateType: null,
    currentNozzleDiameters: [],
    position: 0,
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z'
  }
}

test('hintOnline reconnects every offline managed printer copy that shares a serial and skips online copies', () => {
  const online = makePrinter('printer-online', 'SERIAL123')
  const offlineOne = makePrinter('printer-offline-1', 'SERIAL123')
  const offlineTwo = makePrinter('printer-offline-2', 'SERIAL123')
  const otherSerial = makePrinter('printer-other', 'SERIAL999')

  printerManagerState.managed.set(online.id, { printer: online, status: { online: true } })
  printerManagerState.managed.set(offlineOne.id, { printer: offlineOne, status: { online: false } })
  printerManagerState.managed.set(offlineTwo.id, { printer: offlineTwo, status: { online: false } })
  printerManagerState.managed.set(otherSerial.id, { printer: otherSerial, status: { online: false } })

  const reconnects: string[] = []
  mock.method(printerManagerPrototype, 'reconnect', (printerId: string) => {
    reconnects.push(printerId)
    return true
  })

  assert.equal(printerManager.hintOnline('SERIAL123'), true)
  assert.deepEqual(reconnects, [offlineOne.id, offlineTwo.id])
})

test('hintOnline marks bridged offline printers online immediately when the bridge is connected', () => {
  const bridged = makePrinter('printer-bridge', 'SERIAL123')
  printerManagerState.managed.set(bridged.id, {
    printer: bridged,
    status: { online: false },
    offlineSince: Date.now(),
    recycleTimer: null
  })
  printerManagerState.bridgeIds.set(bridged.id, 'bridge-1')

  mock.method(bridgeSessionManager, 'isConnected', (bridgeId: string) => bridgeId === 'bridge-1')
  const reconnect = mock.method(printerManagerPrototype, 'reconnect', () => false)

  assert.equal(printerManager.hintOnline('SERIAL123'), true)
  assert.equal(printerManager.getStatus(bridged.id)?.online, true)
  assert.equal(reconnect.mock.callCount(), 0)
})