import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { defaultTextInfo, type SvgPartRecord } from '@printstream/shared/three-mf'
import {
  findEditorAddedSvgPart,
  findEditorAddedTextPart,
  findEditorBakedAuthoredPart
} from './editorAuthoredPartLookup'
import {
  addedPartHostId,
  instanceFromStagedImport,
  seedEmptyEditorState,
  type EditorAddedPart
} from './editorModel'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'host', name: 'Host', format: 'stl', triangleCount: 1, bounds,
  parts: [{ name: 'Body', triangleCount: 1, bounds, subtype: null }]
}
const artwork: SvgPartRecord = {
  entryPath: '3D/logo.svg', fileName: 'logo.svg', pieceIndex: 0,
  widthMm: 40, thickness: 2, includeBackground: false
}

/** Make session metadata explicit; the lookup must not infer a type from its display name. */
function sessionPart(key: string): EditorAddedPart {
  return {
    key, importId: key, subtype: 'normal_part', name: key,
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array()
  }
}

test('session Text requires authoring metadata and a live host instance on this plate', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(instance)
  const hostId = addedPartHostId(instance)!
  const plain = sessionPart('plain')
  const text = { ...sessionPart('text'), textInfo: defaultTextInfo('Words', 'DejaVu Sans') }
  state.addedParts = { [hostId]: [plain, text] }

  assert.equal(findEditorAddedTextPart(state, state.plates[0], plain.key), null)
  assert.deepEqual(findEditorAddedTextPart(state, state.plates[0], text.key), {
    part: text, hostInstanceKey: instance.key
  })
  assert.equal(findEditorAddedTextPart(state, undefined, text.key), null)
})

test('session SVG retains its host object id and ignores unauthored parts', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  const hostId = addedPartHostId(instance)!
  const plain = sessionPart('plain')
  const svg = { ...sessionPart('svg'), svgPart: artwork }
  state.addedParts = { [hostId]: [plain, svg] }

  assert.equal(findEditorAddedSvgPart(state, plain.key), null)
  assert.deepEqual(findEditorAddedSvgPart(state, svg.key), { part: svg, hostId })
})

test('baked lookup keeps the authored part ordinal after another part is removed', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  const hostId = addedPartHostId(instance)!
  const plain = {
    entryPath: '3D/Objects/object_1.model', componentObjectId: 4, partIndex: 2,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    filamentId: 1, name: 'Plain', color: null, subtype: null
  }
  const authored = { ...plain, partIndex: 4, name: 'Artwork', svgPart: artwork }
  instance.parts.push(plain, authored)
  state.plates[0]!.instances.push(instance)

  assert.equal(findEditorBakedAuthoredPart(state.plates[0], hostId, 2), null)
  assert.deepEqual(findEditorBakedAuthoredPart(state.plates[0], hostId, 4), {
    part: authored, instance, hostId, partIndex: 4
  })
  instance.parts.splice(0, 1)
  assert.equal(findEditorBakedAuthoredPart(state.plates[0], hostId, 4)?.part, authored)
})
