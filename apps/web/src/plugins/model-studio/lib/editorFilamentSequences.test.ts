import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SceneEdit } from '@printstream/shared'
import { reconcileSceneEditFilamentSequences } from './editorFilamentSequences'

test('emitted plate sequences keep surviving order and append new physical materials', () => {
  const edit = {
    plates: [{
      index: 1,
      firstLayerFilamentSequence: [3, 1, 2],
      otherLayerFilamentSequences: [{ startLayer: 2, endLayer: null, filamentIds: [2, 3] }]
    }]
  } as SceneEdit

  const next = reconcileSceneEditFilamentSequences(edit, [
    { projectFilamentId: 1 },
    { projectFilamentId: 3 },
    { projectFilamentId: 4 },
    { projectFilamentId: 5, mixedFilament: { id: 'virtual' } }
  ])

  assert.deepEqual(next.plates[0]?.firstLayerFilamentSequence, [3, 1, 4])
  assert.deepEqual(next.plates[0]?.otherLayerFilamentSequences?.[0]?.filamentIds, [3, 1, 4])
  assert.deepEqual(edit.plates[0]?.firstLayerFilamentSequence, [3, 1, 2])
  assert.deepEqual(edit.plates[0]?.otherLayerFilamentSequences?.[0]?.filamentIds, [2, 3])
})

test('an unavailable physical-material list leaves the scene edit untouched', () => {
  const edit = { plates: [{ index: 1, firstLayerFilamentSequence: [1] }] } as SceneEdit

  assert.equal(
    reconcileSceneEditFilamentSequences(edit, [{ projectFilamentId: 2, mixedFilament: true }]),
    edit
  )
})
