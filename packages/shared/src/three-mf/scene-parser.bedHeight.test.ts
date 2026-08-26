/**
 * The bed's usable Z. It exists so a "does this fit the printer?" question can be answered about
 * the print VOLUME rather than only its floor: BambuStudio's scale-to-fit takes
 * `min(sx, sy, sz)`, and dropping `sz` silently produces models taller than the machine.
 *
 * The rule that matters most is that null means UNKNOWN, never unlimited.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractSceneBed } from './scene-parser.js'

test('the project\'s own printable_height wins over the per-model table', () => {
  // A retargeted or hand-edited project states the machine it was actually built for; the table is
  // only a stand-in for a file that references a machine profile instead of embedding one.
  const bed = extractSceneBed(JSON.stringify({ printer_model: 'Bambu Lab H2D', printable_height: 400 }), null)
  assert.equal(bed.bed.maxZ, 400)
})

test('a project stating no height falls back to the model table', () => {
  // H2D takes 325 from `fdm_bbl_3dp_002_common` through BambuStudio's profile inheritance.
  const bed = extractSceneBed(JSON.stringify({ printer_model: 'Bambu Lab H2D' }), null)
  assert.equal(bed.bed.maxZ, 325)
})

test('a height written as a string or a one-element array is still read', () => {
  // Bambu writes a scalar option as a bare value in one place and a one-element array in another,
  // and a project that has been through the cloud preset API carries it as a string.
  assert.equal(extractSceneBed(JSON.stringify({ printable_height: '256' }), null).bed.maxZ, 256)
  assert.equal(extractSceneBed(JSON.stringify({ printable_height: [180] }), null).bed.maxZ, 180)
})

test('an unknown machine reports null rather than guessing a height', () => {
  // Null is the whole point: a caller must decline to answer, not assume the model fits.
  assert.equal(extractSceneBed(JSON.stringify({ some_unrelated_key: 1 }), null).bed.maxZ, null)
  assert.equal(extractSceneBed(null, null).bed.maxZ, null)
})

test('targeting a different printer reports THAT printer\'s height', () => {
  // The slice dialog's chosen target overrides the file's embedded machine, and the height has to
  // follow it or the fit is checked against the wrong volume.
  const bed = extractSceneBed(JSON.stringify({ printer_model: 'Bambu Lab H2D', printable_height: 325 }), null, 'A1mini')
  assert.equal(bed.bed.maxZ, 180, 'expected the A1 mini height, not the file\'s H2D one')
})
