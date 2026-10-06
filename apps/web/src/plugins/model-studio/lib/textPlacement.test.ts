import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import opentype from 'opentype.js'
import * as THREE from 'three'
import { ADDED_PART_MESH_NAME } from '../editorGeometry'
import { buildTextPlacement, textAnchorForEdit } from './textPlacement'
import type { TextToolValue } from './textToolValue'

const fontPath = path.resolve(import.meta.dirname, '../../../../public/fonts/text-tool/dejavu-sans.ttf')
const face = { id: 'dejavu-sans', family: 'DejaVu Sans', bold: false, italic: false }
const tool: TextToolValue = {
  text: 'A', family: face.family, bold: false, italic: false, fontSize: 5,
  thickness: 2, textGap: 0, rotateAngle: 0, embeddedDepth: 0,
  surfaceMode: 'horizontal', operation: 'normal_part'
}

async function font() {
  const bytes = await readFile(fontPath)
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

test('text re-editing keeps the pointed, added, or saved part anchor', () => {
  const group = new THREE.Group()
  group.position.set(10, 20, 0)
  const rotor = new THREE.Group()
  rotor.position.set(1, 2, 3)
  group.userData.rotor = rotor
  group.add(rotor)
  const added = new THREE.Object3D()
  added.userData.addedPartKey = 'text-part'
  added.position.set(4, 5, 6)
  rotor.add(added)
  const baked = new THREE.Object3D()
  baked.userData.partRef = { partIndex: 2 }
  baked.position.set(7, 8, 9)
  rotor.add(baked)

  const pointed = new THREE.Vector3(100, 101, 102)
  const fromPointer = textAnchorForEdit(group, pointed, 'text-part', 2)
  assert.deepEqual(fromPointer?.toArray(), [100, 101, 102])
  assert.notEqual(fromPointer, pointed)
  assert.deepEqual(textAnchorForEdit(group, null, 'text-part', 2)?.toArray(), [15, 27, 9])
  assert.deepEqual(textAnchorForEdit(group, null, 'missing', 2)?.toArray(), [18, 30, 12])
  assert.equal(textAnchorForEdit(group, null, 'missing', 3), null)
})

test('text lands on the host and ignores its previously added text mesh', async () => {
  const group = new THREE.Group()
  group.position.set(8, 3, 0)
  group.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })))

  const first = buildTextPlacement(group, tool, face, await font())
  assert.ok(first)
  assert.ok(first.soup.length > 0)
  assert.ok(Math.abs(first.position.z - 2) < 1e-6)

  const previousText = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  previousText.name = ADDED_PART_MESH_NAME
  previousText.position.z = 8
  group.add(previousText)

  const rebuilt = buildTextPlacement(group, tool, face, await font())
  assert.ok(rebuilt)
  assert.ok(Math.abs(rebuilt.position.z - first.position.z) < 1e-6)
})

test('dragging re-seats text on the host after its anchor leaves the surface', async () => {
  const group = new THREE.Group()
  group.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })))
  const placement = buildTextPlacement(
    group, tool, face, await font(), new THREE.Vector3(7, 0, 0), new THREE.Vector3(1, 0, 0)
  )
  assert.ok(placement)
  assert.ok(Math.abs(placement.position.x - 5) < 1e-6)
  assert.ok(Math.abs(placement.position.z - 1) < 1e-6)
})
