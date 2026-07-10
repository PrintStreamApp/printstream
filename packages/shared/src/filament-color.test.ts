import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commonFilamentColorName, filamentColorLabel } from './filament-color.js'

test('commonFilamentColorName maps exact swatch hexes (any accepted form) to names', () => {
  assert.equal(commonFilamentColorName('#FFFFFF'), 'White')
  // Printer trays report RRGGBBAA with no leading '#'.
  assert.equal(commonFilamentColorName('FFFFFFFF'), 'White')
  assert.equal(commonFilamentColorName('#00FFFF'), 'Cyan')
  assert.equal(commonFilamentColorName('#F8F8F2'), null)
  assert.equal(commonFilamentColorName(null), null)
})

test('filamentColorLabel prefers the common name and falls back to the normalized hex', () => {
  assert.equal(filamentColorLabel('FFFFFFFF'), 'White')
  // Not a curated swatch: label with the colour itself, never a tray code.
  assert.equal(filamentColorLabel('f8f8f2ff'), '#F8F8F2')
  assert.equal(filamentColorLabel('A00-B9'), null)
  assert.equal(filamentColorLabel(undefined), null)
})
