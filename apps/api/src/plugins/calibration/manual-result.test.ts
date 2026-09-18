import assert from 'node:assert/strict'
import { test } from 'node:test'
import { manualCalibrationResultSchema } from '@printstream/shared'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { saveManualResult } from './manual-result.js'

test('manual K values persist their mode and unmarked values remain native', async () => {
  const created: Array<Record<string, unknown>> = []
  const db = { calibrationResult: {
    findFirst: async () => null,
    create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data }
  } } as unknown as AnyPrismaClient
  for (const mode of [undefined, 'native', 'linear']) {
    await saveManualResult(db, 'workspace-one', manualCalibrationResultSchema.parse({
      calibration: { kind: 'pressureAdvance', value: 0.045, pressureAdvanceMode: mode },
      printerModel: 'H2D', nozzleDiameter: '0.4', target: { scope: 'spool', spoolIds: ['one'] }
    }))
  }
  assert.deepEqual(created.map((row) => row.pressureAdvanceMode), ['native', 'native', 'linear'])
})

test('manual entry saves deduplicated spool targets with no run or printer operations', async () => {
  const created: Array<Record<string, unknown>> = []
  const db = {
    calibrationResult: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data }
    }
  } as unknown as AnyPrismaClient
  const input = manualCalibrationResultSchema.parse({
    calibration: { kind: 'flowRatio', value: 0.982 }, printerModel: 'H2D', nozzleDiameter: '0.4',
    target: { scope: 'spool', spoolIds: ['one', 'two', 'one'] }
  })
  await saveManualResult(db, 'workspace-one', input)
  assert.equal(created.length, 2)
  for (const row of created) {
    assert.equal(row.workspaceId, 'workspace-one')
    assert.equal(row.runId, null)
    assert.equal(row.value, 0.982)
  }
  await assert.rejects(saveManualResult(db, 'workspace-one', { ...input, target: { scope: 'spool', spoolIds: [], applyToPrinter: false } }), /Choose at least one spool/)
  assert.equal(created.length, 2)
})

test('manual schema rejects out-of-range values and printer writes', () => {
  const input = {
    calibration: { kind: 'flowRatio', value: 2 }, printerModel: 'H2D', nozzleDiameter: '0.4',
    target: { scope: 'spool', spoolIds: ['one'] }
  }
  assert.equal(manualCalibrationResultSchema.safeParse(input).success, false)
  assert.equal(manualCalibrationResultSchema.safeParse({ ...input, calibration: { kind: 'flowRatio', value: 1 }, target: { ...input.target, applyToPrinter: true } }).success, false)
})

test('a checked blank identity field rejects saving even when another match is filled', async () => {
  const input = manualCalibrationResultSchema.parse({
    calibration: { kind: 'pressureAdvance', value: 0.02 }, printerModel: 'H2D', nozzleDiameter: '0.4',
    target: {
      scope: 'identity',
      match: { brand: true, filamentType: true, materialSubtype: false, colorName: false },
      identity: { brand: ' ', filamentType: 'PETG' }
    }
  })
  // No database delegate is supplied: validation must reject before any write.
  await assert.rejects(saveManualResult({} as AnyPrismaClient, 'workspace-one', input), /every checked filament detail/)
})
