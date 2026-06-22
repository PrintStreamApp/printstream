import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bedSizeFromPrintableArea, buildObjectPlateIndex, plateColumnCount, plateRecenterOffset, recenterBuildItemsXml } from './recenter-plates.js'

const P1S = { width: 256, depth: 256 }
const H2D = { width: 350, depth: 320 }

test('plateColumnCount matches BambuStudio grid (ceil-ish sqrt)', () => {
  assert.equal(plateColumnCount(1), 1)
  assert.equal(plateColumnCount(2), 2) // sqrt 1.41 -> 2
  assert.equal(plateColumnCount(4), 2)
  assert.equal(plateColumnCount(9), 3)
  assert.equal(plateColumnCount(12), 4) // sqrt 3.46 -> 4
})

test('plateRecenterOffset reproduces BambuStudio P1S->H2D plate-2 shift', () => {
  const near = ([dx, dy]: [number, number], ex: number, ey: number) => {
    assert.ok(Math.abs(dx - ex) < 1e-9, `dx ${dx} ~ ${ex}`)
    assert.ok(Math.abs(dy - ey) < 1e-9, `dy ${dy} ~ ${ey}`)
  }
  // plate index 1 (Plate 2), 2 plates: col=1, row=0 -> dx=(350-256)*1.7=159.8, dy=(320-256)*0.5=32
  near(plateRecenterOffset(1, 2, P1S, H2D), 159.8, 32)
  // plate index 0 (Plate 1): col=0,row=0 -> dx=94*0.5=47, dy=64*0.5=32
  near(plateRecenterOffset(0, 2, P1S, H2D), 47, 32)
})

test('plateRecenterOffset is zero when the bed is unchanged', () => {
  assert.deepEqual(plateRecenterOffset(1, 4, H2D, H2D), [0, 0])
})

test('recenterBuildItemsXml shifts plate-2 build items by the plate offset (446.8->606.6)', () => {
  const model = [
    '<model><build>',
    '  <item objectid="2" transform="0.7 0.7 0 -0.7 0.7 0 0 0 1 446.847884 114.605651 26.6"/>',
    '  <item objectid="4" transform="1 0 0 0 1 0 0 0 1 122.5 133.4 26.6"/>', // plate 1
    '</build></model>'
  ].join('\n')
  const objectPlateIndex = new Map([[2, 1], [4, 0]]) // obj 2 -> plate index 1, obj 4 -> plate 0
  const out = recenterBuildItemsXml(model, objectPlateIndex, 2, P1S, H2D)
  // obj 2 (plate 2): tx 446.847884 + 159.8 = 606.647884 ; ty 114.605651 + 32 = 146.605651
  assert.match(out, /<item objectid="2"[^>]*transform="[^"]*\b606\.647884 146\.605651 26\.6"/)
  // obj 4 (plate 1): tx 122.5 + 47 = 169.5 ; ty 133.4 + 32 = 165.4
  assert.match(out, /<item objectid="4"[^>]*transform="[^"]*\b169\.5 165\.4 26\.6"/)
})

test('recenterBuildItemsXml is a no-op for the same bed', () => {
  const model = '<model><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></build></model>'
  assert.equal(recenterBuildItemsXml(model, new Map([[2, 1]]), 2, H2D, H2D), model)
})

test('buildObjectPlateIndex maps object_id to 0-based plate + counts plates', () => {
  const settings = [
    '<config>',
    '  <plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="4"/></model_instance></plate>',
    '  <plate><metadata key="plater_id" value="2"/>',
    '    <model_instance><metadata key="object_id" value="2"/></model_instance>',
    '    <model_instance><metadata key="object_id" value="3"/></model_instance>',
    '  </plate>',
    '</config>'
  ].join('\n')
  const { objectPlateIndex, plateCount } = buildObjectPlateIndex(settings)
  assert.equal(plateCount, 2)
  assert.equal(objectPlateIndex.get(4), 0)
  assert.equal(objectPlateIndex.get(2), 1)
  assert.equal(objectPlateIndex.get(3), 1)
})

test('bedSizeFromPrintableArea parses a Bambu rectangle', () => {
  assert.deepEqual(bedSizeFromPrintableArea(['0x0', '350x0', '350x320', '0x320']), { width: 350, depth: 320 })
  assert.equal(bedSizeFromPrintableArea(['0x0']), null)
  assert.equal(bedSizeFromPrintableArea('nope'), null)
})
