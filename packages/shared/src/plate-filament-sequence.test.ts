/**
 * Bambu's compact per-plate filament-order fields are deliberately parsed defensively. A broken
 * range must fall back to Auto as a whole rather than leave a partially trusted order that names
 * the wrong physical material.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BAMBU_SEQUENCE_END_LAYER,
  parseFirstLayerFilamentSequence,
  parseOtherLayerFilamentSequences,
  reconcilePlateFilamentSequence,
  serializeOtherLayerFilamentSequences
} from './plate-filament-sequence.js'

test('the first-layer order reads positive physical filament ids', () => {
  assert.deepEqual(parseFirstLayerFilamentSequence(' 3  1 2 '), [3, 1, 2])
  assert.equal(parseFirstLayerFilamentSequence(undefined), null)
  assert.equal(parseFirstLayerFilamentSequence('0'), null, 'zero is Bambu\'s Auto sentinel')
  assert.equal(parseFirstLayerFilamentSequence('1 nope 2'), null)
  assert.equal(parseFirstLayerFilamentSequence('1 -2'), null)
})

test('other-layer orders split into equal-width ranges and decode End', () => {
  const encoded = `2 10 2 1 11 ${BAMBU_SEQUENCE_END_LAYER} 1 2`
  assert.deepEqual(parseOtherLayerFilamentSequences(encoded, '2'), [
    { startLayer: 2, endLayer: 10, filamentIds: [2, 1] },
    { startLayer: 11, endLayer: null, filamentIds: [1, 2] }
  ])
})

test('malformed other-layer metadata falls back to Auto atomically', () => {
  assert.equal(parseOtherLayerFilamentSequences('2 10 1 2', undefined), null)
  assert.equal(parseOtherLayerFilamentSequences('2 10 1 2', '2'), null, 'chunks need a range and an order')
  assert.equal(parseOtherLayerFilamentSequences('2 10 1 2', '1x'), null, 'the count must be an integer token')
  assert.equal(parseOtherLayerFilamentSequences('1 10 1 2', '1'), null, 'later ranges start at layer 2')
  assert.equal(parseOtherLayerFilamentSequences('5 4 1 2', '1'), null, 'a range cannot run backwards')
})

test('other-layer orders serialize with Bambu\'s open-ended sentinel', () => {
  assert.deepEqual(serializeOtherLayerFilamentSequences([
    { startLayer: 2, endLayer: 8, filamentIds: [2, 1] },
    { startLayer: 9, endLayer: null, filamentIds: [1, 2] }
  ]), {
    value: `2 8 2 1 9 ${BAMBU_SEQUENCE_END_LAYER} 1 2`,
    count: '2'
  })
  assert.equal(serializeOtherLayerFilamentSequences([]), null)
  assert.equal(serializeOtherLayerFilamentSequences([
    { startLayer: 2, endLayer: null, filamentIds: [1] },
    { startLayer: 3, endLayer: null, filamentIds: [1, 2] }
  ]), null, 'every chunk must have the same width')
})

test('material-list changes preserve the surviving custom order and append new ids', () => {
  assert.deepEqual(reconcilePlateFilamentSequence([3, 1, 2], [1, 3, 4]), [3, 1, 4])
  assert.deepEqual(reconcilePlateFilamentSequence([2, 2, 99, 1], [1, 2, 3]), [2, 1, 3])
})
