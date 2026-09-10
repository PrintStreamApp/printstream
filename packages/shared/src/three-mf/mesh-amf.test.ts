/**
 * The AMF import parser.
 *
 * The cases that matter are the ones where a plausible reading produces a MODEL rather than an
 * error: volumes sharing one vertex pool, the unit attribute, and several objects in one document.
 * Each of those failing silently gives the user geometry at the wrong scale or in the wrong pieces.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { isZippedAmf, parseAmfMesh } from './mesh-amf.js'
import { ModelImportError } from './imported-mesh.js'

/** A tetrahedron-ish volume over the four shared vertices the fixtures declare. */
function volume(name: string, triangles: ReadonlyArray<readonly [number, number, number]>): string {
  return [
    '<volume>',
    `<metadata type="name">${name}</metadata>`,
    ...triangles.map(([a, b, c]) => `<triangle><v1>${a}</v1><v2>${b}</v2><v3>${c}</v3></triangle>`),
    '</volume>'
  ].join('')
}

function document(body: string, unit?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><amf${unit ? ` unit="${unit}"` : ''}>${body}</amf>`
}

const VERTICES = [
  [0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]
].map(([x, y, z]) => `<vertex><coordinates><x>${x}</x><y>${y}</y><z>${z}</z></coordinates></vertex>`).join('')

function object(volumes: string, name = 'Thing'): string {
  return `<object id="1"><metadata type="name">${name}</metadata><mesh><vertices>${VERTICES}</vertices>${volumes}</mesh></object>`
}

test('a single-volume object parses to one mesh with no parts', () => {
  // Matching what a single-solid STEP or an STL produces, so the editor treats it as an ordinary
  // one-mesh object rather than a one-part assembly.
  const mesh = parseAmfMesh(document(object(volume('Body', [[0, 1, 2]]))))
  assert.equal(mesh.indices.length / 3, 1)
  assert.equal(mesh.parts, undefined)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } })
})

test('several volumes become parts sharing one coordinate space', () => {
  // The whole reason AMF reuses the multi-solid STEP machinery. If each volume were rebased to its
  // own centre the assembly would collapse onto the origin.
  const mesh = parseAmfMesh(document(object(
    volume('Lower', [[0, 1, 2]]) + volume('Upper', [[0, 1, 3], [0, 2, 3]])
  )))
  assert.equal(mesh.parts?.length, 2)
  assert.deepEqual(mesh.parts?.map((part) => part.name), ['Lower', 'Upper'])
  assert.equal(mesh.parts?.[0]?.mesh.indices.length ?? 0, 3)
  assert.equal(mesh.parts?.[1]?.mesh.indices.length ?? 0, 6)
  // The merged mesh spans both volumes, which is only true if they were NOT individually re-centred.
  assert.equal(mesh.bounds.max.z, 10)
  assert.equal(mesh.indices.length / 3, 3)
})

test('a volume is named from its own metadata, falling back to the object name', () => {
  const named = parseAmfMesh(document(object(volume('Left', [[0, 1, 2]]) + volume('Right', [[0, 1, 3]]))))
  assert.deepEqual(named.parts?.map((part) => part.name), ['Left', 'Right'])

  const unnamed = parseAmfMesh(document(object(
    '<volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume>' +
    '<volume><triangle><v1>0</v1><v2>1</v2><v3>3</v3></triangle></volume>',
    'Widget'
  )))
  assert.deepEqual(unnamed.parts?.map((part) => part.name), ['Widget', 'Widget'])
})

test('volumes across several objects flatten into one part list', () => {
  // A staged import is ONE object, so a multi-object document cannot stay multi-object. Their
  // coordinates already share a space, so flattening moves nothing.
  const mesh = parseAmfMesh(document(
    object(volume('A', [[0, 1, 2]]), 'First') + object(volume('B', [[0, 1, 3]]), 'Second')
  ))
  assert.equal(mesh.parts?.length, 2)
  assert.deepEqual(mesh.parts?.map((part) => part.name), ['A', 'B'])
})

test('unit="inch" scales to millimetres', () => {
  // The one unit BambuStudio honours (AMF.cpp:280-281).
  const mesh = parseAmfMesh(document(object(volume('Body', [[0, 1, 2]])), 'inch'))
  assert.equal(mesh.bounds.max.x, 254)
})

test('the units BambuStudio ignores are honoured, which is a deliberate divergence', () => {
  // It checks only for `inch`, so a metre-declared document opens there a thousand times too small.
  // Silently wrong scale is not an error the user is shown; it is a model they have to notice.
  assert.equal(parseAmfMesh(document(object(volume('B', [[0, 1, 2]])), 'meter')).bounds.max.x, 10_000)
  assert.equal(parseAmfMesh(document(object(volume('B', [[0, 1, 2]])), 'micron')).bounds.max.x, 0.01)
  // AMF spells this one `feet` where the 3MF attribute spells it `foot`; both must work.
  assert.equal(parseAmfMesh(document(object(volume('B', [[0, 1, 2]])), 'feet')).bounds.max.x, 3048)
})

test('an absent or unrecognised unit means millimetres, not a refusal', () => {
  // The spec default. Refusing over an attribute the engine shrugs at would be stricter than the
  // thing we are trying to agree with.
  assert.equal(parseAmfMesh(document(object(volume('B', [[0, 1, 2]])))).bounds.max.x, 10)
  assert.equal(parseAmfMesh(document(object(volume('B', [[0, 1, 2]])), 'furlong')).bounds.max.x, 10)
})

test('a triangle naming a vertex outside the pool is refused', () => {
  // Refused rather than skipped: it means the file disagrees with itself about how many vertices
  // there are, and guessing which end is right would silently reshape the model.
  assert.throws(
    () => parseAmfMesh(document(object(volume('B', [[0, 1, 9]])))),
    /invalid vertex index/
  )
})

test('markup inside an XML comment is not read as markup', () => {
  // Both halves of this parser are scan-based, so a comment is otherwise indistinguishable from
  // real markup. A banner comment naming the root element won the search for `<amf unit=...>`, so
  // the declared unit was missed and an inch-declared part imported 25.4x too small -- silently.
  const commented = `<?xml version="1.0"?><!-- exported as <amf> by SomeCAD 4.2 --><amf unit="inch">${
    object(volume('Body', [[0, 1, 2]]))}</amf>`
  assert.equal(parseAmfMesh(commented).bounds.max.x, 254, 'the real unit attribute must win')

  // The inverse: a unit named inside a comment must not override the real one.
  const decoy = `<!-- unit="meter" --><amf unit="millimeter">${object(volume('Body', [[0, 1, 2]]))}</amf>`
  assert.equal(parseAmfMesh(decoy).bounds.max.x, 10)

  // And a commented-out volume contributes no geometry.
  const hidden = document(object(volume('Real', [[0, 1, 2]]) + `<!-- ${volume('Ghost', [[0, 1, 3]])} -->`))
  assert.equal(parseAmfMesh(hidden).parts, undefined, 'only one volume survives, so no parts list')
  assert.equal(parseAmfMesh(hidden).indices.length / 3, 1)
})

test('a triangle that does not name three vertices is refused, not dropped', () => {
  // Dropping it leaves a hole the user cannot see, in a mesh that then slices as an open shell.
  // The module's own header states this rule for a bad INDEX; the same reasoning applies here, and
  // the sibling OBJ parser refuses the same shape.
  const short = document(object(
    '<volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle>' +
    '<triangle><v1>0</v1><v2>1</v2></triangle></volume>'
  ))
  assert.throws(() => parseAmfMesh(short), /triangle with less than 3 vertices/)
})

test('every refusal is a ModelImportError, so the worker can classify by type', () => {
  for (const [label, source] of [
    ['no volumes', document(`<object id="1"><mesh><vertices>${VERTICES}</vertices></mesh></object>`)],
    ['bad index', document(object(volume('B', [[0, 1, 9]])))],
    ['short triangle', document(object('<volume><triangle><v1>0</v1><v2>1</v2></triangle></volume>'))]
  ] as const) {
    const error = (() => { try { parseAmfMesh(source); return null } catch (caught) { return caught } })()
    assert.ok(error instanceof ModelImportError, `${label} must throw a ModelImportError`)
  }
})

test('a document with no volumes is refused rather than imported empty', () => {
  assert.throws(
    () => parseAmfMesh(document(`<object id="1"><mesh><vertices>${VERTICES}</vertices></mesh></object>`)),
    /contained no triangles/
  )
})

test('constellation instances are refused rather than silently discarded', () => {
  const source = document(
    object(volume('Body', [[0, 1, 2]])) +
    '<constellation id="2"><instance objectid="1"><deltax>50</deltax></instance></constellation>'
  )
  assert.throws(() => parseAmfMesh(source), /constellation instances are not supported/)
})

test('a zipped AMF is detected by magic, not by extension', () => {
  // `load_amf` switches on a `PK` magic (AMF.cpp:1111); the extension is `.amf` either way.
  assert.equal(isZippedAmf(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), true)
  assert.equal(isZippedAmf(new TextEncoder().encode('<?xml version="1.0"?><amf>')), false)
  assert.equal(isZippedAmf(new Uint8Array([])), false)
})

test('attribute values containing angle brackets do not derail the tag scan', () => {
  // The scanner steps tag to tag, so a quoted `>` inside an attribute must not end the tag early.
  const mesh = parseAmfMesh(document(
    `<object id="1"><metadata type="name">a &gt; b</metadata><mesh><vertices>${VERTICES}</vertices>` +
    volume('Body', [[0, 1, 2]]) + '</mesh></object>'
  ))
  assert.equal(mesh.indices.length / 3, 1)
})
