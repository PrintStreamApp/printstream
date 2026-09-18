process.env.NODE_ENV = 'test'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobTag, PrinterStatus } from '@printstream/shared'
import { capturePrintJobTags } from './print-job-tag-capture.js'
import { rootPrisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

const stub = usePrismaStubs()
const spoolTag: JobTag = { id: 'spool-tag', entityKind: 'spool', name: 'Dry', group: '', color: '#123456' }

test('capture includes RFID inventory and only mapped slots, independent of grams or outcome', async () => {
  stub(rootPrisma.filamentSpool, 'findMany', async (args: { where: unknown }) => {
    assert.deepEqual(args.where, {
      workspaceId: 'w1', loadedPrinterId: 'p1', deletedAt: null,
      OR: [{ loadedAmsId: 0, loadedSlotId: 1 }, { loadedAmsId: 128, loadedSlotId: 0 }, { loadedAmsId: 254, loadedSlotId: null }]
    })
    // No remainSource filter: RFID spools are as eligible as manually tracked spools.
    return [{ id: 'rfid-spool' }, { id: 'untagged-spool' }]
  })
  stub(rootPrisma.workspaceTag, 'findMany', async (args: { where: unknown }) => {
    assert.deepEqual(args.where, { workspaceId: 'w1', OR: [
      { entityKind: 'spool', spools: { some: { id: { in: ['rfid-spool', 'untagged-spool'] }, workspaceId: 'w1' } } }
    ] })
    return [spoolTag]
  })
  const tags: JobTag[] = [{ ...spoolTag, id: 'file-tag', entityKind: 'file', name: 'Original' }]
  const snapshot = await capturePrintJobTags(rootPrisma, 'w1', { printerId: 'p1', tags, amsMapping: [1, -1, 128, 254] })
  tags[0]!.name = 'Edited during print'
  spoolTag.name = 'Edited after capture'
  assert.equal(snapshot.tags[0]?.name, 'Original')
  assert.equal(snapshot.tags[1]?.name, 'Dry')
  spoolTag.name = 'Dry'
  assert.deepEqual(snapshot.spoolIds, ['rfid-spool', 'untagged-spool'])
})

test('unknown mapping never attributes all loaded inventory', async () => {
  stub(rootPrisma.filamentSpool, 'findMany', async () => { throw new Error('must not query unknown slots') })
  assert.deepEqual(await capturePrintJobTags(rootPrisma, 'w1', { printerId: 'p1', tags: [] }), { tags: [], spoolIds: [] })
})

test('external spool selection works without an AMS mapping', async () => {
  stub(rootPrisma.filamentSpool, 'findMany', async (args: { where: { OR: unknown } }) => {
    assert.deepEqual(args.where.OR, [{ loadedAmsId: 255, loadedSlotId: null }])
    return []
  })
  await capturePrintJobTags(rootPrisma, 'w1', { printerId: 'p1', tags: [], useAms: false })
})

test('externally started jobs capture only observed active inventory slots', async () => {
  stub(rootPrisma.filamentSpool, 'findMany', async (args: { where: { OR: unknown } }) => {
    assert.deepEqual(args.where.OR, [{ loadedAmsId: 128, loadedSlotId: 0 }, { loadedAmsId: 254, loadedSlotId: null }])
    return []
  })
  const observedStatus = {
    ams: [{ unitId: 128, slots: [{ slot: 0, active: true }, { slot: 1, active: false }] }],
    externalSpools: [{ amsId: 254, active: true }, { amsId: 255, active: false }]
  } as PrinterStatus
  await capturePrintJobTags(rootPrisma, 'w1', { printerId: 'p1', tags: [], observedStatus })
})
