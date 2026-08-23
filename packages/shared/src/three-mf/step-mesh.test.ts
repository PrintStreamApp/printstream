/**
 * The STEP fold both hosts share.
 *
 * The WASM tessellator is not exercised here, it is the same upstream build on both sides, and
 * running it would make this a 7 MB integration test. What IS worth pinning is everything we decide
 * after OCCT answers: the quality settings it is asked for, how per-solid output becomes one import,
 * and the refusals. Those are the parts that could drift between the api and the browser, which is
 * exactly why they were hoisted out of `apps/api/src/lib/mesh-import.ts`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { STEP_TESSELLATION, stepMeshFromOcctResult, type OcctReadResult } from './step-mesh.js'

/** A unit triangle, as OCCT hands one back. */
function solid(name: string, offsetX = 0): OcctReadResult['meshes'][number] {
  return {
    name,
    attributes: { position: { array: [offsetX, 0, 0, offsetX + 1, 0, 0, offsetX, 1, 0] } },
    index: { array: [0, 1, 2] }
  }
}

test('the tessellation quality is BambuStudio\'s, in absolute millimetres', () => {
  // Not occt's own default (a 0.001 bounding-box RATIO), which visibly facets curved surfaces.
  // These four values are what make an import match the same file opened in BambuStudio.
  assert.equal(STEP_TESSELLATION.linearUnit, 'millimeter')
  assert.equal(STEP_TESSELLATION.linearDeflectionType, 'absolute_value')
  assert.equal(STEP_TESSELLATION.linearDeflection, 0.003)
  assert.equal(STEP_TESSELLATION.angularDeflection, 0.5)
})

test('a single-solid STEP folds to a bare mesh, with no parts list', () => {
  const mesh = stepMeshFromOcctResult({ success: true, meshes: [solid('Body')] })
  assert.equal(mesh.indices.length / 3, 1)
  // A lone solid must NOT carry a parts list: the editor treats a parts list as an assembly.
  assert.equal(mesh.parts, undefined)
})

test('a multi-solid STEP keeps each solid as a named part AND merges them', () => {
  const mesh = stepMeshFromOcctResult({ success: true, meshes: [solid('Bracket'), solid('Pin', 10)] })
  assert.deepEqual(mesh.parts?.map((part) => part.name), ['Bracket', 'Pin'])
  // The merged mesh is what bounds, triangle count, and the single-mesh render path read.
  assert.equal(mesh.indices.length / 3, 2)
  assert.equal(mesh.bounds.max.x, 11)
})

test('an unnamed solid still gets a stable positional name', () => {
  const unnamed = { ...solid(''), name: undefined }
  const mesh = stepMeshFromOcctResult({ success: true, meshes: [unnamed, solid('  ', 10)] })
  assert.deepEqual(mesh.parts?.map((part) => part.name), ['Part 1', 'Part 2'])
})

test('a failed or empty read is refused rather than yielding an empty import', () => {
  assert.throws(() => stepMeshFromOcctResult({ success: false, meshes: [solid('Body')] }), /could not be tessellated/)
  assert.throws(() => stepMeshFromOcctResult({ success: true, meshes: [] }), /could not be tessellated/)
  // Succeeded, but every solid was degenerate: distinct message, because the file DID read.
  const degenerate = { ...solid('Body'), index: { array: [] } }
  assert.throws(() => stepMeshFromOcctResult({ success: true, meshes: [degenerate] }), /produced no geometry/)
})

test('typed arrays from the WASM heap are accepted, not just plain arrays', () => {
  // occt-import-js hands back views onto the WASM heap; copying them into JS arrays is this
  // module's job. Reading them as arrays without converting silently produced empty geometry.
  const mesh = stepMeshFromOcctResult({
    success: true,
    meshes: [{
      name: 'Body',
      attributes: { position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) } },
      index: { array: new Uint32Array([0, 1, 2]) }
    }]
  })
  assert.equal(mesh.indices.length / 3, 1)
  assert.equal(mesh.positions.length, 9)
})
