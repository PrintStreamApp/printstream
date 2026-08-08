import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideOwnershipCheck } from './prisma.js'

const WORKSPACE = 'workspace-1'

test('upsert proceeds (to create) when no row exists yet', () => {
  // Regression: the first cross-bridge libraryFileReplica.upsert used to be
  // rejected as not-found before it could create the row.
  assert.equal(decideOwnershipCheck('upsert', null, WORKSPACE), 'proceed')
})

test('upsert proceeds (to update) when the workspace already owns the row', () => {
  assert.equal(decideOwnershipCheck('upsert', { workspaceId: WORKSPACE }, WORKSPACE), 'proceed')
})

test('upsert is rejected when the row belongs to another workspace', () => {
  assert.equal(decideOwnershipCheck('upsert', { workspaceId: 'other' }, WORKSPACE), 'not-found')
})

test('update/delete require an existing workspace-owned row', () => {
  assert.equal(decideOwnershipCheck('update', null, WORKSPACE), 'not-found')
  assert.equal(decideOwnershipCheck('delete', null, WORKSPACE), 'not-found')
  assert.equal(decideOwnershipCheck('update', { workspaceId: WORKSPACE }, WORKSPACE), 'proceed')
})

test('any cross-workspace hit is reported as not-found regardless of operation', () => {
  for (const op of ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']) {
    assert.equal(decideOwnershipCheck(op, { workspaceId: 'other' }, WORKSPACE), 'not-found', op)
  }
})

test('findUnique miss returns null; findUniqueOrThrow miss is not-found', () => {
  assert.equal(decideOwnershipCheck('findUnique', null, WORKSPACE), 'return-null')
  assert.equal(decideOwnershipCheck('findUniqueOrThrow', null, WORKSPACE), 'not-found')
})
