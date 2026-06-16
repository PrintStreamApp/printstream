import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryThreeMfPrimeTowerSizing } from '@printstream/shared'
import { estimateWipeTowerFootprint, wipeTowerMinDepth } from './primeTower'

const BAMBU_DEFAULTS: LibraryThreeMfPrimeTowerSizing = {
  wipeVolume: 45,
  layerHeight: 0.2,
  infillGap: 1.5,
  ribWall: true,
  ribWidth: 8,
  extraRibLength: 0,
  extruderCount: 1,
  needWipeTower: false
}

test('wipeTowerMinDepth clamps below the first and above the last table entry', () => {
  assert.equal(wipeTowerMinDepth(0), 5)
  assert.equal(wipeTowerMinDepth(5), 5)
  assert.equal(wipeTowerMinDepth(500), 60)
})

test('wipeTowerMinDepth linearly interpolates between table entries', () => {
  // Between (5,5) and (100,20): at 50mm -> 5 + (45/95)*15.
  assert.ok(Math.abs(wipeTowerMinDepth(50) - (5 + (45 / 95) * 15)) < 1e-9)
})

test('estimateWipeTowerFootprint matches BambuStudio rib-wall estimate for a 2-filament plate', () => {
  // volume = 45 * (2-1) = 45; depth = sqrt(45/0.2 * 1.5) = sqrt(337.5) ~= 18.371.
  // forced (count > 1): min depth at 40mm tall ~= 5 + (35/95)*15 = 10.526 (< 18.371, so depth stays).
  // ribWidth = min(8, depth/2) = 8; depth = 8/sqrt(2) + max(18.371, 18.371) ~= 5.657 + 18.371 = 24.028.
  const { width, depth } = estimateWipeTowerFootprint(BAMBU_DEFAULTS, 35, 2, 40)
  assert.equal(width, depth) // rib walls -> square
  assert.ok(Math.abs(depth - 24.028) < 0.05, `expected ~24.03, got ${depth}`)
  // The whole point of the fix: smaller than the old prime_tower_width (35) square.
  assert.ok(depth < 35)
})

test('estimateWipeTowerFootprint grows with filament count', () => {
  const two = estimateWipeTowerFootprint(BAMBU_DEFAULTS, 35, 2, 40).depth
  const four = estimateWipeTowerFootprint(BAMBU_DEFAULTS, 35, 4, 40).depth
  assert.ok(four > two)
})

test('estimateWipeTowerFootprint non-rib uses prime_tower_width for X and a computed depth for Y', () => {
  const sizing = { ...BAMBU_DEFAULTS, ribWall: false }
  const { width, depth } = estimateWipeTowerFootprint(sizing, 35, 2, 40)
  assert.equal(width, 35)
  // depth = volume/(layerHeight*w) * gap = 45/(0.2*35)*1.5 = 9.643, floored by min depth (~10.526).
  assert.ok(Math.abs(depth - 10.526) < 0.05, `expected ~10.53 (min-depth floor), got ${depth}`)
})

test('estimateWipeTowerFootprint falls back to a width square when no filaments are purged', () => {
  assert.deepEqual(estimateWipeTowerFootprint(BAMBU_DEFAULTS, 35, 0, 40), { width: 35, depth: 35 })
})
