/** In-place part mesh replacement preserves the volume contract around the changed triangles. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SceneEdit } from '../slicing.js'
import { buildEditedThreeMfDocuments, type ImportedObjectInput } from './bake-documents.js'

const triangleObject = (id: number, x: number): string => [
  `<object id="${id}" type="model"><mesh><vertices>`,
  `<vertex x="${x}" y="0" z="0"/><vertex x="${x + 1}" y="0" z="0"/><vertex x="${x}" y="1" z="0"/>`,
  '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
].join('')

const MODEL = [
  '<model><resources>',
  '<object id="5" type="model"><components>',
  '<component objectid="20" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
  '<component objectid="21" transform="1 0 0 0 1 0 0 0 1 7 0 0"/>',
  '</components></object>',
  triangleObject(20, 0),
  triangleObject(21, 10),
  '</resources><build><item objectid="5"/></build></model>'
].join('')

const SETTINGS = [
  '<config><object id="5"><metadata key="name" value="Assembly"/>',
  '<part id="20" subtype="normal_part"><metadata key="name" value="Body"/></part>',
  '<part id="21" subtype="support_blocker"><metadata key="name" value="Keep out"/></part>',
  '</object></config>'
].join('')

const edit: SceneEdit = {
  plates: [{ index: 1 }],
  instances: [{
    objectId: 5,
    plateIndex: 1,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    filamentId: null
  }],
  partMeshReplacements: [{ objectId: 5, partIndex: 1, meshImportId: 'simplified' }]
}

const replacement: ImportedObjectInput = {
  importId: 'simplified',
  name: 'Simplified helper',
  mesh: {
    positions: new Float32Array([30, 0, 0, 31, 0, 0, 30, 1, 0]),
    indices: new Uint32Array([0, 1, 2])
  }
}

test('part mesh replacement retains order, metadata, subtype, and component transform', () => {
  const result = buildEditedThreeMfDocuments(MODEL, SETTINGS, null, edit, [replacement])

  assert.match(result.modelXml, /<component objectid="20"[^>]*\/><component objectid="21"[^>]*transform="1 0 0 0 1 0 0 0 1 7 0 0"\/>/)
  assert.match(result.modelXml, /<object id="21"[^>]*>[\s\S]*?<vertex x="30"/)
  assert.doesNotMatch(result.modelXml, /<object id="21"[^>]*>[\s\S]*?<vertex x="10"/)
  assert.match(result.modelSettingsXml, /<part id="20" subtype="normal_part">/)
  assert.match(result.modelSettingsXml, /<part id="21" subtype="support_blocker"><metadata key="name" value="Keep out"\/><\/part>/)
  assert.equal(result.importIdToObjectId.has('simplified'), false, 'replacement mesh is not appended as a new object')
})

test('an unsaved multi-solid import replaces the addressed solid before its first bake', () => {
  const host: ImportedObjectInput = {
    importId: 'assembly',
    name: 'Assembly',
    mesh: replacement.mesh,
    parts: [
      { name: 'Body', mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) } },
      { name: 'Keep out', subtype: 'support_blocker', mesh: { positions: new Float32Array([10, 0, 0, 11, 0, 0, 10, 1, 0]), indices: new Uint32Array([0, 1, 2]) } }
    ]
  }
  const importEdit: SceneEdit = {
    ...edit,
    instances: [{
      importId: host.importId,
      plateIndex: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      filamentId: null
    }],
    partMeshReplacements: undefined,
    importPartMeshReplacements: [{ importId: host.importId, partIndex: 1, meshImportId: replacement.importId }]
  }
  const result = buildEditedThreeMfDocuments(MODEL.replace(/<item objectid="5"\/>/, ''), '<config/>', null, importEdit, [host, replacement])

  assert.match(result.modelXml, /<vertex x="30"/)
  assert.match(result.modelSettingsXml, /value="Body"[\s\S]*value="Keep out"/)
  assert.match(result.modelSettingsXml, /subtype="support_blocker"/)
  assert.equal(result.importIdToObjectId.has(replacement.importId), false)
})
