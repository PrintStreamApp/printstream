process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'
import { bridgeSessionManager } from '../lib/bridge-session-manager.js'
import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
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

    assert.equal(status, 201)
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

test('staging the same bytes twice reuses the one snapshot row', async () => {
  // Every slice of unsaved work re-bakes and re-uploads; without the content key each one would
  // leave its own permanent copy behind (snapshot rows are exempt from the age-based sweeps).
  let existing: Record<string, unknown> | null = null
  let creates = 0
  stubBridgeLibraryRpc(stub)
  stub(prisma.libraryFile, 'findUnique', async (args: { where: { snapshotKey?: string } }) => (
    args.where.snapshotKey && existing?.snapshotKey === args.where.snapshotKey ? existing : null
  ))
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
  })
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
function stubBridgeLibraryRpc(stubber: PrismaStubber): { writtenToBridgeIds: string[] } {
  const writtenToBridgeIds: string[] = []
  stubber(bridgeSessionManager, 'isConnected', () => true)
  stubber(bridgeSessionManager, 'requestRpc', async (bridgeId: string, method: string) => {
    if (method === 'library.stat') return { sizeBytes: 1, contentSha256: '0'.repeat(64) }
    if (method === 'library.storeStart') writtenToBridgeIds.push(bridgeId)
    return {}
  })
  return { writtenToBridgeIds }
}

/** Run a whole upload (begin, one chunk, complete) and return the completion's response. */
async function completeChunkedUpload(baseUrl: string, input: {
  fileName: string
  bridgeId: string | null
  folderId?: string | null
  complete: Record<string, unknown>
}): Promise<{ status: number; body: { file?: { id?: string; name?: string }; snapshot?: boolean; unchanged?: boolean; archivedVersionId?: string | null; error?: string } }> {
  const begun = await fetch(`${baseUrl}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: input.fileName,
      sizeBytes: BAKED_BYTES.byteLength,
      bridgeId: input.bridgeId,
      folderId: input.folderId ?? null
    })
  })
  assert.equal(begun.status, 201)
  const { uploadId } = await begun.json() as { uploadId: string }

  const chunk = await fetch(`${baseUrl}/uploads/${uploadId}/chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': '0' },
    body: BAKED_BYTES
  })
  assert.equal(chunk.status, 200)

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
  return { status: completed.status, body }
}

async function withLibraryTestServer(
  auth: { workspace: typeof TEST_WORKSPACE | null; demoMode?: boolean },
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
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
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}
