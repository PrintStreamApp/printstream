import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repairModelEntryMeshes, repairSingleMeshXml } from './three-mf-mesh-repair.js'

/**
 * A small tetra-ish mesh with three defects the repair targets:
 *  - vertex 4 is a sub-tolerance near-duplicate of vertex 1 (a "crack")
 *  - the second triangle is an exact duplicate of the first
 *  - the third triangle collapses to zero area once vertex 4 welds onto vertex 1
 * The fourth triangle is unique and paint-tagged, to prove attributes survive.
 */
function crackedMeshXml(): string {
  return [
    '  <object id="7" type="model">',
    '   <mesh>',
    '    <vertices>',
    '     <vertex x="0" y="0" z="0"/>',
    '     <vertex x="10" y="0" z="0"/>',
    '     <vertex x="0" y="10" z="0"/>',
    '     <vertex x="0" y="0" z="10"/>',
    '     <vertex x="10.00001" y="0" z="0"/>',
    '    </vertices>',
    '    <triangles>',
    '     <triangle v1="0" v2="1" v3="2"/>',
    '     <triangle v1="0" v2="1" v3="2"/>',
    '     <triangle v1="1" v2="4" v3="3"/>',
    '     <triangle v1="0" v2="2" v3="3" mmu_segmentation="8"/>',
    '    </triangles>',
    '   </mesh>',
    '  </object>'
  ].join('\n')
}

test('repairSingleMeshXml welds near-duplicate vertices and drops degenerate + duplicate triangles', () => {
  const meshXml = /<mesh>[\s\S]*<\/mesh>/.exec(crackedMeshXml())![0]
  const result = repairSingleMeshXml(meshXml)
  assert.ok(result, 'cracked mesh should be repaired')
  assert.deepEqual(result.stats, {
    weldedVertices: 1,
    degenerateTrianglesRemoved: 1,
    duplicateTrianglesRemoved: 1
  })
  // The near-duplicate corner is gone: 4 canonical vertices, 2 surviving triangles.
  assert.equal((result.xml.match(/<vertex /g) ?? []).length, 4)
  assert.equal((result.xml.match(/<triangle /g) ?? []).length, 2)
  // Paint attribute on the surviving unique triangle is preserved.
  assert.match(result.xml, /mmu_segmentation="8"/)
})

test('repairSingleMeshXml is a no-op (null) on an already-clean mesh', () => {
  const clean = [
    '<mesh>',
    ' <vertices>',
    '  <vertex x="0" y="0" z="0"/>',
    '  <vertex x="10" y="0" z="0"/>',
    '  <vertex x="0" y="10" z="0"/>',
    ' </vertices>',
    ' <triangles>',
    '  <triangle v1="0" v2="1" v3="2"/>',
    ' </triangles>',
    '</mesh>'
  ].join('\n')
  assert.equal(repairSingleMeshXml(clean), null)
})

test('repairSingleMeshXml leaves a non-conforming mesh untouched (null)', () => {
  // Missing <triangles> block — not a serialization we understand.
  const weird = '<mesh><vertices><vertex x="0" y="0" z="0"/></vertices></mesh>'
  assert.equal(repairSingleMeshXml(weird), null)
})

test('repairModelEntryMeshes aggregates across meshes and reports combined stats', () => {
  const result = repairModelEntryMeshes(crackedMeshXml())
  assert.ok(result)
  assert.equal(result.stats.weldedVertices, 1)
  assert.equal(result.stats.degenerateTrianglesRemoved, 1)
  assert.equal(result.stats.duplicateTrianglesRemoved, 1)
})
