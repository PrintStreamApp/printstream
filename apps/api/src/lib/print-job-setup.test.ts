import assert from 'node:assert/strict'
import test from 'node:test'
import type { BridgeLibraryThreeMfIndex } from '@printstream/shared'
import { buildPrintJobSetup } from './print-job-setup.js'

test('job setup snapshots only selected plate materials and keeps slicer version separate from project version', () => {
  const index = {
    plates: [{
      index: 2,
      plateType: 'textured_pei_plate',
      nozzleSizes: ['0.4'],
      printSequence: 'by object',
      filaments: [
        { id: 1, filamentType: null },
        { id: 2, filamentType: 'PETG-CF' },
        { id: 3, filamentType: 'PLA' }
      ]
    }],
    projectFilaments: [
      { id: 1, filamentType: 'PLA', filamentPresetName: 'Bambu PLA Basic' },
      { id: 2, filamentType: 'PETG-CF', filamentPresetName: 'Bambu PETG-CF' },
      { id: 3, filamentType: 'PLA', filamentPresetName: 'Bambu PLA Basic' },
      { id: 4, filamentType: 'ABS', filamentPresetName: 'Bambu ABS' }
    ],
    printerProfileName: 'X1 Carbon 0.4',
    processProfileName: '0.20mm Standard',
    projectVersion: '02.09.00.50'
  } as unknown as BridgeLibraryThreeMfIndex

  assert.deepEqual(buildPrintJobSetup({
    index,
    plate: 2,
    printerModel: 'X1C',
    sliceSettingsJson: JSON.stringify({
      target: { mode: 'realPrinter', printerId: 'printer-1' },
      plate: 2,
      slicerName: 'Bambu Studio',
      slicerVersion: '2.8.0'
    })
  }), {
    printerModel: 'X1C',
    slicedPlateType: 'Textured PEI Plate',
    materialTypes: ['PETG-CF', 'PLA'],
    materialPresets: [
      { materialType: 'PLA', presetName: 'Bambu PLA Basic' },
      { materialType: 'PETG-CF', presetName: 'Bambu PETG-CF' }
    ],
    printerProfileName: 'X1 Carbon 0.4',
    processProfileName: '0.20mm Standard',
    nozzleSizes: ['0.4'],
    printSequence: 'by object',
    slicerName: 'Bambu Studio',
    slicerVersion: '2.8.0',
    projectVersion: '02.09.00.50'
  })
})
