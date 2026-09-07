import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { bridgeSessionManager } from './bridge-session-manager.js'
import {
  deleteLibraryFolderTree,
  discardHiddenSlicedOutput,
  ensureLibraryFolderPath,
  persistLibraryFileFromLocalPath,
  unhideSlicedOutput
} from './library-files.js'
import { usePrismaStubs, type PrismaStubber } from '../test-utils/prisma-stubs.js'

const stub = usePrismaStubs()

test('ensureLibraryFolderPath returns the base folder unchanged for an empty segment list', async () => {
  const folderId = await ensureLibraryFolderPath({
    workspaceId: 'workspace-1',
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
    workspaceId: 'workspace-1',
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
    workspaceId: 'workspace-1',
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
    workspaceId: 'workspace-1',
    bridgeId: 'bridge-1',
    baseFolderId: null,
    segments: ['Raced']
  })
  assert.equal(folderId, 'winner-id')
})

test('ensureLibraryFolderPath rejects traversal-style segments', async () => {
  await assert.rejects(
    ensureLibraryFolderPath({ workspaceId: 'workspace-1', bridgeId: 'bridge-1', baseFolderId: null, segments: ['..'] }),
    /invalid folder name/i
  )
})

test('ensureLibraryFolderPath requires a bridge when creating from the root', async () => {
  await assert.rejects(
    ensureLibraryFolderPath({ workspaceId: 'workspace-1', bridgeId: null, baseFolderId: null, segments: ['Widgets'] }),
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
    workspaceId: 'workspace-1',
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
    workspaceId: 'workspace-1',
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

test('unhideSlicedOutput moves the re-slice link onto the file it merged into', async () => {
  // The surviving row now holds the OUTPUT's bytes, so it must hold the output's preserved
  // project too. Keeping the replaced file's would point "Slice again" at a project that
  // produced different G-code, and the output row is deleted here, so nothing else would
  // reference the project it was sliced from.
  let updateArgs: { where: { id: string }; data: Record<string, unknown> } | null = null
  stub(prisma.libraryFile, 'findUnique', async () => ({
    id: 'output-1',
    workspaceId: 'workspace-1',
    ownerBridgeId: 'bridge-1',
    name: 'widget.gcode.3mf',
    storedPath: 'output-1.gcode.3mf',
    sizeBytes: 512,
    kind: 'gcode',
    thumbnailPath: null,
    folderId: 'folder-1',
    hidden: true,
    createdById: 'user-1',
    createdByName: 'Sam',
    sourceProjectFileId: 'project-new',
    sliceSettingsJson: '{"plate":2}'
  }))
  stub(prisma.libraryFile, 'findFirst', async () => ({
    id: 'existing-1',
    workspaceId: 'workspace-1',
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
    restoredFromVersionNumber: null,
    sourceProjectFileId: 'project-stale',
    sliceSettingsJson: '{"plate":9}'
  }))
  stub(prisma.libraryFileVersion, 'create', async (args: { data: unknown }) => args.data)
  stub(prisma.libraryFile, 'delete', async (args: { where: { id: string } }) => ({ id: args.where.id }))
  stub(prisma.libraryFile, 'update', async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updateArgs = args
    return { id: args.where.id, name: args.data.name }
  })
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  await unhideSlicedOutput('output-1', { folderId: 'folder-1', name: 'widget' })

  const applied = updateArgs as { where: { id: string }; data: Record<string, unknown> } | null
  assert.equal(applied?.data.sourceProjectFileId, 'project-new')
  assert.equal(applied?.data.sliceSettingsJson, '{"plate":2}')
})

test('unhideSlicedOutput simply unhides when no same-name file exists', async () => {
  let updateArgs: { where: { id: string }; data: Record<string, unknown> } | null = null
  stub(prisma.libraryFile, 'findUnique', async () => ({
    id: 'output-1',
    workspaceId: 'workspace-1',
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

test('unhideSlicedOutput appends .gcode.3mf unless the full compound extension is already present', async () => {
  // The save dialog previews `<name>.gcode.3mf`; the final name must match that
  // preview even when the typed name ends in a bare `.3mf`.
  stub(prisma.libraryFile, 'findUnique', async () => ({
    id: 'output-1',
    workspaceId: 'workspace-1',
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
  stub(prisma.libraryFile, 'update', async (args: { where: { id: string }; data: { name: string } }) => (
    { id: args.where.id, name: args.data.name }
  ))

  const cases: Array<[input: string, saved: string]> = [
    ['widget', 'widget.gcode.3mf'],
    ['widget.3mf', 'widget.3mf.gcode.3mf'],
    ['widget.gcode.3mf', 'widget.gcode.3mf'],
    ['Widget.GCODE.3MF', 'Widget.GCODE.3MF']
  ]
  for (const [input, saved] of cases) {
    const result = await unhideSlicedOutput('output-1', { name: input })
    assert.equal(result.name, saved)
  }
})

test('discarding an unsaved slice also drops the preserved project nothing else references', async () => {
  // Snapshot rows are exempt from every cleanup pass, so a discard that leaves the project behind
  // leaks its bytes permanently, one copy per discarded slice, never reclaimed. Found by actually
  // discarding a slice on the dev stack and finding the snapshot row still there.
  const deleted: string[] = []
  stub(prisma.libraryFile, 'findUnique', async (args: { where: { id: string } }) => (
    args.where.id === 'output-1'
      ? { id: 'output-1', ownerBridgeId: 'bridge-1', storedPath: 'out.gcode.3mf', hidden: true, sourceProjectFileId: 'project-1', versions: [] }
      : { id: 'project-1', ownerBridgeId: 'bridge-1', storedPath: 'proj.3mf', snapshotKey: 'abc:proj.3mf' }
  ))
  stub(prisma.libraryFile, 'count', async () => 0)
  stub(prisma.printJob, 'count', async () => 0)
  stub(prisma.libraryFile, 'delete', async (args: { where: { id: string } }) => {
    deleted.push(args.where.id)
    return { id: args.where.id }
  })

  assert.equal(await discardHiddenSlicedOutput('output-1'), true)
  assert.deepEqual(deleted, ['output-1', 'project-1'])
})

test('discarding a slice keeps a preserved project another slice still points at', async () => {
  // The snapshot is content-addressed, so two slices of identical bytes SHARE one row; a print's
  // history row references it too. Deleting a shared project would break the survivor's re-slice.
  const deleted: string[] = []
  stub(prisma.libraryFile, 'findUnique', async () => (
    { id: 'output-1', ownerBridgeId: 'bridge-1', storedPath: 'out.gcode.3mf', hidden: true, sourceProjectFileId: 'project-1', versions: [] }
  ))
  stub(prisma.libraryFile, 'count', async () => 1)
  stub(prisma.printJob, 'count', async () => 0)
  stub(prisma.libraryFile, 'delete', async (args: { where: { id: string } }) => {
    deleted.push(args.where.id)
    return { id: args.where.id }
  })

  assert.equal(await discardHiddenSlicedOutput('output-1'), true)
  assert.deepEqual(deleted, ['output-1'], 'the shared project survives')
})

const UPLOAD_BYTES = Buffer.from('bytes the browser baked')
const UPLOAD_HASH = createHash('sha256').update(UPLOAD_BYTES).digest('hex')
const OTHER_HASH = 'f'.repeat(64)

/** A visible, bridge-owned project the editor could have open. */
function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    workspaceId: 'workspace-1',
    ownerBridgeId: 'bridge-1',
    name: 'project.3mf',
    storedPath: 'stored-project.3mf',
    sizeBytes: 12,
    uploadedAt: new Date('2026-09-01T00:00:00.000Z'),
    kind: '3mf',
    thumbnailPath: null,
    folderId: 'folder-1',
    hidden: false,
    deletedAt: null,
    currentVersionNumber: 3,
    createdById: null,
    createdByName: null,
    restoredFromVersionNumber: null,
    ...overrides
  }
}

/**
 * Answer `findFirst` the way the database would: every clause must match, so a lookup by id and
 * a lookup by name reach different verdicts about the same row. A stub that returns the row
 * regardless would pass whether or not the target was addressed by id, which is the whole point.
 */
function stubLibraryFileLookup(row: Record<string, unknown>): void {
  stub(prisma.libraryFile, 'findFirst', async (args: { where: Record<string, unknown> }) => (
    Object.entries(args.where).every(([key, value]) => row[key] === value) ? row : null
  ))
}

/**
 * Stand in for the owning bridge: library writes are RPCs, and `library.stat` answers the
 * identical-upload probe, so `statHash` decides whether the stored bytes count as unchanged.
 */
function stubBridgeLibraryRpc(stubber: PrismaStubber, statHash: string): { writtenToBridgeIds: string[] } {
  const writtenToBridgeIds: string[] = []
  stubber(bridgeSessionManager, 'isConnected', () => true)
  stubber(bridgeSessionManager, 'requestRpc', async (bridgeId: string, method: string) => {
    if (method === 'library.stat') return { sizeBytes: UPLOAD_BYTES.byteLength, contentSha256: statHash }
    if (method === 'library.storeStart') writtenToBridgeIds.push(bridgeId)
    return {}
  })
  return { writtenToBridgeIds }
}

/** Stage the upload's bytes on local disk, where `persistLibraryFileFromLocalPath` expects them. */
async function withStagedBytes(run: (sourcePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printstream-library-files-'))
  try {
    const sourcePath = path.join(dir, 'upload.bin')
    await writeFile(sourcePath, UPLOAD_BYTES)
    await run(sourcePath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('targetFileId versions the file it names even after the project was renamed and moved', async () => {
  // Name matching cannot express the editor's target: a project renamed or moved since the
  // session opened matches no (bridge, folder, name) tuple, so the save used to land as a
  // SECOND file and the version history of the real one silently stopped growing.
  const target = projectRow()
  const versionCreates: Array<{ versionNumber: number; libraryFileId: string }> = []
  let created = 0
  let updateArgs: { where: { id: string }; data: Record<string, unknown> } | null = null

  stubLibraryFileLookup(target)
  const bridge = stubBridgeLibraryRpc(stub, OTHER_HASH)
  stub(prisma.libraryFileVersion, 'create', async (args: { data: { versionNumber: number; libraryFileId: string } }) => {
    versionCreates.push(args.data)
    return { id: 'version-3', ...args.data }
  })
  stub(prisma.libraryFile, 'update', async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updateArgs = args
    return { ...target, ...args.data }
  })
  stub(prisma.libraryFile, 'create', async () => {
    created += 1
    return projectRow({ id: 'file-2' })
  })
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  await withStagedBytes(async (sourcePath) => {
    const result = await persistLibraryFileFromLocalPath({
      workspaceId: 'workspace-1',
      sourcePath,
      // What the editor session still calls the file, and where it thinks it lives: all stale.
      fileName: 'renamed-by-the-user.3mf',
      sizeBytes: UPLOAD_BYTES.byteLength,
      folderId: null,
      bridgeId: 'bridge-2',
      hidden: false,
      targetFileId: 'file-1'
    })

    assert.equal(created, 0, 'no second file was created')
    assert.equal(result.file.id, 'file-1')
    assert.equal(result.unchanged, false)
    assert.equal(result.archivedVersionId, 'version-3', 'the replaced content is reported for the editor to pin')
    // An overwrite never rewrites `ownerBridgeId`, so the bytes must go to the row's own bridge.
    assert.deepEqual(bridge.writtenToBridgeIds, ['bridge-1'])
    assert.deepEqual(versionCreates.map((row) => [row.libraryFileId, row.versionNumber]), [['file-1', 3]])
    const applied = updateArgs as { where: { id: string }; data: Record<string, unknown> } | null
    assert.equal(applied?.where.id, 'file-1')
    assert.equal(applied?.data.currentVersionNumber, 4)
    // A save is neither a rename nor a move.
    assert.equal(applied?.data.name, 'project.3mf')
    assert.equal(applied?.data.folderId, 'folder-1')
  })
})

test('targetFileId is not found when the row belongs to another workspace', async () => {
  // A hard 404, never a fall back to name matching: falling back is exactly the silent
  // duplicate the id was passed to prevent.
  stubLibraryFileLookup(projectRow({ workspaceId: 'workspace-2' }))
  stubBridgeLibraryRpc(stub, OTHER_HASH)
  stub(prisma.libraryFile, 'create', async () => {
    throw new Error('a missing target must not fall through to creating a file')
  })

  await withStagedBytes(async (sourcePath) => {
    await assert.rejects(
      persistLibraryFileFromLocalPath({
        workspaceId: 'workspace-1',
        sourcePath,
        fileName: 'project.3mf',
        sizeBytes: UPLOAD_BYTES.byteLength,
        folderId: null,
        bridgeId: 'bridge-1',
        hidden: false,
        targetFileId: 'file-1'
      }),
      /File not found/
    )
  })
})

test('a targeted save of byte-identical content creates no version', async () => {
  // The editor re-bakes on every save, so an untouched project reaches this path unchanged;
  // versioning it would fill the history with copies of one file.
  const target = projectRow()
  stubLibraryFileLookup(target)
  stubBridgeLibraryRpc(stub, UPLOAD_HASH)
  stub(prisma.libraryFile, 'findUniqueOrThrow', async () => target)
  stub(prisma.libraryFileVersion, 'create', async () => {
    throw new Error('identical bytes must not be versioned')
  })
  stub(prisma.libraryFile, 'create', async () => {
    throw new Error('identical bytes must not create a file')
  })

  await withStagedBytes(async (sourcePath) => {
    const result = await persistLibraryFileFromLocalPath({
      workspaceId: 'workspace-1',
      sourcePath,
      fileName: 'renamed-by-the-user.3mf',
      sizeBytes: UPLOAD_BYTES.byteLength,
      folderId: null,
      bridgeId: 'bridge-2',
      hidden: false,
      targetFileId: 'file-1'
    })
    assert.equal(result.unchanged, true)
    assert.equal(result.file.id, 'file-1')
    assert.equal(result.archivedVersionId, null)
  })
})

test('without targetFileId an upload still resolves its overwrite target by name', async () => {
  // The unchanged path: an ordinary upload replaces the same-named file in the same folder,
  // and takes the uploaded name. Nothing may consult a row id it was never given.
  const target = projectRow()
  const lookups: Array<Record<string, unknown>> = []
  let updateArgs: { where: { id: string }; data: Record<string, unknown> } | null = null

  stub(prisma.libraryFolder, 'findUnique', async () => ({ ownerBridgeId: 'bridge-1' }))
  stub(prisma.libraryFile, 'findFirst', async (args: { where: Record<string, unknown> }) => {
    lookups.push(args.where)
    return Object.entries(args.where).every(([key, value]) => target[key as keyof typeof target] === value) ? target : null
  })
  stubBridgeLibraryRpc(stub, OTHER_HASH)
  stub(prisma.libraryFileVersion, 'create', async (args: { data: unknown }) => ({ id: 'version-3', ...(args.data as object) }))
  stub(prisma.libraryFile, 'update', async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updateArgs = args
    return { ...target, ...args.data }
  })
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  await withStagedBytes(async (sourcePath) => {
    const result = await persistLibraryFileFromLocalPath({
      workspaceId: 'workspace-1',
      sourcePath,
      fileName: 'project.3mf',
      sizeBytes: UPLOAD_BYTES.byteLength,
      folderId: 'folder-1',
      bridgeId: 'bridge-1',
      hidden: false
    })

    assert.equal(result.file.id, 'file-1')
    assert.equal(result.archivedVersionId, 'version-3')
    assert.deepEqual(lookups, [{
      workspaceId: 'workspace-1',
      ownerBridgeId: 'bridge-1',
      folderId: 'folder-1',
      name: 'project.3mf',
      hidden: false,
      deletedAt: null
    }])
    const applied = updateArgs as { where: { id: string }; data: Record<string, unknown> } | null
    assert.equal(applied?.data.name, 'project.3mf')
    assert.equal(applied?.data.folderId, 'folder-1')
  })
})
