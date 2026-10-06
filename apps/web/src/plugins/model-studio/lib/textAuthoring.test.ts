import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import opentype from 'opentype.js'
import * as THREE from 'three'
import { createAddedTextPart, standaloneTextSoup, textInfoForTool, updateAddedTextPart } from './textAuthoring'
import type { TextToolValue } from './textToolValue'

const face = { id: 'dejavu-sans', family: 'DejaVu Sans', bold: false, italic: false }
const value: TextToolValue = {
  text: 'A', family: 'Unavailable face', bold: false, italic: false,
  fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0,
  embeddedDepth: 0.5, surfaceMode: 'surface', operation: 'normal_part'
}

test('hosted text records the resolved face and pointed surface', () => {
  const record = textInfoForTool(value, face, {
    standalone: false,
    hit: { point: { x: 4, y: 5, z: 6 }, normal: { x: 0, y: 1, z: 0 } }
  })
  assert.equal(record.fontName, face.family)
  assert.equal(record.fontIndex, 0)
  assert.equal(record.surfaceType, 'surface')
  assert.deepEqual(record.hitPosition, [4, 5, 6])
  assert.deepEqual(record.hitNormal, [0, 1, 0])
})

test('standalone text uses a horizontal record and sits on the bed', async () => {
  const record = textInfoForTool(value, face, { standalone: true })
  assert.equal(record.surfaceType, 'horizontal')
  assert.deepEqual(record.hitPosition, [0, 0, 0])
  assert.deepEqual(record.hitNormal, [0, 0, 1])

  const fontPath = path.resolve(import.meta.dirname, '../../../../public/fonts/text-tool/dejavu-sans.ttf')
  const bytes = await readFile(fontPath)
  const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const soup = standaloneTextSoup(font, value)
  assert.ok(soup.length > 0)
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 2; i < soup.length; i += 3) {
    minZ = Math.min(minZ, soup[i]!)
    maxZ = Math.max(maxZ, soup[i]!)
  }
  assert.ok(Math.abs(minZ) < 1e-6)
  assert.ok(Math.abs(maxZ - value.thickness) < 1e-6)
})

test('live text keeps saved placement until a pointed drag supplies a new one', () => {
  const record = textInfoForTool(value, face, { standalone: false })
  const placement = {
    position: new THREE.Vector3(1, 2, 3),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array([1, 2, 3])
  }
  const kept = {
    position: new THREE.Vector3(10, 20, 30),
    rotation: new THREE.Euler(0.2, 0.3, 0.4),
    scale: new THREE.Vector3(2, 3, 4)
  }
  const part = createAddedTextPart({
    key: 'text-part', importId: 'first', placement, keptPlacement: kept,
    value, textInfo: record, filamentId: 7
  })
  assert.deepEqual(part.position.toArray(), [10, 20, 30])
  assert.deepEqual([part.rotation.x, part.rotation.y, part.rotation.z], [0.2, 0.3, 0.4])
  assert.deepEqual(part.scale.toArray(), [2, 3, 4])
  assert.equal(part.filamentId, 7)

  updateAddedTextPart({
    part, importId: 'second', placement, value: { ...value, text: 'Edited' },
    textInfo: record, pointed: false
  })
  assert.equal(part.importId, 'second')
  assert.equal(part.name, 'Edited')
  assert.deepEqual(part.position.toArray(), [10, 20, 30])

  updateAddedTextPart({ part, importId: 'third', placement, value, textInfo: record, pointed: true })
  assert.deepEqual(part.position.toArray(), [1, 2, 3])
  assert.deepEqual(part.scale.toArray(), [1, 1, 1])

  const cut = createAddedTextPart({
    key: 'cut', importId: 'cut-mesh', placement, keptPlacement: null,
    value: { ...value, operation: 'negative_part' }, textInfo: record, filamentId: 7
  })
  assert.equal(Object.hasOwn(cut, 'filamentId'), false)
})
