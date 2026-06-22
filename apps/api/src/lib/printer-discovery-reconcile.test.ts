import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { reconcileAdoptedPrinterHost } from './printer-discovery-reconcile.js'

function makePrinterRow(overrides: Partial<{
  id: string
  name: string
  host: string
  serial: string
  bridgeId: string
  accessCode: string
  model: string
  currentPlateType: string | null
  currentNozzleDiameters: string | null
  position: number
  createdAt: Date
  updatedAt: Date
}> = {}) {
  return {
    id: overrides.id ?? 'printer-1',
    name: overrides.name ?? 'Printer 1',
    host: overrides.host ?? '192.168.1.10',
    serial: overrides.serial ?? 'SERIAL123',
    bridgeId: overrides.bridgeId ?? 'bridge-1',
    accessCode: overrides.accessCode ?? 'secret',
    model: overrides.model ?? 'P1S',
    currentPlateType: overrides.currentPlateType ?? null,
    currentNozzleDiameters: overrides.currentNozzleDiameters ?? null,
    position: overrides.position ?? 0,
    createdAt: overrides.createdAt ?? new Date('2026-04-28T00:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-04-28T00:00:00.000Z')
  }
}

test('reconcileAdoptedPrinterHost refreshes an adopted printer host and reconnects the manager entry', async () => {
  const existing = makePrinterRow()
  const updated = { ...existing, host: '192.168.1.44', updatedAt: new Date('2026-04-29T00:00:00.000Z') }
  const writes: Array<{ where: { id: string }; data: { host: string } }> = []
  const managerUpdates: Printer[] = []

  const changed = await reconcileAdoptedPrinterHost(
    { serial: existing.serial, host: updated.host, bridgeId: 'bridge-1' },
    {
      printerStore: {
        async findMany({ where }: { where: { serial: string; bridgeId: string } }) {
          assert.equal(where.serial, existing.serial)
          // The lookup must be scoped to the reporting bridge, never serial alone.
          assert.equal(where.bridgeId, 'bridge-1')
          return [existing]
        },
        async update(args) {
          writes.push(args)
          return updated
        }
      },
      manager: {
        update(printer) {
          managerUpdates.push(printer)
        }
      }
    }
  )

  assert.equal(changed, true)
  assert.deepEqual(writes, [{ where: { id: existing.id }, data: { host: updated.host } }])
  assert.equal(managerUpdates.length, 1)
  assert.equal(managerUpdates[0]?.id, existing.id)
  assert.equal(managerUpdates[0]?.host, updated.host)
})

test('reconcileAdoptedPrinterHost refreshes every adopted copy on the reporting bridge that shares a serial', async () => {
  const first = makePrinterRow({ id: 'printer-1', name: 'Printer 1', host: '192.168.1.10', bridgeId: 'bridge-1' })
  const second = makePrinterRow({ id: 'printer-2', name: 'Printer 2', host: '192.168.1.11', bridgeId: 'bridge-1' })
  const writes: Array<{ where: { id: string }; data: { host: string } }> = []
  const managerUpdates: Printer[] = []

  const changed = await reconcileAdoptedPrinterHost(
    { serial: first.serial, host: '192.168.1.44', bridgeId: 'bridge-1' },
    {
      printerStore: {
        async findMany({ where }: { where: { serial: string; bridgeId: string } }) {
          assert.equal(where.bridgeId, 'bridge-1')
          return [first, second]
        },
        async update(args) {
          writes.push(args)
          const source = args.where.id === first.id ? first : second
          return {
            ...source,
            host: args.data.host,
            updatedAt: new Date('2026-04-29T00:00:00.000Z')
          }
        }
      },
      manager: {
        update(printer) {
          managerUpdates.push(printer)
        }
      }
    }
  )

  assert.equal(changed, true)
  assert.deepEqual(writes, [
    { where: { id: first.id }, data: { host: '192.168.1.44' } },
    { where: { id: second.id }, data: { host: '192.168.1.44' } }
  ])
  assert.deepEqual(managerUpdates.map((row) => row.id), [first.id, second.id])
  assert.deepEqual(managerUpdates.map((row) => row.host), ['192.168.1.44', '192.168.1.44'])
})

test('reconcileAdoptedPrinterHost never touches a same-serial printer owned by a different bridge/tenant', async () => {
  // Two tenants own a printer with the same serial via different bridges. A
  // discovery report from bridge-1 must only ever rewrite bridge-1's row.
  const mine = makePrinterRow({ id: 'mine', host: '192.168.1.10', bridgeId: 'bridge-1' })
  const theirs = makePrinterRow({ id: 'theirs', host: '10.0.0.5', bridgeId: 'bridge-2' })
  const allRows = [mine, theirs]
  const writes: Array<{ where: { id: string }; data: { host: string } }> = []
  const managerUpdates: Printer[] = []

  const changed = await reconcileAdoptedPrinterHost(
    { serial: 'SERIAL123', host: '192.168.1.44', bridgeId: 'bridge-1' },
    {
      printerStore: {
        // Stand in for Prisma's WHERE: only rows matching serial AND bridgeId.
        async findMany({ where }: { where: { serial: string; bridgeId: string } }) {
          return allRows.filter((row) => row.serial === where.serial && row.bridgeId === where.bridgeId)
        },
        async update(args) {
          writes.push(args)
          return { ...mine, host: args.data.host }
        }
      },
      manager: {
        update(printer) {
          managerUpdates.push(printer)
        }
      }
    }
  )

  assert.equal(changed, true)
  // Only bridge-1's row is rewritten; the other tenant's same-serial printer is untouched.
  assert.deepEqual(writes.map((write) => write.where.id), ['mine'])
  assert.deepEqual(managerUpdates.map((row) => row.id), ['mine'])
})

test('reconcileAdoptedPrinterHost ignores rediscovery when the saved host is already current', async () => {
  const existing = makePrinterRow()
  let updateCalled = false
  let managerCalled = false

  const changed = await reconcileAdoptedPrinterHost(
    { serial: existing.serial, host: existing.host, bridgeId: 'bridge-1' },
    {
      printerStore: {
        async findMany() {
          return [existing]
        },
        async update() {
          updateCalled = true
          return existing
        }
      },
      manager: {
        update() {
          managerCalled = true
        }
      }
    }
  )

  assert.equal(changed, false)
  assert.equal(updateCalled, false)
  assert.equal(managerCalled, false)
})
