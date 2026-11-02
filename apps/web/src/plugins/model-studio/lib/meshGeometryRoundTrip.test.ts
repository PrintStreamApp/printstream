/** Save/reopen must preserve source corners, face order, paint, placement, and shading at any scale. */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import * as THREE from 'three'
import { unzipSync, strFromU8 } from 'fflate'
import {
  computeMeshBounds, meshToBinaryStl, parseStlMesh, type ImportedMesh
} from '@printstream/shared/three-mf'
import type { SceneEdit } from '@printstream/shared'
import { installJsdomGlobals } from '../../../test-utils/jsdom'
import { bakeClientThreeMf } from './clientThreeMfBake'
import { buildStlGeometry, buildThreeMfGeometries } from './meshParseCore'
import { createThreeMfMatrix, parseThreeMfModelEntry } from './threeMfScene'

const dom = installJsdomGlobals()
;(globalThis as { DOMParser?: typeof DOMParser }).DOMParser = dom.window.DOMParser
after(() => { dom.window.close() })

function ringMesh(radius: number): ImportedMesh {
  const ring = new THREE.TorusGeometry(radius, radius / 4, 12, 48)
  const positions = Array.from(ring.getAttribute('position').array)
  const mesh = { positions, indices: Array.from(ring.index!.array), bounds: computeMeshBounds(positions) }
  ring.dispose()
  // The editor receives an STL's float32 bytes, not Three's original indexed buffers.
  return parseStlMesh(meshToBinaryStl(mesh))
}

for (const { radius, scale } of [{ radius: 0.15, scale: 770 }, { radius: 15, scale: 1 }, { radius: 1.5e-4, scale: 770_000 }]) {
  test(`STL save/reopen preserves geometry and shading at scale ${scale}`, async () => {
    const mesh = ringMesh(radius)
    const before = buildStlGeometry(meshToBinaryStl(mesh).buffer as ArrayBuffer)
    const edit: SceneEdit = {
      plates: [{ index: 1 }],
      instances: [{ importId: 'ring', plateIndex: 1, position: { x: 175, y: 175, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: scale, y: scale, z: scale }, filamentId: 1 }],
      importPaint: [{ importId: 'ring', partIndex: 0, channel: 'support', triangles: { 0: '4', 7: '8' } }]
    }
    const { bytes, result } = await bakeClientThreeMf(null, edit, [{ importId: 'ring', name: 'Tiny curved ring', mesh }])
    const objectId = result.importObjectIds[0]!.objectId
    const rootXml = strFromU8(unzipSync(bytes)['3D/3dmodel.model']!)
    const item = new RegExp(`<item\\b[^>]*objectid="${objectId}"[^>]*>`).exec(rootXml)?.[0]
    assert.ok(item, 'the saved build places the imported object')
    const transform = /transform="([^"]+)"/.exec(item)?.[1]
    assert.ok(transform)
    const savedMatrix = createThreeMfMatrix(transform.split(/\s+/).map(Number))
    // Apply the live group's one composed matrix, avoiding an extra float32
    // quantization between a geometry.scale() and geometry.translate().
    const expectedMatrix = new THREE.Matrix4().makeScale(scale, scale, scale).setPosition(175, 175, 0)
    const expectedWorld = before.clone().applyMatrix4(expectedMatrix)
    for (const [label, parse] of [['worker', buildThreeMfGeometries], ['DOM fallback', parseThreeMfModelEntry]] as const) {
      const reopened = parse(rootXml).get(objectId)!
      assert.ok(reopened, label)
      assert.deepEqual(reopened.getAttribute('position').array, before.getAttribute('position').array, `${label}: every corner and triangle survives`)
      assert.deepEqual(reopened.getAttribute('normal').array, before.getAttribute('normal').array, `${label}: shading survives`)
      assert.deepEqual(reopened.userData.supportPaint, { 0: '4', 7: '8' }, `${label}: paint remains attached to its original faces`)
      reopened.applyMatrix4(savedMatrix)
      assert.deepEqual(reopened.getAttribute('position').array, expectedWorld.getAttribute('position').array, `${label}: scaled placement survives`)
      reopened.dispose()
    }
    expectedWorld.dispose()
    before.dispose()
  })
}

test('3MF loading never collapses distinct sub-0.05mm corners', () => {
  const xml = '<model><resources><object id="1"><mesh><vertices>'
    + '<vertex x="0" y="0" z="0"/><vertex x="0.01" y="0" z="0"/><vertex x="0" y="0.01" z="0"/>'
    + '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>'
  for (const parse of [buildThreeMfGeometries, parseThreeMfModelEntry]) {
    const geometry = parse(xml).get(1)!
    assert.deepEqual(geometry.getAttribute('position').array, new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]))
    geometry.dispose()
  }
})
