process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePinnedContentBase } from './library-content-base.js'
import { prisma } from './prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import { HttpError } from './http-error.js'

/**
 * The pin resolves the bytes an editor session authors from, for BOTH its saves and its slices.
 *
 * These pin the two rules a caller cannot see from the signature: a named version outranks the
 * file's head (that is the entire point -- the head moves as the session saves), and an
 * unresolvable pin is an error rather than a quiet fall back to the head, because falling back
 * re-applies an already-applied edit and fails as a wrong-looking print instead of as a failure.
 */

const p = prisma as unknown as Record<string, Record<string, unknown>>
const libraryFile = p.libraryFile!
const libraryFileVersion = p.libraryFileVersion!
restorePrismaMethodsAfterEach([
  [libraryFile, 'findFirst'],
  [libraryFileVersion, 'findFirst']
])

function stub(version: unknown, file: unknown): void {
  libraryFileVersion.findFirst = (async () => version) as unknown as typeof prisma.libraryFileVersion.findFirst
  libraryFile.findFirst = (async () => file) as unknown as typeof prisma.libraryFile.findFirst
}

test('a pinned version wins over the file head', async () => {
  // The head is the session's own latest save; the pinned version is what it opened.
  stub({ ownerBridgeId: 'bridge-1', storedPath: 'opened.3mf' }, { ownerBridgeId: 'bridge-1', storedPath: 'latest-save.3mf' })
  const resolved = await resolvePinnedContentBase('ws-1', { fileId: 'file-1', versionId: 'version-opened' })
  assert.deepEqual(resolved, { ownerBridgeId: 'bridge-1', storedPath: 'opened.3mf' })
})

test('no version means the file head, which is still what an unsaved session opened', async () => {
  stub(null, { ownerBridgeId: null, storedPath: 'current.3mf' })
  assert.deepEqual(
    await resolvePinnedContentBase('ws-1', { fileId: 'file-1' }),
    { ownerBridgeId: null, storedPath: 'current.3mf' }
  )
  assert.deepEqual(
    await resolvePinnedContentBase('ws-1', { fileId: 'file-1', versionId: null }),
    { ownerBridgeId: null, storedPath: 'current.3mf' }
  )
})

test('an unresolvable pin throws instead of falling back to the head', async () => {
  // Falling back is the corruption: the head already contains this edit, so baking it again
  // re-applies the non-idempotent parts (`partOrder`, `removedParts`).
  stub(null, { ownerBridgeId: null, storedPath: 'current.3mf' })
  await assert.rejects(
    () => resolvePinnedContentBase('ws-1', { fileId: 'file-1', versionId: 'swept-version' }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  )

  stub(null, null)
  await assert.rejects(
    () => resolvePinnedContentBase('ws-1', { fileId: 'deleted-file' }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  )
})
