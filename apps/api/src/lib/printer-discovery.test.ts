import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PrinterDiscovery } from './printer-discovery.js'

function makeDiscoveredPrinter(overrides: Partial<{
  bridgeId: string
  serial: string
  host: string
  modelCode: string | null
  name: string | null
  firmware: string | null
  lastSeenAt: string
}> = {}) {
  return {
    bridgeId: overrides.bridgeId ?? 'bridge-1',
    serial: overrides.serial ?? 'SERIAL123',
    host: overrides.host ?? '192.168.1.30',
    modelCode: overrides.modelCode ?? 'C12',
    model: 'P1S' as const,
    name: overrides.name ?? 'Printer 3',
    firmware: overrides.firmware ?? '01.00.00.00',
    lastSeenAt: overrides.lastSeenAt ?? new Date(1_000).toISOString()
  }
}

test('same-host rediscovery hints an offline adopted printer to reconnect', async () => {
  const reconcileCalls: Array<{ serial: string; host: string; bridgeId: string }> = []
  const recoveryCalls: Array<{ serial: string; bridgeId: string }> = []
  let now = 1_000

  const discovery = new PrinterDiscovery({
    now: () => now,
    async reconcileHost(discovered) {
      reconcileCalls.push(discovered)
      return false
    },
    recoverOfflinePrinter(serial, bridgeId) {
      recoveryCalls.push({ serial, bridgeId })
      return true
    }
  })

  discovery.setBridgePrinters('bridge-1', [makeDiscoveredPrinter({ lastSeenAt: new Date(now).toISOString() })])
  // Discovery threads the observing bridge through so downstream writes/hints stay scoped to it.
  assert.deepEqual(reconcileCalls, [{ serial: 'SERIAL123', host: '192.168.1.30', bridgeId: 'bridge-1' }])
  assert.deepEqual(recoveryCalls, [])

  now += 1_000
  discovery.setBridgePrinters('bridge-1', [makeDiscoveredPrinter({ lastSeenAt: new Date(now).toISOString() })])
  assert.deepEqual(recoveryCalls, [{ serial: 'SERIAL123', bridgeId: 'bridge-1' }])

  now += 1_000
  discovery.setBridgePrinters('bridge-1', [makeDiscoveredPrinter({ lastSeenAt: new Date(now).toISOString() })])
  assert.deepEqual(recoveryCalls, [{ serial: 'SERIAL123', bridgeId: 'bridge-1' }])
})

test('tenant-specific discovery dismissal hides entries only for that tenant', () => {
  const discovery = new PrinterDiscovery({
    now: () => 1_000,
    async reconcileHost() {
      return false
    },
    recoverOfflinePrinter() {
      return false
    }
  })

  discovery.setBridgePrinters('bridge-1', [makeDiscoveredPrinter()])
  discovery.dismiss('SERIAL123', 'tenant-1')

  assert.deepEqual(discovery.list({ tenantId: 'tenant-1' }), [])
  assert.equal(discovery.get('SERIAL123', 'tenant-1'), undefined)
  assert.equal(discovery.list({ tenantId: 'tenant-2' }).length, 1)
  assert.equal(discovery.get('SERIAL123', 'tenant-2')?.serial, 'SERIAL123')
})

test('bridge filtering only returns entries discovered by the selected tenant bridges', () => {
  const discovery = new PrinterDiscovery({
    now: () => 1_000,
    async reconcileHost() {
      return false
    },
    recoverOfflinePrinter() {
      return false
    }
  })

  discovery.setBridgePrinters('bridge-1', [makeDiscoveredPrinter({ serial: 'SERIAL123' })])
  discovery.setBridgePrinters('bridge-2', [makeDiscoveredPrinter({ serial: 'SERIAL456', host: '192.168.1.31' })])

  assert.deepEqual(
    discovery.list({ bridgeIds: ['bridge-2'] }).map((entry) => entry.serial),
    ['SERIAL456']
  )
})