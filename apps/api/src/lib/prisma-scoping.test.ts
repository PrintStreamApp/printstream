import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergeWorkspaceWhere,
  scopeCreateArgs,
  scopeCreateManyArgs,
  scopeFilteredArgs,
  scopeOwnedMutationArgs,
  scopeUpsertArgs
} from './prisma.js'

const WORKSPACE = 'workspace-1'

// The workspace-scoping `$extends` extension can only be exercised end-to-end
// against a live engine, so its pure argument-shaping (inject on create, merge
// on filtered/upsert) is extracted into these helpers and tested here. Ownership
// decisions are covered in prisma-ownership.test.ts; model classification in
// prisma-workspace-models.test.ts.

test('scopeCreateArgs injects the workspace id into create data', () => {
  const scoped = scopeCreateArgs({ data: { name: 'Cube' } }, WORKSPACE)
  assert.deepEqual(scoped, { data: { name: 'Cube', workspaceId: WORKSPACE } })
})

test('scopeCreateArgs does not let caller data override the workspace id', () => {
  const scoped = scopeCreateArgs({ data: { name: 'Cube', workspaceId: 'attacker' } }, WORKSPACE)
  assert.equal(scoped.data.workspaceId, WORKSPACE)
})

test('scopeCreateManyArgs injects the workspace id into every row of an array', () => {
  const scoped = scopeCreateManyArgs({ data: [{ name: 'A' }, { name: 'B' }] }, WORKSPACE)
  assert.deepEqual(scoped.data, [
    { name: 'A', workspaceId: WORKSPACE },
    { name: 'B', workspaceId: WORKSPACE }
  ])
})

test('scopeCreateManyArgs injects the workspace id into a single-object createMany', () => {
  const scoped = scopeCreateManyArgs({ data: { name: 'A' } }, WORKSPACE)
  assert.deepEqual(scoped.data, { name: 'A', workspaceId: WORKSPACE })
})

test('scopeCreateManyArgs preserves other args (e.g. skipDuplicates)', () => {
  const scoped = scopeCreateManyArgs({ data: [{ name: 'A' }], skipDuplicates: true }, WORKSPACE) as { data: unknown; skipDuplicates: boolean }
  assert.equal(scoped.skipDuplicates, true)
})

test('mergeWorkspaceWhere returns a bare workspace filter when there is no where', () => {
  assert.deepEqual(mergeWorkspaceWhere(undefined, WORKSPACE), { workspaceId: WORKSPACE })
})

test('mergeWorkspaceWhere ANDs the workspace filter with an existing where (never widens it)', () => {
  const merged = mergeWorkspaceWhere({ name: 'Cube' }, WORKSPACE)
  assert.deepEqual(merged, { AND: [{ name: 'Cube' }, { workspaceId: WORKSPACE }] })
})

test('scopeFilteredArgs constrains where and keeps other args', () => {
  const scoped = scopeFilteredArgs({ where: { name: 'Cube' }, orderBy: { name: 'asc' } }, WORKSPACE) as {
    where: Record<string, unknown>
    orderBy: unknown
  }
  assert.deepEqual(scoped.where, { AND: [{ name: 'Cube' }, { workspaceId: WORKSPACE }] })
  assert.deepEqual(scoped.orderBy, { name: 'asc' })
})

test('scopeFilteredArgs scopes a where-less list to the workspace', () => {
  const scoped = scopeFilteredArgs({}, WORKSPACE) as { where: Record<string, unknown> }
  assert.deepEqual(scoped.where, { workspaceId: WORKSPACE })
})

test('scopeUpsertArgs constrains where, injects workspace into create, leaves update', () => {
  const scoped = scopeUpsertArgs({
    where: { id: 'row-1' },
    create: { id: 'row-1', name: 'Cube' },
    update: { name: 'Cube v2' }
  }, WORKSPACE)
  assert.deepEqual(scoped.where, { id: 'row-1', workspaceId: WORKSPACE })
  assert.deepEqual(scoped.create, { id: 'row-1', name: 'Cube', workspaceId: WORKSPACE })
  assert.deepEqual(scoped.update, { name: 'Cube v2' })
})

test('scopeOwnedMutationArgs adds the workspace id to an update/delete where', () => {
  const scoped = scopeOwnedMutationArgs({ where: { id: 'row-1' }, data: { name: 'x' } }, WORKSPACE) as {
    where: Record<string, unknown>
    data: unknown
  }
  // The unique selector is kept and workspaceId added as an extra filter so the DB
  // only mutates the row while it is still workspace-owned (atomic ownership check).
  assert.deepEqual(scoped.where, { id: 'row-1', workspaceId: WORKSPACE })
  assert.deepEqual(scoped.data, { name: 'x' })
})

test('scopeOwnedMutationArgs forces the workspace id even if where already carries one', () => {
  const scoped = scopeOwnedMutationArgs({ where: { id: 'row-1', workspaceId: 'attacker' } }, WORKSPACE)
  assert.equal(scoped.where.workspaceId, WORKSPACE)
})

test('scopeUpsertArgs does not let create override the workspace id', () => {
  const scoped = scopeUpsertArgs({
    where: { id: 'row-1' },
    create: { workspaceId: 'attacker' },
    update: {}
  }, WORKSPACE)
  assert.equal(scoped.create.workspaceId, WORKSPACE)
})
