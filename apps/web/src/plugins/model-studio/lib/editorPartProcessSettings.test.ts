import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  partSlotKey,
  seedEmptyEditorState,
  type EditorAddedPart,
  type EditorInstance
} from './editorModel'
import {
  applyEditorPartProcessOverrides,
  editorPartProcessSettingsTarget,
  readEditorPartProcessOverrides,
  type EditorPartProcessSettingsTarget
} from './editorPartProcessSettings'

function instance(): EditorInstance {
  return {
    key: 'host', source: { kind: 'object' }, objectId: 12, instanceId: 0, name: 'Host',
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1, printable: true, parts: [], color: null
  }
}

test('part settings target names body, baked, added, and bulk selections', () => {
  const state = seedEmptyEditorState()
  const host = instance()
  host.parts = [{ partIndex: 2, name: 'Baked volume' }] as EditorInstance['parts']
  state.plates[0]!.instances.push(host)
  state.addedParts = { 12: [addedPart()] }

  assert.deepEqual(editorPartProcessSettingsTarget(state, null, {
    objectId: 12, member: { kind: 'body' }
  }), { objectId: 12, members: [{ kind: 'body' }], name: 'Host' })
  assert.deepEqual(editorPartProcessSettingsTarget(state, null, {
    objectId: 12, member: { kind: 'baked', partIndex: 2 }
  }), { objectId: 12, members: [{ kind: 'baked', partIndex: 2 }], name: 'Baked volume' })
  assert.deepEqual(editorPartProcessSettingsTarget(state, null, {
    objectId: 12, member: { kind: 'added', key: 'volume' }
  }), { objectId: 12, members: [{ kind: 'added', key: 'volume' }], name: 'Volume' })
  assert.deepEqual(editorPartProcessSettingsTarget(state, {
    objectId: 12, members: [{ kind: 'body' }, { kind: 'added', key: 'volume' }]
  }, null), {
    objectId: 12, members: [{ kind: 'body' }, { kind: 'added', key: 'volume' }], name: '2 parts'
  })
  assert.equal(editorPartProcessSettingsTarget(state, null, null), null)
})

function addedPart(): EditorAddedPart {
  return {
    key: 'volume', importId: 'import-volume', subtype: 'normal_part', name: 'Volume',
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array(), settings: { old: 'source', keep: 'volume' }
  }
}

test('mixed baked and added part settings retain each member while clearing named keys', () => {
  const state = seedEmptyEditorState()
  state.plates[0]!.instances.push(instance())
  const volume = addedPart()
  state.addedParts = { 12: [volume] }
  const bakedSlot = partSlotKey(12, 2)
  state.partProcessOverrides = { [bakedSlot]: { old: 'source', keep: 'baked' } }
  const target: EditorPartProcessSettingsTarget = {
    objectId: 12,
    name: 'Two parts',
    members: [{ kind: 'baked', partIndex: 2 }, { kind: 'added', key: 'volume' }]
  }
  assert.deepEqual(readEditorPartProcessOverrides(state, target), [
    { old: 'source', keep: 'baked' },
    { old: 'source', keep: 'volume' }
  ])

  const applied = applyEditorPartProcessOverrides(state, target, { speed: ['10', '20'] }, ['old'])
  assert.notEqual(applied, state)
  assert.deepEqual(applied.partProcessOverrides?.[bakedSlot], { keep: 'baked', speed: '10;20' })
  assert.deepEqual(volume.settings, { keep: 'volume', speed: '10;20' })

  const cleared = applyEditorPartProcessOverrides(applied, target, {}, ['keep', 'speed'])
  assert.deepEqual(cleared.partProcessOverrides?.[bakedSlot], {})
  assert.equal(volume.settings, undefined)
})

test('body settings use the promoted ordinal-zero slot', () => {
  const state = seedEmptyEditorState()
  const bodySlot = partSlotKey(12, 0)
  state.partProcessOverrides = { [bodySlot]: { old: 'source' } }
  const target: EditorPartProcessSettingsTarget = {
    objectId: 12,
    name: 'Body',
    members: [{ kind: 'body' }]
  }
  assert.deepEqual(readEditorPartProcessOverrides(state, target), [{ old: 'source' }])
  const applied = applyEditorPartProcessOverrides(state, target, {}, ['old'])
  assert.deepEqual(applied.partProcessOverrides?.[bodySlot], {})
})
