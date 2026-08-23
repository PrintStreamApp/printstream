/**
 * A component cycle is the one malformed shape that neither rejects nor degrades: BambuStudio's
 * component walk has no visited set (`bbs_3mf.cpp:4992-5016`), so it re-pushes the cycle forever and
 * dies of memory exhaustion with no message naming the project.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertAcyclicComponentGraph, findComponentCycle } from './component-graph'

const wrap = (objects: string) =>
  ['<?xml version="1.0" encoding="UTF-8"?>', '<model unit="millimeter">', ' <resources>', objects, ' </resources>', '</model>'].join('\n')

const meshObject = (id: number) => `  <object id="${id}" type="model"><mesh><vertices/><triangles/></mesh></object>`
const componentObject = (id: number, children: number[]) =>
  `  <object id="${id}" type="model"><components>${children
    .map((child) => `<component objectid="${child}"/>`)
    .join('')}</components></object>`

test('an ordinary assembly is a DAG', () => {
  assert.equal(findComponentCycle(wrap([meshObject(1), meshObject(2), componentObject(3, [1, 2])].join('\n'))), null)
})

test('a shared child reached twice is not a cycle', () => {
  // Two parents referencing one mesh is BambuStudio's own `m_share_mesh` layout. Reporting it would
  // fail every multi-instance project, so the DFS has to distinguish "seen" from "on the stack".
  const xml = wrap([meshObject(1), componentObject(2, [1]), componentObject(3, [1, 2])].join('\n'))
  assert.equal(findComponentCycle(xml), null)
})

test('an object containing itself is caught', () => {
  // The reachable shape: an added part whose mesh import IS its host import.
  assert.equal(findComponentCycle(wrap(componentObject(1, [1]))), '1 -> 1')
})

test('a two-object loop is caught', () => {
  // Assembled from two individually valid edits, which is why the schema cannot see it.
  const cycle = findComponentCycle(wrap([componentObject(1, [2]), componentObject(2, [1])].join('\n')))
  assert.equal(cycle, '1 -> 2 -> 1')
})

test('a cycle deeper in the graph is caught', () => {
  const xml = wrap([componentObject(1, [2]), componentObject(2, [3]), componentObject(3, [2])].join('\n'))
  assert.equal(findComponentCycle(xml), '2 -> 3 -> 2')
})

test('a cross-entry component is not treated as an edge in this id space', () => {
  // `p:path` addresses another entry, whose ids are a different space (`Id` is a (path, id) pair),
  // so counting it here would report a cycle between two unrelated objects.
  const xml = wrap(`  <object id="1" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1"/></components></object>`)
  assert.equal(findComponentCycle(xml), null)
})

test('a model with no components at all builds no graph', () => {
  assert.equal(findComponentCycle(wrap([meshObject(1), meshObject(2)].join('\n'))), null)
})

test('the assert names the loop and says what it would do', () => {
  assert.throws(() => assertAcyclicComponentGraph(wrap(componentObject(1, [1]))), /loop \(1 -> 1\).*hang/s)
  assert.doesNotThrow(() => assertAcyclicComponentGraph(wrap(meshObject(1))))
})
