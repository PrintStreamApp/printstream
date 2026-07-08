import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slotFilamentResolvers, type SlotFilamentIdentity } from './slot-filament-registry.js'

const query = { tenantId: 't1', printerId: 'p1', amsId: 0, slotId: 1 }
const identity = (spoolId: string): SlotFilamentIdentity => ({
  spoolId,
  brand: 'Acme',
  filamentType: 'PLA',
  materialSubtype: null,
  colorName: 'White'
})

test('resolve returns null when no resolver is registered', async () => {
  assert.equal(slotFilamentResolvers.size(), 0)
  assert.equal(await slotFilamentResolvers.resolve(query), null)
})

test('a registered resolver answers, and unregister removes it', async () => {
  const off = slotFilamentResolvers.register(async () => identity('spool-1'))
  assert.deepEqual(await slotFilamentResolvers.resolve(query), identity('spool-1'))
  off()
  assert.equal(slotFilamentResolvers.size(), 0)
  assert.equal(await slotFilamentResolvers.resolve(query), null)
})

test('resolve returns the first non-null answer and passes the query through', async () => {
  const seen: unknown[] = []
  const off1 = slotFilamentResolvers.register(async (q) => { seen.push(q); return null })
  const off2 = slotFilamentResolvers.register(async () => identity('spool-2'))
  const off3 = slotFilamentResolvers.register(async () => identity('spool-3'))
  try {
    assert.deepEqual(await slotFilamentResolvers.resolve(query), identity('spool-2'))
    assert.deepEqual(seen, [query])
  } finally {
    off1(); off2(); off3()
  }
})

test('a throwing resolver is skipped so a later one still answers', async () => {
  const off1 = slotFilamentResolvers.register(async () => { throw new Error('boom') })
  const off2 = slotFilamentResolvers.register(async () => identity('spool-4'))
  try {
    assert.deepEqual(await slotFilamentResolvers.resolve(query), identity('spool-4'))
  } finally {
    off1(); off2()
  }
})
