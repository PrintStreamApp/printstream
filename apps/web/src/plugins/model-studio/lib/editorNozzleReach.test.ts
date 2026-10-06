import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editorFilamentNozzleMap, editorInstanceNozzles } from './editorNozzleReach'

test('plate reorder retains nozzle assignments from the plate source index', () => {
  const sources = [
    { index: 3, filaments: [{ id: 1, nozzleId: 0 }] },
    { index: 7, filaments: [{ id: 1, nozzleId: 1 }, { id: 2, nozzleId: null }] }
  ]
  assert.deepEqual([...editorFilamentNozzleMap({ sourcePlateIndex: 7 }, sources)], [[1, 1]])
  assert.deepEqual([...editorFilamentNozzleMap({ sourcePlateIndex: null }, sources)], [])
})

test('object and part materials together determine the nozzles it must reach', () => {
  const map = new Map([[1, 0], [2, 1]])
  const instance = {
    filamentId: 1,
    parts: [{ filamentId: 2 }, { filamentId: 3 }, { filamentId: null }]
  }
  assert.deepEqual([...editorInstanceNozzles(instance, map)].sort(), [0, 1])
  assert.deepEqual([...editorInstanceNozzles({ filamentId: null, parts: [] }, map)], [])
})
