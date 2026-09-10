/**
 * The two format catalogues, checked against each other.
 *
 * `classifyLibraryFileKind` (what a stored file IS) and `detectImportFormat` (what the editor can
 * stage as geometry) are deliberately separate lists -- one includes G-code, the other does not, and
 * they answer different questions. But they OVERLAP on every mesh format, and the overlap is what
 * drifts: adding an importable format without a library kind leaves the file showing as "Other" with
 * no thumbnail and no preview, while the editor opens it happily. Nothing about that fails a build.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { IMPORT_FORMAT_EXTENSIONS, STAGED_IMPORT_FORMATS, detectImportFormat } from './import-formats.js'
import { classifyLibraryFileKind, isMeshLibraryFileKind } from './printer-contracts.js'

test('every importable extension classifies as something other than "other"', () => {
  // The drift this file exists to catch. A file the editor can stage must be recognisable in the
  // library, or the two surfaces disagree about what the user just uploaded.
  for (const [format, extensions] of Object.entries(IMPORT_FORMAT_EXTENSIONS)) {
    for (const extension of extensions) {
      const kind = classifyLibraryFileKind(`model${extension}`)
      assert.notEqual(kind, 'other', `${extension} (${format}) must have a library kind`)
    }
  }
})

test('every bare-mesh import format maps to a mesh library kind', () => {
  // 3MF is the deliberate exception: a `.3mf` is usually a PROJECT, and whether a given one is
  // geometry-only cannot be decided from the name. Callers that can see the parsed index add it.
  for (const format of STAGED_IMPORT_FORMATS) {
    if (format === '3mf') continue
    const extension = IMPORT_FORMAT_EXTENSIONS[format][0]
    const kind = classifyLibraryFileKind(`model${extension}`)
    assert.ok(isMeshLibraryFileKind(kind), `${format} should be a mesh kind, got ${kind}`)
  }
})

test('a mesh library kind is spelled the same as its import format', () => {
  // Not required by anything structurally, but a `gltf` kind beside a `gltf` format is one fewer
  // mapping table to keep, and the moment they diverge every gate has to translate between them.
  for (const format of STAGED_IMPORT_FORMATS) {
    if (format === '3mf') continue
    assert.equal(classifyLibraryFileKind(`model${IMPORT_FORMAT_EXTENSIONS[format][0]}`), format)
  }
})

test('G-code is claimed before 3MF, so a sliced project is not read as an unsliced one', () => {
  // `.gcode.3mf` ends with `.3mf`, so ORDER is what keeps a directly-printable file out of the
  // project path on the LIBRARY axis.
  assert.equal(classifyLibraryFileKind('plate_1.gcode.3mf'), 'gcode')
  assert.equal(classifyLibraryFileKind('plate_1.gcode'), 'gcode')
  assert.equal(classifyLibraryFileKind('project.3mf'), '3mf')
})

test('the two axes deliberately disagree about a sliced 3MF, and that is not a bug', () => {
  // `detectImportFormat` DOES claim `.gcode.3mf` as a 3MF, because the archive really does carry
  // the model and the editor can extract its geometry -- longstanding behaviour, unchanged here.
  // The library axis calls the same file `gcode`, because what it IS to a user is a printable job.
  // Pinned because the disagreement looks like an oversight and reads as one until you know why.
  assert.equal(detectImportFormat('plate_1.gcode.3mf'), '3mf')
  assert.equal(classifyLibraryFileKind('plate_1.gcode.3mf'), 'gcode')
  // Plain `.gcode` is neither: no geometry to import at all.
  assert.equal(detectImportFormat('plate_1.gcode'), null)
})

test('a file matching no catalogue is "other" and not importable', () => {
  assert.equal(classifyLibraryFileKind('notes.txt'), 'other')
  assert.equal(detectImportFormat('notes.txt'), null)
  assert.equal(isMeshLibraryFileKind('other'), false)
  assert.equal(isMeshLibraryFileKind('gcode'), false)
  assert.equal(isMeshLibraryFileKind('3mf'), false)
})
