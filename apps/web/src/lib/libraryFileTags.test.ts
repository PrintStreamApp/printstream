import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile } from '@printstream/shared'
import { isPreviewOnlyLibraryFile, isUnslicedThreeMfFile } from './libraryFileTags.js'

function fileOfKind(kind: LibraryFile['kind'], name: string): LibraryFile {
  return { kind, name } as LibraryFile
}

test('isPreviewOnlyLibraryFile is true for STL and STEP, false for printable/editable kinds', () => {
  assert.equal(isPreviewOnlyLibraryFile(fileOfKind('stl', 'part.stl')), true)
  assert.equal(isPreviewOnlyLibraryFile(fileOfKind('step', 'bracket.step')), true)
  // 3MF projects are editable and gcode is directly printable — they have their own
  // default action, so they are not "preview only".
  assert.equal(isPreviewOnlyLibraryFile(fileOfKind('3mf', 'project.3mf')), false)
  assert.equal(isPreviewOnlyLibraryFile(fileOfKind('gcode', 'sliced.gcode.3mf')), false)
  assert.equal(isPreviewOnlyLibraryFile(fileOfKind('other', 'notes.txt')), false)
})

test('isUnslicedThreeMfFile only matches plain project 3MFs', () => {
  assert.equal(isUnslicedThreeMfFile(fileOfKind('3mf', 'project.3mf')), true)
  assert.equal(isUnslicedThreeMfFile(fileOfKind('gcode', 'sliced.gcode.3mf')), false)
  assert.equal(isUnslicedThreeMfFile(fileOfKind('stl', 'part.stl')), false)
})
