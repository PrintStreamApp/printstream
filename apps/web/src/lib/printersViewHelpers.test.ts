import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filamentPresetLabel } from './printersViewHelpers.js'

const BAMBU_RFID = '0F674662BC86478AA008E7CCAD3B3A2A'

test('filamentPresetLabel surfaces the Bambu preset name for a scanned Bambu spool', () => {
  assert.equal(
    filamentPresetLabel('GFA00', 'PLA', 'PLA', { trayUuid: BAMBU_RFID }),
    'Bambu PLA Basic'
  )
})

test('filamentPresetLabel uses the plain type for custom filament assigned a Bambu preset without an RFID tag', () => {
  // A custom spool mapped to "Bambu PLA Basic" for slicing (GFA00) but with no scanned tag is not
  // genuine Bambu filament, so it reads "PLA", never "Bambu PLA Basic".
  assert.equal(filamentPresetLabel('GFA00', 'PLA', 'PLA', { trayUuid: null }), 'PLA')
})

test('filamentPresetLabel uses the plain type for custom filament with no preset or RFID tag', () => {
  assert.equal(filamentPresetLabel(null, 'PLA', 'PLA'), 'PLA')
})

test('filamentPresetLabel never prepends "Bambu" to the material fallback for non-RFID filament', () => {
  assert.equal(filamentPresetLabel('GFA00', 'PLA', null, { trayUuid: null }), 'PLA')
})

test('filamentPresetLabel still prepends "Bambu" to the material fallback for a scanned spool without a mapped preset', () => {
  assert.equal(filamentPresetLabel('GFUNKNOWN', 'PLA', null, { trayUuid: BAMBU_RFID }), 'Bambu PLA')
})
