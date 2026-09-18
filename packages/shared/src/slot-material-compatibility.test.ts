import assert from 'node:assert/strict'
import test from 'node:test'
import { BAMBU_FILAMENT_PRESETS } from './filament-setup-catalog.js'
import { slotMaterialAllowsPreset, slotMaterialCompatibilityError } from './slot-material-compatibility.js'

const presetId = (type: string) => BAMBU_FILAMENT_PRESETS.find((preset) => preset.name === `Generic ${type}`)!.id

test('manual and reopened composite assignments only offer their exact material type', () => {
  for (const type of ['PETG-CF', 'PLA-CF', 'PA6-GF']) {
    const allowed = BAMBU_FILAMENT_PRESETS.filter((preset) => slotMaterialAllowsPreset(` ${type.toLowerCase()} `, preset.type))
    assert.ok(allowed.length > 0)
    assert.ok(allowed.every((preset) => preset.type === type))
    assert.match(slotMaterialCompatibilityError(type, 'PLA', presetId('PLA'))!, /must preserve the material type/)
  }
  assert.equal(slotMaterialCompatibilityError(' petg-cf ', 'PETG-CF', presetId('PETG-CF')), null)
})

test('a forged hardware type cannot conceal the known preset actual type', () => {
  assert.match(slotMaterialCompatibilityError('PETG-CF', 'PETG-CF', presetId('PLA'))!, /does not match/)
  assert.match(slotMaterialCompatibilityError(null, 'PETG-CF', presetId('PLA'))!, /does not match/)
})

test('unknown physical types retain explicit compatibility choices without implicit PLA defaults', () => {
  assert.equal(slotMaterialAllowsPreset('Unusual polymer', 'PLA'), true)
  assert.equal(slotMaterialCompatibilityError('Unusual polymer', 'PLA', presetId('PLA')), null)
  assert.match(slotMaterialCompatibilityError('Unusual polymer', 'PLA', '')!, /custom material type/)
  assert.match(slotMaterialCompatibilityError('Unusual polymer', '', '')!, /Choose a compatible/)
})

test('matching known types permit custom presets, but not mismatches or blank identity', () => {
  assert.equal(slotMaterialCompatibilityError('PETG-CF', 'PETG-CF', 'user-custom-id'), null)
  assert.equal(slotMaterialCompatibilityError('PHA', 'PHA', ''), null)
  assert.match(slotMaterialCompatibilityError('PETG-CF', 'PETG', '')!, /must preserve/)
  assert.match(slotMaterialCompatibilityError('', 'PLA', presetId('PLA'))!, /Enter a material/)
})

test('legacy commands without physical identity retain support for vendor custom types', () => {
  assert.equal(slotMaterialCompatibilityError(null, 'Vendor-specific type', 'custom-id'), null)
})
