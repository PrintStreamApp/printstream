import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalCurrBedType } from './plate-types.js'

test('canonicalCurrBedType maps code-form tokens and labels onto the serialized enum values', () => {
  // Code-form tokens the web UI circulates.
  assert.equal(canonicalCurrBedType('textured_pei_plate'), 'Textured PEI Plate')
  assert.equal(canonicalCurrBedType('cool_plate'), 'Cool Plate')
  assert.equal(canonicalCurrBedType('supertack_plate'), 'Supertack Plate')
  // Already-serialized values pass through unchanged.
  assert.equal(canonicalCurrBedType('High Temp Plate'), 'High Temp Plate')
  // BambuStudio display labels that differ from the enum value.
  assert.equal(canonicalCurrBedType('Smooth PEI Plate / High Temp Plate'), 'High Temp Plate')
  assert.equal(canonicalCurrBedType('Bambu Cool Plate SuperTack'), 'Supertack Plate')
})

test('canonicalCurrBedType passes unknown values through trimmed and blanks through as null', () => {
  assert.equal(canonicalCurrBedType('  Default Plate  '), 'Default Plate')
  assert.equal(canonicalCurrBedType(''), null)
  assert.equal(canonicalCurrBedType('   '), null)
  assert.equal(canonicalCurrBedType(null), null)
  assert.equal(canonicalCurrBedType(undefined), null)
})
