import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideOwnershipCheck } from './prisma.js'

const TENANT = 'tenant-1'

test('upsert proceeds (to create) when no row exists yet', () => {
  // Regression: the first cross-bridge libraryFileReplica.upsert used to be
  // rejected as not-found before it could create the row.
  assert.equal(decideOwnershipCheck('upsert', null, TENANT), 'proceed')
})

test('upsert proceeds (to update) when the tenant already owns the row', () => {
  assert.equal(decideOwnershipCheck('upsert', { tenantId: TENANT }, TENANT), 'proceed')
})

test('upsert is rejected when the row belongs to another tenant', () => {
  assert.equal(decideOwnershipCheck('upsert', { tenantId: 'other' }, TENANT), 'not-found')
})

test('update/delete require an existing tenant-owned row', () => {
  assert.equal(decideOwnershipCheck('update', null, TENANT), 'not-found')
  assert.equal(decideOwnershipCheck('delete', null, TENANT), 'not-found')
  assert.equal(decideOwnershipCheck('update', { tenantId: TENANT }, TENANT), 'proceed')
})

test('any cross-tenant hit is reported as not-found regardless of operation', () => {
  for (const op of ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']) {
    assert.equal(decideOwnershipCheck(op, { tenantId: 'other' }, TENANT), 'not-found', op)
  }
})

test('findUnique miss returns null; findUniqueOrThrow miss is not-found', () => {
  assert.equal(decideOwnershipCheck('findUnique', null, TENANT), 'return-null')
  assert.equal(decideOwnershipCheck('findUniqueOrThrow', null, TENANT), 'not-found')
})
