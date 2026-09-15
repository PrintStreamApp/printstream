import assert from 'node:assert/strict'
import test from 'node:test'
import type { SceneEdit } from '@printstream/shared'
import { sceneEditForPreparedSlice } from './preparedSlicePayload.js'

test('prepared slice payload omits auxiliaries already embedded in the staged project', () => {
  const sceneEdit: SceneEdit = {
    plates: [{ index: 1 }],
    instances: [],
    plateThumbnails: [{ plateIndex: 1, png: 'thumbnail' }],
    projectAuxiliaries: {
      files: [{ category: 'Model Pictures', name: 'large.png', contentBase64: 'AQ==' }],
      metadata: {
        modelName: '',
        modelAuthor: '',
        modelDescription: '',
        modelId: '',
        profileName: '',
        profileAuthor: '',
        profileDescription: ''
      }
    }
  }

  const requestEdit = sceneEditForPreparedSlice(sceneEdit)

  assert.equal(requestEdit.projectAuxiliaries, undefined)
  assert.deepEqual(requestEdit.plateThumbnails, sceneEdit.plateThumbnails)
  assert.ok(sceneEdit.projectAuxiliaries, 'the editor-owned state is not mutated')
})
