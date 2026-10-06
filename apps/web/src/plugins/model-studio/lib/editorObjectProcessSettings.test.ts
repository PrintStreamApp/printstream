import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyEditorObjectProcessOverrides,
  editorObjectProcessSettingsTarget,
  readEditorObjectProcessOverrides,
  type EditorObjectProcessSettingsTarget
} from './editorObjectProcessSettings'
import type { EditorInstance } from './editorModel'

test('object settings target deduplicates linked copies and names a bulk selection', () => {
  const instances = [
    { key: 'first', objectId: 1, source: { kind: 'object' }, name: 'Gear' },
    { key: 'copy', objectId: 1, source: { kind: 'object' }, name: 'Gear copy' },
    { key: 'second', objectId: 2, source: { kind: 'object' }, name: 'Shaft' }
  ] as EditorInstance[]
  assert.deepEqual(editorObjectProcessSettingsTarget(instances, ['first', 'copy', 'second']), {
    ids: [1, 2], name: '2 objects'
  })
  assert.deepEqual(editorObjectProcessSettingsTarget(instances, ['copy']), {
    ids: [1], name: 'Gear copy'
  })
  assert.equal(editorObjectProcessSettingsTarget(instances, ['missing']), null)
})

test('bulk object settings merge uniform values and preserve untouched mixed values', () => {
  const current = {
    '1': { old: 'left', keep: 'one' },
    '2': { old: 'right', keep: 'two' },
    '3': { unrelated: 'untouched' }
  }
  const target: EditorObjectProcessSettingsTarget = { ids: [1, 2], name: 'Two objects' }
  assert.deepEqual(readEditorObjectProcessOverrides(current, target), [
    { old: 'left', keep: 'one' },
    { old: 'right', keep: 'two' }
  ])

  const applied = applyEditorObjectProcessOverrides(current, target, { speed: '75' }, ['old'])
  assert.deepEqual(applied['1'], { keep: 'one', speed: '75' })
  assert.deepEqual(applied['2'], { keep: 'two', speed: '75' })
  assert.deepEqual(applied['3'], { unrelated: 'untouched' })
  assert.deepEqual(current['1'], { old: 'left', keep: 'one' })
})

test('cleared objects retain explicit empty entries for the next save', () => {
  const current = { '1': { old: 'source' } }
  const target: EditorObjectProcessSettingsTarget = { ids: [1, 2], name: 'Two objects' }
  const applied = applyEditorObjectProcessOverrides(current, target, {}, ['old'])
  assert.deepEqual(applied, { '1': {}, '2': {} })
})
