import assert from 'node:assert/strict'
import test from 'node:test'
import { sampleTexturePixel, sampleTexturedTriangles, type DecodedTextureImage } from './mesh-texture.js'

const image: DecodedTextureImage = {
  width: 2,
  height: 2,
  rgba: Uint8Array.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255
  ])
}

test('texture sampling is bilinear and repeat wrapped', () => {
  assert.deepEqual(sampleTexturePixel(image, 0, 0), [1, 0, 0, 1])
  assert.deepEqual(sampleTexturePixel(image, 1.5, -0.5), [0.5, 0.5, 0.5, 1])
})

test('texture sampling honours clamp and mirrored repeat wrapping', () => {
  assert.deepEqual(sampleTexturePixel(image, 1.5, 0, 'clamp'), [0, 1, 0, 1])
  assert.deepEqual(sampleTexturePixel(image, 1.5, 0, 'mirrored-repeat'), [0.5, 0.5, 0, 1])
})

test('low-poly texture sampling subdivides without changing bounds', () => {
  const mesh = sampleTexturedTriangles([{
    positions: [[0, 0, 0], [2, 0, 0], [0, 2, 0]],
    uvs: [[0, 0], [1, 0], [0, 1]],
    texture: image
  }])

  assert.equal(mesh.sourceColorMode, 'texture')
  assert.ok(mesh.indices.length / 3 >= 10_000)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 0 } })
  assert.equal(mesh.triangleCornerColors?.length, mesh.indices.length * 4)
})

test('texture conversion keeps printable colour opaque', () => {
  const transparentImage: DecodedTextureImage = {
    width: 1,
    height: 1,
    rgba: Uint8Array.from([25, 50, 75, 0])
  }
  const mesh = sampleTexturedTriangles([{
    positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    uvs: [[0, 0], [0, 0], [0, 0]],
    texture: transparentImage
  }], { targetTriangles: 1 })

  const colors = mesh.triangleCornerColors!
  assert.ok(Math.abs(colors[0]! - 25 / 255) < 1e-7)
  assert.ok(Math.abs(colors[1]! - 50 / 255) < 1e-7)
  assert.ok(Math.abs(colors[2]! - 75 / 255) < 1e-7)
  assert.deepEqual([colors[3], colors[7], colors[11]], [1, 1, 1])
})
