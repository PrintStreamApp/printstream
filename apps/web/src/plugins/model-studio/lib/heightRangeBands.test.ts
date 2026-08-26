import assert from 'node:assert/strict'
import test from 'node:test'
import { MIN_BAND_HEIGHT_MM, nextBandSlot } from './heightRangeBands'
import type { EditorHeightRange } from './editorModel'

function band(minZ: number, maxZ: number): EditorHeightRange {
  return { minZ, maxZ, settings: { layer_height: '0.2', extruder: '0' } }
}

test('the first band starts at the object base, BambuStudio-style 2mm tall', () => {
  assert.deepEqual(nextBandSlot([], 50), { minZ: 0, maxZ: 2 })
})

test('a new band stacks on top of the highest existing one', () => {
  assert.deepEqual(nextBandSlot([band(0, 2), band(2, 5)], 50), { minZ: 5, maxZ: 7 })
  // Order of the input must not matter: the slot follows the highest top, not the last entry.
  assert.deepEqual(nextBandSlot([band(2, 5), band(0, 2)], 50), { minZ: 5, maxZ: 7 })
})

test('a new band is clipped to the object height rather than overhanging it', () => {
  // 1mm of model left, so the band is 1mm rather than the default 2mm.
  assert.deepEqual(nextBandSlot([band(0, 9)], 10), { minZ: 9, maxZ: 10 })
})

test('no slot is offered when the model has no room left', () => {
  // BambuStudio leaves its + enabled here and then silently does nothing.
  assert.equal(nextBandSlot([band(0, 10)], 10), null)
  assert.equal(nextBandSlot([band(0, 9.99)], 10), null, 'a sliver too thin to hold a layer is not a slot')
})

test('an unknown object height still allows a band', () => {
  // maxZ unknown (an import we have not measured) must not block the feature.
  assert.deepEqual(nextBandSlot([], null), { minZ: 0, maxZ: 2 })
  assert.deepEqual(nextBandSlot([band(0, 4)], null), { minZ: 4, maxZ: 6 })
})

test('the minimum band height is small enough for a fine layer but non-zero', () => {
  // A zero-height band is representable in the file and silently dropped by the slicer.
  assert.ok(MIN_BAND_HEIGHT_MM > 0)
  assert.ok(MIN_BAND_HEIGHT_MM <= 0.05, 'must not exclude the finest layer heights people use')
})
