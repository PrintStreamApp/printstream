/**
 * The 3MF core spec lets a model declare its coordinate space in units other than millimetres, and
 * BambuStudio honours the attribute (`bbs_get_unit_factor`, `bbs_3mf.cpp:618-635`) while always
 * writing `millimeter` itself. So it is 1.0 for every Bambu project and only matters for foreign
 * files, where ignoring it brings a CAD export in 25.4x too small.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { threeMfModelUnitFactor } from './model-unit'

const model = (attrs: string) => `<?xml version="1.0"?>\n<model ${attrs}>\n <resources/>\n</model>`

test('every unit the engine knows maps to the same factor it uses', () => {
  const expected: Array<[string, number]> = [
    ['micron', 0.001],
    ['millimeter', 1],
    ['centimeter', 10],
    ['inch', 25.4],
    ['foot', 304.8],
    ['meter', 1000]
  ]
  for (const [unit, factor] of expected) {
    assert.equal(threeMfModelUnitFactor(model(`unit="${unit}"`)), factor, `${unit} disagrees with the engine`)
  }
})

test('an absent unit defaults to millimetres', () => {
  // What the spec says, and what every Bambu project relies on.
  assert.equal(threeMfModelUnitFactor(model('xml:lang="en-US"')), 1)
})

test('an unrecognised unit defaults to millimetres rather than failing', () => {
  // The engine's own `else` branch. Refusing an import over an attribute the engine shrugs at
  // would be stricter than the behaviour we are trying to match.
  assert.equal(threeMfModelUnitFactor(model('unit="furlong"')), 1)
  assert.equal(threeMfModelUnitFactor(model('unit=""')), 1)
})

test('the attribute is read case-insensitively and only from the model element', () => {
  assert.equal(threeMfModelUnitFactor(model('unit="INCH"')), 25.4)
  // A `unit` inside the body must not be mistaken for the model's own declaration.
  const bodyUnit = '<model xml:lang="en-US">\n <resources><object id="1" unit="inch"/></resources>\n</model>'
  assert.equal(threeMfModelUnitFactor(bodyUnit), 1)
})

test('a document with no model element is left at 1', () => {
  assert.equal(threeMfModelUnitFactor('not xml'), 1)
})
