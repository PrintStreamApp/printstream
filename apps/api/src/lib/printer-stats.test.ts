process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prisma } from './prisma.js'
import { readPrinterStats, setManualPrinterStats } from './printer-stats.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

const stub = usePrismaStubs()

const statsRowBase = {
  manualTotalPrints: 0,
  manualPrintDurationSeconds: 0,
  totalPrints: 0,
  successfulPrints: 0,
  failedPrints: 0,
  cancelledPrints: 0,
  successfulPrintDurationSeconds: 0,
  failedPrintDurationSeconds: 0,
  cancelledPrintDurationSeconds: 0,
  trackedFilamentPrints: 0,
  filamentUsedGrams: 0,
  successfulFilamentUsedGrams: 0,
  failedFilamentUsedGrams: 0,
  cancelledFilamentUsedGrams: 0,
  filamentUsedMeters: 0,
  successfulFilamentUsedMeters: 0,
  failedFilamentUsedMeters: 0,
  cancelledFilamentUsedMeters: 0
}

function stubPrinterLookup() {
  stub(prisma.printer, 'findFirst', async () => ({
    id: 'printer-1',
    tenantId: 'tenant-1',
    serial: 'SERIAL-1'
  }))
}

test('readPrinterStats folds manual adjustments into the lifetime totals', async () => {
  stubPrinterLookup()
  stub(prisma.printerStats, 'findUnique', async () => ({
    ...statsRowBase,
    manualTotalPrints: 12,
    manualPrintDurationSeconds: 90 * 60,
    totalPrints: 3,
    successfulPrints: 2,
    failedPrints: 1,
    successfulPrintDurationSeconds: 7200,
    failedPrintDurationSeconds: 1800
  }))

  const stats = await readPrinterStats('printer-1')
  assert.ok(stats)
  assert.equal(stats.manualPrints, 12)
  assert.equal(stats.manualPrintHours, 1.5)
  // Tracked 3 prints + 12 manual; tracked 2.5h + 1.5h manual.
  assert.equal(stats.totalPrints, 15)
  assert.equal(stats.totalPrintHours, 4)
  // Outcome breakdowns stay tracked-only.
  assert.equal(stats.successfulPrints, 2)
  assert.equal(stats.successfulPrintHours, 2)
  assert.equal(stats.failedPrints, 1)
})

test('readPrinterStats reports zero manual adjustments when no stats row exists', async () => {
  stubPrinterLookup()
  stub(prisma.printerStats, 'findUnique', async () => null)

  const stats = await readPrinterStats('printer-1')
  assert.ok(stats)
  assert.equal(stats.manualPrints, 0)
  assert.equal(stats.manualPrintHours, 0)
  assert.equal(stats.totalPrints, 0)
  assert.equal(stats.totalPrintHours, 0)
})

type CapturedUpsertArgs = { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }

test('setManualPrinterStats stores absolute values and converts hours to seconds', async () => {
  let capturedArgs: CapturedUpsertArgs | undefined
  stub(prisma.printerStats, 'upsert', async (args: CapturedUpsertArgs) => {
    capturedArgs = args
    return {}
  })

  await setManualPrinterStats({
    tenantId: 'tenant-1',
    printerSerial: 'SERIAL-1',
    manualPrints: 42,
    manualPrintHours: 10.5
  })

  assert.ok(capturedArgs)
  assert.deepEqual(capturedArgs.where, {
    tenantId_printerSerial: { tenantId: 'tenant-1', printerSerial: 'SERIAL-1' }
  })
  assert.equal(capturedArgs.create.manualTotalPrints, 42)
  assert.equal(capturedArgs.create.manualPrintDurationSeconds, 37800)
  assert.equal(capturedArgs.update.manualTotalPrints, 42)
  assert.equal(capturedArgs.update.manualPrintDurationSeconds, 37800)
})

test('setManualPrinterStats leaves omitted fields untouched on update', async () => {
  let capturedArgs: CapturedUpsertArgs | undefined
  stub(prisma.printerStats, 'upsert', async (args: CapturedUpsertArgs) => {
    capturedArgs = args
    return {}
  })

  await setManualPrinterStats({
    tenantId: 'tenant-1',
    printerSerial: 'SERIAL-1',
    manualPrintHours: 2
  })

  assert.ok(capturedArgs)
  assert.equal(capturedArgs.update.manualPrintDurationSeconds, 7200)
  assert.ok(!('manualTotalPrints' in capturedArgs.update))
  // A freshly created row still starts the omitted adjustment at zero.
  assert.equal(capturedArgs.create.manualTotalPrints, 0)
})
