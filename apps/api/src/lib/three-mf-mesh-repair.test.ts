import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repairModelEntryMeshes, repairObjectMeshesInModelEntry, repairSingleMeshXml } from './three-mf-mesh-repair.js'

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

/** Two objects in one entry: object 5 is cracked, object 6 is clean and must not be touched. */
function twoObjectEntryXml(): string {
  return [
    '<model>',
    ' <resources>',
    '  <object id="5" type="model">',
    '   <mesh>',
    '    <vertices>',
    '     <vertex x="0" y="0" z="0"/>',
    '     <vertex x="10" y="0" z="0"/>',
    '     <vertex x="0" y="10" z="0"/>',
    '     <vertex x="10.00001" y="0" z="0"/>',
    '    </vertices>',
    '    <triangles>',
    '     <triangle v1="0" v2="1" v3="2" paint_color="9"/>',
    '     <triangle v1="0" v2="3" v3="2"/>',
    '    </triangles>',
    '   </mesh>',
    '  </object>',
    '  <object id="6" type="model">',
    '   <mesh>',
    '    <vertices>',
    '     <vertex x="0" y="0" z="0"/>',
    '     <vertex x="1" y="0" z="0"/>',
    '     <vertex x="0" y="1" z="0"/>',
    '    </vertices>',
    '    <triangles>',
    '     <triangle v1="0" v2="1" v3="2"/>',
    '    </triangles>',
    '   </mesh>',
    '  </object>',
    ' </resources>',
    '</model>'
  ].join('\n')
}

test('repairObjectMeshesInModelEntry repairs only the named objects and preserves paint', () => {
  const result = repairObjectMeshesInModelEntry(twoObjectEntryXml(), new Set([5]))
  assert.ok(result, 'object 5 is cracked so the entry should be rewritten')
  // Vertex 3 welded onto vertex 1; the second triangle became a duplicate of the first and dropped.
  assert.equal(result.stats.weldedVertices, 1)
  assert.equal(result.stats.duplicateTrianglesRemoved, 1)
  // Paint on the surviving triangle rides through the repair — the property that lets repair run
  // in place on a painted object instead of replacing its geometry.
  assert.match(result.xml, /paint_color="9"/)
  // Object 6 was not named and must be byte-identical.
  assert.match(result.xml, /<object id="6" type="model">\n {3}<mesh>\n {4}<vertices>\n {5}<vertex x="0" y="0" z="0"\/>/)
})

test('repairObjectMeshesInModelEntry is a no-op (null) when the named object is already clean', () => {
  assert.equal(repairObjectMeshesInModelEntry(twoObjectEntryXml(), new Set([6])), null)
  assert.equal(repairObjectMeshesInModelEntry(twoObjectEntryXml(), new Set([999])), null)
})
