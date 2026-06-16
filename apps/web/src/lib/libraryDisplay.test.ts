import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatLibraryFileKindLabel, formatLibraryFileName, splitLibraryFileNameForRename } from './libraryDisplay.js'

test('formatLibraryFileName hides file extensions in user-facing names', () => {
  assert.equal(formatLibraryFileName('widget.gcode.3mf'), 'widget')
  assert.equal(formatLibraryFileName('widget.3mf'), 'widget')
  assert.equal(formatLibraryFileName('widget.stl'), 'widget')
  assert.equal(formatLibraryFileName('widget.gcode'), 'widget')
  assert.equal(formatLibraryFileName('widget'), 'widget')
  assert.equal(formatLibraryFileName('.hidden'), '.hidden')
})

test('splitLibraryFileNameForRename keeps the sliced gcode 3mf suffix outside the editable basename', () => {
  assert.deepEqual(splitLibraryFileNameForRename('widget.gcode.3mf'), {
    baseName: 'widget',
    extension: '.gcode.3mf'
  })
})

test('splitLibraryFileNameForRename keeps standard file extensions outside the editable basename', () => {
  assert.deepEqual(splitLibraryFileNameForRename('widget.stl'), {
    baseName: 'widget',
    extension: '.stl'
  })
})

test('splitLibraryFileNameForRename leaves extensionless names fully editable', () => {
  assert.deepEqual(splitLibraryFileNameForRename('widget'), {
    baseName: 'widget',
    extension: ''
  })
})

test('formatLibraryFileKindLabel shows sliced 3mf files as 3MF GCODE', () => {
  assert.equal(formatLibraryFileKindLabel('widget.gcode.3mf', 'gcode'), '3MF GCODE')
})

test('formatLibraryFileKindLabel keeps regular 3mf files labeled as 3MF', () => {
  assert.equal(formatLibraryFileKindLabel('widget.3mf', '3mf'), '3MF')
})

test('formatLibraryFileKindLabel labels STEP files as STEP', () => {
  assert.equal(formatLibraryFileKindLabel('bracket.step', 'step'), 'STEP')
  assert.equal(formatLibraryFileKindLabel('bracket.stp', 'step'), 'STEP')
})