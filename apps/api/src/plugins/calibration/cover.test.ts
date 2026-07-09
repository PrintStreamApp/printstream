import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PNG } from 'pngjs'
import { renderCalibrationCover } from './cover.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('renderCalibrationCover produces a 512x512 PNG per kind', () => {
  for (const kind of ['pressureAdvance', 'flowRatio'] as const) {
    const png = renderCalibrationCover(kind)
    assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), `${kind} cover is a PNG`)
    const decoded = PNG.sync.read(png)
    assert.equal(decoded.width, 512)
    assert.equal(decoded.height, 512)
  }
})

test('the two calibration kinds get visibly different covers', () => {
  assert.notEqual(
    renderCalibrationCover('pressureAdvance').toString('base64'),
    renderCalibrationCover('flowRatio').toString('base64')
  )
})

test('covers are cached (same buffer instance on repeat)', () => {
  assert.equal(renderCalibrationCover('pressureAdvance'), renderCalibrationCover('pressureAdvance'))
})
