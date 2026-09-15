/** Regression coverage for nullable spool fields that must remain clearable on update. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { updateSpoolRow } from './store.js'

test('updateSpoolRow preserves an explicit null product code', async () => {
  let writtenData: Record<string, unknown> | null = null
  const db = {
    filamentSpool: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        writtenData = data
        return { count: 1 }
      },
      findFirst: async () => null
    }
  } as unknown as AnyPrismaClient

  await updateSpoolRow(db, 'workspace-1', 'spool-1', { productCode: null })

  assert.deepEqual(writtenData, { productCode: null })
})
