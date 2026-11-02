/** Normal smoothing joins exact shared corners while retaining creases and nearby separate surfaces. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { meshWithCreasedNormals } from './meshCreasedNormals'

function assertNormal(actual: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, corner: number, expected: number[]): void {
  const normal = new THREE.Vector3().fromBufferAttribute(actual, corner)
  assert.ok(normal.distanceTo(new THREE.Vector3(...expected)) < 1e-6, `${normal.toArray()} matches ${expected}`)
}

for (const degrees of [30, 90]) {
  test(`shared corners ${degrees < 45 ? 'smooth a shallow join' : 'retain a sharp crease'}`, () => {
    const angle = THREE.MathUtils.degToRad(degrees)
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 0, -Math.cos(angle), Math.sin(angle), 1, 0, 0
    ])
    const source = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const result = meshWithCreasedNormals(source, Math.PI / 4)
    const normals = result.getAttribute('normal')
    const expectedAngle = degrees < 45 ? angle / 2 : 0
    assertNormal(normals, 0, [0, Math.sin(expectedAngle), Math.cos(expectedAngle)])
    assertNormal(normals, 2, [0, 0, 1])
    assertNormal(normals, 4, [0, Math.sin(angle), Math.cos(angle)])
    assert.deepEqual(result.getAttribute('position').array, positions)
    source.dispose()
    result.dispose()
  })
}

test('nearby tiny surfaces do not share shading normals', () => {
  const source = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 0.001, 0, 0, 0, 0.001, 0,
    0.00001, 0, 0.00001, 0.00101, 0, 0.00001, 0.00001, 0.001, 0.00051
  ], 3))
  const result = meshWithCreasedNormals(source, Math.PI / 4)
  const normals = result.getAttribute('normal')
  for (let corner = 0; corner < 3; corner += 1) assertNormal(normals, corner, [0, 0, 1])
  for (let corner = 3; corner < 6; corner += 1) assertNormal(normals, corner, [0, -1 / Math.sqrt(5), 2 / Math.sqrt(5)])
  source.dispose()
  result.dispose()
})
