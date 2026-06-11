import assert from 'node:assert/strict'
import test from 'node:test'
import { bambuModelKeysAreCompatible, canonicalBambuModelKey, normalizeBambuStudioPrinterModelOption, resolveBambuPrinterModelAliases } from './bambuPrinterModels.js'

test('normalizeBambuStudioPrinterModelOption maps raw H2D ids to the H2D label', () => {
  assert.equal(normalizeBambuStudioPrinterModelOption('O1D'), 'H2D')
  assert.equal(normalizeBambuStudioPrinterModelOption('BL-D001'), 'H2D')
})

test('resolveBambuPrinterModelAliases includes raw slicer ids for H2D matching', () => {
  assert.deepEqual(resolveBambuPrinterModelAliases('H2D'), ['H2D', 'O1D', 'BL-D001'])
})

test('canonicalBambuModelKey keeps H2D and H2D Pro distinct', () => {
  assert.equal(canonicalBambuModelKey('Bambu Lab H2D 0.4 nozzle'), 'H2D')
  assert.equal(canonicalBambuModelKey('Bambu Lab H2D Pro 0.4 nozzle'), 'H2DPRO')
  assert.equal(canonicalBambuModelKey('H2DP'), 'H2DPRO')
  assert.equal(canonicalBambuModelKey('Qidi X-Plus 4 0.4 nozzle'), null)
  assert.equal(canonicalBambuModelKey('unknown'), null)
})

test('bambuModelKeysAreCompatible rejects an H2D Pro profile for an H2D printer', () => {
  assert.equal(bambuModelKeysAreCompatible('H2D', 'H2DPRO'), false)
  assert.equal(bambuModelKeysAreCompatible('H2D', 'H2D'), true)
})

test('bambuModelKeysAreCompatible treats the X1C-class family as compatible', () => {
  assert.equal(bambuModelKeysAreCompatible('P1P', 'X1C'), true)
  assert.equal(bambuModelKeysAreCompatible('P1S', 'X1C'), true)
  assert.equal(bambuModelKeysAreCompatible('X1E', 'X1'), true)
})

test('bambuModelKeysAreCompatible does not gate unknown/non-Bambu models', () => {
  assert.equal(bambuModelKeysAreCompatible(null, 'H2D'), true)
  assert.equal(bambuModelKeysAreCompatible('H2D', null), true)
})

test('bambuModelKeysAreCompatible rejects unrelated Bambu models', () => {
  assert.equal(bambuModelKeysAreCompatible('A1', 'A1MINI'), false)
  assert.equal(bambuModelKeysAreCompatible('H2D', 'X1C'), false)
})