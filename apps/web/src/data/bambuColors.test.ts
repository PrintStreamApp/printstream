import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bambuColorName, bambuColorsForMaterial, bambuMaterialFromPresetName, bambuMaterialFromType } from './bambuColors.js'

test('bambuColorName prefers a material-specific swatch when one is available', () => {
  assert.equal(bambuColorName('#FFFFFF', 'PETG Translucent'), 'Clear')
  assert.equal(bambuColorName('#FFFFFF', 'PC'), 'Transparent')
})

test('bambuMaterialFromPresetName recognizes newer BambuStudio material families', () => {
  assert.equal(bambuMaterialFromPresetName('Bambu PLA Silk+'), 'PLA Silk+')
  assert.equal(bambuMaterialFromPresetName('Bambu TPU for AMS'), 'TPU for AMS')
  assert.equal(bambuMaterialFromPresetName('Bambu Support for PLA/PETG'), 'Support for PLA/PETG')
})

test('bambuMaterialFromType and bambuColorsForMaterial expose the added swatches', () => {
  assert.equal(bambuMaterialFromType('PLA-S'), 'Support for PLA')
  assert.equal(bambuMaterialFromType('PLA Lite'), 'PLA Lite')
  assert.equal(bambuMaterialFromType('PC FR'), 'PC FR')
  assert.equal(
    bambuColorsForMaterial('PLA Lite').some((swatch) => swatch.name === 'Blue' && swatch.hex === '#004EA8'),
    true
  )
  assert.equal(
    bambuColorsForMaterial('TPU for AMS').some((swatch) => swatch.name === 'Neon Green' && swatch.hex === '#90FF1A'),
    true
  )
})