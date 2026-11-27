/** Prepared download ownership, completion serialization and shutdown fixtures. */
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PREPARED_IMPORT_LIMITS, PreparedImports } from './prepared-imports.js'

test('confirm, replay and cancel serialize around one library mutation', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  const directory = await mkdtemp(path.join(tmpdir(), 'prepared-fixture-'))
  try {
    const prepared = await store.prepare('workspace:user', 'workspace', async () => ({ sourceUrl: 'https://example.com/a.stl', fileName: 'real.stl', filePath: path.join(directory, 'real.stl'), cleanupPath: directory, sizeBytes: 1 }))
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
  const prepare = store.prepare('workspace:user', 'workspace', async () => {
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
      const prepared = await store.prepare('workspace:user', 'workspace', async () => ({ sourceUrl: 'https://example.com/a.stl', fileName: 'real.stl', filePath: path.join(directory, 'real.stl'), cleanupPath: directory, sizeBytes: 1 }))
      assert.equal(await store.confirm(prepared.id, 'workspace:user', 'same choice', async () => 'saved'), 'saved')
    }
  } finally { await store.close() }
})

test('a stalled upstream preparation is aborted at the server deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const prepared = store.prepare('workspace:user', 'workspace', async (signal) => await new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started()
  }))
  await began
  context.mock.timers.tick(10 * 60_000)
  await assert.rejects(prepared, /timed out/)
  await store.close()
})

/** A finished download in a fresh temporary directory, for tests that only count capacity. */
async function fixtureDownload() {
  const directory = await mkdtemp(path.join(tmpdir(), 'prepared-fixture-'))
  return { sourceUrl: 'https://example.com/a.stl', fileName: 'real.stl', filePath: path.join(directory, 'real.stl'), cleanupPath: directory, sizeBytes: 1 }
}

test('one person\'s abandoned imports make way for their next one and never block anyone else', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  try {
    const first = await store.prepare('a:alice', 'a', fixtureDownload)
    await store.prepare('a:alice', 'a', fixtureDownload)
    // A third replaces Alice's oldest waiting import, whose bytes are discarded.
    await store.prepare('a:alice', 'a', fixtureDownload)
    await assert.rejects(store.cancel(first.id, 'a:alice'), /not found/)
    // Bob, in the same workspace, still has room; so does another workspace.
    await store.prepare('a:bob', 'a', fixtureDownload)
    await store.prepare('b:carol', 'b', fixtureDownload)
  } finally { await store.close() }
})

test('a workspace and the whole node each have a ceiling', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  try {
    for (let person = 0; person < PREPARED_IMPORT_LIMITS.perWorkspace; person += 1) {
      await store.prepare(`a:person-${person}`, 'a', fixtureDownload)
    }
    await assert.rejects(store.prepare('a:late', 'a', fixtureDownload), /Too many model imports/)
    for (let workspace = 1; workspace * PREPARED_IMPORT_LIMITS.perWorkspace < PREPARED_IMPORT_LIMITS.total; workspace += 1) {
      for (let person = 0; person < PREPARED_IMPORT_LIMITS.perWorkspace; person += 1) {
        await store.prepare(`w${workspace}:p${person}`, `w${workspace}`, fixtureDownload)
      }
    }
    await assert.rejects(store.prepare('z:first', 'z', fixtureDownload), /Too many model imports/)
  } finally { await store.close() }
})

test('an import whose saving has begun is never replaced', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  try {
    const saving = await store.prepare('a:alice', 'a', fixtureDownload)
    const other = await store.prepare('a:alice', 'a', fixtureDownload)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const confirmed = store.confirm(saving.id, 'a:alice', 'choice', async () => { await gate; return 'saved' })
    // The waiting one is replaced, the saving one is left alone.
    await store.prepare('a:alice', 'a', fixtureDownload)
    await assert.rejects(store.cancel(other.id, 'a:alice'), /not found/)
    release()
    assert.equal(await confirmed, 'saved')
  } finally { await store.close() }
})

test('without sign-in, one person\'s import never replaces another\'s', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  try {
    const anonymous = 'a:anonymous'
    const first = await store.prepare(anonymous, 'a', fixtureDownload, { identifiable: false })
    for (let index = 1; index < PREPARED_IMPORT_LIMITS.perWorkspace; index += 1) {
      await store.prepare(anonymous, 'a', fixtureDownload, { identifiable: false })
    }
    await assert.rejects(store.prepare(anonymous, 'a', fixtureDownload, { identifiable: false }), /Too many model imports/)
    // The first is still there to confirm.
    assert.equal(await store.confirm(first.id, anonymous, 'choice', async () => 'saved'), 'saved')
  } finally { await store.close() }
})

test('parallel imports from one person never exceed their allowance', async () => {
  const store = new PreparedImports<string>(path.join(tmpdir(), 'absent-prepared-fixture'), () => {})
  try {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow = async () => { await gate; return await fixtureDownload() }
    const attempts = Array.from({ length: 5 }, () => store.prepare('a:alice', 'a', slow))
    const settled = Promise.allSettled(attempts)
    release()
    const results = await settled
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, PREPARED_IMPORT_LIMITS.perOwner)
  } finally { await store.close() }
})
