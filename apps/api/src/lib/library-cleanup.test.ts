process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { after, beforeEach, mock, test } from 'node:test'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

const testRoot = mkdtempSync(path.join(tmpdir(), 'bambu-library-cleanup-test-'))
process.env.LIBRARY_DIR = path.join(testRoot, 'library')

const { pruneAbandonedUploadSessions, pruneHiddenLibraryFiles, prunePrintJobSnapshots, prunePrintJobThumbnails } = await import('./library-cleanup.js')
const { rootPrisma } = await import('./prisma.js')
const { resolveLibraryPath } = await import('./library-paths.js')
const { getPrintJobThumbnailDir } = await import('./print-job-thumbnails.js')
const { getPrintJobSnapshotDir } = await import('./print-job-snapshots.js')

// Auto-restore the whole rootPrisma delegates these tests swap out (each test still spreads the real
// delegate into its mock), replacing the per-test try/finally restore blocks.
restorePrismaMethodsAfterEach([
  [rootPrisma, 'libraryFile'],
  [rootPrisma, 'printJob'],
  [rootPrisma, 'bridge']
])

after(async () => {
  mock.restoreAll()
  await rm(testRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  mock.restoreAll()
  await rm(testRoot, { recursive: true, force: true })
  await mkdir(process.env.LIBRARY_DIR!, { recursive: true })
})

test('pruneHiddenLibraryFiles removes stale hidden library files and rows', async () => {
  const storedPath = 'stale-hidden.3mf'
  const filePath = resolveLibraryPath(storedPath)
  await writeFile(filePath, Buffer.from('3mf'))

  const originalLibraryFile = rootPrisma.libraryFile
  const deleteCalls: Array<unknown> = []
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async () => [{
        id: 'row-1',
        storedPath,
        uploadedAt: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)),
        tenant: { slug: 'alpha' }
      }],
      delete: async (input: unknown) => {
        deleteCalls.push(input)
        return { id: 'row-1' }
      }
    }
  })

  const result = await pruneHiddenLibraryFiles({
    deleteLibraryFileBytes: async () => {
      await rm(filePath, { force: true })
    }
  })

  assert.equal(result.removed, 1)
  assert.equal(deleteCalls.length, 1)
  await assert.rejects(stat(filePath), /ENOENT/)
})

test('pruneHiddenLibraryFiles applies the shorter demo retention window', async () => {
  const staleDemoPath = 'demo-stale-hidden.3mf'
  const freshDefaultPath = 'default-fresh-hidden.3mf'
  await writeFile(resolveLibraryPath(staleDemoPath), Buffer.from('demo'))
  await writeFile(resolveLibraryPath(freshDefaultPath), Buffer.from('default'))

  const originalLibraryFile = rootPrisma.libraryFile
  const deletedIds: string[] = []
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async () => [
        {
          id: 'demo-row',
          ownerBridgeId: null,
          storedPath: staleDemoPath,
          uploadedAt: new Date(Date.now() - (13 * 60 * 60 * 1000)),
          tenant: { slug: 'demo' }
        },
        {
          id: 'default-row',
          ownerBridgeId: null,
          storedPath: freshDefaultPath,
          uploadedAt: new Date(Date.now() - (24 * 60 * 60 * 1000)),
          tenant: { slug: 'alpha' }
        }
      ],
      delete: async (input: { where: { id: string } }) => {
        deletedIds.push(input.where.id)
        return { id: input.where.id }
      }
    }
  })

  const result = await pruneHiddenLibraryFiles({
    deleteLibraryFileBytes: async (row) => {
      await rm(resolveLibraryPath(row.storedPath), { force: true })
    }
  })

  assert.equal(result.removed, 1)
  assert.deepEqual(deletedIds, ['demo-row'])
  await assert.rejects(stat(resolveLibraryPath(staleDemoPath)), /ENOENT/)
  await stat(resolveLibraryPath(freshDefaultPath))
})

test('prunePrintJobThumbnails removes stale thumbnail files and clears rows', async () => {
  const storedPath = 'job-1.png'
  const thumbnailPath = path.join(getPrintJobThumbnailDir(), storedPath)
  await mkdir(path.dirname(thumbnailPath), { recursive: true })
  await writeFile(thumbnailPath, Buffer.from('png'))

  const originalPrintJob = rootPrisma.printJob
  const updateCalls: Array<unknown> = []
  Object.defineProperty(rootPrisma, 'printJob', {
    configurable: true,
    value: {
      ...originalPrintJob,
      findMany: async () => [{ id: 'job-1', thumbnailPath: storedPath }],
      update: async (input: unknown) => {
        updateCalls.push(input)
        return { id: 'job-1' }
      }
    }
  })

  const result = await prunePrintJobThumbnails()

  assert.equal(result.removed, 1)
  assert.equal(updateCalls.length, 1)
  await assert.rejects(stat(thumbnailPath), /ENOENT/)
})

test('prunePrintJobSnapshots removes stale snapshot files and clears rows', async () => {
  const storedPath = 'job-1.jpg'
  const snapshotPath = path.join(getPrintJobSnapshotDir(), storedPath)
  await mkdir(path.dirname(snapshotPath), { recursive: true })
  await writeFile(snapshotPath, Buffer.from('jpeg'))

  const originalPrintJob = rootPrisma.printJob
  const updateCalls: Array<unknown> = []
  Object.defineProperty(rootPrisma, 'printJob', {
    configurable: true,
    value: {
      ...originalPrintJob,
      findMany: async () => [{ id: 'job-1', snapshotPath: storedPath }],
      update: async (input: unknown) => {
        updateCalls.push(input)
        return { id: 'job-1' }
      }
    }
  })

  const result = await prunePrintJobSnapshots()

  assert.equal(result.removed, 1)
  assert.equal(updateCalls.length, 1)
  await assert.rejects(stat(snapshotPath), /ENOENT/)
})
test('pruneUnreferencedSlicedOutputs removes only stale slice-origin hidden rows', async () => {
  const { pruneUnreferencedSlicedOutputs } = await import('./library-cleanup.js')
  const originalLibraryFile = rootPrisma.libraryFile
  const queries: unknown[] = []
  const deletedIds: string[] = []
  const deletedBytes: string[] = []
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async (args: unknown) => {
        queries.push(args)
        return [{ id: 'sliced-1', ownerBridgeId: 'bridge-1', storedPath: 'sliced-1.gcode.3mf' }]
      },
      delete: async (args: { where: { id: string } }) => {
        deletedIds.push(args.where.id)
        return { id: args.where.id }
      }
    }
  })

  const result = await pruneUnreferencedSlicedOutputs({
    deleteLibraryFileBytes: async (input: { storedPath: string }) => {
      deletedBytes.push(input.storedPath)
    }
  })

  assert.equal(result.removed, 1)
  assert.deepEqual(deletedIds, ['sliced-1'])
  assert.deepEqual(deletedBytes, ['sliced-1.gcode.3mf'])
  const where = (queries[0] as { where: Record<string, unknown> }).where
  assert.equal(where.hidden, true)
  assert.equal(where.snapshotKey, null)
  assert.equal(where.origin, 'slice')
})

test('pruneDormantBridges reaps only never-connected, unpaired, expired registrations', async () => {
  const { pruneDormantBridges } = await import('./library-cleanup.js')
  const originalBridge = rootPrisma.bridge
  let capturedWhere: Record<string, unknown> | undefined
  Object.defineProperty(rootPrisma, 'bridge', {
    configurable: true,
    value: {
      ...originalBridge,
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        capturedWhere = args.where
        return { count: 3 }
      }
    }
  })

  const result = await pruneDormantBridges()

  assert.equal(result.removed, 3)
  // Only anonymous (tenantId null) bridges that never connected (lastSeenAt null)
  // and are older than the retention window are eligible.
  assert.equal(capturedWhere?.tenantId, null)
  assert.equal(capturedWhere?.lastSeenAt, null)
  assert.ok((capturedWhere?.createdAt as { lt?: Date })?.lt instanceof Date)
})

test('pruneRecycledLibraryFiles hard-deletes expired bin entries with their version bytes', async () => {
  const { pruneRecycledLibraryFiles } = await import('./library-cleanup.js')
  const originalLibraryFile = rootPrisma.libraryFile
  const deletedIds: string[] = []
  const deletedBytes: string[] = []
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async (args: { where: { deletedAt?: { lt?: Date } } }) => {
        assert.ok(args.where.deletedAt?.lt instanceof Date, 'queries by deletedAt cutoff')
        return [{
          id: 'recycled-1',
          ownerBridgeId: 'bridge-1',
          storedPath: 'recycled-1.3mf',
          versions: [{ ownerBridgeId: 'bridge-1', storedPath: 'recycled-1.v1.3mf' }]
        }]
      },
      delete: async (args: { where: { id: string } }) => {
        deletedIds.push(args.where.id)
        return { id: args.where.id }
      }
    }
  })

  const result = await pruneRecycledLibraryFiles({
    deleteLibraryFileBytes: async (input: { storedPath: string }) => {
      deletedBytes.push(input.storedPath)
    },
    isBridgeConnected: () => true
  })

  assert.equal(result.removed, 1)
  assert.deepEqual(deletedIds, ['recycled-1'])
  assert.deepEqual(deletedBytes, ['recycled-1.3mf', 'recycled-1.v1.3mf'])
})

test('pruneRecycledLibraryFiles defers an entry whose owning bridge is offline (keeps the row to retry)', async () => {
  const { pruneRecycledLibraryFiles } = await import('./library-cleanup.js')
  const originalLibraryFile = rootPrisma.libraryFile
  const deletedIds: string[] = []
  const deletedBytes: string[] = []
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async () => [{
        id: 'recycled-offline',
        ownerBridgeId: 'bridge-offline',
        storedPath: 'recycled-offline.3mf',
        versions: [{ ownerBridgeId: 'bridge-offline', storedPath: 'recycled-offline.v1.3mf' }]
      }],
      delete: async (args: { where: { id: string } }) => {
        deletedIds.push(args.where.id)
        return { id: args.where.id }
      }
    }
  })

  const result = await pruneRecycledLibraryFiles({
    deleteLibraryFileBytes: async (input: { storedPath: string }) => {
      deletedBytes.push(input.storedPath)
    },
    isBridgeConnected: () => false
  })

  // The owning bridge is offline, so neither the bytes nor the DB row are
  // touched — the row survives for a later run once the bridge reconnects.
  assert.equal(result.removed, 0)
  assert.deepEqual(deletedIds, [])
  assert.deepEqual(deletedBytes, [])
})

test('pruneAbandonedUploadSessions reaps stale .part/.json but keeps recently-touched sessions', async () => {
  const uploadDir = path.join(process.env.LIBRARY_DIR!, '.uploads')
  await mkdir(uploadDir, { recursive: true })

  // An abandoned session whose files were last touched > 24h ago.
  const stalePart = path.join(uploadDir, 'stale.part')
  const staleMeta = path.join(uploadDir, 'stale.json')
  await writeFile(stalePart, Buffer.from('partial bytes'))
  await writeFile(staleMeta, JSON.stringify({ id: 'stale' }))
  const old = new Date(Date.now() - (25 * 60 * 60 * 1000))
  await utimes(stalePart, old, old)
  await utimes(staleMeta, old, old)

  // An in-flight session touched just now (its .json is rewritten on every chunk).
  const activePart = path.join(uploadDir, 'active.part')
  const activeMeta = path.join(uploadDir, 'active.json')
  await writeFile(activePart, Buffer.from('still uploading'))
  await writeFile(activeMeta, JSON.stringify({ id: 'active' }))

  const result = await pruneAbandonedUploadSessions()

  assert.equal(result.removed, 1) // counted per .part removed
  await assert.rejects(stat(stalePart), /ENOENT/)
  await assert.rejects(stat(staleMeta), /ENOENT/)
  // The active session is untouched.
  assert.ok((await stat(activePart)).isFile())
  assert.ok((await stat(activeMeta)).isFile())
})

test('pruneAbandonedUploadSessions is a no-op when the .uploads dir does not exist', async () => {
  const result = await pruneAbandonedUploadSessions()
  assert.equal(result.removed, 0)
})
