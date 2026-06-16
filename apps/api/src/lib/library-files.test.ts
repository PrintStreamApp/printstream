import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { deleteLibraryFolderTree, ensureLibraryFolderPath, unhideSlicedOutput } from './library-files.js'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'

const stub = usePrismaStubs()

test('ensureLibraryFolderPath returns the base folder unchanged for an empty segment list', async () => {
  const folderId = await ensureLibraryFolderPath({
    tenantId: 'tenant-1',
    bridgeId: 'bridge-1',
    baseFolderId: 'base-folder',
    segments: []
  })
  assert.equal(folderId, 'base-folder')
})

test('ensureLibraryFolderPath creates the missing chain under the base folder and returns the deepest id', async () => {
  const created: Array<{ name: string; parentId: string | null; ownerBridgeId: string }> = []
  stub(prisma.libraryFolder, 'findUnique', async () => ({ ownerBridgeId: 'bridge-from-base' }))
  stub(prisma.libraryFolder, 'findFirst', async () => null)
  stub(prisma.libraryFolder, 'create', async (args: { data: { name: string; parentId: string | null; ownerBridgeId: string } }) => {
    created.push(args.data)
    return { id: `created-${args.data.name}` }
  })

  const folderId = await ensureLibraryFolderPath({
    tenantId: 'tenant-1',
    bridgeId: null,
    baseFolderId: 'base-folder',
    segments: ['Widgets', 'Brackets']
  })

  assert.equal(folderId, 'created-Brackets')
  assert.deepEqual(created.map((row) => ({ name: row.name, parentId: row.parentId, ownerBridgeId: row.ownerBridgeId })), [
    { name: 'Widgets', parentId: 'base-folder', ownerBridgeId: 'bridge-from-base' },
    { name: 'Brackets', parentId: 'created-Widgets', ownerBridgeId: 'bridge-from-base' }
  ])
})

test('ensureLibraryFolderPath reuses existing folders instead of recreating them', async () => {
  let createCalls = 0
  stub(prisma.libraryFolder, 'findFirst', async (args: { where: { name: string } }) =>
    args.where.name === 'Existing' ? { id: 'existing-id' } : null
  )
  stub(prisma.libraryFolder, 'create', async (args: { data: { name: string } }) => {
    createCalls += 1
    return { id: `created-${args.data.name}` }
  })

  const folderId = await ensureLibraryFolderPath({
    tenantId: 'tenant-1',
    bridgeId: 'bridge-1',
    baseFolderId: null,
    segments: ['Existing', 'Fresh']
  })

  assert.equal(folderId, 'created-Fresh')
  assert.equal(createCalls, 1)
})

test('ensureLibraryFolderPath recovers a unique-violation race by re-reading the winner', async () => {
  let findFirstCalls = 0
  stub(prisma.libraryFolder, 'findFirst', async () => {
    findFirstCalls += 1
    // First lookup misses; the post-conflict re-read finds the concurrent winner.
    return findFirstCalls > 1 ? { id: 'winner-id' } : null
  })
  stub(prisma.libraryFolder, 'create', async () => {
    throw new Prisma.PrismaClientKnownRequestError('unique violation', { code: 'P2002', clientVersion: '6.5.0' })
  })

  const folderId = await ensureLibraryFolderPath({
    tenantId: 'tenant-1',
    bridgeId: 'bridge-1',
    baseFolderId: null,
    segments: ['Raced']
  })
  assert.equal(folderId, 'winner-id')
})

test('ensureLibraryFolderPath rejects traversal-style segments', async () => {
  await assert.rejects(
    ensureLibraryFolderPath({ tenantId: 'tenant-1', bridgeId: 'bridge-1', baseFolderId: null, segments: ['..'] }),
    /invalid folder name/i
  )
})

test('ensureLibraryFolderPath requires a bridge when creating from the root', async () => {
  await assert.rejects(
    ensureLibraryFolderPath({ tenantId: 'tenant-1', bridgeId: null, baseFolderId: null, segments: ['Widgets'] }),
    /select a bridge/i
  )
})

test('deleteLibraryFolderTree recycles contained files and removes the folder subtree in one transaction', async () => {
  const fileQueries: unknown[] = []
  let recycledFileIds: string[] = []
  let recycledData: { deletedAt?: Date } | null = null
  let deletedFolderId: string | null = null
  let transactionCalls = 0

  // BFS: root has one child, the child has one grandchild, then no more.
  stub(prisma.libraryFolder, 'findMany', async (args: { where: { parentId: { in: string[] } } }) => {
    const frontier = args.where.parentId.in
    if (frontier.includes('root')) return [{ id: 'child' }]
    if (frontier.includes('child')) return [{ id: 'grandchild' }]
    return []
  })
  stub(prisma.libraryFile, 'findMany', async (args: unknown) => {
    fileQueries.push(args)
    return [
      { id: 'file-1', name: 'a.3mf', hidden: false },
      { id: 'file-2', name: 'b.stl', hidden: false }
    ]
  })
  stub(prisma.libraryFile, 'updateMany', async (args: { where: { id: { in: string[] } }; data: { deletedAt?: Date } }) => {
    recycledFileIds = args.where.id.in
    recycledData = args.data
    return { count: recycledFileIds.length }
  })
  stub(prisma.libraryFolder, 'delete', async (args: { where: { id: string } }) => {
    deletedFolderId = args.where.id
    return { id: deletedFolderId }
  })
  stub(prisma, '$transaction', async (operations: Promise<unknown>[]) => {
    transactionCalls += 1
    return await Promise.all(operations)
  })

  const result = await deleteLibraryFolderTree('root')

  assert.equal(result.deletedFiles, 2)
  assert.equal(transactionCalls, 1)
  assert.deepEqual(recycledFileIds, ['file-1', 'file-2'])
  const appliedData = recycledData as { deletedAt?: Date } | null
  assert.ok(appliedData?.deletedAt instanceof Date, 'files were soft-deleted, not removed')
  assert.equal(deletedFolderId, 'root')
  assert.deepEqual(
    (fileQueries[0] as { where: { folderId: { in: string[] } } }).where.folderId.in,
    ['root', 'child', 'grandchild']
  )
})

test('deleteLibraryFolderTree vetoes the whole tree when a contained file is not deletable', async () => {
  let transactionCalls = 0
  stub(prisma.libraryFolder, 'findMany', async () => [])
  stub(prisma.libraryFile, 'findMany', async () => [
    { id: 'file-1', name: 'protected.3mf', hidden: false, ownerBridgeId: null, storedPath: 'a', versions: [] }
  ])
  stub(prisma, '$transaction', async () => {
    transactionCalls += 1
    return []
  })

  await assert.rejects(
    deleteLibraryFolderTree('root', {
      assertFileDeletable: () => {
        throw new Error('demo files are read-only')
      }
    }),
    /read-only/
  )
  assert.equal(transactionCalls, 0)
})

test('unhideSlicedOutput replaces an existing same-name file with version archiving', async () => {
  const versionCreates: unknown[] = []
  let deletedOutputId: string | null = null
  let updateArgs: { where: { id: string }; data: Record<string, unknown> } | null = null

  stub(prisma.libraryFile, 'findUnique', async () => ({
    id: 'output-1',
    tenantId: 'tenant-1',
    ownerBridgeId: 'bridge-1',
    name: 'widget.gcode.3mf',
    storedPath: 'output-1.gcode.3mf',
    sizeBytes: 512,
    kind: 'gcode',
    thumbnailPath: null,
    folderId: 'folder-1',
    hidden: true,
    createdById: 'user-1',
    createdByName: 'Sam'
  }))
  stub(prisma.libraryFile, 'findFirst', async () => ({
    id: 'existing-1',
    tenantId: 'tenant-1',
    ownerBridgeId: 'bridge-1',
    name: 'widget.gcode.3mf',
    storedPath: 'existing-1.gcode.3mf',
    sizeBytes: 256,
    uploadedAt: new Date('2026-06-01T00:00:00.000Z'),
    kind: 'gcode',
    thumbnailPath: null,
    folderId: 'folder-1',
    currentVersionNumber: 3,
    createdById: 'user-0',
    createdByName: 'Avery',
    restoredFromVersionNumber: null
  }))
  stub(prisma.libraryFileVersion, 'create', async (args: { data: unknown }) => {
    versionCreates.push(args.data)
    return args.data
  })
  stub(prisma.libraryFile, 'delete', async (args: { where: { id: string } }) => {
    deletedOutputId = args.where.id
    return { id: args.where.id }
  })
  stub(prisma.libraryFile, 'update', async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updateArgs = args
    return { id: args.where.id, name: args.data.name }
  })
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  const result = await unhideSlicedOutput('output-1', { folderId: 'folder-1', name: 'widget' })

  assert.deepEqual(result, { id: 'existing-1', name: 'widget.gcode.3mf', replacedExisting: true })
  assert.equal(versionCreates.length, 1)
  assert.equal((versionCreates[0] as { versionNumber: number }).versionNumber, 3)
  assert.equal(deletedOutputId, 'output-1')
  const applied = updateArgs as { where: { id: string }; data: Record<string, unknown> } | null
  assert.equal(applied?.where.id, 'existing-1')
  assert.equal(applied?.data.storedPath, 'output-1.gcode.3mf')
  assert.equal(applied?.data.currentVersionNumber, 4)
  assert.equal(applied?.data.hidden, undefined)
})

test('unhideSlicedOutput simply unhides when no same-name file exists', async () => {
  let updateArgs: { where: { id: string }; data: Record<string, unknown> } | null = null
  stub(prisma.libraryFile, 'findUnique', async () => ({
    id: 'output-1',
    tenantId: 'tenant-1',
    ownerBridgeId: 'bridge-1',
    name: 'widget.gcode.3mf',
    storedPath: 'output-1.gcode.3mf',
    sizeBytes: 512,
    kind: 'gcode',
    thumbnailPath: null,
    folderId: null,
    hidden: true,
    createdById: null,
    createdByName: null
  }))
  stub(prisma.libraryFile, 'findFirst', async () => null)
  stub(prisma.libraryFile, 'update', async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updateArgs = args
    return { id: args.where.id, name: args.data.name }
  })

  const result = await unhideSlicedOutput('output-1', { folderId: 'folder-2', name: 'widget' })

  assert.deepEqual(result, { id: 'output-1', name: 'widget.gcode.3mf', replacedExisting: false })
  const applied = updateArgs as { where: { id: string }; data: Record<string, unknown> } | null
  assert.equal(applied?.data.hidden, false)
  assert.equal(applied?.data.folderId, 'folder-2')
  assert.equal(applied?.data.name, 'widget.gcode.3mf')
})
