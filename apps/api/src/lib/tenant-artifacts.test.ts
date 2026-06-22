import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deleteTenantArtifactBytes, type TenantArtifactDeps } from './tenant-artifacts.js'

function makeDeps(overrides: Partial<TenantArtifactDeps> = {}): {
  deps: TenantArtifactDeps
  libraryDeletes: Array<{ ownerBridgeId?: string | null; storedPath: string }>
  thumbnailDeletes: string[]
  snapshotDeletes: string[]
  removedPrinters: string[]
  logs: string[]
} {
  const libraryDeletes: Array<{ ownerBridgeId?: string | null; storedPath: string }> = []
  const thumbnailDeletes: string[] = []
  const snapshotDeletes: string[] = []
  const removedPrinters: string[] = []
  const logs: string[] = []
  const deps: TenantArtifactDeps = {
    loadLibraryFiles: async () => [],
    loadPrintJobArtifacts: async () => [],
    loadPrinterIds: async () => [],
    deleteLibraryFileBytes: async (input) => { libraryDeletes.push(input) },
    deletePrintJobThumbnail: async (p) => { thumbnailDeletes.push(p) },
    deletePrintJobSnapshot: async (p) => { snapshotDeletes.push(p) },
    removePrinter: (id) => { removedPrinters.push(id) },
    log: (message) => { logs.push(message) },
    ...overrides
  }
  return { deps, libraryDeletes, thumbnailDeletes, snapshotDeletes, removedPrinters, logs }
}

test('deletes bytes for every library file and version, both print-job artifacts, and detaches printers', async () => {
  const ctx = makeDeps({
    loadLibraryFiles: async () => [
      { id: 'f1', ownerBridgeId: 'b1', storedPath: 'a.3mf', versions: [{ ownerBridgeId: 'b1', storedPath: 'a.v1.3mf' }] },
      { id: 'f2', ownerBridgeId: 'b1', storedPath: 'b.3mf', versions: [] }
    ],
    loadPrintJobArtifacts: async () => [
      { id: 'j1', thumbnailPath: 'j1.png', snapshotPath: 'j1.jpg' },
      { id: 'j2', thumbnailPath: null, snapshotPath: 'j2.jpg' }
    ],
    loadPrinterIds: async () => ['p1', 'p2']
  })

  const result = await deleteTenantArtifactBytes('tenant-1', ctx.deps)

  assert.deepEqual(ctx.libraryDeletes.map((d) => d.storedPath), ['a.3mf', 'a.v1.3mf', 'b.3mf'])
  assert.deepEqual(ctx.thumbnailDeletes, ['j1.png'])
  assert.deepEqual(ctx.snapshotDeletes, ['j1.jpg', 'j2.jpg'])
  assert.deepEqual(ctx.removedPrinters, ['p1', 'p2'])
  assert.deepEqual(result, { libraryFiles: 2, printJobArtifacts: 3, printers: 2 })
})

test('a failing byte delete is logged but does not abort the rest (best-effort)', async () => {
  const ctx = makeDeps({
    loadLibraryFiles: async () => [
      { id: 'bad', ownerBridgeId: null, storedPath: 'local.3mf', versions: [] },
      { id: 'good', ownerBridgeId: 'b1', storedPath: 'ok.3mf', versions: [] }
    ],
    deleteLibraryFileBytes: async (input) => {
      if (input.storedPath === 'local.3mf') throw new Error('bridge offline')
      ctx.libraryDeletes.push(input)
    },
    loadPrinterIds: async () => ['p1']
  })

  const result = await deleteTenantArtifactBytes('tenant-1', ctx.deps)

  // The good file still got cleaned, the printer still detached, and the failure logged.
  assert.deepEqual(ctx.libraryDeletes.map((d) => d.storedPath), ['ok.3mf'])
  assert.deepEqual(ctx.removedPrinters, ['p1'])
  assert.equal(ctx.logs.length, 1)
  assert.match(ctx.logs[0] ?? '', /failed to delete library bytes for bad/)
  assert.equal(result.libraryFiles, 2)
})

test('does nothing (no throw) for a tenant with no artifacts', async () => {
  const ctx = makeDeps()
  const result = await deleteTenantArtifactBytes('empty', ctx.deps)
  assert.deepEqual(result, { libraryFiles: 0, printJobArtifacts: 0, printers: 0 })
  assert.equal(ctx.libraryDeletes.length, 0)
})
