process.env.NODE_ENV = 'test'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withOptionalPrintSource } from './print-job-source-link.js'
import { rootPrisma } from './prisma.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

const stub = usePrismaStubs()
const fkError = Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' })

test('deletion during upload drops only optional lineage and preserves captured tags', async () => {
  stub(rootPrisma.libraryFile, 'findUnique', async () => null)
  const attempts: (string | null)[] = []
  const snapshot = { tags: [{ id: 'deleted-tag', name: 'Original' }], spoolIds: [] }
  const result = await withOptionalPrintSource('deleted-file', async (sourceLibraryFileId) => {
    attempts.push(sourceLibraryFileId)
    if (sourceLibraryFileId) throw fkError
    return { sourceLibraryFileId, fileId: 'retained-snapshot', tagSnapshotJson: JSON.stringify(snapshot) }
  })
  assert.deepEqual(attempts, ['deleted-file', null])
  assert.equal(result.fileId, 'retained-snapshot')
  assert.deepEqual(JSON.parse(result.tagSnapshotJson), snapshot)
})

test('unrelated foreign key and storage failures are not swallowed', async () => {
  stub(rootPrisma.libraryFile, 'findUnique', async () => ({ id: 'source' }))
  await assert.rejects(withOptionalPrintSource('source', async () => { throw fkError }), (error) => error === fkError)
  const storageError = new Error('database unavailable')
  await assert.rejects(withOptionalPrintSource('source', async () => { throw storageError }), (error) => error === storageError)
})
