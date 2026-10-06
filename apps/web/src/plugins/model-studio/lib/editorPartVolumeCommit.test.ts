import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import type { EditorImportStore } from './editorImportStore'
import { commitEditorPartVolume, type PartVolumeCommitOptions } from './editorPartVolumeCommit'
import { addedPartHostId, instanceFromStagedImport, seedEmptyEditorState } from './editorModel'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }
const staged: StagedImport = {
  importId: 'body', name: 'Body', format: 'stl', triangleCount: 12, bounds,
  parts: [{ name: 'Body', triangleCount: 12, bounds, subtype: null }]
}

/** Supply a real printable host and inspect only the controller's observable callbacks. */
function fixture(stageFile: EditorImportStore['stageFile']) {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  instance.filamentId = 3
  state.plates[0]!.instances.push(instance)
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial())
  mesh.position.z = 5
  group.add(mesh)
  const events: string[] = []
  const options: PartVolumeCommitOptions = {
    stateRef: { current: state },
    activePlateIndex: 1,
    key: instance.key,
    subtype: 'normal_part',
    source: { kind: 'primitive', shape: 'cube' },
    groupByKey: new Map([[instance.key, group]]),
    importStore: { stageFile } as EditorImportStore,
    recordHistory: () => { events.push('history') },
    setImporting: (value) => { events.push(`importing:${value}`) },
    refreshAddedPartMeshes: () => { events.push('refresh') },
    selectPart: (_hostId, _key) => { events.push('select') },
    setMoveMode: () => { events.push('move') },
    regenerateThumbnail: () => { events.push('thumbnail') }
  }
  return { state, instance, options, events }
}

test('staged normal part inherits the host material and records history before publication', async () => {
  const { state, instance, options, events } = fixture(async () => ({ importId: 'part', name: 'cube' } as StagedImport))
  await commitEditorPartVolume(options)

  const part = state.addedParts?.[addedPartHostId(instance)!]?.[0]
  assert.equal(part?.importId, 'part')
  assert.equal(part?.name, 'Part')
  assert.equal(part?.filamentId, 3)
  assert.deepEqual(events, ['importing:true', 'history', 'refresh', 'select', 'move', 'thumbnail', 'importing:false'])
})

test('a helper has no inherited material, and failed staging leaves state and history untouched', async () => {
  const { state, instance, options, events } = fixture(async () => ({ importId: 'helper', name: 'cube' } as StagedImport))
  options.subtype = 'support_blocker'
  await commitEditorPartVolume(options)
  assert.equal(state.addedParts?.[addedPartHostId(instance)!]?.[0]?.filamentId, undefined)

  const failing = fixture(async () => { throw new Error('staging failed') })
  await commitEditorPartVolume(failing.options)
  assert.equal(failing.state.addedParts, undefined)
  assert.deepEqual(failing.events, ['importing:true', 'importing:false'])
  assert.ok(events.includes('history'))
})

test('staging that finishes after the editor state changes cannot mutate the old project', async () => {
  let releaseStage: (() => void) | undefined
  const stagedWhenReleased = new Promise<void>((resolve) => { releaseStage = resolve })
  const { state, options, events } = fixture(async () => {
    await stagedWhenReleased
    return { importId: 'late', name: 'cube' } as StagedImport
  })

  const commit = commitEditorPartVolume(options)
  options.stateRef.current = null
  releaseStage?.()
  await commit

  assert.equal(state.addedParts, undefined)
  assert.deepEqual(events, ['importing:true', 'importing:false'])
})
