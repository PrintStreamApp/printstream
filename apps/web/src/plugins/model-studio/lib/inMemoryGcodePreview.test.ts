import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientThreeMfProject } from './clientThreeMfProject'
import { readInMemoryPlateGcode, type InMemoryGcodePreviewSource } from './inMemoryGcodePreview'

function source(gcodeFile: string | null, text: string | null): InMemoryGcodePreviewSource {
  return {
    fileName: 'slice.gcode.3mf',
    project: {
      index: { plates: [{ index: 2, gcodeFile }] },
      archive: { entryText: () => text }
    } as unknown as ClientThreeMfProject
  }
}

test('reads the selected plate from a browser-held sliced archive', () => {
  assert.equal(readInMemoryPlateGcode(source('Metadata/plate_2.gcode', 'G1 X10'), 2), 'G1 X10')
})

test('rejects an output without previewable G-code for the selected plate', () => {
  assert.throws(() => readInMemoryPlateGcode(source(null, null), 2), /does not include previewable G-code/)
})
