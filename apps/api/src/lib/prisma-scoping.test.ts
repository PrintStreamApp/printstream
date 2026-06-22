import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergeTenantWhere,
  scopeCreateArgs,
  scopeCreateManyArgs,
  scopeFilteredArgs,
  scopeOwnedMutationArgs,
  scopeUpsertArgs
} from './prisma.js'

const TENANT = 'tenant-1'

// The tenant-scoping `$extends` extension can only be exercised end-to-end
// against a live engine, so its pure argument-shaping (inject on create, merge
// on filtered/upsert) is extracted into these helpers and tested here. Ownership
// decisions are covered in prisma-ownership.test.ts; model classification in
// prisma-tenant-models.test.ts.

test('scopeCreateArgs injects the tenant id into create data', () => {
  const scoped = scopeCreateArgs({ data: { name: 'Cube' } }, TENANT)
  assert.deepEqual(scoped, { data: { name: 'Cube', tenantId: TENANT } })
})

test('scopeCreateArgs does not let caller data override the tenant id', () => {
  const scoped = scopeCreateArgs({ data: { name: 'Cube', tenantId: 'attacker' } }, TENANT)
  assert.equal(scoped.data.tenantId, TENANT)
})

test('scopeCreateManyArgs injects the tenant id into every row of an array', () => {
  const scoped = scopeCreateManyArgs({ data: [{ name: 'A' }, { name: 'B' }] }, TENANT)
  assert.deepEqual(scoped.data, [
    { name: 'A', tenantId: TENANT },
    { name: 'B', tenantId: TENANT }
  ])
})

test('scopeCreateManyArgs injects the tenant id into a single-object createMany', () => {
  const scoped = scopeCreateManyArgs({ data: { name: 'A' } }, TENANT)
  assert.deepEqual(scoped.data, { name: 'A', tenantId: TENANT })
})

test('scopeCreateManyArgs preserves other args (e.g. skipDuplicates)', () => {
  const scoped = scopeCreateManyArgs({ data: [{ name: 'A' }], skipDuplicates: true }, TENANT) as { data: unknown; skipDuplicates: boolean }
  assert.equal(scoped.skipDuplicates, true)
})

test('mergeTenantWhere returns a bare tenant filter when there is no where', () => {
  assert.deepEqual(mergeTenantWhere(undefined, TENANT), { tenantId: TENANT })
})

test('mergeTenantWhere ANDs the tenant filter with an existing where (never widens it)', () => {
  const merged = mergeTenantWhere({ name: 'Cube' }, TENANT)
  assert.deepEqual(merged, { AND: [{ name: 'Cube' }, { tenantId: TENANT }] })
})

test('scopeFilteredArgs constrains where and keeps other args', () => {
  const scoped = scopeFilteredArgs({ where: { name: 'Cube' }, orderBy: { name: 'asc' } }, TENANT) as {
    where: Record<string, unknown>
    orderBy: unknown
  }
  assert.deepEqual(scoped.where, { AND: [{ name: 'Cube' }, { tenantId: TENANT }] })
  assert.deepEqual(scoped.orderBy, { name: 'asc' })
})

test('scopeFilteredArgs scopes a where-less list to the tenant', () => {
  const scoped = scopeFilteredArgs({}, TENANT) as { where: Record<string, unknown> }
  assert.deepEqual(scoped.where, { tenantId: TENANT })
})

test('scopeUpsertArgs constrains where, injects tenant into create, leaves update', () => {
  const scoped = scopeUpsertArgs({
    where: { id: 'row-1' },
    create: { id: 'row-1', name: 'Cube' },
    update: { name: 'Cube v2' }
  }, TENANT)
  assert.deepEqual(scoped.where, { AND: [{ id: 'row-1' }, { tenantId: TENANT }] })
  assert.deepEqual(scoped.create, { id: 'row-1', name: 'Cube', tenantId: TENANT })
  assert.deepEqual(scoped.update, { name: 'Cube v2' })
})

test('scopeOwnedMutationArgs adds the tenant id to an update/delete where', () => {
  const scoped = scopeOwnedMutationArgs({ where: { id: 'row-1' }, data: { name: 'x' } }, TENANT) as {
    where: Record<string, unknown>
    data: unknown
  }
  // The unique selector is kept and tenantId added as an extra filter so the DB
  // only mutates the row while it is still tenant-owned (atomic ownership check).
  assert.deepEqual(scoped.where, { id: 'row-1', tenantId: TENANT })
  assert.deepEqual(scoped.data, { name: 'x' })
})

test('scopeOwnedMutationArgs forces the tenant id even if where already carries one', () => {
  const scoped = scopeOwnedMutationArgs({ where: { id: 'row-1', tenantId: 'attacker' } }, TENANT)
  assert.equal(scoped.where.tenantId, TENANT)
})

test('scopeUpsertArgs does not let create override the tenant id', () => {
  const scoped = scopeUpsertArgs({
    where: { id: 'row-1' },
    create: { tenantId: 'attacker' },
    update: {}
  }, TENANT)
  assert.equal(scoped.create.tenantId, TENANT)
})
