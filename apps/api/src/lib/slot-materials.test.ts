import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import type { PrinterStatus, PrinterCommand } from '@printstream/shared'
import { rootPrisma } from './prisma.js'
import { clearSlotMaterial, decorateSlotMaterials, loadSlotMaterials, manualSlotMaterial, removePrinterSlotMaterials, saveSlotMaterial } from './slot-materials.js'
import { slotFilamentResolvers } from './slot-filament-registry.js'
import { commandToMqttPayloads } from './printer-command-payloads.js'

const original = {
  findMany: rootPrisma.setting.findMany,
  upsert: rootPrisma.setting.upsert,
  deleteMany: rootPrisma.setting.deleteMany
}
const rows = new Map<string, string>()
const identity = { brand: 'My brand', filamentType: 'PETG-CF', materialSubtype: 'Custom series', colorName: 'Red' }
const query = { workspaceId: 'ws', printerId: 'wilma', amsId: 0, slotId: 1 }
const command: Extract<PrinterCommand, { type: 'setAmsSlot' }> = {
  type: 'setAmsSlot', amsId: 0, slotId: 1, trayType: 'PETG-CF', trayInfoIdx: 'GFG50', trayColor: 'FF0000FF',
  nozzleTempMin: 240, nozzleTempMax: 270, materialIdentity: identity
}
const tray = { slot: 1, occupied: true, trayUuid: null, filamentType: 'PETG-CF', trayInfoIdx: 'GFG50', color: '#ff0000' }
function status(overrides = {}): PrinterStatus {
  return { printerId: 'wilma', online: true, ams: [{ unitId: 0, slots: [{ ...tray, ...overrides }] }], externalSpools: [] } as unknown as PrinterStatus
}

beforeEach(async () => {
  rows.clear()
  rootPrisma.setting.findMany = (async () => [...rows].map(([key, value]) => ({ key, value }))) as typeof rootPrisma.setting.findMany
  rootPrisma.setting.upsert = (async (args: { where: { key: string }; update: { value: string } }) => {
    rows.set(args.where.key, args.update.value)
    return { key: args.where.key, value: args.update.value }
  }) as unknown as typeof rootPrisma.setting.upsert
  rootPrisma.setting.deleteMany = (async (args: { where: { key: string | { startsWith: string }; value?: string } }) => {
    for (const [key, value] of rows) {
      if ((typeof args.where.key === 'string' ? args.where.key === key : key.startsWith(args.where.key.startsWith))
        && (args.where.value === undefined || args.where.value === value)) rows.delete(key)
    }
    return { count: 1 }
  }) as unknown as typeof rootPrisma.setting.deleteMany
  await loadSlotMaterials([{ id: 'wilma', workspaceId: 'ws' }])
})
afterEach(() => Object.assign(rootPrisma.setting, original))

test('manual identity survives the generic printer echo and restart, scoped to its workspace', async () => {
  await saveSlotMaterial('ws', 'wilma', command)
  assert.deepEqual(decorateSlotMaterials(status()).ams[0]!.slots[0]!.materialIdentity, identity)
  assert.equal(decorateSlotMaterials(status()).ams[0]!.slots[0]!.trayInfoIdx, 'GFG50')
  await loadSlotMaterials([{ id: 'wilma', workspaceId: 'ws' }])
  assert.deepEqual(manualSlotMaterial(query), identity)
  assert.equal(manualSlotMaterial({ ...query, workspaceId: 'other' }), null)
  await loadSlotMaterials([{ id: 'wilma', workspaceId: 'other' }])
  assert.equal(manualSlotMaterial({ ...query, workspaceId: 'other' }), null)
})

test('the pre-command report is tolerated, but a confirmed spool replacement clears identity', async () => {
  await saveSlotMaterial('ws', 'wilma', command)
  assert.deepEqual(decorateSlotMaterials(status({ filamentType: 'PLA' })).ams[0]!.slots[0]!.materialIdentity, identity)
  decorateSlotMaterials(status())
  assert.equal(decorateSlotMaterials(status({ color: '#0000FF' })).ams[0]!.slots[0]!.materialIdentity, null)
  assert.equal(manualSlotMaterial(query), null)
  assert.equal(rows.size, 0)
})

test('empty and RFID trays cannot retain a confirmed manual assignment', async () => {
  for (const replacement of [{ occupied: false }, { trayUuid: 'ABC123' }]) {
    await saveSlotMaterial('ws', 'wilma', command)
    decorateSlotMaterials(status())
    assert.equal(decorateSlotMaterials(status(replacement)).ams[0]!.slots[0]!.materialIdentity, null)
    assert.equal(rows.size, 0)
  }
})

test('inventory assignment, slot reset, and printer deletion clear saved identity', async () => {
  await saveSlotMaterial('ws', 'wilma', command)
  await clearSlotMaterial('ws', 'wilma', 0, 1)
  assert.equal(manualSlotMaterial(query), null)
  await saveSlotMaterial('ws', 'wilma', command)
  await saveSlotMaterial('ws', 'wilma', { type: 'resetAmsSlot', amsId: 0, slotId: 1 })
  assert.equal(rows.size, 0)
  await saveSlotMaterial('ws', 'wilma', command)
  await removePrinterSlotMaterials('ws', 'wilma')
  assert.equal(rows.size, 0)
  assert.equal(manualSlotMaterial(query), null)
})

test('external identities persist independently and no PS identity is serialized into MQTT', async () => {
  const external: Extract<PrinterCommand, { type: 'setExternalSpool' }> = { ...command, type: 'setExternalSpool', amsId: 255 }
  await saveSlotMaterial('ws', 'wilma', external)
  assert.deepEqual(manualSlotMaterial({ ...query, amsId: 255, slotId: null }), identity)
  for (const setting of [command, external]) {
    const withIdentity = commandToMqttPayloads('H2D', setting, undefined)
    const withoutIdentity = commandToMqttPayloads('H2D', { ...setting, materialIdentity: null }, undefined)
    assert.deepEqual(withIdentity, withoutIdentity)
    assert.equal(JSON.stringify(withIdentity).includes('My brand'), false)
  }
})

test('expired pending settings clear only after a live contradictory report', async (t) => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  await saveSlotMaterial('ws', 'wilma', command)
  now += 31_000
  decorateSlotMaterials({ ...status({ filamentType: 'PLA' }), online: false })
  assert.deepEqual(manualSlotMaterial(query), identity)
  decorateSlotMaterials(status({ filamentType: 'PLA' }))
  assert.equal(manualSlotMaterial(query), null)
})

test('an empty hardware preset echoes as null without losing the manual identity', async () => {
  await saveSlotMaterial('ws', 'wilma', { ...command, trayInfoIdx: '' })
  assert.deepEqual(decorateSlotMaterials(status({ trayInfoIdx: null })).ams[0]!.slots[0]!.materialIdentity, identity)
})

test('manual identity precedes optional inventory and can release its previous association', async () => {
  let released = false
  const off = slotFilamentResolvers.register(async () => ({
    spoolId: 'old-spool', brand: 'Old', filamentType: 'PLA', materialSubtype: null, colorName: null, remainingGrams: 500
  }), async (target) => {
    assert.deepEqual(target, query)
    released = true
  })
  try {
    await saveSlotMaterial('ws', 'wilma', command)
    assert.deepEqual(await slotFilamentResolvers.resolve(query), { ...identity, spoolId: null, remainingGrams: null })
    await slotFilamentResolvers.release(query)
    assert.equal(released, true)
  } finally {
    off()
  }
})

test('partial connection status has no slot identities until trays arrive', () => {
  const decorated = decorateSlotMaterials({ printerId: 'wilma', online: true } as PrinterStatus)
  assert.deepEqual(decorated.ams, [])
  assert.deepEqual(decorated.externalSpools, [])
})
