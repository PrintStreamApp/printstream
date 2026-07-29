import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultPlateName, plateDisplayName, resolvePlateRename } from './plateName'

/**
 * The rename prompt starts pre-filled with what the strip shows, so the two must agree on what an
 * unnamed plate is called AND on the fact that confirming that default still means "unnamed".
 */

test('an unnamed plate reads as its default label', () => {
  assert.equal(plateDisplayName(null, 2), 'Plate 2')
  assert.equal(plateDisplayName('   ', 2), 'Plate 2')
})

test('a named plate reads as its trimmed name', () => {
  assert.equal(plateDisplayName('  Lid  ', 1), 'Lid')
})

test('confirming the pre-filled default leaves the plate unnamed', () => {
  assert.equal(resolvePlateRename(defaultPlateName(3), 3), null)
  assert.equal(resolvePlateRename(`  ${defaultPlateName(3)}  `, 3), null)
})

test('clearing the field unnames the plate', () => {
  assert.equal(resolvePlateRename('', 1), null)
  assert.equal(resolvePlateRename('   ', 1), null)
})

test('another plate number typed in is a real name, not the default', () => {
  assert.equal(resolvePlateRename('Plate 4', 3), 'Plate 4')
})

test('a typed name is stored trimmed', () => {
  assert.equal(resolvePlateRename('  Lid  ', 1), 'Lid')
})
