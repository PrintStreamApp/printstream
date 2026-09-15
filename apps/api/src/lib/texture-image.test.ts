import assert from 'node:assert/strict'
import test from 'node:test'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { decodeTextureImage } from './texture-image.js'

test('server texture decoding returns RGBA pixels for PNG and JPEG', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255])
  const sourcePng = new PNG({ width: 2, height: 1 })
  sourcePng.data = rgba
  const png = PNG.sync.write(sourcePng)
  const decodedPng = decodeTextureImage('palette.PNG', png)
  assert.deepEqual(decodedPng, { width: 2, height: 1, rgba: Uint8Array.from(rgba) })

  const jpg = jpeg.encode({ width: 2, height: 1, data: rgba }, 100).data
  const decodedJpeg = decodeTextureImage('palette.jpeg', jpg)
  assert.equal(decodedJpeg.width, 2)
  assert.equal(decodedJpeg.height, 1)
  assert.equal(decodedJpeg.rgba.length, 8)
})

test('unsupported and malformed texture resources are classified import errors', () => {
  assert.throws(() => decodeTextureImage('palette.webp', Uint8Array.of()), /must be PNG or JPEG/)
  assert.throws(() => decodeTextureImage('palette.png', Uint8Array.of()), /not a readable PNG/)
})
