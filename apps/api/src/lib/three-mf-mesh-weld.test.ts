import assert from 'node:assert/strict'
import { test } from 'node:test'
import { weldModelEntryMeshes } from './three-mf-mesh-weld.js'

/** Two triangles sharing an edge, serialized as soup (6 vertices, 2 exact duplicates). */
function soupMeshXml(extraTriangleAttrs = ''): string {
  return [
    '  <object id="7" type="model">',
    '   <mesh>',
    '    <vertices>',
    '     <vertex x="0" y="0" z="0"/>',
    '     <vertex x="10" y="0" z="0"/>',
    '     <vertex x="0" y="10" z="0"/>',
    '     <vertex x="10" y="0" z="0"/>',
    '     <vertex x="10" y="10" z="0"/>',
    '     <vertex x="0" y="10" z="0"/>',
    '    </vertices>',
    '    <triangles>',
    '     <triangle v1="0" v2="1" v3="2"/>',
    `     <triangle v1="3" v2="4" v3="5"${extraTriangleAttrs}/>`,
    '    </triangles>',
    '   </mesh>',
    '  </object>'
  ].join('\n')
}

test('weldModelEntryMeshes shares duplicated vertices across triangles', () => {
  const welded = weldModelEntryMeshes(soupMeshXml())
  assert.ok(welded, 'soup mesh should be rewritten')
  const vertexCount = (welded.match(/<vertex /g) ?? []).length
  assert.equal(vertexCount, 4)
  assert.match(welded, /<triangle v1="0" v2="1" v3="2"\/>/)
  // Second triangle's duplicated corners now reference the shared vertices.
  assert.match(welded, /<triangle v1="1" v2="3" v3="2"\/>/)
})

test('weldModelEntryMeshes preserves non-index triangle attributes (paint codes)', () => {
  const welded = weldModelEntryMeshes(soupMeshXml(' paint_supports="4"'))
  assert.ok(welded)
  assert.match(welded, /<triangle v1="1" v2="3" v3="2" paint_supports="4"\/>/)
})

test('weldModelEntryMeshes drops triangles degenerate after welding', () => {
  const xml = [
    '<object id="1" type="model"><mesh>',
    '<vertices>',
    '<vertex x="0" y="0" z="0"/>',
    '<vertex x="0" y="0" z="0"/>',
    '<vertex x="1" y="0" z="0"/>',
    '<vertex x="0" y="1" z="0"/>',
    '</vertices>',
    '<triangles>',
    '<triangle v1="0" v2="1" v3="2"/>',
    '<triangle v1="0" v2="2" v3="3"/>',
    '</triangles>',
    '</mesh></object>'
  ].join('\n')
  const welded = weldModelEntryMeshes(xml)
  assert.ok(welded)
  assert.equal((welded.match(/<triangle /g) ?? []).length, 1)
  assert.match(welded, /<triangle v1="0" v2="1" v3="2"\/>/)
})

test('weldModelEntryMeshes returns null for an already-welded mesh', () => {
  const xml = [
    '<object id="1" type="model"><mesh>',
    '<vertices>',
    '<vertex x="0" y="0" z="0"/>',
    '<vertex x="1" y="0" z="0"/>',
    '<vertex x="0" y="1" z="0"/>',
    '</vertices>',
    '<triangles>',
    '<triangle v1="0" v2="1" v3="2"/>',
    '</triangles>',
    '</mesh></object>'
  ].join('\n')
  assert.equal(weldModelEntryMeshes(xml), null)
})

test('weldModelEntryMeshes welds only the soup mesh in a multi-object entry', () => {
  const weldedObject = [
    '<object id="2" type="model"><mesh>',
    '<vertices>',
    '<vertex x="5" y="5" z="5"/>',
    '<vertex x="6" y="5" z="5"/>',
    '<vertex x="5" y="6" z="5"/>',
    '</vertices>',
    '<triangles>',
    '<triangle v1="0" v2="1" v3="2"/>',
    '</triangles>',
    '</mesh></object>'
  ].join('\n')
  const xml = `${soupMeshXml()}\n${weldedObject}`
  const welded = weldModelEntryMeshes(xml)
  assert.ok(welded)
  // The already-welded object's mesh is untouched.
  assert.match(welded, /<vertex x="5" y="5" z="5"\/>/)
  assert.equal((welded.match(/<vertex /g) ?? []).length, 4 + 3)
})
