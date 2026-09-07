process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { LIBRARY_DOWNLOAD_PERMISSION, LIBRARY_UPLOAD_PERMISSION } from '@printstream/shared'
import { editorRouter } from './editor.js'
import type { RequestAuthContext } from '../lib/auth-context.js'
import { prisma } from '../lib/prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { HttpError } from '../lib/http-error.js'

/**
 * The save/export request names its content base separately from its save target
 * (`contentBase`, see the shared schema), and `ignoreBaseContent` says "carry no base bytes at
 * all". These tests pin the INTERACTION between the two, which is ordering-sensitive in a way the
 * types cannot express: resolving a pin before honouring `ignoreBaseContent` reads perfectly fine
 * and shipped once (fixed in d7929e57), because the only symptom is a save that 404s long after
 * the pinned row was swept.
 *
 * `/export-3mf` rather than `/save`: it runs the identical bake and content-base resolution but
 * persists nothing, so these stay hermetic, no bridge, no library writes.
 */

const p = prisma as unknown as Record<string, Record<string, unknown>>
const libraryFile = p.libraryFile!
const libraryFileVersion = p.libraryFileVersion!
restorePrismaMethodsAfterEach([
  [libraryFile, 'findFirst'],
  [libraryFileVersion, 'findFirst']
])

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

/** Only `target-file` exists; anything else is gone (a discarded/swept scaffold). */
function stubOnlyTargetFileExists(): void {
  libraryFile.findFirst = (async (args: { where?: { id?: string } }) => (
    args?.where?.id === 'target-file'
      ? { id: 'target-file', name: 'Target.3mf', ownerBridgeId: null, storedPath: 'target.3mf', folderId: null }
      : null
  )) as unknown as typeof prisma.libraryFile.findFirst
  libraryFileVersion.findFirst = (async () => null) as unknown as typeof prisma.libraryFileVersion.findFirst
}

async function postExport(body: unknown): Promise<{ status: number; text: string }> {
  const auth: RequestAuthContext = {
    authEnabled: true,
    actor: { type: 'user', userId: 'user-1' },
    // `/export-3mf` is gated on DOWNLOAD (it streams bytes back); upload is here so the same
    // harness can drive `/save` if these grow.
    permissions: [LIBRARY_DOWNLOAD_PERMISSION, LIBRARY_UPLOAD_PERMISSION],
    runtimePolicy: { demoMode: false }
  } as RequestAuthContext

  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use((request, _response, next) => {
    request.auth = auth
    request.workspace = { id: 'workspace-1', slug: 'dev', name: 'Dev' }
    next()
  })
  app.use('/api/editor', editorRouter)
  app.use((error: unknown, _req: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  servers.push(server)
  const { port } = server.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${port}/api/editor/export-3mf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, text: response.ok ? '' : await response.text() }
}

const BAKEABLE_EDIT = { plates: [{ index: 1 }], instances: [], filaments: [{ color: '#00FF00', type: 'PLA' }] }

test('a save that ignores base content does not fail on a content base that no longer exists', async () => {
  stubOnlyTargetFileExists()
  // An editor-born session pins its new-project SCAFFOLD, a hidden row that is discarded on
  // abandon and swept by `pruneHiddenLibraryFiles`. Once it is gone the pin dangles, and the save
  // must not care: it already declared it wants none of those bytes.
  const result = await postExport({
    baseFileId: 'target-file',
    contentBase: { fileId: 'swept-scaffold', versionId: null },
    ignoreBaseContent: true,
    sceneEdit: BAKEABLE_EDIT,
    name: 'editor-born.3mf'
  })
  assert.equal(result.status, 200, `expected the bake to succeed, got ${result.status} ${result.text}`)
})

test('a save that NEEDS its content base still fails loudly when the base is gone', async () => {
  stubOnlyTargetFileExists()
  // The counterpart, and the reason the guard is two terms rather than a try/catch: silently
  // falling back to the target's current bytes here would resume authoring each save onto the
  // previous save's output, which is exactly what the content base exists to stop.
  const result = await postExport({
    baseFileId: 'target-file',
    contentBase: { fileId: 'gone-file', versionId: null },
    sceneEdit: BAKEABLE_EDIT,
    name: 'ordinary.3mf'
  })
  assert.equal(result.status, 404)
  assert.match(result.text, /no longer available/)
})

test('a bake naming a file, with no version and no pin, is refused rather than read from the head', async () => {
  stubOnlyTargetFileExists()
  // The third way to name base bytes, and the only one that can MOVE. After this session's first
  // save the target's head holds this session's own output, so serving it re-applies the edit over
  // itself: `partOrder` and `removedParts` are not idempotent, and a re-applied reorder permutes an
  // object's volumes while the positional per-part extruder writes stay put, so parts trade
  // materials silently. Both single-object exports shipped in exactly this state.
  const result = await postExport({
    baseFileId: 'target-file',
    sceneEdit: BAKEABLE_EDIT,
    name: 'unpinned.3mf'
  })
  assert.equal(result.status, 400, `expected a refusal, got ${result.status} ${result.text}`)
  assert.match(result.text, /did not say which version/)
})

test('a bake carrying an explicit base VERSION needs no pin, because a version cannot move', async () => {
  stubOnlyTargetFileExists()
  // The refusal is scoped to the one source that can move under the session. An archived version is
  // a snapshot, so the history dialog's Edit flow keeps working without a pin.
  libraryFileVersion.findFirst = (async (args: { where?: { id?: string } }) => (
    args?.where?.id === 'target-version'
      ? { id: 'target-version', ownerBridgeId: null, storedPath: 'target.3mf' }
      : null
  )) as unknown as typeof prisma.libraryFileVersion.findFirst
  const result = await postExport({
    baseFileId: 'target-file',
    baseVersionId: 'target-version',
    sceneEdit: BAKEABLE_EDIT,
    name: 'versioned.3mf'
  })
  // Asserted as "not refused for want of a pin" rather than 200: this harness stubs the database
  // but not the filesystem, so the bake goes on to fail reading bytes that were never written. The
  // guard is what is under test, and it must not fire here.
  assert.notEqual(result.status, 400, `the pin guard fired on a versioned bake: ${result.text}`)
  assert.doesNotMatch(result.text, /did not say which version/)
})
