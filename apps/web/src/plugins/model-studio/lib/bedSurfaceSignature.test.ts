import test from 'node:test'
import assert from 'node:assert/strict'
import { bedSurfaceSignature, type BedSurfaceSignatureInput } from './bedSurfaceSignature'

const A1_BED: BedSurfaceSignatureInput = {
  width: 256,
  depth: 256,
  centerX: 128,
  centerY: 128,
  excludeAreas: [],
  bedModel: { uuid: 'a1-plate-mesh' }
}

const H2D_BED: BedSurfaceSignatureInput = {
  width: 350,
  depth: 320,
  centerX: 175,
  centerY: 160,
  excludeAreas: [{ polygon: [{ x: 0, y: 0 }, { x: 30, y: 0 }], label: 'Left nozzle only area' }],
  bedModel: { uuid: 'h2d-plate-mesh' }
}

test('the same bed reads as unchanged', () => {
  assert.equal(bedSurfaceSignature(A1_BED), bedSurfaceSignature({ ...A1_BED }))
})

// The regression: an A1 -> H2D switch resizes the grid AND swaps the plate mesh, but the mesh
// arrives from its own fetch, so the two land on different renders. The build that sees the new
// dimensions with the OLD mesh must not latch a signature the build carrying the new mesh matches.
test('a new plate mesh at the same dimensions is stale', () => {
  const withOldMesh = bedSurfaceSignature({ ...H2D_BED, bedModel: A1_BED.bedModel })
  assert.notEqual(withOldMesh, bedSurfaceSignature(H2D_BED))
})

test('gaining or losing the plate mesh is stale', () => {
  assert.notEqual(bedSurfaceSignature(A1_BED), bedSurfaceSignature({ ...A1_BED, bedModel: null }))
})

test('a printer switch that resizes the bed is stale', () => {
  assert.notEqual(bedSurfaceSignature(A1_BED), bedSurfaceSignature(H2D_BED))
})

test('a bed that moves without resizing is stale', () => {
  assert.notEqual(bedSurfaceSignature(A1_BED), bedSurfaceSignature({ ...A1_BED, centerX: 0, centerY: 0 }))
})

test('a change to the unprintable zones is stale', () => {
  assert.notEqual(bedSurfaceSignature(H2D_BED), bedSurfaceSignature({ ...H2D_BED, excludeAreas: [] }))
})
