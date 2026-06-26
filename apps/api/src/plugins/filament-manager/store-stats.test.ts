process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { readFilamentUsageStats } from './store.js'

type GroupRow = { filamentType?: string; brand?: string | null; _sum: { netWeightGrams: number | null; remainingGrams: number | null } }

/** A minimal Prisma stand-in that answers the two groupBy calls by `by` field. */
function fakeDb(byType: GroupRow[], byBrand: GroupRow[]): AnyPrismaClient {
  return {
    filamentSpool: {
      groupBy: async (args: { by: string[] }) => (args.by[0] === 'brand' ? byBrand : byType)
    }
  } as unknown as AnyPrismaClient
}

test('readFilamentUsageStats sums net-minus-remaining and sorts slices desc', async () => {
  const db = fakeDb(
    [
      { filamentType: 'PLA', _sum: { netWeightGrams: 2000, remainingGrams: 500 } }, // 1500 used
      { filamentType: 'PETG', _sum: { netWeightGrams: 1000, remainingGrams: 700 } } // 300 used
    ],
    [
      { brand: 'Bambu', _sum: { netWeightGrams: 2000, remainingGrams: 500 } }, // 1500
      { brand: 'Polymaker', _sum: { netWeightGrams: 1000, remainingGrams: 700 } } // 300
    ]
  )
  const stats = await readFilamentUsageStats(db, 'tenant-1')
  assert.equal(stats.totalGramsUsed, 1800)
  assert.deepEqual(stats.byType, [
    { label: 'PLA', gramsUsed: 1500 },
    { label: 'PETG', gramsUsed: 300 }
  ])
  assert.deepEqual(stats.byBrand[0], { label: 'Bambu', gramsUsed: 1500 })
})

test('readFilamentUsageStats clamps negatives, drops zero usage, and labels missing brand', async () => {
  const db = fakeDb(
    [
      { filamentType: 'PLA', _sum: { netWeightGrams: 1000, remainingGrams: 1000 } }, // 0 used -> dropped
      { filamentType: 'ABS', _sum: { netWeightGrams: 1000, remainingGrams: 1200 } } // negative -> clamped 0 -> dropped
    ],
    [
      { brand: null, _sum: { netWeightGrams: 1000, remainingGrams: 250 } }, // 750, no brand
      { brand: '  ', _sum: { netWeightGrams: 500, remainingGrams: 0 } } // 500, blank brand -> merges with Unbranded
    ]
  )
  const stats = await readFilamentUsageStats(db, 'tenant-1')
  assert.deepEqual(stats.byType, [])
  assert.deepEqual(stats.byBrand, [{ label: 'Unbranded', gramsUsed: 1250 }])
})

test('readFilamentUsageStats handles an empty inventory', async () => {
  const stats = await readFilamentUsageStats(fakeDb([], []), 'tenant-1')
  assert.deepEqual(stats, { totalGramsUsed: 0, byType: [], byBrand: [] })
})
