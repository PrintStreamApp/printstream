import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { strToU8 } from 'fflate'
import { ZIP_ARCHIVE_BASE_DEADLINE_MS, unzipArchiveBytes, zipArchiveDeadlineMs, zipArchiveEntries } from './zipArchiveClient'

const realWorker = globalThis.Worker
afterEach(() => {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: realWorker })
})

/**
 * The bounded zip codec behind every client-side archive open and save.
 *
 * What these pin is the SETTLING contract: every call resolves or rejects: the fflate async API
 * this replaced could wedge without erroring, leaving the editor on "Loading plates…" forever.
 * Node has no `Worker`, so these deliberately exercise the main-thread fallback leg, the same leg
 * a browser lands on when the worker fails or times out; the worker leg is bounded by construction
 * (size-scaled deadline + terminate in `finally`), whose numbers the deadline test pins.
 */

test('round-trips entries through zip and unzip byte-identically', async () => {
  const entries = {
    '3D/3dmodel.model': strToU8('<model unit="millimeter"/>'),
    'Metadata/model_settings.config': strToU8('<config/>'),
    'Metadata/plate_1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
  }
  const bytes = await zipArchiveEntries(entries, 6)
  const unzipped = await unzipArchiveBytes(bytes)
  assert.deepEqual(Object.keys(unzipped).sort(), Object.keys(entries).sort())
  for (const [path, content] of Object.entries(entries)) {
    assert.deepEqual([...unzipped[path]!], [...content], `entry ${path} should survive the round-trip`)
  }
})

test('rejects corrupt archive bytes instead of hanging', async () => {
  await assert.rejects(unzipArchiveBytes(new Uint8Array([1, 2, 3, 4])))
})

test('rejects an archive whose expanded body exceeds the caller budget', async () => {
  const bytes = await zipArchiveEntries({ 'large.bin': new Uint8Array(2_048) }, 9)
  await assert.rejects(
    unzipArchiveBytes(bytes, { maxEntries: 10, maxEntryBytes: 1_024, maxInflatedBytes: 1_024 }),
    /expands beyond the allowed size/
  )
})

test('rejects case-folded duplicate entry names before exposing an ambiguous archive', async () => {
  // fflate's object-shaped writer cannot produce exact duplicates. A case variant still exercises
  // the cross-reader ambiguity without hand-authoring ZIP structures in this test.
  const bytes = await zipArchiveEntries({ 'Metadata/value.txt': strToU8('one'), 'metadata/value.txt': strToU8('two') }, 6)
  await assert.rejects(unzipArchiveBytes(bytes), /duplicate entry names/)
})

test('deadline scales with payload size from a fixed base', () => {
  assert.equal(zipArchiveDeadlineMs(0), ZIP_ARCHIVE_BASE_DEADLINE_MS)
  assert.equal(zipArchiveDeadlineMs(1024), ZIP_ARCHIVE_BASE_DEADLINE_MS + 1)
  // The incident's 17MB project: bounded to well under a minute beyond the base, not forever.
  assert.equal(zipArchiveDeadlineMs(17 * 1024 * 1024), ZIP_ARCHIVE_BASE_DEADLINE_MS + 17 * 1024)
})

test('aborting compression terminates its worker without falling back to main-thread compression', async () => {
  let terminated = false
  class PendingWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    postMessage(): void {}
    terminate(): void { terminated = true }
  }
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: PendingWorker as unknown as typeof Worker
  })
  const abort = new AbortController()
  const compression = zipArchiveEntries({ 'large.model': new Uint8Array(1024) }, 6, abort.signal)

  abort.abort()

  await assert.rejects(
    compression,
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.equal(terminated, true)
})
