/**
 * The channel-name to 3MF-attribute map, and the reason fuzzy skin is its OWN channel.
 *
 * BambuStudio gives fuzzy skin the same underlying value as a support enforcer
 * (`FUZZY_SKIN = ENFORCER`, `Model.hpp:719`), which makes it tempting to fold the two together.
 * The ATTRIBUTES are separate (`paint_supports` vs `paint_fuzzy_skin`, `bbs_3mf.cpp:295`), so a
 * triangle can legitimately be both, and sharing one map or one attribute would make painting
 * either channel silently erase the other.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAINT_ATTRIBUTE_BY_CHANNEL } from './bake-documents'
import { sceneEditSchema } from '../slicing'

test('every paint channel maps to its own distinct 3MF attribute', () => {
  assert.deepEqual(PAINT_ATTRIBUTE_BY_CHANNEL, {
    support: 'paint_supports',
    seam: 'paint_seam',
    color: 'paint_color',
    fuzzy: 'paint_fuzzy_skin'
  })
  const attributes = Object.values(PAINT_ATTRIBUTE_BY_CHANNEL)
  assert.equal(new Set(attributes).size, attributes.length, 'two channels share an attribute')
})

test('fuzzy skin does NOT share the support attribute, despite sharing Studio\'s enum value', () => {
  assert.notEqual(PAINT_ATTRIBUTE_BY_CHANNEL.fuzzy, PAINT_ATTRIBUTE_BY_CHANNEL.support)
})

test('the edit carries fuzzy paint as its own seam, so it survives a save', () => {
  const parsed = sceneEditSchema.parse({
    plates: [{ index: 1 }],
    instances: [],
    supportPaint: [{ objectId: 5, componentObjectId: 5, triangles: { 0: '4' } }],
    fuzzyPaint: [{ objectId: 5, componentObjectId: 5, triangles: { 1: '4' } }]
  })
  // Both present and independent: the same part can carry support paint AND fuzzy paint.
  assert.deepEqual(parsed.supportPaint?.[0]?.triangles, { 0: '4' })
  assert.deepEqual(parsed.fuzzyPaint?.[0]?.triangles, { 1: '4' })
})

test('an import can be painted fuzzy before it has ever been saved', () => {
  // Same "no feature may require a save first" rule the other channels follow.
  const parsed = sceneEditSchema.parse({
    plates: [{ index: 1 }],
    instances: [],
    importPaint: [{ importId: 'imp-1', partIndex: 0, channel: 'fuzzy', triangles: { 2: '4' } }]
  })
  assert.equal(parsed.importPaint?.[0]?.channel, 'fuzzy')
})
