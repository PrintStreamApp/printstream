import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installJsdomGlobals } from '../../../test-utils/jsdom'

/**
 * The worker parses 3MF mesh XML with a DOM-free regex parser (`meshParseCore`), while the
 * main-thread fallback uses the DOM parser (`threeMfScene`). They MUST produce identical geometry,
 * or the editor would render a 50MB object differently depending on whether the worker was used.
 * This pins that equivalence: same object ids, vertices, normals, and paint maps from both paths.
 */
function cubeObjectXml(id: number): string {
  const verts = [
    [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
    [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]
  ]
  const tris: Array<[number, number, number, string]> = [
    [0, 2, 1, ' paint_supports="4"'], [0, 3, 2, ' paint_seam="8"'], [4, 5, 6, ' paint_color="4"'], [4, 6, 7, ''],
    [0, 1, 5, ''], [0, 5, 4, ''], [2, 3, 7, ''], [2, 7, 6, ''],
    [0, 4, 7, ''], [0, 7, 3, ''], [1, 2, 6, ''], [1, 6, 5, '']
  ]
  return `<object id="${id}" type="model"><mesh><vertices>` +
    verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('') +
    `</vertices><triangles>` +
    tris.map(([a, b, c, paint]) => `<triangle v1="${a}" v2="${b}" v3="${c}"${paint}/>`).join('') +
    `</triangles></mesh></object>`
}

const SAMPLE_XML =
  `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter">` +
  `<resources>${cubeObjectXml(1)}${cubeObjectXml(2)}</resources>` +
  `<build><item objectid="1"/></build></model>`

function assertArraysClose(actual: ArrayLike<number> | undefined, expected: ArrayLike<number> | undefined, label: string) {
  assert.ok(actual && expected, `${label}: both present`)
  assert.equal(actual!.length, expected!.length, `${label}: length`)
  for (let i = 0; i < actual!.length; i += 1) {
    assert.ok(Math.abs(actual![i]! - expected![i]!) < 1e-4, `${label}: element ${i} (${actual![i]} vs ${expected![i]})`)
  }
}

test('meshParseCore produces the same geometry as the DOM parser', async () => {
  const dom = installJsdomGlobals()
  // installJsdomGlobals doesn't expose DOMParser; the threeMfScene DOM path needs it.
  ;(globalThis as { DOMParser?: typeof DOMParser }).DOMParser = dom.window.DOMParser
  const { buildThreeMfGeometries } = await import('./meshParseCore')
  const { parseThreeMfModelEntry } = await import('./threeMfScene')

  const fromWorkerCore = buildThreeMfGeometries(SAMPLE_XML)
  const fromDom = parseThreeMfModelEntry(SAMPLE_XML)

  assert.deepEqual([...fromWorkerCore.keys()].sort(), [1, 2], 'parses both objects by id')
  assert.deepEqual([...fromDom.keys()].sort(), [1, 2])

  for (const objectId of [1, 2]) {
    const core = fromWorkerCore.get(objectId)!
    const dom = fromDom.get(objectId)!
    assertArraysClose(core.getAttribute('position')?.array, dom.getAttribute('position')?.array, `obj ${objectId} position`)
    assertArraysClose(core.getAttribute('normal')?.array, dom.getAttribute('normal')?.array, `obj ${objectId} normal`)
    assert.deepEqual(core.userData.supportPaint, dom.userData.supportPaint, `obj ${objectId} supportPaint`)
    assert.deepEqual(core.userData.seamPaint, dom.userData.seamPaint, `obj ${objectId} seamPaint`)
    assert.deepEqual(core.userData.colorPaint, dom.userData.colorPaint, `obj ${objectId} colorPaint`)
  }
})

test('meshParseCore parses paint codes onto the right triangles', async () => {
  const { parseThreeMfMeshArrays } = await import('./meshParseCore')
  const [first] = parseThreeMfMeshArrays(SAMPLE_XML)
  assert.ok(first)
  assert.equal(first!.objectId, 1)
  assert.equal(first!.positions.length, 8 * 3, '8 cube vertices')
  assert.equal(first!.index.length, 12 * 3, '12 cube triangles')
  assert.deepEqual(first!.supportPaint, { 0: '4' })
  assert.deepEqual(first!.seamPaint, { 1: '8' })
  assert.deepEqual(first!.colorPaint, { 2: '4' })
})
