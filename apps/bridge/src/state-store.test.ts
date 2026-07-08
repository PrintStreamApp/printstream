import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CorruptBridgeStateError, clearBridgeCredentials, loadBridgeState, writeBridgeState } from './state-store.js'

let dir: string | null = null

function newStateFile(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'bridge-state-'))
  return path.join(dir, 'bridge-state.json')
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
})

test('loadBridgeState generates and persists a durable installationId on first run', async () => {
  const file = newStateFile()

  const first = await loadBridgeState(file)
  assert.equal(typeof first.installationId, 'string')
  assert.ok(first.installationId.length > 0)
  assert.equal(first.bridgeId, undefined)
  assert.equal(first.runtimeToken, undefined)

  // The id is persisted, so it stays stable across loads (and process restarts).
  const second = await loadBridgeState(file)
  assert.equal(second.installationId, first.installationId)
})

test('loadBridgeState backfills installationId for a legacy file, preserving credentials', async () => {
  const file = newStateFile()
  writeFileSync(file, JSON.stringify({ bridgeId: 'bridge-1', runtimeToken: 'token-1' }))

  const state = await loadBridgeState(file)
  assert.equal(state.bridgeId, 'bridge-1')
  assert.equal(state.runtimeToken, 'token-1')
  assert.equal(typeof state.installationId, 'string')

  // The backfilled id is written through so it survives the next credential reset.
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.installationId, state.installationId)
})

test('loadBridgeState refuses to mint a new identity for a corrupt file, preserving it', async () => {
  const file = newStateFile()
  writeFileSync(file, '{ this is not valid json')

  await assert.rejects(loadBridgeState(file), CorruptBridgeStateError)

  // The corrupt file is left in place (so restarts keep failing loudly rather than
  // silently re-provisioning) and a backup copy is preserved for recovery.
  assert.equal(readFileSync(file, 'utf8'), '{ this is not valid json')
  assert.equal(readFileSync(`${file}.corrupt`, 'utf8'), '{ this is not valid json')
})

test('loadBridgeState treats an empty (truncated) file as corruption, not a first run', async () => {
  const file = newStateFile()
  writeFileSync(file, '')

  await assert.rejects(loadBridgeState(file), CorruptBridgeStateError)
})

test('writeBridgeState replaces atomically and leaves no temp file behind', async () => {
  const file = newStateFile()
  await writeBridgeState(file, { installationId: 'install-1', bridgeId: 'b1', runtimeToken: 't1' })

  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.installationId, 'install-1')
  assert.throws(() => readFileSync(`${file}.tmp`, 'utf8'))
})

test('clearBridgeCredentials drops credentials but keeps the installationId', async () => {
  const file = newStateFile()
  await writeBridgeState(file, { installationId: 'install-1', bridgeId: 'bridge-1', runtimeToken: 'token-1' })

  await clearBridgeCredentials(file, 'install-1')

  const state = await loadBridgeState(file)
  assert.equal(state.installationId, 'install-1')
  assert.equal(state.bridgeId, undefined)
  assert.equal(state.runtimeToken, undefined)
})
