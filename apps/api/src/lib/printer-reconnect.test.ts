import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { reconnectPrinter } from './printer-reconnect.js'

const printer: Printer = {
  id: 'printer-2',
  name: '2 - Wilma',
  host: '192.168.1.20',
  serial: 'WILMA123',
  accessCode: 'secret',
  model: 'P1S',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 1,
  createdAt: '2026-04-28T00:00:00.000Z',
  updatedAt: '2026-04-28T00:00:00.000Z'
}

test('reconnectPrinter updates the saved host before reconnecting when discovery disagrees', async () => {
  const reconciles: Array<{ serial: string; host: string }> = []
  let reconnects = 0

  const result = await reconnectPrinter(printer, {
    discovery: {
      get(serial) {
        assert.equal(serial, printer.serial)
        return { host: '192.168.1.77' }
      }
    },
    async reconcileHost(discovered) {
      reconciles.push(discovered)
      return true
    },
    manager: {
      reconnect() {
        reconnects += 1
        return true
      }
    }
  })

  assert.equal(result, 'updated-host')
  assert.deepEqual(reconciles, [{ serial: printer.serial, host: '192.168.1.77' }])
  assert.equal(reconnects, 0)
})

test('reconnectPrinter recycles the current client when discovery has no newer host', async () => {
  let reconnectTarget: string | null = null

  const result = await reconnectPrinter(printer, {
    discovery: {
      get() {
        return undefined
      }
    },
    async reconcileHost() {
      throw new Error('should not reconcile when discovery has no newer host')
    },
    manager: {
      reconnect(printerId) {
        reconnectTarget = printerId
        return true
      }
    }
  })

  assert.equal(result, 'reconnecting')
  assert.equal(reconnectTarget, printer.id)
})