/**
 * A part-scoped edit addresses a volume by ORDINAL, and that ordinal is a position in the object's
 * `<component>` list (the scene parser walks components and pairs each with its `<part>` metadata by
 * mesh id). The writers then have to find the `<part>` describing that volume.
 *
 * They used to assume the two lists are a positional mirror. Usually they are, and nothing asserted
 * it, so a file where they are not, a foreign export, or an object `applyPartLayout` deliberately
 * left un-permuted because the lists were different lengths, silently landed every per-part
 * material, subtype, override and matrix on the wrong volume, and every later save re-applied the
 * same skew.
 *
 * These pin BambuStudio's actual rule (`_generate_volumes_new`): positional, GUARDED by an id
 * check, then a linear id search, then nothing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPartTypeChanges, parseObjectComponentIds, resolvePartBlockIndex } from './bake-documents.js'

test('resolvePartBlockIndex: a mirrored object resolves to the ordinal itself', () => {
  // The overwhelmingly common shape, and the one that must not change behaviour.
  assert.equal(resolvePartBlockIndex(0, [20, 21, 22], [20, 21, 22]), 0)
  assert.equal(resolvePartBlockIndex(2, [20, 21, 22], [20, 21, 22]), 2)
})

test('resolvePartBlockIndex: a non-mirrored part list is found by id', () => {
  // Components say volume 0 is mesh 20, but `<part id="20">` sits third.
  assert.equal(resolvePartBlockIndex(0, [20, 21, 22], [21, 22, 20]), 2)
  assert.equal(resolvePartBlockIndex(1, [20, 21, 22], [21, 22, 20]), 0)
})

test('resolvePartBlockIndex: positional wins over the id search for volumes sharing a mesh', () => {
  // BambuStudio writes ONE id for every volume sharing a mesh (`m_share_mesh`), so an id-FIRST
  // lookup would collapse these three distinct volumes onto the first of them.
  assert.equal(resolvePartBlockIndex(0, [20, 20, 20], [20, 20, 20]), 0)
  assert.equal(resolvePartBlockIndex(1, [20, 20, 20], [20, 20, 20]), 1)
  assert.equal(resolvePartBlockIndex(2, [20, 20, 20], [20, 20, 20]), 2)
})

test('resolvePartBlockIndex: an inline-mesh object has no components, so its parts ARE the volumes', () => {
  assert.equal(resolvePartBlockIndex(0, [], [7]), 0)
  assert.equal(resolvePartBlockIndex(1, undefined, [7, 8]), 1)
})

test('resolvePartBlockIndex: a volume no part describes resolves to nothing', () => {
  // Skipping is the point: writing onto an unrelated block is the corruption. BambuStudio reads
  // such a volume with default settings, so this matches what the engine already does.
  assert.equal(resolvePartBlockIndex(1, [20, 21], [20]), null)
  // An ordinal past the end of the volume list names no volume at all.
  assert.equal(resolvePartBlockIndex(5, [20, 21], [20, 21]), null)
})

test('parseObjectComponentIds reads each object\'s volume list in document order', () => {
  const modelXml = [
    '<model><resources>',
    ' <object id="5" type="model"><components>',
    '  <component objectid="22"/><component objectid="20"/><component objectid="21"/>',
    ' </components></object>',
    ' <object id="6" type="model"><mesh/></object>',
    '</resources></model>'
  ].join('\n')
  const ids = parseObjectComponentIds(modelXml)
  assert.deepEqual(ids.get(5), [22, 20, 21])
  // An inline-mesh object declares none, which is what makes its `<part>` list the volume list.
  assert.deepEqual(ids.get(6), [])
})

const NON_MIRRORED_MODEL = [
  '<model><resources>',
  ' <object id="3" type="model"><components>',
  '  <component objectid="20"/><component objectid="21"/><component objectid="22"/>',
  ' </components></object>',
  '</resources></model>'
].join('\n')

/** The SAME three volumes, listed in a different order: exactly what the old writers mis-read. */
const NON_MIRRORED_SETTINGS = [
  '<config>',
  ' <object id="3">',
  '  <part id="22" subtype="normal_part"><metadata key="name" value="C"/></part>',
  '  <part id="20" subtype="normal_part"><metadata key="name" value="A"/></part>',
  '  <part id="21" subtype="normal_part"><metadata key="name" value="B"/></part>',
  ' </object>',
  '</config>'
].join('\n')

const subtypeOf = (xml: string, partId: number): string | null =>
  new RegExp(`<part id="${partId}" subtype="([^"]*)"`).exec(xml)?.[1] ?? null

test('a part-type change lands on the volume its ordinal names, not the block in that position', () => {
  // Volume 0 is mesh 20 ("A"), which sits SECOND in the settings list.
  const out = applyPartTypeChanges(
    NON_MIRRORED_SETTINGS,
    [{ objectId: 3, partIndex: 0, subtype: 'modifier_part' }] as never,
    NON_MIRRORED_MODEL
  )
  assert.equal(subtypeOf(out, 20), 'modifier_part')
  // The block that merely occupied position 0 must be untouched.
  assert.equal(subtypeOf(out, 22), 'normal_part')
  assert.equal(subtypeOf(out, 21), 'normal_part')
})

test('a mirrored object is rewritten exactly as before', () => {
  const modelXml = [
    '<model><resources>',
    ' <object id="3" type="model"><components>',
    '  <component objectid="20"/><component objectid="21"/>',
    ' </components></object>',
    '</resources></model>'
  ].join('\n')
  const settingsXml = [
    '<config>',
    ' <object id="3">',
    '  <part id="20" subtype="normal_part"><metadata key="name" value="A"/></part>',
    '  <part id="21" subtype="normal_part"><metadata key="name" value="B"/></part>',
    ' </object>',
    '</config>'
  ].join('\n')
  const out = applyPartTypeChanges(settingsXml, [{ objectId: 3, partIndex: 1, subtype: 'negative_part' }] as never, modelXml)
  assert.equal(subtypeOf(out, 21), 'negative_part')
  assert.equal(subtypeOf(out, 20), 'normal_part')
})
