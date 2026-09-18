import assert from 'node:assert/strict'
import test from 'node:test'
import { automaticSlotMaterial, genericSlotMaterial, inventorySlotMaterial, slotMaterialDraft } from './slotMaterialDraft'

test('fallbacks preserve reinforced material types and require a choice for unknown types', () => {
  assert.equal(genericSlotMaterial(' petg-cf ')?.type, 'PETG-CF')
  assert.notEqual(genericSlotMaterial('PETG-CF')?.presetId, genericSlotMaterial('PETG')?.presetId)
  assert.equal(genericSlotMaterial('My unusual polymer'), null)
})

test('manual identity never inherits a compatibility brand, product line, or stale inventory colour', () => {
  const materialIdentity = { brand: null, filamentType: 'Custom polymer', materialSubtype: null, colorName: 'Scarlet' }
  const draft = slotMaterialDraft({ trayName: null, materialIdentity, filamentType: 'PLA', color: '#FF0000', trayInfoIdx: 'GFA00',
    spool: { brand: 'Old brand', filamentType: 'ABS', materialSubtype: 'Old line', colorName: 'Blue', colorHex: '#0000FF' } })
  assert.deepEqual(draft, materialIdentity)
})

test('inventory and manual saves preserve explicit compatibility for unusual materials', () => {
  assert.deepEqual(inventorySlotMaterial('Custom polymer', 'GFA00'), { type: 'PLA', presetId: 'GFA00' })
  assert.deepEqual(inventorySlotMaterial('PETG-CF', 'GFA00'), genericSlotMaterial('PETG-CF'))
})

test('automatic presets prefer exact branded products and otherwise the same generic type', () => {
  assert.equal(automaticSlotMaterial({ brand: 'Polymaker', filamentType: 'PETG', materialSubtype: 'PolyLite PETG' })?.presetId, 'GFG60')
  assert.equal(automaticSlotMaterial({ brand: 'Bambu Lab', filamentType: 'PLA', materialSubtype: 'PLA Metal' })?.presetId, 'GFA02')
  assert.deepEqual(automaticSlotMaterial({ brand: 'Other', filamentType: 'PETG-CF', materialSubtype: 'Special' }), genericSlotMaterial('PETG-CF'))
  assert.equal(automaticSlotMaterial({ brand: 'Other', filamentType: 'Unknown polymer', materialSubtype: null }), null)
})
