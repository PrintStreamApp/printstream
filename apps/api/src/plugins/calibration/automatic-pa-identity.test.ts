/** Regression coverage for prepared automatic calibrations surviving changes to loaded filament. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AmsSlot } from '@printstream/shared'
import { automaticPaFilamentMatches, automaticPaFilamentSnapshot, automaticPaMaterialTypesMatch } from './automatic-pa-identity.js'

const slot = { color: '#FF0000', colors: ['#FF0000'], trayUuid: null, trayInfoIdx: 'GFG60', filamentType: 'PETG' } as AmsSlot
const identity = { spoolId: 'red-spool', brand: 'Polymaker', filamentType: 'PETG', materialSubtype: 'PolyLite PETG', colorName: 'Red' }

test('untagged spool swaps invalidate a prepared run even when the tray preset and type are unchanged', () => {
  const prepared = automaticPaFilamentSnapshot(slot, identity)
  assert.equal(automaticPaFilamentMatches(prepared, automaticPaFilamentSnapshot(slot, identity)), true)
  assert.equal(automaticPaFilamentMatches(prepared, automaticPaFilamentSnapshot(slot, { ...identity, spoolId: 'replacement-spool' })), false)
  assert.equal(automaticPaFilamentMatches(prepared, automaticPaFilamentSnapshot({ ...slot, color: '#0000FF', colors: ['#0000FF'] }, identity)), false)
  assert.equal(automaticPaFilamentMatches(prepared, automaticPaFilamentSnapshot(slot, { ...identity, colorName: 'Blue' })), false)
  assert.equal(automaticPaFilamentMatches(undefined, prepared), false)
})

test('automatic calibration requires the distinct material type, not just its polymer family', () => {
  assert.equal(automaticPaMaterialTypesMatch('PETG-CF', 'PETG'), false)
  assert.equal(automaticPaMaterialTypesMatch('PETG', 'PETG-CF'), false)
  assert.equal(automaticPaMaterialTypesMatch('PLA-CF', 'PLA'), false)
  assert.equal(automaticPaMaterialTypesMatch('PA6-GF', 'PA6-CF'), false)
  assert.equal(automaticPaMaterialTypesMatch(' petg-cf ', 'PETG-CF'), true)
  assert.equal(automaticPaMaterialTypesMatch(undefined, 'PETG'), false)
})
