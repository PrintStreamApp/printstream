import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeLibraryThreeMfIndexSchema } from '@printstream/shared'
import type { ClientThreeMfProject } from './clientThreeMfProject'
import { LOCAL_SLICE_FILE_ID, localBakedIndex, localSliceLibraryFile } from './localSliceFile'

function fakeProject(): ClientThreeMfProject {
  const index = bridgeLibraryThreeMfIndexSchema.parse({
    plates: [{
      index: 1, name: 'Plate 1', gcodeFile: null, pickFile: null, thumbnailFile: null,
      plateType: 'Textured PEI Plate', nozzleSizes: ['0.4'], filaments: [], objects: []
    }],
    projectFilaments: [
      { id: 1, filamentType: 'PLA', filamentName: 'Bambu PLA Basic', color: '#FFFFFF', nozzleId: 0, chamberTemperature: null }
    ],
    compatiblePrinterModels: ['X1C'],
    processProfileName: '0.20mm Standard @BBL X1C',
    projectVersion: '01.09.00.15'
  })
  // The controller only reads fileName/sizeBytes/index; the archive-backed methods are for the
  // editor surface, not the settings controller, so a partial stub is enough here.
  return { fileName: 'Widget.3mf', sizeBytes: 12345, index } as ClientThreeMfProject
}

test('the baked index round-trips the parsed project index', () => {
  const index = localBakedIndex(fakeProject())
  assert.equal(index.plates.length, 1)
  assert.equal(index.projectFilaments.length, 1)
  assert.deepEqual(index.compatiblePrinterModels, ['X1C'])
  assert.equal(index.processProfileName, '0.20mm Standard @BBL X1C')
})

test('the synthesized library file carries real identity and empty chips', () => {
  const file = localSliceLibraryFile(fakeProject())
  assert.equal(file.id, LOCAL_SLICE_FILE_ID)
  assert.equal(file.name, 'Widget.3mf')
  assert.equal(file.kind, '3mf')
  assert.equal(file.sizeBytes, 12345)
  assert.deepEqual(file.compatiblePrinterModels, ['X1C'])
  assert.equal(file.plateCount, 1)
  assert.equal(file.projectVersion, '01.09.00.15')
  // Chips are intentionally empty: the controller always passes the baked index, which every helper
  // prefers, so the file-chip fallback never fires.
  assert.deepEqual(file.plateTypeChips, [])
  assert.deepEqual(file.nozzleSizeChips, [])
  assert.deepEqual(file.projectFilamentChips, [])
  // Neutral library-lifecycle defaults for a file that has no versions/stars/print history.
  assert.equal(file.favorite, false)
  assert.equal(file.printCount, 0)
  assert.equal(file.lastPrintedAt, null)
})
