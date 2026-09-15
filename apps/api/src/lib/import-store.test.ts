import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSceneEditImports, stageImport } from './import-store.js'
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
  const summary = stageImport({ workspaceId: 't1', name: 'Widget', format: 'stl', mesh: mesh(10), normalize: 'object' })
  assert.equal(summary.parts.length, 1)
  assert.equal(summary.parts[0]?.name, 'Widget')
  assert.equal(summary.parts[0]?.triangleCount, 1)
  assert.equal(summary.triangleCount, 1)
})

test('stageImport reports retained source vertex colours without putting them in the summary', () => {
  const coloured = { ...mesh(10), triangleCornerColors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1] }
  const summary = stageImport({ workspaceId: 't1', name: 'Coloured', format: 'obj', mesh: coloured, normalize: 'object' })
  assert.equal(summary.sourceColorMode, 'vertex')
  assert.equal('triangleCornerColors' in summary, false, 'large per-corner data stays in the staged record')
})

test('stageImport summarizes a multi-solid import as one part per named solid', () => {
  const merged: ImportedMesh = {
    ...mesh(20),
    parts: [
      { name: 'Cylinder', mesh: mesh(10) },
      { name: 'Hole modifier 1', mesh: mesh(5) }
    ]
  }
  const summary = stageImport({ workspaceId: 't1', name: 'CHM Cylinder', format: 'step', mesh: merged, normalize: 'object' })
  assert.deepEqual(summary.parts.map((part) => part.name), ['Cylinder', 'Hole modifier 1'])
  assert.equal(summary.parts.length, 2)
})

// The store normalises a whole OBJECT to the editor's pivot convention (XY centre on the origin,
// lowest point at z = 0) so its `position` places its own centre and the rotate gizmo pivots there
// rather than at whatever point the file's exporter chose.
test('stageImport rebases an object import to the editor pivot', () => {
  const summary = stageImport({ workspaceId: 't1', name: 'Widget', format: 'stl', mesh: mesh(10), normalize: 'object' })
  assert.deepEqual(summary.bounds.min, { x: -5, y: -5, z: 0 })
  assert.deepEqual(summary.bounds.max, { x: 5, y: 5, z: 0 })
})

// And must NOT touch a PART. An added part is centred on every axis by `primitivePartSoup` and then
// placed by that single point inside its host (`addedPartDropPosition` drops a helper volume at the
// host's centre), so flooring its Z would bury it half its own height above where the user put it,
// invisibly, since a helper volume is translucent and never prints. Both shapes go through this one
// entry point and nothing about the bytes tells them apart, which is why the caller states it.
test('stageImport leaves a part import exactly as staged', () => {
  const summary = stageImport({ workspaceId: 't1', name: 'Blocker', format: 'stl', mesh: mesh(10), normalize: 'part' })
  assert.deepEqual(summary.bounds.min, { x: 0, y: 0, z: 0 })
  assert.deepEqual(summary.bounds.max, { x: 10, y: 10, z: 0 })
})

test('part mesh replacements resolve both their host and replacement imports', () => {
  const workspaceId = 'part-replacement'
  const host = stageImport({ workspaceId, name: 'Assembly', format: 'stl', mesh: mesh(10), normalize: 'object' })
  const replacement = stageImport({ workspaceId, name: 'Simplified', format: 'stl', mesh: mesh(5), normalize: 'part' })
  const imports = resolveSceneEditImports(workspaceId, {
    plates: [{ index: 1 }],
    instances: [{
      importId: host.importId,
      plateIndex: 1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      filamentId: null
    }],
    importPartMeshReplacements: [{
      importId: host.importId,
      partIndex: 0,
      meshImportId: replacement.importId
    }]
  })

  assert.deepEqual(new Set(imports.map((entry) => entry.importId)), new Set([host.importId, replacement.importId]))
})
