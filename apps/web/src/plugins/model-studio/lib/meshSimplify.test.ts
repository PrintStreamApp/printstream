import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandSimplifiedMesh,
  indexPaintedTriangleSoup,
  simplifyTriangleSoup,
  simplifyTargetTriangleCount
} from './meshSimplify'

test('decimate ratio matches BambuStudio reduction semantics', () => {
  assert.equal(simplifyTargetTriangleCount(1_000, 0), 1_000)
  assert.equal(simplifyTargetTriangleCount(1_000, 50), 500)
  assert.equal(simplifyTargetTriangleCount(1_000, 100), 4)
})

test('painted triangles retain connected topology across a paint boundary', () => {
  const soup = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    1, 0, 0, 1, 1, 0, 0, 1, 0
  ])
  const indexed = indexPaintedTriangleSoup(soup, { supports: { 1: '4' } })
  assert.equal(indexed.positions.length / 3, 4, 'paint does not split the shared edge')
})

test('expanded simplification carries all four paint channels', () => {
  const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indexed = indexPaintedTriangleSoup(soup, {
    supports: { 0: '4' },
    seam: { 0: '8' },
    color: { 0: '0C' },
    fuzzy: { 0: '4' }
  })
  const result = expandSimplifiedMesh(indexed, indexed.indices, 0)
  assert.deepEqual(result.paint, {
    supports: { 0: '4' },
    seam: { 0: '8' },
    color: { 0: '0C' },
    fuzzy: { 0: '4' }
  })
})

test('decimation executes the meshoptimizer path and reaches the requested count', async () => {
  const vertices = [
    -1, -1, -1,
    1, -1, -1,
    1, 1, -1,
    -1, 1, -1,
    -1, -1, 1,
    1, -1, 1,
    1, 1, 1,
    -1, 1, 1
  ]
  const faces = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7
  ]
  const soup = new Float32Array(faces.flatMap((vertex) => vertices.slice(vertex * 3, vertex * 3 + 3)))
  const result = await simplifyTriangleSoup(soup, {}, {
    mode: 'ratio',
    detail: 'medium',
    ratio: 50
  })

  assert.equal(result.triangleCount, 6)
  assert.equal(result.soup.length, 54)
})

test('extreme decimation keeps a printable painted result', async () => {
  const vertices = [
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1
  ]
  const faces = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7
  ]
  const soup = new Float32Array(faces.flatMap((vertex) => vertices.slice(vertex * 3, vertex * 3 + 3)))
  const paint = { color: Object.fromEntries(Array.from({ length: 12 }, (_, triangle) => [triangle, String(triangle + 1)])) }
  const result = await simplifyTriangleSoup(soup, paint, { mode: 'ratio', detail: 'medium', ratio: 100 })

  assert.ok(result.triangleCount >= 4)
  assert.ok(result.triangleCount < 12, 'painted geometry still simplifies')
  assert.equal(Object.keys(result.paint.color ?? {}).length, result.triangleCount)
})
