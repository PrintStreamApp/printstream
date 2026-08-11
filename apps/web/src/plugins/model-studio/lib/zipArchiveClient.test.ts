import assert from 'node:assert/strict'
import test from 'node:test'
import { strToU8 } from 'fflate'
import { ZIP_ARCHIVE_BASE_DEADLINE_MS, unzipArchiveBytes, zipArchiveDeadlineMs, zipArchiveEntries } from './zipArchiveClient'

/**
 * The bounded zip codec behind every client-side archive open and save.
 *
 * What these pin is the SETTLING contract: every call resolves or rejects — the fflate async API
 * this replaced could wedge without erroring, leaving the editor on "Loading plates…" forever.
 * Node has no `Worker`, so these deliberately exercise the main-thread fallback leg — the same leg
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

test('deadline scales with payload size from a fixed base', () => {
  assert.equal(zipArchiveDeadlineMs(0), ZIP_ARCHIVE_BASE_DEADLINE_MS)
  assert.equal(zipArchiveDeadlineMs(1024), ZIP_ARCHIVE_BASE_DEADLINE_MS + 1)
  // The incident's 17MB project: bounded to well under a minute beyond the base, not forever.
  assert.equal(zipArchiveDeadlineMs(17 * 1024 * 1024), ZIP_ARCHIVE_BASE_DEADLINE_MS + 17 * 1024)
})
