import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findLibrarySaveConflict } from './librarySaveConflict.js'

const files = [
  { name: 'benchy.gcode' },
  { name: 'benchy.stl' },
  { name: 'benchy.3mf' },
  { name: 'benchy.gcode.3mf' }
]

test('findLibrarySaveConflict matches only the exact final name (base + extension)', () => {
  assert.equal(findLibrarySaveConflict(files, 'benchy', '.gcode.3mf'), files[3])
  assert.equal(findLibrarySaveConflict(files, 'benchy', '.3mf'), files[2])
})

test('findLibrarySaveConflict ignores files sharing the base name under a different extension', () => {
  // Regression: saving `benchy` as `.gcode.3mf` next to `benchy.gcode` used to
  // warn about a replace the server would never perform.
  assert.equal(findLibrarySaveConflict([{ name: 'benchy.gcode' }, { name: 'benchy.stl' }], 'benchy', '.gcode.3mf'), null)
})

test('findLibrarySaveConflict is case-sensitive like the server overwrite lookup', () => {
  assert.equal(findLibrarySaveConflict(files, 'Benchy', '.gcode.3mf'), null)
})

test('findLibrarySaveConflict without a declared extension matches the bare name', () => {
  assert.equal(findLibrarySaveConflict(files, 'benchy.stl'), files[1])
  assert.equal(findLibrarySaveConflict(files, 'benchy'), null)
})

test('findLibrarySaveConflict returns null for an empty base name', () => {
  assert.equal(findLibrarySaveConflict(files, '   ', '.gcode.3mf'), null)
})
