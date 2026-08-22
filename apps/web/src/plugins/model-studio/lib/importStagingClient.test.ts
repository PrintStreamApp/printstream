/**
 * The staging client's worker leg — the part node would otherwise never reach.
 *
 * Every other import test runs with no `Worker` global and therefore exercises only the main-thread
 * fallback. What is decided HERE and nowhere else is which failures may be retried: a file the
 * worker refused must NOT be parsed again inline (the same bytes fail the same way, and doing it
 * twice freezes the tab on the way to the identical message), while a broken worker MUST fall back
 * or the import cannot happen at all. Those two live one field apart in the response.
 */
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import type { ImportStagingRequest, ImportStagingResponse } from './importStagingWorker'
import {
  IMPORT_STAGING_BASE_DEADLINE_MS,
  ImportStagingDataError,
  disposeImportStagingWorker,
  importStagingDeadlineMs,
  stageImportGeometry
} from './importStagingClient'

type Reply = (request: ImportStagingRequest) => ImportStagingResponse | null

/** Installs a `Worker` that answers with `reply`; returns what the client posted. */
function installWorker(reply: Reply) {
  const posted: ImportStagingRequest[] = []
  let terminated = 0
  class StubWorker {
    onmessage: ((event: { data: ImportStagingResponse }) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null
    postMessage(request: ImportStagingRequest) {
      posted.push(request)
      const response = reply(request)
      // Asynchronous, like a real worker: the client must not depend on a synchronous answer.
      if (response) queueMicrotask(() => this.onmessage?.({ data: response }))
    }
    terminate() { terminated += 1 }
  }
  ;(globalThis as { Worker?: unknown }).Worker = StubWorker
  return { posted, terminated: () => terminated }
}

afterEach(() => {
  disposeImportStagingWorker()
  delete (globalThis as { Worker?: unknown }).Worker
})

const MESH = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } } }

test('a staged mesh comes back with the STL the viewport loads', async () => {
  const { posted } = installWorker((request) => ({ id: request.id, ok: true, mesh: MESH, stl: new Uint8Array([1, 2, 3]), partStls: [] }))
  const result = await stageImportGeometry('3mf', new Uint8Array([9, 9, 9, 9]))
  assert.deepEqual(result.mesh.indices, [0, 1, 2])
  assert.deepEqual([...result.stl], [1, 2, 3])
  assert.equal(posted[0]?.format, '3mf')
})

test('the caller\'s bytes survive being posted, so a fallback can still read them', async () => {
  installWorker((request) => ({ id: request.id, ok: true, mesh: MESH, stl: new Uint8Array(), partStls: [] }))
  const bytes = new Uint8Array([4, 5, 6])
  await stageImportGeometry('stl', bytes)
  // Transferring the caller's own buffer would detach it and leave the fallback path with nothing.
  assert.deepEqual([...bytes], [4, 5, 6])
})

test('a file the worker refused is a data error, not something to retry', async () => {
  installWorker((request) => ({
    id: request.id, ok: false, dataError: true, error: 'This 3MF contains no importable model geometry.'
  }))
  const error = await stageImportGeometry('3mf', new Uint8Array([1])).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof ImportStagingDataError, 'the caller keys the no-retry decision on this type')
  assert.equal(error.message, 'This 3MF contains no importable model geometry.')
})

test('a broken worker is an ordinary error, so the caller falls back', async () => {
  installWorker((request) => ({ id: request.id, ok: false, dataError: false, error: 'module failed to load' }))
  const error = await stageImportGeometry('step', new Uint8Array([1])).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof Error)
  assert.ok(!(error instanceof ImportStagingDataError), 'a mechanism failure must stay retryable')
})

test('a worker that never answers is terminated rather than left wedged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { terminated } = installWorker(() => null) // never replies
  const pending = stageImportGeometry('step', new Uint8Array([1])).then(() => null, (thrown: unknown) => thrown)
  t.mock.timers.tick(importStagingDeadlineMs(1))
  const error = await pending
  assert.ok(error instanceof Error)
  assert.ok(!(error instanceof ImportStagingDataError), 'a timeout must fall back, not refuse the file')
  // Terminated, not merely abandoned: a wedged worker holding a 7 MB WASM instance must not leak,
  // and the next import has to start from a worker that is actually answering.
  assert.equal(terminated(), 1)
})

test('with no Worker at all the client fails as a mechanism problem', async () => {
  delete (globalThis as { Worker?: unknown }).Worker
  const error = await stageImportGeometry('stl', new Uint8Array([1])).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof Error)
  assert.ok(!(error instanceof ImportStagingDataError), 'node and exotic embedders must reach the fallback')
})

test('the deadline scales with payload size from a fixed base', () => {
  assert.equal(importStagingDeadlineMs(0), IMPORT_STAGING_BASE_DEADLINE_MS)
  assert.equal(importStagingDeadlineMs(512), IMPORT_STAGING_BASE_DEADLINE_MS + 1)
  // A 40 MB STEP: bounded to a couple of minutes beyond the base, not forever.
  assert.equal(importStagingDeadlineMs(40 * 1024 * 1024), IMPORT_STAGING_BASE_DEADLINE_MS + 80 * 1024)
})
