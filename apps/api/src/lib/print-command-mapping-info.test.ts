import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrinterStatus } from '@printstream/shared'
import {
  buildProjectFileMappingInfoFields,
  parsePlateSliceMappingSource,
  toWireTrayColor,
  trayColorsByIndex
} from './print-command-mapping-info.js'

// Modeled on a real H2D-sliced plate (dual 0.4 high-flow nozzles, filament 1
// on the right extruder, filament 2 on the left).
const DUAL_NOZZLE_SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="O1D"/>
    <metadata key="nozzle_diameters" value="0.4,0.4"/>
    <metadata key="filament_maps" value="2 1"/>
    <metadata key="nozzle_volume_type" value="1 1"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_m="4.21" used_g="12.75" group_id="1" nozzle_diameter="0.40" volume_type="High Flow"/>
    <filament id="2" tray_info_idx="GFA06" type="PLA" color="#FF0000" used_m="2.44" used_g="7.45" group_id="0" nozzle_diameter="0.40" volume_type="High Flow"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="filament_maps" value="1"/>
    <filament id="1" tray_info_idx="GFL99" type="PETG" color="#00FF00" nozzle_diameter="0.40"/>
  </plate>
</config>`

test('parsePlateSliceMappingSource reads the matching plate block', () => {
  const source = parsePlateSliceMappingSource(DUAL_NOZZLE_SLICE_INFO, 1)
  assert.ok(source)
  assert.deepEqual(source.filaments, [
    { id: 1, type: 'PLA', color: '#FFFFFF', trayInfoIdx: 'GFA00' },
    { id: 2, type: 'PLA', color: '#FF0000', trayInfoIdx: 'GFA06' }
  ])
  assert.deepEqual(source.filamentMaps, [2, 1])
  assert.deepEqual(source.nozzleDiameters, [0.4, 0.4])
  assert.deepEqual(source.nozzleVolumeTypes, [1, 1])

  const plate2 = parsePlateSliceMappingSource(DUAL_NOZZLE_SLICE_INFO, 2)
  assert.ok(plate2)
  assert.equal(plate2.filaments[0]?.type, 'PETG')
  assert.equal(parsePlateSliceMappingSource(DUAL_NOZZLE_SLICE_INFO, 3), null)
})

test('toWireTrayColor widens to RRGGBBAA and drops unknowns', () => {
  assert.equal(toWireTrayColor('#00AE42'), '00AE42FF')
  assert.equal(toWireTrayColor('00AE42F0'), '00AE42F0')
  assert.equal(toWireTrayColor(null), '')
  assert.equal(toWireTrayColor('not-a-color'), '')
})

test('trayColorsByIndex keys colors by global tray index including the HT band', () => {
  const status = {
    ams: [
      {
        unitId: 0,
        type: 'ams-2-pro',
        slots: [
          { slot: 0, color: '#FFFFFF' },
          { slot: 1, color: '#161616' },
          { slot: 2, color: null }
        ]
      },
      { unitId: 128, type: 'ams-ht', slots: [{ slot: 0, color: '#0A2CA5' }] }
    ]
  } as unknown as PrinterStatus
  const colors = trayColorsByIndex(status)
  assert.equal(colors.get(0), 'FFFFFFFF')
  assert.equal(colors.get(1), '161616FF')
  assert.equal(colors.get(128), '0A2CA5FF')
  assert.equal(colors.has(2), false)
})

test('buildProjectFileMappingInfoFields mirrors BambuStudio for a dual-nozzle plate', () => {
  const source = parsePlateSliceMappingSource(DUAL_NOZZLE_SLICE_INFO, 1)
  assert.ok(source)
  // Filament 1 (white, right nozzle) from a regular slot; filament 2 (red,
  // left nozzle) from the AMS HT — the exact shape of the failing prints.
  const fields = buildProjectFileMappingInfoFields([0, 128], source, new Map([[0, 'FFFFFFFF'], [128, '0A2CA5FF']]))
  assert.deepEqual(fields.amsMappingInfo, [
    {
      ams: 0,
      targetColor: 'FFFFFFFF',
      filamentId: 'GFA00',
      filamentType: 'PLA',
      nozzleId: 0,
      sourceColor: 'FFFFFFFF'
    },
    {
      ams: 128,
      targetColor: '0A2CA5FF',
      filamentId: 'GFA06',
      filamentType: 'PLA',
      nozzleId: 1,
      sourceColor: 'FF0000FF'
    }
  ])
  assert.deepEqual(fields.nozzlesInfo, [
    { id: 1, type: null, flowSize: 'high_flow', diameter: 0.4 },
    { id: 0, type: null, flowSize: 'high_flow', diameter: 0.4 }
  ])
})

test('buildProjectFileMappingInfoFields uses the default entry for pruned filaments and tolerates unknown trays', () => {
  const source = parsePlateSliceMappingSource(DUAL_NOZZLE_SLICE_INFO, 1)
  assert.ok(source)
  const fields = buildProjectFileMappingInfoFields([-1, 255], source, new Map())
  assert.deepEqual(fields.amsMappingInfo?.[0], { ams: -1, targetColor: '', filamentId: '', filamentType: '' })
  assert.deepEqual(fields.amsMappingInfo?.[1], {
    ams: 255,
    targetColor: '',
    filamentId: 'GFA06',
    filamentType: 'PLA',
    nozzleId: 1,
    sourceColor: 'FF0000FF'
  })
})

test('buildProjectFileMappingInfoFields is null for single-nozzle plates', () => {
  const source = parsePlateSliceMappingSource(DUAL_NOZZLE_SLICE_INFO, 2)
  assert.ok(source)
  const fields = buildProjectFileMappingInfoFields([4], source, new Map())
  assert.equal(fields.amsMappingInfo, null)
  assert.equal(fields.nozzlesInfo, null)
})
