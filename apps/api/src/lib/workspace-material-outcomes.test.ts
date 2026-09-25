import assert from 'node:assert/strict'
import test from 'node:test'
import { prisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { foldMaterialOutcomeRows, readWorkspaceMaterialOutcomes } from './workspace-material-outcomes.js'

const stub = usePrismaStubs()

test('material reliability applies workspace and selected dates inside the aggregate query', async () => {
  stub(prisma, '$queryRaw', async (query: { strings: string[]; values: unknown[] }) => {
    const sql = query.strings.join('?')
    assert.match(sql, /job\."workspaceId" =/)
    assert.match(sql, /job\."finishedAt" >=/)
    assert.match(sql, /job\."finishedAt" </)
    assert.deepEqual(query.values, [
      'workspace-1',
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-25T00:00:00.000Z')
    ])
    return [{ materialType: 'PLA', result: 'success', printCount: 2 }]
  })

  assert.deepEqual(await readWorkspaceMaterialOutcomes('workspace-1', {
    from: new Date('2026-09-01T00:00:00.000Z'),
    until: new Date('2026-09-25T00:00:00.000Z')
  }), [{ materialType: 'PLA', successfulPrints: 2, failedPrints: 0, cancelledPrints: 0 }])
})

test('material outcomes retain cancellation counts without treating them as failures', () => {
  assert.deepEqual(foldMaterialOutcomeRows([
    { materialType: 'PLA', result: 'success', printCount: 7 },
    { materialType: 'PLA', result: 'failed', printCount: 2 },
    { materialType: 'PLA', result: 'cancelled', printCount: 3 },
    { materialType: 'PETG', result: 'failed', printCount: 1 }
  ]), [
    { materialType: 'PETG', successfulPrints: 0, failedPrints: 1, cancelledPrints: 0 },
    { materialType: 'PLA', successfulPrints: 7, failedPrints: 2, cancelledPrints: 3 }
  ])
})
