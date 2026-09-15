process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { after, beforeEach, mock, test } from 'node:test'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'

const testRoot = mkdtempSync(path.join(tmpdir(), 'bambu-library-cleanup-test-'))
process.env.LIBRARY_DIR = path.join(testRoot, 'library')

const {
  pruneAbandonedUploadSessions,
  pruneExpiredLibraryUploadCompletions,
  pruneExpiredSliceCacheEntries,
  pruneHiddenLibraryFiles,
  prunePrintJobSnapshots,
  prunePrintJobThumbnails
} = await import('./library-cleanup.js')
const { rootPrisma } = await import('./prisma.js')
const { resolveLibraryPath } = await import('./library-paths.js')
const { getPrintJobThumbnailDir } = await import('./print-job-thumbnails.js')
const { getPrintJobSnapshotDir } = await import('./print-job-snapshots.js')

// Auto-restore the whole rootPrisma delegates these tests swap out (each test still spreads the real
// delegate into its mock), replacing the per-test try/finally restore blocks.
restorePrismaMethodsAfterEach([
  [rootPrisma, 'libraryFile'],
  [rootPrisma, 'libraryUploadCompletion'],
  [rootPrisma, 'printJob'],
  [rootPrisma, 'sliceCacheEntry'],
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
        workspace: { slug: 'alpha' }
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
          workspace: { slug: 'demo' }
        },
        {
          id: 'default-row',
          ownerBridgeId: null,
          storedPath: freshDefaultPath,
          uploadedAt: new Date(Date.now() - (24 * 60 * 60 * 1000)),
          workspace: { slug: 'alpha' }
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

test('pruneExpiredSliceCacheEntries expires entries by last use', async () => {
  const originalSliceCacheEntry = rootPrisma.sliceCacheEntry
  let where: Record<string, unknown> | null = null
  Object.defineProperty(rootPrisma, 'sliceCacheEntry', {
    configurable: true,
    value: {
      ...originalSliceCacheEntry,
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        where = args.where
        return { count: 2 }
      }
    }
  })

  const before = Date.now()
  assert.deepEqual(await pruneExpiredSliceCacheEntries(), { removed: 2 })
  const after = Date.now()
  const cutoff = (where as { updatedAt?: { lt?: Date } } | null)?.updatedAt?.lt
  assert.ok(cutoff instanceof Date)
  const retentionMs = 24 * 60 * 60 * 1000
  assert.ok(cutoff.getTime() >= before - retentionMs)
  assert.ok(cutoff.getTime() <= after - retentionMs)
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
  // Never prune a slice output a print-queue item still points at (losing it would break dispatch).
  assert.deepEqual(where.queueItems, { none: {} })
})

test('pruneUnreferencedProjectSnapshots leaves bytes when a selected row is reused before deletion', async () => {
  const { pruneUnreferencedProjectSnapshots } = await import('./library-cleanup.js')
  const originalLibraryFile = rootPrisma.libraryFile
  const deletedBytes: string[] = []
  let deleteWhere: Record<string, unknown> | null = null
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async () => [{
        id: 'reused-project', workspaceId: 'workspace-1', snapshotKey: 'hash:reused.3mf', ownerBridgeId: null, storedPath: 'reused.3mf'
      }],
      // Simulates a proof/job being attached after findMany. The full conditional no longer matches.
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        deleteWhere = args.where
        return { count: 0 }
      }
    }
  })

  const result = await pruneUnreferencedProjectSnapshots({
    deleteLibraryFileBytes: async (row) => { deletedBytes.push(row.storedPath) },
    retainedPreparedSourceIds: () => []
  })

  assert.equal(result.removed, 0)
  assert.deepEqual(deletedBytes, [])
  const capturedDeleteWhere = deleteWhere as Record<string, unknown> | null
  assert.equal(capturedDeleteWhere?.id, 'reused-project')
  assert.deepEqual(capturedDeleteWhere?.jobs, { none: {} })
  assert.ok(capturedDeleteWhere?.preparedSlicingSources)
})

test('snapshot recreation waits for cleanup byte deletion and its recreated bytes survive', async () => {
  const { pruneUnreferencedProjectSnapshots } = await import('./library-cleanup.js')
  const { snapshotMutationKey, snapshotMutationMutex } = await import('./print-file-snapshots.js')
  const originalLibraryFile = rootPrisma.libraryFile
  const storedPath = 'recreated.3mf'
  const filePath = resolveLibraryPath(storedPath)
  await writeFile(filePath, 'old')
  let deletionStarted!: () => void
  const deletionEntered = new Promise<void>((resolve) => { deletionStarted = resolve })
  let releaseDeletion!: () => void
  const deletionReleased = new Promise<void>((resolve) => { releaseDeletion = resolve })
  Object.defineProperty(rootPrisma, 'libraryFile', {
    configurable: true,
    value: {
      ...originalLibraryFile,
      findMany: async () => [{
        id: 'old-row', workspaceId: 'workspace-1', snapshotKey: 'hash:recreated.3mf', ownerBridgeId: null, storedPath
      }],
      deleteMany: async () => ({ count: 1 })
    }
  })

  const pruning = pruneUnreferencedProjectSnapshots({
    deleteLibraryFileBytes: async () => {
      deletionStarted()
      await deletionReleased
      await rm(filePath, { force: true })
    },
    retainedPreparedSourceIds: () => []
  })
  await deletionEntered
  const recreation = snapshotMutationMutex.run(
    snapshotMutationKey('workspace-1', 'hash:recreated.3mf'),
    async () => { await writeFile(filePath, 'new') }
  )
  releaseDeletion()
  await Promise.all([pruning, recreation])

  assert.equal(await readFile(filePath, 'utf8'), 'new')
})

test('pruneUnreferencedProjectSnapshots enforces "no job, no kept project"', async () => {
  // A slice preserves the project it handed the engine, but that is only worth keeping if the user
  // went on to start a print (or kept the sliced output). Snapshot rows are exempt from every other
  // pass here, so without this one an abandoned slice leaks its project bytes forever.
  const { pruneUnreferencedProjectSnapshots } = await import('./library-cleanup.js')
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
        return [{
          id: 'project-1', workspaceId: 'workspace-1', snapshotKey: 'hash:abc-part.3mf', ownerBridgeId: 'bridge-1', storedPath: 'abc-part.3mf'
        }]
      },
      deleteMany: async (args: { where: { id: string } }) => {
        deletedIds.push(args.where.id)
        return { count: 1 }
      }
    }
  })

  try {
    const result = await pruneUnreferencedProjectSnapshots({
      deleteLibraryFileBytes: async (input: { storedPath: string }) => {
        deletedBytes.push(input.storedPath)
      },
      retainedPreparedSourceIds: () => ['prepared-live']
    })

    assert.equal(result.removed, 1)
    assert.deepEqual(deletedIds, ['project-1'])
    assert.deepEqual(deletedBytes, ['abc-part.3mf'])
    const where = (queries[0] as { where: Record<string, unknown> }).where
    assert.equal(where.origin, 'snapshot')
    assert.deepEqual(where.snapshotKey, { not: null })
    // A started job or a kept output is exactly what "referenced" means, and it has to be checked
    // through EVERY relation. The markers above do not narrow this to a preserved project: a
    // dispatched print's snapshot carries the same origin and snapshotKey, and is referenced only
    // through `PrintJob.fileId` (`jobs`). Without that clause this pass deleted the artifact behind
    // every print older than the retention window, and `onDelete: SetNull` blanked the job's file
    // link, so history offered "Slice again" with no Reprint.
    assert.deepEqual(where.jobs, { none: {} })
    assert.deepEqual(where.slicedOutputs, { none: {} })
    assert.deepEqual(where.sourceProjectJobs, { none: {} })
    assert.deepEqual(where.sliceCacheArtifacts, { none: {} })
    assert.deepEqual(where.sliceCacheProjects, { none: {} })
    const preparedRelation = where.preparedSlicingSources as { none: { OR: Array<Record<string, unknown>> } }
    assert.equal(preparedRelation.none.OR.length, 2)
    assert.deepEqual(preparedRelation.none.OR[1], { id: { in: ['prepared-live'] } })
    assert.ok(preparedRelation.none.OR[0]?.expiresAt, 'a fresh staged proof protects the pre-enqueue gap')
  } finally {
    Object.defineProperty(rootPrisma, 'libraryFile', { configurable: true, value: originalLibraryFile })
  }
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
  // Only anonymous (workspaceId null) bridges that never connected (lastSeenAt null)
  // and are older than the retention window are eligible.
  assert.equal(capturedWhere?.workspaceId, null)
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
  // touched: the row survives for a later run once the bridge reconnects.
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
  const stalePendingMeta = path.join(uploadDir, 'stale.json.abcd-1234.tmp')
  await writeFile(stalePart, Buffer.from('partial bytes'))
  await writeFile(staleMeta, JSON.stringify({ id: 'stale' }))
  await writeFile(stalePendingMeta, JSON.stringify({ id: 'stale' }))
  const old = new Date(Date.now() - (25 * 60 * 60 * 1000))
  await utimes(stalePart, old, old)
  await utimes(staleMeta, old, old)
  await utimes(stalePendingMeta, old, old)

  // An in-flight session touched just now (its .json is rewritten on every chunk).
  const activePart = path.join(uploadDir, 'active.part')
  const activeMeta = path.join(uploadDir, 'active.json')
  await writeFile(activePart, Buffer.from('still uploading'))
  await writeFile(activeMeta, JSON.stringify({ id: 'active' }))

  const result = await pruneAbandonedUploadSessions()

  assert.equal(result.removed, 1) // counted per .part removed
  await assert.rejects(stat(stalePart), /ENOENT/)
  await assert.rejects(stat(staleMeta), /ENOENT/)
  await assert.rejects(stat(stalePendingMeta), /ENOENT/)
  // The active session is untouched.
  assert.ok((await stat(activePart)).isFile())
  assert.ok((await stat(activeMeta)).isFile())
})

test('pruneAbandonedUploadSessions is a no-op when the .uploads dir does not exist', async () => {
  const result = await pruneAbandonedUploadSessions()
  assert.equal(result.removed, 0)
})

test('pruneExpiredLibraryUploadCompletions sweeps expired receipts globally', async () => {
  const now = new Date('2026-09-10T18:00:00.000Z')
  let where: unknown
  Object.defineProperty(rootPrisma, 'libraryUploadCompletion', {
    configurable: true,
    value: {
      ...rootPrisma.libraryUploadCompletion,
      deleteMany: async (args: { where: unknown }) => {
        where = args.where
        return { count: 2 }
      }
    }
  })

  const result = await pruneExpiredLibraryUploadCompletions(now)

  assert.deepEqual(where, { expiresAt: { lt: now } })
  assert.deepEqual(result, { removed: 2 })
})
