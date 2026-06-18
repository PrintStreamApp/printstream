import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stageImport } from './import-store.js'
import type { ImportedMesh } from './mesh-import.js'

/** A trivial single-triangle mesh with the given bounds, for staging tests. */
function mesh(maxX: number): ImportedMesh {
  return {
    positions: [0, 0, 0, maxX, 0, 0, 0, maxX, 0],
    indices: [0, 1, 2],
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: maxX, y: maxX, z: 0 } }
  }
}

test('stageImport summarizes a single-solid import as one part named after the import', () => {
  const summary = stageImport({ tenantId: 't1', name: 'Widget', format: 'stl', mesh: mesh(10) })
  assert.equal(summary.parts.length, 1)
  assert.equal(summary.parts[0]?.name, 'Widget')
  assert.equal(summary.parts[0]?.triangleCount, 1)
  assert.equal(summary.triangleCount, 1)
})

test('stageImport summarizes a multi-solid import as one part per named solid', () => {
  const merged: ImportedMesh = {
    ...mesh(20),
    parts: [
      { name: 'Cylinder', mesh: mesh(10) },
      { name: 'Hole modifier 1', mesh: mesh(5) }
    ]
  }
  const summary = stageImport({ tenantId: 't1', name: 'CHM Cylinder', format: 'step', mesh: merged })
  assert.deepEqual(summary.parts.map((part) => part.name), ['Cylinder', 'Hole modifier 1'])
  assert.equal(summary.parts.length, 2)
})
