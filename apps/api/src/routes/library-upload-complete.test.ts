process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { mock, test, type TestContext } from 'node:test'
import express from 'express'
import yazl from 'yazl'
import { buildBuiltinSlicingPresetId } from '@printstream/shared'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { HttpError } from '../lib/http-error.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { libraryDir } from '../lib/library-paths.js'
import { slicerClient } from '../lib/slicer-client.js'
import { usePrismaStubs, type PrismaStubber } from '../test-utils/prisma-stubs.js'
import { libraryRouter } from './library.js'

/**
 * The completion step of the chunked upload, which is where a browser-baked 3MF gets the
 * editor's save semantics: a new version of a file addressed by ID (not by name, which a
 * rename or a move invalidates), or a hidden staging snapshot that must never touch the
 * user's project. Everything before completion (chunking, resume, pacing) is shared.
 */

const TEST_WORKSPACE = { id: 'workspace-1', slug: 'workspace-1', name: 'Workspace 1' }
const BAKED_BYTES = Buffer.from('bytes the browser baked for the editor')
const BAKED_HASH = createHash('sha256').update(BAKED_BYTES).digest('hex')

const stub = usePrismaStubs()

/** A visible, bridge-owned project row: what an editor session has open. */
const PROJECT_ROW = {
  id: 'file-1',
  workspaceId: 'workspace-1',
  ownerBridgeId: 'bridge-1',
  name: 'project.stl',
  storedPath: 'stored-project.stl',
  sizeBytes: 12,
  uploadedAt: new Date('2026-09-01T00:00:00.000Z'),
  kind: 'stl',
  thumbnailPath: null,
  folderId: null,
  hidden: false,
  deletedAt: null,
  currentVersionNumber: 7,
  createdById: null,
  createdByName: null,
  restoredFromVersionNumber: null
}

test('a snapshot completion stages hidden deduped bytes and versions nothing', async () => {
  // Slicing unsaved editor work needs the bytes addressable by id without saving the user's
  // project. That is the preserved-project snapshot: hidden, content-keyed, never a version.
  const creates: Array<Record<string, unknown>> = []
  stubBridgeLibraryRpc(stub)
  stub(prisma.libraryFile, 'findUnique', async () => null)
  stub(rootPrisma.libraryFile, 'update', async () => { throw Object.assign(new Error('missing'), { code: 'P2025' }) })
  // Present so the unmodified persist path could resolve a target; a snapshot must not look here.
  stub(prisma.libraryFile, 'findFirst', async () => null)
  stub(prisma.libraryFile, 'create', async (args: { data: Record<string, unknown> }) => {
    creates.push(args.data)
    return { ...args.data, id: 'snapshot-1' }
  })
  stub(prisma.libraryFileVersion, 'create', async () => {
    throw new Error('staging must never create a version')
  })

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const { status, body } = await completeChunkedUpload(baseUrl, {
      fileName: 'project.stl',
      bridgeId: 'bridge-1',
      complete: { snapshot: true }
    })

    assert.equal(status, 201, body.error)
    assert.equal(body.snapshot, true)
    assert.equal(body.file?.id, 'snapshot-1')
    assert.equal(creates.length, 1)
    const staged = creates[0] ?? {}
    assert.equal(staged.hidden, true, 'a staged snapshot never appears in a listing')
    assert.equal(staged.origin, 'snapshot')
    assert.equal(staged.folderId, null)
    assert.equal(staged.snapshotKey, `${BAKED_HASH}:project.stl`, 'keyed on content, so identical bytes share a row')
    assert.equal(staged.ownerBridgeId, 'bridge-1')
  })
})

test('a prepared snapshot returns server-issued provenance bound to source and selected target', async (t) => {
  const sourceLineageId = 'source-lineage-1'
  let proofCreate: Record<string, unknown> | null = null
  let proofUpdate: Record<string, unknown> | null = null
  stubBridgeLibraryRpc(stub)
  const presetResolver = stubPreparedPresetResolution(t)
  stub(prisma.libraryFile, 'findUnique', async () => null)
  stub(rootPrisma.libraryFile, 'update', async () => { throw Object.assign(new Error('missing'), { code: 'P2025' }) })
  stub(prisma.libraryFile, 'findFirst', async (args: { where: { id?: string } }) => (
    args.where.id === PROJECT_ROW.id
      ? PROJECT_ROW
      : args.where.id === sourceLineageId
        ? { id: sourceLineageId }
        : null
  ))
  stub(prisma.libraryFile, 'create', async (args: { data: Record<string, unknown> }) => ({ ...args.data, id: 'snapshot-1' }))
  stub(prisma.libraryFileVersion, 'findFirst', async (args: { where: { id?: string; libraryFileId?: string } }) => (
    args.where.id === 'version-3' && args.where.libraryFileId === PROJECT_ROW.id
      ? { name: 'project-v3.3mf', ownerBridgeId: 'bridge-1', storedPath: 'project-v3.3mf' }
      : null
  ))
  stub(prisma.preparedSlicingSource, 'upsert', async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    proofCreate = args.create
    proofUpdate = args.update
    return { id: 'prepared-1' }
  })

  const preparedBytes = await validPreparedProjectBytes()
  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const { status, body } = await completeChunkedUpload(baseUrl, {
      fileName: 'project.3mf',
      bridgeId: 'bridge-1',
      bytes: preparedBytes,
      complete: {
        snapshot: true,
        targetFileId: PROJECT_ROW.id,
        preparedSlicing: {
          contractVersion: 1,
          sourceFileId: sourceLineageId,
          slicerTargetId: 'bambu-1',
          configurationBaseVersionId: 'version-3',
          target: {
            mode: 'manualProfile',
            printerModel: 'P1S',
            printerProfileId: buildBuiltinSlicingPresetId('machine', 'Prepared P1S machine')
          }
        }
      }
    })

    assert.equal(status, 201, body.error)
    assert.equal(body.file?.id, 'snapshot-1')
    assert.equal(body.preparedSourceId, 'prepared-1')
    assert.equal(proofCreate?.workspaceId, TEST_WORKSPACE.id)
    assert.equal(proofCreate?.libraryFileId, 'snapshot-1')
    assert.equal(proofCreate?.sourceFileId, sourceLineageId)
    assert.equal(proofCreate?.configurationBaseFileId, PROJECT_ROW.id)
    assert.equal(proofCreate?.configurationBaseVersionId, 'version-3')
    assert.equal(proofCreate?.contractVersion, 1)
    assert.match(String(proofCreate?.configurationDigest), /^[a-f0-9]{64}$/)
    assert.ok(proofCreate?.expiresAt instanceof Date)
    assert.ok(proofUpdate?.expiresAt instanceof Date, 'dedup reuse atomically renews the proof lease')
    assert.equal(presetResolver.mock.callCount(), 0, 'proof issuance must not re-resolve preset bodies through the slicer')
  })
})

test('an invalid prepared archive creates neither a snapshot nor a proof', async (t) => {
  let snapshotCreates = 0
  let proofCreates = 0
  stubBridgeLibraryRpc(stub)
  const presetResolver = stubPreparedPresetResolution(t)
  stub(prisma.libraryFile, 'findFirst', async (args: { where: { id?: string } }) => (
    args.where.id === PROJECT_ROW.id ? PROJECT_ROW : null
  ))
  stub(prisma.libraryFile, 'create', async () => { snapshotCreates += 1; return {} })
  stub(prisma.preparedSlicingSource, 'upsert', async () => { proofCreates += 1; return { id: 'prepared-1' } })

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const { status, body } = await completeChunkedUpload(baseUrl, {
      fileName: 'project.3mf',
      bridgeId: 'bridge-1',
      bytes: Buffer.from('not a 3mf archive'),
      complete: {
        snapshot: true,
        targetFileId: PROJECT_ROW.id,
        preparedSlicing: {
          contractVersion: 1,
          sourceFileId: PROJECT_ROW.id,
          target: {
            mode: 'manualProfile',
            printerModel: 'P1S',
            printerProfileId: buildBuiltinSlicingPresetId('machine', 'Prepared P1S machine')
          }
        }
      }
    })

    assert.equal(status, 400)
    assert.match(body.error ?? '', /incomplete or unreadable/)
    assert.equal(snapshotCreates, 0)
    assert.equal(proofCreates, 0)
    assert.equal(presetResolver.mock.callCount(), 0)
  })
})

test('staging the same bytes twice reuses the one snapshot row', async () => {
  // Every slice of unsaved work re-bakes and re-uploads; without the content key each one would
  // leave its own permanent copy behind (snapshot rows are exempt from the age-based sweeps).
  let existing: Record<string, unknown> | null = null
  let creates = 0
  let touches = 0
  stubBridgeLibraryRpc(stub)
  stub(rootPrisma.libraryFile, 'update', async (args: { where: { workspaceId_snapshotKey?: { workspaceId: string; snapshotKey: string } }; data: { uploadedAt: Date } }) => {
    const key = args.where.workspaceId_snapshotKey
    if (!key || key.workspaceId !== TEST_WORKSPACE.id || existing?.snapshotKey !== key.snapshotKey) {
      throw Object.assign(new Error('missing'), { code: 'P2025' })
    }
    touches += 1
    return { ...existing, uploadedAt: args.data.uploadedAt }
  })
  stub(prisma.libraryFile, 'findFirst', async () => null)
  stub(prisma.libraryFile, 'create', async (args: { data: Record<string, unknown> }) => {
    creates += 1
    existing = { ...args.data, id: `snapshot-${creates}` }
    return existing
  })

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const first = await completeChunkedUpload(baseUrl, { fileName: 'project.stl', bridgeId: 'bridge-1', complete: { snapshot: true } })
    const second = await completeChunkedUpload(baseUrl, { fileName: 'project.stl', bridgeId: 'bridge-1', complete: { snapshot: true } })

    assert.equal(first.body.file?.id, 'snapshot-1')
    assert.equal(second.body.file?.id, 'snapshot-1', 'the second staging resolved to the first row')
    assert.equal(creates, 1)
    assert.equal(touches, 1, 'a dedupe hit atomically refreshes its retention timestamp')
  })
})

test('identical snapshots deduplicate within a workspace but never across workspaces', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const lookupWorkspaces: string[] = []
  let creates = 0
  stubBridgeLibraryRpc(stub)
  stub(rootPrisma.libraryFile, 'update', async (args: { where: { workspaceId_snapshotKey?: { workspaceId: string; snapshotKey: string } }; data: { uploadedAt: Date } }) => {
    const key = args.where.workspaceId_snapshotKey
    if (!key) throw Object.assign(new Error('missing'), { code: 'P2025' })
    lookupWorkspaces.push(key.workspaceId)
    const row = rows.get(`${key.workspaceId}:${key.snapshotKey}`)
    if (!row) throw Object.assign(new Error('missing'), { code: 'P2025' })
    return { ...row, uploadedAt: args.data.uploadedAt }
  })
  stub(prisma.libraryFile, 'findFirst', async () => null)
  stub(prisma.libraryFile, 'create', async (args: { data: Record<string, unknown> }) => {
    creates += 1
    const row = { ...args.data, id: `snapshot-${creates}` }
    rows.set(`${String(args.data.workspaceId)}:${String(args.data.snapshotKey)}`, row)
    return row
  })

  const secondWorkspace = { id: 'workspace-2', slug: 'workspace-2', name: 'Workspace 2' }
  const first = await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => (
    await completeChunkedUpload(baseUrl, { fileName: 'project.3mf', bridgeId: 'bridge-1', complete: { snapshot: true } })
  ))
  const second = await withLibraryTestServer({ workspace: secondWorkspace }, async (baseUrl) => (
    await completeChunkedUpload(baseUrl, { fileName: 'project.3mf', bridgeId: 'bridge-1', complete: { snapshot: true } })
  ))

  assert.equal(first.body.file?.id, 'snapshot-1')
  assert.equal(second.body.file?.id, 'snapshot-2')
  assert.equal(creates, 2)
  assert.deepEqual(new Set(lookupWorkspaces), new Set(['workspace-1', 'workspace-2']))
})

test('a targeted completion versions the addressed file and reports the archived version', async () => {
  // `archivedVersionId` is the content this save authored FROM: the editor pins it so its next
  // save bakes from the same original instead of from this save's own output.
  let updatedId: string | null = null
  stubBridgeLibraryRpc(stub)
  stub(prisma.libraryFile, 'findFirst', async (args: { where: Record<string, unknown> }) => (
    Object.entries(args.where).every(([key, value]) => PROJECT_ROW[key as keyof typeof PROJECT_ROW] === value) ? PROJECT_ROW : null
  ))
  stub(prisma.libraryFileVersion, 'create', async (args: { data: unknown }) => ({ id: 'version-7', ...(args.data as object) }))
  stub(prisma.libraryFile, 'update', async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updatedId = args.where.id
    return { ...PROJECT_ROW, ...args.data }
  })
  stub(prisma.libraryFile, 'create', async () => {
    throw new Error('a targeted save must version the addressed file, not create a second one')
  })
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const { status, body } = await completeChunkedUpload(baseUrl, {
      // The name the session still holds; the file was renamed in the library meanwhile.
      fileName: 'renamed-by-the-user.stl',
      bridgeId: null,
      complete: { targetFileId: 'file-1' }
    })

    assert.equal(status, 201)
    assert.equal(body.file?.id, 'file-1')
    assert.equal(body.file?.name, 'project.stl', 'a save is not a rename')
    assert.equal(body.archivedVersionId, 'version-7')
    assert.equal(body.unchanged, false)
    assert.equal(updatedId, 'file-1')
  })
})

test('a completed 3MF save does not wait for library-card metadata inspection', async () => {
  let releaseInspection: (() => void) | null = null
  const inspectionBlocked = new Promise<void>((resolve) => { releaseInspection = resolve })
  stubBridgeLibraryRpc(stub, { inspectionBlocked })
  const project = {
    ...PROJECT_ROW,
    id: 'file-slow-metadata',
    name: 'project.3mf',
    storedPath: 'stored-project.3mf',
    kind: '3mf',
    derivedChipsJson: null,
    derivedChipsVersion: null
  }
  stub(prisma.libraryFile, 'findFirst', async () => project)
  stub(prisma.libraryFileVersion, 'create', async (args: { data: unknown }) => ({ id: 'version-7', ...(args.data as object) }))
  stub(prisma.libraryFile, 'update', async (args: { data: Record<string, unknown> }) => ({ ...project, ...args.data }))
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const completion = completeChunkedUpload(baseUrl, {
      fileName: project.name,
      bridgeId: project.ownerBridgeId,
      complete: { targetFileId: project.id }
    })
    const settledBeforeInspection = await Promise.race([
      completion.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
    ])
    releaseInspection?.()
    const result = await completion

    assert.equal(settledBeforeInspection, true, 'metadata inspection must run outside the blocking save path')
    assert.equal(result.status, 201)
    assert.equal(result.body.file?.id, project.id)
  })
})

test('completion retries and status reads return one authoritative committed result', async () => {
  let updates = 0
  let currentRow = PROJECT_ROW
  stubBridgeLibraryRpc(stub)
  stub(prisma.libraryFile, 'findFirst', async () => currentRow)
  stub(prisma.libraryFileVersion, 'create', async (args: { data: unknown }) => ({ id: 'version-7', ...(args.data as object) }))
  stub(prisma.libraryFile, 'update', async (args: { data: Record<string, unknown> }) => {
    updates += 1
    currentRow = { ...PROJECT_ROW, ...args.data } as typeof PROJECT_ROW
    return currentRow
  })
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const complete = { targetFileId: PROJECT_ROW.id }
    const first = await completeChunkedUpload(baseUrl, {
      fileName: PROJECT_ROW.name,
      bridgeId: PROJECT_ROW.ownerBridgeId,
      complete
    })
    // Simulate a process dying after the database mutation/receipt transaction but before the
    // filesystem transport session recorded the HTTP response.
    const metaPath = path.join(libraryDir, '.uploads', `${first.uploadId}.json`)
    const stuckSession = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    stuckSession.phase = 'transferring'
    delete stuckSession.completion
    delete stuckSession.completedAt
    await writeFile(metaPath, JSON.stringify(stuckSession), 'utf8')
    // A later library edit must not rewrite the outcome of this operation while it is being
    // reconciled. The receipt holds the committed row snapshot, not a pointer to mutable state.
    currentRow = { ...currentRow, name: 'renamed-after-save.stl' }
    const retried = await fetch(`${baseUrl}/uploads/${first.uploadId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(complete)
    })
    const retriedBody = await retried.json()
    // A process restart can also lose the transport-session file entirely. Status lookup must
    // still recover the committed result from the durable receipt by upload id.
    await unlink(metaPath)
    const status = await fetch(`${baseUrl}/uploads/${first.uploadId}`)
    const statusBody = await status.json() as { upload: { phase: string; completion: { body: unknown } | null } }

    assert.equal(retried.status, 201)
    assert.deepEqual(retriedBody, first.body)
    assert.equal(statusBody.upload.phase, 'completed')
    assert.deepEqual(statusBody.upload.completion?.body, first.body)
    assert.equal(updates, 1, 'an idempotent retry must not create a second file version')
  })
})

test('starting an upload never deletes an old but still active recovery session', async () => {
  const uploadDir = path.join(libraryDir, '.uploads')
  const recoverableId = 'recoverable-active-session'
  const recoverableMeta = path.join(uploadDir, `${recoverableId}.json`)
  const recoverablePart = path.join(uploadDir, `${recoverableId}.part`)
  await mkdir(uploadDir, { recursive: true })
  await writeFile(recoverableMeta, JSON.stringify({
    id: recoverableId,
    fileName: 'slow.3mf',
    sizeBytes: 100,
    receivedBytes: 50,
    phase: 'receiving',
    bridgeReceivedBytes: 0,
    workspaceId: TEST_WORKSPACE.id,
    folderId: null,
    bridgeId: null,
    hidden: false,
    relativeFolderPath: null,
    createdAt: '2026-09-01T00:00:00.000Z'
  }), 'utf8')
  await writeFile(recoverablePart, Buffer.alloc(50))

  try {
    await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'next.3mf', sizeBytes: 1 })
      })
      const body = await response.json() as { uploadId?: string }
      assert.equal(response.status, 201)
      await stat(recoverableMeta)
      await stat(recoverablePart)
      if (body.uploadId) await fetch(`${baseUrl}/uploads/${body.uploadId}`, { method: 'DELETE' })
    })
  } finally {
    await rm(recoverableMeta, { force: true })
    await rm(recoverablePart, { force: true })
  }
})

test('completion resumes an orphaned transferring session with a pending durable receipt', async () => {
  let updates = 0
  const bridge = stubBridgeLibraryRpc(stub)
  stub(prisma.libraryFile, 'findFirst', async () => PROJECT_ROW)
  stub(prisma.libraryFileVersion, 'create', async (args: { data: unknown }) => ({ id: 'version-resumed', ...(args.data as object) }))
  stub(prisma.libraryFile, 'update', async (args: { data: Record<string, unknown> }) => {
    updates += 1
    return { ...PROJECT_ROW, ...args.data }
  })
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const complete = { targetFileId: PROJECT_ROW.id }
    const result = await completeChunkedUpload(baseUrl, {
      fileName: PROJECT_ROW.name,
      bridgeId: PROJECT_ROW.ownerBridgeId,
      complete,
      beforeComplete: async (uploadId) => {
        const completionDigest = createHash('sha256').update(JSON.stringify(complete)).digest('hex')
        bridge.receipts.set(uploadId, {
          id: uploadId,
          workspaceId: TEST_WORKSPACE.id,
          intentDigest: completionDigest,
          status: 'pending'
        })
        const metaPath = path.join(libraryDir, '.uploads', `${uploadId}.json`)
        const session = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
        session.phase = 'transferring'
        session.completionDigest = completionDigest
        await writeFile(metaPath, JSON.stringify(session), 'utf8')
      }
    })

    assert.equal(result.status, 201)
    assert.equal(result.body.file?.id, PROJECT_ROW.id)
    assert.equal(result.body.archivedVersionId, 'version-resumed')
    assert.equal(updates, 1)
  })
})

test('an ordinary completion is unchanged, and now reports its archived version too', async () => {
  // The no-new-fields path: still a name-matched overwrite of the same-named file, still the
  // same response, plus the `archivedVersionId` the route used to compute and drop.
  stubBridgeLibraryRpc(stub)
  stub(prisma.libraryFile, 'findFirst', async (args: { where: Record<string, unknown> }) => (
    Object.entries(args.where).every(([key, value]) => PROJECT_ROW[key as keyof typeof PROJECT_ROW] === value) ? PROJECT_ROW : null
  ))
  stub(prisma.libraryFileVersion, 'create', async (args: { data: unknown }) => ({ id: 'version-7', ...(args.data as object) }))
  stub(prisma.libraryFile, 'update', async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ ...PROJECT_ROW, ...args.data }))
  stub(prisma, '$transaction', async (run: (tx: typeof prisma) => Promise<unknown>) => await run(prisma))

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const { status, body } = await completeChunkedUpload(baseUrl, {
      fileName: 'project.stl',
      bridgeId: 'bridge-1',
      complete: {}
    })

    assert.equal(status, 201)
    assert.equal(body.file?.id, 'file-1')
    assert.equal(body.unchanged, false)
    assert.equal(body.archivedVersionId, 'version-7')
  })
})

test('a targeted completion 404s on a file the workspace cannot see, without storing bytes', async () => {
  // The editor's tab can outlive the file (deleted, or another workspace's). Falling back to
  // name matching there is what silently produced a second copy of the project.
  const bridge = stubBridgeLibraryRpc(stub)
  stub(prisma.libraryFile, 'findFirst', async () => null)
  stub(prisma.libraryFile, 'create', async () => {
    throw new Error('a missing target must not fall through to creating a file')
  })

  await withLibraryTestServer({ workspace: TEST_WORKSPACE }, async (baseUrl) => {
    const { status, body } = await completeChunkedUpload(baseUrl, {
      fileName: 'project.stl',
      bridgeId: 'bridge-1',
      complete: { targetFileId: 'file-gone' }
    })

    assert.equal(status, 404)
    assert.equal(body.error, 'File not found')
    assert.deepEqual(bridge.writtenToBridgeIds, [])
  })
})

test('the demo cannot version a curated file through a targeted completion', async () => {
  // Demo uploads escape the read-only guard only because they are forced hidden; a targeted
  // save is not hidden, so it has to be refused explicitly.
  stubBridgeLibraryRpc(stub)
  stub(prisma.libraryFile, 'findFirst', async () => PROJECT_ROW)
  stub(prisma.libraryFile, 'update', async () => {
    throw new Error('demo library files are read-only')
  })

  await withLibraryTestServer({ workspace: TEST_WORKSPACE, demoMode: true }, async (baseUrl) => {
    const { status, body } = await completeChunkedUpload(baseUrl, {
      fileName: 'project.stl',
      bridgeId: 'bridge-1',
      complete: { targetFileId: 'file-1' }
    })

    assert.equal(status, 403)
    assert.equal(body.error, 'Curated demo library files are read-only in the public demo.')
  })
})

/**
 * Stand in for the owning bridge. `library.stat` answers the identical-upload probe with a hash
 * that never matches, so every test here takes the "content differs" path.
 */
function stubBridgeLibraryRpc(stubber: PrismaStubber, options: { inspectionBlocked?: Promise<void> } = {}): {
  writtenToBridgeIds: string[]
  receipts: Map<string, Record<string, unknown>>
} {
  const writtenToBridgeIds: string[] = []
  const receipts = new Map<string, Record<string, unknown>>()
  stubber(prisma.libraryUploadCompletion, 'deleteMany', async () => ({ count: 0 }))
  stubber(prisma.libraryUploadCompletion, 'findFirst', async (args: { where: { id?: string } }) => (
    args.where.id ? receipts.get(args.where.id) ?? null : null
  ))
  stubber(prisma.libraryUploadCompletion, 'upsert', async (args: {
    where: { id: string }
    create: Record<string, unknown>
    update: Record<string, unknown>
  }) => {
    const current = receipts.get(args.where.id)
    const next = current ? { ...current, ...args.update } : { ...args.create, status: 'pending' }
    receipts.set(args.where.id, next)
    return next
  })
  stubber(prisma.libraryUploadCompletion, 'update', async (args: {
    where: { id: string }
    data: Record<string, unknown>
  }) => {
    const next = { ...(receipts.get(args.where.id) ?? {}), ...args.data }
    receipts.set(args.where.id, next)
    return next
  })
  stubber(bridgeSessionManager, 'isConnected', () => true)
  stubber(bridgeSessionManager, 'requestRpc', async (bridgeId: string, method: string) => {
    if (method === 'library.inspect3mf' && options.inspectionBlocked) await options.inspectionBlocked
    if (method === 'library.stat') return { sizeBytes: 1, contentSha256: '0'.repeat(64) }
    if (method === 'library.storeStart') writtenToBridgeIds.push(bridgeId)
    return {}
  })
  return { writtenToBridgeIds, receipts }
}

/** Run a whole upload (begin, one chunk, complete) and return the completion's response. */
async function completeChunkedUpload(baseUrl: string, input: {
  fileName: string
  bridgeId: string | null
  folderId?: string | null
  bytes?: Buffer
  complete: Record<string, unknown>
  beforeComplete?: (uploadId: string) => Promise<void>
}): Promise<{ uploadId: string; status: number; body: { file?: { id?: string; name?: string }; snapshot?: boolean; preparedSourceId?: string | null; unchanged?: boolean; archivedVersionId?: string | null; error?: string } }> {
  const bytes = input.bytes ?? BAKED_BYTES
  const begun = await fetch(`${baseUrl}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: input.fileName,
      sizeBytes: bytes.byteLength,
      bridgeId: input.bridgeId,
      folderId: input.folderId ?? null
    })
  })
  assert.equal(begun.status, 201)
  const { uploadId } = await begun.json() as { uploadId: string }

  const chunk = await fetch(`${baseUrl}/uploads/${uploadId}/chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': '0' },
    body: new Uint8Array(bytes)
  })
  assert.equal(chunk.status, 200)

  await input.beforeComplete?.(uploadId)

  const completed = await fetch(`${baseUrl}/uploads/${uploadId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input.complete)
  })
  const body = await completed.json() as Awaited<ReturnType<typeof completeChunkedUpload>>['body']
  // A rejected completion keeps its session (the bytes are still good for a corrected retry),
  // so tests clean up after themselves rather than leaving staged files on disk.
  if (!completed.ok) {
    await fetch(`${baseUrl}/uploads/${uploadId}`, { method: 'DELETE' })
  }
  return { uploadId, status: completed.status, body }
}

async function validPreparedProjectBytes(): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  const chunks: Buffer[] = []
  const complete = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.on('error', reject)
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
  const rootModel = [
    '<model>',
    '<metadata name="Application">BambuStudio-02.00.00.00</metadata>',
    '<resources><object id="1" type="model"><mesh>',
    '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>',
    '<triangles><triangle v1="0" v2="1" v3="2"/></triangles>',
    '</mesh></object></resources><build><item objectid="1"/></build></model>'
  ].join('')
  const settings = JSON.stringify({
    printer_settings_id: 'Prepared P1S machine',
    printer_model: 'P1S',
    print_compatible_printers: ['Prepared P1S machine'],
    print_settings_id: 'Prepared process',
    filament_settings_id: ['Bambu PLA Basic @BBL P1S'],
    filament_ids: ['GFA00'],
    filament_type: ['PLA'],
    filament_colour: ['#FFFFFF'],
    filament_nozzle_map: ['0'],
    filament_diameter: ['1.75'],
    nozzle_temperature: ['220'],
    nozzle_temperature_initial_layer: ['220'],
    filament_flow_ratio: ['0.98'],
    filament_density: ['1.24']
  })
  for (const [name, content] of Object.entries({
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    '3D/3dmodel.model': rootModel,
    '3D/_rels/3dmodel.model.rels': '<Relationships/>',
    'Metadata/model_settings.config': '<config><plate/></config>',
    'Metadata/project_settings.config': settings
  })) zip.addBuffer(Buffer.from(content), name)
  zip.end()
  return await complete
}

function stubPreparedPresetResolution(t: TestContext) {
  stub(rootPrisma.setting, 'findUnique', async () => null)
  const method = mock.method(slicerClient, 'resolveMachineConfig', async () => ({
    printer_settings_id: 'Prepared P1S machine',
    printer_model: 'P1S'
  }))
  t.after(() => method.mock.restore())
  return method
}

async function withLibraryTestServer<Result>(
  auth: { workspace: typeof TEST_WORKSPACE | null; demoMode?: boolean },
  run: (baseUrl: string) => Promise<Result>
): Promise<Result> {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.workspace = auth.workspace
    request.auth = {
      authEnabled: false,
      actor: { type: 'user', userId: 'user-1' },
      permissions: [],
      runtimePolicy: { demoMode: auth.demoMode ?? false }
    }
    next()
  })
  app.use(libraryRouter)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: (error as Error).message })
  })

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}
