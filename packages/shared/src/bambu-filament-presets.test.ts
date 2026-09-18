/** Product lines must retain the vendor's family without inventing identities from recipe names. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filamentProductLineFromPresetName } from './bambu-filament-presets.js'

test('known presets separate manufacturer, product line and machine', () => {
  for (const [name, expected] of [
    ['PolyLite PETG @BBL H2D', 'PolyLite PETG'],
    ['PolyTerra PLA', 'PolyTerra PLA'],
    ['Fiberon PA6-CF', 'Fiberon PA6-CF'],
    ['Bambu PETG Basic', 'PETG Basic'],
    ['Bambu PLA Metal @BBL H2D', 'PLA Metal'],
    ['eSUN PLA+', 'PLA+'],
    ['Generic PETG', null],
    ['My tuned PETG @BBL H2D', null]
  ]) {
    assert.equal(filamentProductLineFromPresetName(name!), expected)
  }
})
