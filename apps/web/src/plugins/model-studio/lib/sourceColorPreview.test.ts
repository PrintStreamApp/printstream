/** Pure preview-buffer coverage keeps the WebGL component itself free of data-shape policy. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildQuantizedPreviewColors, buildSourceColorPreviewGeometry } from './sourceColorPreview'

test('source preview expands indexed geometry into triangle-corner order', () => {
  const preview = buildSourceColorPreviewGeometry({
    positions: [0, 0, 0, 2, 0, 0, 0, 3, 0],
    indices: [2, 0, 1]
  }, new Float32Array([
    1, 0, 0, 1,
    0, 1, 0, 0,
    0, 0, 1, 1
  ]))

  assert.deepEqual([...preview.positions], [0, 3, 0, 0, 0, 0, 2, 0, 0])
  assert.deepEqual([...preview.originalColors], [1, 0, 0, ...new Array(3).fill(Math.fround(0.55)), 0, 0, 1])
})

test('quantized preview maps cluster labels and leaves inherited corners neutral', () => {
  assert.deepEqual([...buildQuantizedPreviewColors(3, {
    clusters: [{ color: [0.25, 0.5, 0.75], count: 2 }],
    labels: [0, -1, 0]
  })], [0.25, 0.5, 0.75, ...new Array(3).fill(Math.fround(0.55)), 0.25, 0.5, 0.75])
})

test('source preview refuses mismatched sidecars and invalid indices', () => {
  assert.throws(
    () => buildSourceColorPreviewGeometry({ positions: [0, 0, 0], indices: [0] }, []),
    /do not match/
  )
  assert.throws(
    () => buildSourceColorPreviewGeometry({ positions: [0, 0, 0], indices: [1] }, [1, 0, 0, 1]),
    /invalid vertex index/
  )
})
