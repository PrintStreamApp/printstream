import assert from 'node:assert/strict'
import { test } from 'node:test'
import { printerMaterialType } from './printerMaterialType'

test('library composites retain their printer material instead of falling back to base polymer', () => {
  assert.equal(printerMaterialType('PETG', 'PETG-CF'), 'PETG-CF')
  assert.equal(printerMaterialType('ABS', 'ABS-GF'), 'ABS-GF')
  assert.equal(printerMaterialType('PETG', 'PETG-ESD'), 'PETG-ESD')
  assert.equal(printerMaterialType('PETG', 'Experimental-CF'), 'EXPERIMENTAL-CF')
})

test('ordinary marketing subtypes and absent subtypes retain the base material', () => {
  assert.equal(printerMaterialType('PLA', 'Matte'), 'PLA')
  assert.equal(printerMaterialType('PETG', null), 'PETG')
  assert.equal(printerMaterialType(' petg ', 'petg-cf'), 'PETG-CF')
})
