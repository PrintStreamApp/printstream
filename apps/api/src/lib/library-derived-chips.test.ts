import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LIBRARY_DERIVED_CHIPS_VERSION,
  parseDerivedChips,
  serializeDerivedChips,
  warmLibraryFileDerivedChips,
  type DerivedChips
} from './library-derived-chips.js'

const sample: DerivedChips = {
  plateCount: 3,
  compatiblePrinterModels: [],
  plateTypeChips: [],
  nozzleSizeChips: [],
  projectFilamentChips: []
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('serialize/parse round-trips at the current parser version', () => {
  const parsed = parseDerivedChips(serializeDerivedChips(sample), LIBRARY_DERIVED_CHIPS_VERSION)
  assert.deepEqual(parsed, sample)
})

test('parse returns null for a stale parser version (invalidates the cache)', () => {
  assert.equal(parseDerivedChips(serializeDerivedChips(sample), LIBRARY_DERIVED_CHIPS_VERSION - 1), null)
})

test('parse returns null for missing or malformed json', () => {
  assert.equal(parseDerivedChips(null, LIBRARY_DERIVED_CHIPS_VERSION), null)
  assert.equal(parseDerivedChips(undefined, undefined), null)
  assert.equal(parseDerivedChips('{not json', LIBRARY_DERIVED_CHIPS_VERSION), null)
})

test('warm derives + persists chips for a 3mf, with the current version', async () => {
  const persisted: Array<{ id: string; json: string; version: number }> = []
  warmLibraryFileDerivedChips(
    { id: 'f1', kind: '3mf', ownerBridgeId: 'b1', storedPath: 'a.3mf' },
    {
      deriveChips: async () => sample,
      persist: async (id, json, version) => { persisted.push({ id, json, version }) }
    }
  )
  await tick()
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0]?.id, 'f1')
  assert.equal(persisted[0]?.version, LIBRARY_DERIVED_CHIPS_VERSION)
  assert.deepEqual(parseDerivedChips(persisted[0]?.json ?? null, LIBRARY_DERIVED_CHIPS_VERSION), sample)
})

test('warm dedupes concurrent calls for the same file', async () => {
  let derives = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const deps = {
    deriveChips: async () => { derives += 1; await gate; return sample },
    persist: async () => {}
  }
  const file = { id: 'f2', kind: '3mf', ownerBridgeId: 'b1', storedPath: 'b.3mf' }
  warmLibraryFileDerivedChips(file, deps)
  warmLibraryFileDerivedChips(file, deps) // deduped
  await tick()
  assert.equal(derives, 1)
  release()
  await tick()
})

test('warm skips non-chip file kinds (e.g. stl)', async () => {
  let derives = 0
  warmLibraryFileDerivedChips(
    { id: 'f3', kind: 'stl', ownerBridgeId: 'b1', storedPath: 'c.stl' },
    { deriveChips: async () => { derives += 1; return sample }, persist: async () => {} }
  )
  await tick()
  assert.equal(derives, 0)
})

test('a failing derive frees the key so a later warm can retry', async () => {
  let calls = 0
  const file = { id: 'f4', kind: 'gcode', ownerBridgeId: 'b1', storedPath: 'd.gcode' }
  warmLibraryFileDerivedChips(file, { deriveChips: async () => { calls += 1; throw new Error('boom') }, persist: async () => {}, log: () => {} })
  await tick()
  warmLibraryFileDerivedChips(file, { deriveChips: async () => { calls += 1; return sample }, persist: async () => {} })
  await tick()
  assert.equal(calls, 2)
})
