import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePaintTree } from './triangle-paint-codec.js'
import {
  buildImportedColorPaint,
  quantizeTriangleCornerColors,
  smoothQuantizedTextureColors
} from './source-color-paint.js'

test('source colours cluster deterministically and leave transparent corners undefined', () => {
  const rgba = [
    1, 0, 0, 1, 0.95, 0, 0, 1, 0, 0, 1, 1,
    0, 0, 0, 0
  ]
  const first = quantizeTriangleCornerColors(rgba, 2)
  const second = quantizeTriangleCornerColors(rgba, 2)
  assert.deepEqual(first, second)
  assert.equal(first.clusters.length, 2)
  assert.deepEqual(first.clusters.map((cluster) => cluster.count), [2, 1])
  assert.equal(first.labels[0], first.labels[1])
  assert.equal(first.labels[3], -1)
})

test('source colour quantization validates its bounded wire inputs', () => {
  assert.throws(() => quantizeTriangleCornerColors([1, 0, 0], 2), /RGBA/)
  assert.throws(() => quantizeTriangleCornerColors([1, 0, 0, 1], 33), /between 1 and 32/)
})

test('texture smoothing removes a face island while level zero preserves it', () => {
  const mesh = { indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3] }
  const quantized = {
    clusters: [
      { color: [1, 0, 0] as [number, number, number], count: 3 },
      { color: [0, 0, 1] as [number, number, number], count: 9 }
    ],
    labels: [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  }

  assert.equal(smoothQuantizedTextureColors(mesh, quantized, 0), quantized)
  assert.deepEqual(smoothQuantizedTextureColors(mesh, quantized, 1), {
    clusters: [{ color: [0, 0, 1], count: 12 }],
    labels: new Array(12).fill(0)
  })
})

test('paint authoring emits whole, two-colour, and three-colour Bambu trees', () => {
  const mesh = {
    positions: [0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0],
    indices: [0, 1, 2, 3, 4, 5, 6, 7, 8]
  }
  const paint = buildImportedColorPaint(mesh, [0, 0, 0, 0, 1, 1, 0, 1, 2], [2, 3, 4], 1)
  assert.deepEqual(decodePaintTree(paint[0]!), { kind: 'leaf', state: 2 })
  assert.deepEqual(decodePaintTree(paint[1]!), {
    kind: 'split', splits: 2, special: 0, children: [
      { kind: 'leaf', state: 2 }, { kind: 'leaf', state: 3 }, { kind: 'leaf', state: 3 }
    ]
  })
  assert.equal((decodePaintTree(paint[2]!) as { kind: string; splits: number }).splits, 3)
})

test('paint authoring omits triangles that resolve entirely to the base filament', () => {
  const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }
  assert.deepEqual(buildImportedColorPaint(mesh, [-1, -1, -1], [], 1), {})
})
