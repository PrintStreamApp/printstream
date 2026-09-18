import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { validateCalibrationPrinterTarget } from './printer-target.js'

test('model targets are canonical and omitted targets retain the measured model', async () => {
  const db = {} as AnyPrismaClient
  assert.deepEqual(await validateCalibrationPrinterTarget(db, 'workspace', undefined, 'P1S'), { scope: 'models', models: ['P1S'] })
  assert.deepEqual(await validateCalibrationPrinterTarget(db, 'workspace', { scope: 'models', models: ['P1S', 'P1P', 'P1S'] }, 'P1S'), { scope: 'models', models: ['P1P', 'P1S'] })
})

test('named printer targets must all belong to the current workspace', async () => {
  const db = { printer: { findMany: async (query: unknown) => {
    assert.deepEqual(query, { where: { workspaceId: 'workspace', id: { in: ['wilma'] } }, select: { id: true } })
    return [{ id: 'wilma' }]
  } } } as unknown as AnyPrismaClient
  assert.deepEqual(await validateCalibrationPrinterTarget(db, 'workspace', { scope: 'printers', printerIds: ['wilma', 'wilma'] }, 'P1S'), { scope: 'printers', printerIds: ['wilma'] })
  const missing = { printer: { findMany: async () => [] } } as unknown as AnyPrismaClient
  await assert.rejects(validateCalibrationPrinterTarget(missing, 'workspace', { scope: 'printers', printerIds: ['foreign'] }, 'P1S'), /belong to this workspace/)
})
