import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeleteOperationDispatcher } from './delete-operation-dispatcher.js'

test('library delete jobs run in the background and finish with progress', async () => {
  const deletedRows: string[] = []
  const libraryBroadcasts: boolean[] = []
  let changeCount = 0
  let tick = 0

  const dispatcher = new DeleteOperationDispatcher({
    now: () => new Date(1_000 + tick++),
    createId: () => 'delete-job-1',
    async listLibraryRows(fileIds) {
      return fileIds.map((id, index) => ({
        id,
        tenantId: 'tenant-1',
        name: `file-${index + 1}.gcode`,
        storedPath: `stored-${index + 1}.gcode`,
        hidden: false
      }))
    },
    async deleteLibraryRow(fileId) {
      deletedRows.push(fileId)
    },
    onLibraryDeleted(hidden) {
      libraryBroadcasts.push(hidden)
    },
    getPrinter() {
      return null
    },
    async deletePrinterEntry() {
      throw new Error('not used')
    },
    clearPrinterStorageCache() {},
    onPrinterStorageDeleted() {},
    onJobChanged() {
      changeCount += 1
    }
  })

  const queued = await dispatcher.enqueueLibraryDelete(['file-a', 'file-b'])
  assert.equal(queued.status, 'queued')
  assert.equal(queued.completedItems, 0)
  assert.equal(queued.totalItems, 2)

  await dispatcher.waitForIdle()

  const [finished] = dispatcher.list()
  assert.ok(finished)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.completedItems, 2)
  assert.equal(finished.progressPercent, 100)
  assert.equal(finished.progressMessage, 'Deleted 2 files')
  assert.deepEqual(deletedRows, ['file-a', 'file-b'])
  assert.deepEqual(libraryBroadcasts, [false, false])
  assert.ok(changeCount >= 4)
})