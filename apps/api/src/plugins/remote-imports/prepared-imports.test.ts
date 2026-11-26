/** Prepared download ownership, completion serialization and shutdown fixtures. */
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PreparedImports } from './prepared-imports.js'

test('confirm, replay and cancel serialize around one library mutation', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  const directory = await mkdtemp(path.join(tmpdir(), 'prepared-fixture-'))
  try {
    const prepared = await store.prepare('workspace:user', async () => ({ sourceUrl: 'https://example.com/a.stl', fileName: 'real.stl', filePath: path.join(directory, 'real.stl'), cleanupPath: directory, sizeBytes: 1 }))
    await assert.rejects(store.cancel(prepared.id, 'other-workspace:user'), /not found/)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let writes = 0
    const save = async () => { writes += 1; await gate; return 'saved' }
    const first = store.confirm(prepared.id, 'workspace:user', 'same choice', save)
    const replay = store.confirm(prepared.id, 'workspace:user', 'same choice', save)
    const cancellation = assert.rejects(store.cancel(prepared.id, 'workspace:user'), /Saving has begun/)
    release()
    assert.deepEqual(await Promise.all([first, replay]), ['saved', 'saved'])
    await cancellation
    assert.equal(writes, 1)
    await assert.rejects(store.confirm(prepared.id, 'workspace:user', 'different choice', save), /another destination/)
    await assert.rejects(stat(directory))
  } finally { await store.close() }
})

test('a download completing after shutdown is discarded without creating a pending entry', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  const directory = await mkdtemp(path.join(tmpdir(), 'prepared-fixture-'))
  let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const prepare = store.prepare('workspace:user', async () => {
    started()
    await gate
    return { sourceUrl: 'https://example.com/a.stl', fileName: 'real.stl', filePath: path.join(directory, 'real.stl'), cleanupPath: directory, sizeBytes: 1 }
  })
  await began
  await store.close()
  release()
  await assert.rejects(prepare, /shutting down/)
  await assert.rejects(stat(directory))
})

test('successful imports do not consume pending-download capacity', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  try {
    for (let index = 0; index < 10; index += 1) {
      const directory = await mkdtemp(path.join(tmpdir(), 'prepared-fixture-'))
      const prepared = await store.prepare('workspace:user', async () => ({ sourceUrl: 'https://example.com/a.stl', fileName: 'real.stl', filePath: path.join(directory, 'real.stl'), cleanupPath: directory, sizeBytes: 1 }))
      assert.equal(await store.confirm(prepared.id, 'workspace:user', 'same choice', async () => 'saved'), 'saved')
    }
  } finally { await store.close() }
})

test('a stalled upstream preparation is aborted at the server deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const prepared = store.prepare('workspace:user', async (signal) => await new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started()
  }))
  await began
  context.mock.timers.tick(10 * 60_000)
  await assert.rejects(prepared, /timed out/)
  await store.close()
})
