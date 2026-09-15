import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_OBJ_MATERIAL_BYTES, MAX_OBJ_TEXTURE_BYTES } from '@printstream/shared/three-mf'
import { selectLibraryObjMaterialFiles, selectLibraryObjTextureFiles, type LibraryObjMaterialCandidate } from './library-obj-materials.js'

function candidate(name: string, sizeBytes = 100): LibraryObjMaterialCandidate {
  return { name, sizeBytes, ownerBridgeId: 'bridge-1', storedPath: `${name}-stored` }
}

test('library MTL matching follows OBJ path basenames and reference order', () => {
  const first = candidate('SHELL.MTL')
  const second = candidate('detail.mtl')
  const unrelated = candidate('other.mtl')
  const obj = Buffer.from('mtllib materials/shell.mtl detail.mtl')

  assert.deepEqual(selectLibraryObjMaterialFiles(obj, [second, unrelated, first]), [first, second])
})

test('missing material resources leave a geometry-only import', () => {
  assert.deepEqual(selectLibraryObjMaterialFiles(Buffer.from('mtllib missing.mtl'), []), [])
})

test('ambiguous and oversized library material resources are refused', () => {
  const obj = Buffer.from('mtllib shell.mtl')
  assert.throws(
    () => selectLibraryObjMaterialFiles(obj, [candidate('shell.mtl'), candidate('SHELL.MTL')]),
    /more than one/i
  )
  assert.throws(
    () => selectLibraryObjMaterialFiles(obj, [candidate('shell.mtl', MAX_OBJ_MATERIAL_BYTES + 1)]),
    /16 MB/i
  )
})

test('library textures match referenced basenames and enforce their own limit', () => {
  const texture = candidate('SHELL.PNG')
  assert.deepEqual(selectLibraryObjTextureFiles(['textures/shell.png'], [texture, candidate('other.png')]), [texture])
  assert.throws(
    () => selectLibraryObjTextureFiles(['shell.png'], [candidate('shell.png', MAX_OBJ_TEXTURE_BYTES + 1)]),
    /64 MB/i
  )
})
