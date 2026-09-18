import assert from 'node:assert/strict'
import { test } from 'node:test'
import { amsTrayIndex } from '@printstream/shared'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { calibrationAmsMapping, saveRunResult, type CalibrationRunManagerDeps } from './run-manager.js'

test('a failed second target keeps all result and run writes inside the transaction', async () => {
  const run = { id: 'run-1', kind: 'flowRatio', status: 'saved', resultValue: 1,
    printerModel: 'H2D', nozzleDiameter: '0.4' }
  let transactions = 0
  let creates = 0
  let committed = false
  const transaction = {
    calibrationResult: {
      deleteMany: async () => ({ count: 1 }),
      findFirst: async () => null,
      create: async () => {
        creates++
        if (creates === 2) throw new Error('second target failed')
        return {}
      }
    },
    calibrationRun: { updateMany: async () => ({ count: 1 }) }
  }
  // The root client deliberately has no write methods: every write must use the
  // transaction client, whose rejection is what instructs Prisma to roll back.
  const db = {
    calibrationRun: { findFirst: async () => run },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      transactions++
      await callback(transaction)
      committed = true
    }
  } as unknown as AnyPrismaClient
  await assert.rejects(saveRunResult({} as CalibrationRunManagerDeps, db, 'workspace-1', 'run-1', {
    scope: 'spool', spoolIds: ['spool-1', 'spool-2'], applyToPrinter: false,
    identity: { brand: 'Brand', filamentType: 'PETG', materialSubtype: null, colorName: null }
  }), /second target failed/)
  assert.equal(transactions, 1)
  assert.equal(creates, 2)
  assert.equal(committed, false)
})

test('calibrationAmsMapping pins the chosen tray, or defers to the printer default when unknown', () => {
  // The reported bug: AMS A (unit 0) slot 2 (slotId 1) must map to global tray index 1, so the
  // print uses slot 2 and not the printer's default (tray 0 / slot 1).
  const trayIndex = amsTrayIndex('ams-2-pro', 0, 1)
  assert.equal(trayIndex, 1)
  assert.deepEqual(calibrationAmsMapping(trayIndex), [1])
  // AMS B (unit 1) slot 1 (slotId 0) -> global tray 4.
  assert.deepEqual(calibrationAmsMapping(amsTrayIndex('ams-2-pro', 1, 0)), [4])
  // Unknown tray (slot not in live status) -> omit ams_mapping so dispatch keeps the printer default.
  assert.equal(calibrationAmsMapping(null), undefined)
})

test('saveRunResult replaces one run with an explicit multi-spool target set', async () => {
  const created: Array<Record<string, unknown>> = []
  const deleted: Array<Record<string, unknown>> = []
  const runUpdates: Array<Record<string, unknown>> = []
  const run = {
    id: 'run-1',
    workspaceId: 'workspace-1',
    kind: 'flowRatio',
    status: 'awaitingResult',
    printerId: 'printer-1',
    printerModel: 'H2D',
    nozzleDiameter: '0.4',
    amsId: 0,
    slotId: 3,
    spoolId: null,
    brand: null,
    filamentType: 'PETG',
    materialSubtype: null,
    colorName: 'Red',
    resultValue: 0.982
  }
  const db = {
    $transaction: async (callback: (transaction: AnyPrismaClient) => Promise<unknown>) => callback(db),
    calibrationRun: {
      findFirst: async () => run,
      updateMany: async (args: Record<string, unknown>) => { runUpdates.push(args); return { count: 1 } }
    },
    calibrationResult: {
      deleteMany: async (args: Record<string, unknown>) => { deleted.push(args); return { count: 0 } },
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data }
    }
  } as unknown as AnyPrismaClient

  await saveRunResult({} as CalibrationRunManagerDeps, db, 'workspace-1', 'run-1', {
    scope: 'spool',
    spoolIds: ['spool-1', 'spool-2', 'spool-1'],
    applyToPrinter: false
  })

  assert.deepEqual(created.map((row) => row.spoolId), ['spool-1', 'spool-2'])
  assert.deepEqual(deleted[0], { where: { workspaceId: 'workspace-1', runId: 'run-1' } })
  assert.deepEqual(runUpdates.at(-1), { where: { id: 'run-1', workspaceId: 'workspace-1' }, data: { status: 'saved' } })

  run.status = 'saved'
  await saveRunResult({} as CalibrationRunManagerDeps, db, 'workspace-1', 'run-1', {
    scope: 'spool',
    spoolIds: ['spool-1', 'spool-2'],
    value: 1.017,
    applyToPrinter: false
  })
  assert.deepEqual(created.slice(-2).map((row) => row.value), [1.017, 1.017])
  assert.deepEqual(runUpdates.at(-1), {
    where: { id: 'run-1', workspaceId: 'workspace-1' },
    data: { status: 'saved', resultValue: 1.017 }
  })
  const writesBeforeInvalidValue = created.length
  await assert.rejects(saveRunResult({} as CalibrationRunManagerDeps, db, 'workspace-1', 'run-1', {
    scope: 'spool', spoolIds: ['spool-1'], value: 2, applyToPrinter: false
  }), /outside the allowed range/)
  assert.equal(created.length, writesBeforeInvalidValue)
})

test('saveRunResult can repair an unidentified AMS filament after the print', async () => {
  const created: Array<Record<string, unknown>> = []
  const runUpdates: Array<Record<string, unknown>> = []
  const run = {
    id: 'run-1',
    workspaceId: 'workspace-1',
    kind: 'flowRatio',
    status: 'awaitingResult',
    printerId: 'printer-1',
    printerModel: 'H2D',
    nozzleDiameter: '0.4',
    amsId: 0,
    slotId: 3,
    spoolId: null,
    brand: null,
    filamentType: null,
    materialSubtype: null,
    colorName: null,
    resultValue: 0.982
  }
  const db = {
    $transaction: async (callback: (transaction: AnyPrismaClient) => Promise<unknown>) => callback(db),
    calibrationRun: {
      findFirst: async () => run,
      updateMany: async (args: Record<string, unknown>) => { runUpdates.push(args); return { count: 1 } }
    },
    calibrationResult: {
      deleteMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data }
    }
  } as unknown as AnyPrismaClient

  await saveRunResult({} as CalibrationRunManagerDeps, db, 'workspace-1', 'run-1', {
    scope: 'identity',
    match: { brand: true, filamentType: true, materialSubtype: false, colorName: false },
    identity: { brand: 'Polymaker', filamentType: 'PETG', materialSubtype: null, colorName: null },
    applyToPrinter: false
  })

  assert.equal(created[0]?.brand, 'Polymaker')
  assert.equal(created[0]?.filamentType, 'PETG')
  assert.deepEqual(runUpdates[0], {
    where: { id: 'run-1', workspaceId: 'workspace-1' },
    data: { brand: 'Polymaker', filamentType: 'PETG', materialSubtype: null, colorName: null }
  })
})
