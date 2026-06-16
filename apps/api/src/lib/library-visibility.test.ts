import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleLibraryFilesWhere } from './library-visibility.js'

test('visibleLibraryFilesWhere merges the caller clause with hidden + recycled exclusion', () => {
  assert.deepEqual(
    visibleLibraryFilesWhere({ tenantId: 'tenant-1', folderId: null }),
    { tenantId: 'tenant-1', folderId: null, hidden: false, deletedAt: null }
  )
})

test('visibleLibraryFilesWhere pins visibility fields over conflicting caller clauses', () => {
  assert.deepEqual(
    visibleLibraryFilesWhere({ hidden: true, deletedAt: { not: null } } as object),
    { hidden: false, deletedAt: null }
  )
})
