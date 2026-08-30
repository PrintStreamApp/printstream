import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectivePartFilamentId, summarizeInstanceMaterial } from './lib/editorModel'
import type { EditorInstance } from './lib/editorModel'

const identity = (id: number | null) => id
const passthroughColor = (_id: number | null, fallback: string | null) => fallback

/**
 * The resolver every editor surface actually passes: it exists to recolour a DANGLING filament id
 * (one whose material the user removed) and therefore answers with the project's first material for
 * anything it does not recognise, INCLUDING null. Tests use it wherever the point is that an
 * unassigned part must not reach it.
 */
const resolveAgainstProject = (ids: number[]) => (id: number | null) => (id != null && ids.includes(id) ? id : ids[0] ?? null)

function instance(
  parts: Array<{ filamentId: number | null; color: string | null; subtype?: string | null }>,
  own?: { filamentId: number | null; color: string | null }
): EditorInstance {
  return {
    ...(own ?? { filamentId: 1, color: '#ffffff' }),
    parts: parts.map((part, index) => ({ ...part, componentObjectId: index + 1 }))
  } as unknown as EditorInstance
}

test('a single-part object reports its own material', () => {
  const result = summarizeInstanceMaterial(instance([{ filamentId: 2, color: '#00ff00' }], { filamentId: 2, color: '#00ff00' }), identity, passthroughColor)
  assert.equal(result.uniformId, 2)
  assert.equal(result.mixedColors, undefined)
})

test('a multi-part object whose parts agree reports that one material (not the old bare "+")', () => {
  const result = summarizeInstanceMaterial(
    instance([{ filamentId: 3, color: '#0000ff' }, { filamentId: 3, color: '#0000ff' }]),
    identity,
    passthroughColor
  )
  assert.equal(result.uniformId, 3)
  assert.equal(result.mixedColors, undefined)
})

test('a multi-part object whose parts name no material reports the OBJECT\'s material, not the project\'s first', () => {
  // What Replace object produces: the replacement's solids are all unassigned, and the object
  // carries the material the replaced object printed in. The bake writes that object material onto
  // every unassigned solid, so the badge must say the same thing rather than reporting material 1.
  const result = summarizeInstanceMaterial(
    instance(
      [{ filamentId: null, color: null }, { filamentId: null, color: null }, { filamentId: null, color: null }],
      { filamentId: 5, color: '#ffffff' }
    ),
    resolveAgainstProject([1, 2, 3, 4, 5]),
    passthroughColor
  )
  assert.equal(result.uniformId, 5)
  assert.equal(result.mixedColors, undefined)
})

test('an unassigned part alongside an assigned one on the same material stays uniform', () => {
  // Both resolve to 4, so the object is uniform. Resolving the bare null would have made this read
  // as mixed (4 and 1) and shown the indeterminate two-band swatch.
  const result = summarizeInstanceMaterial(
    instance([{ filamentId: 4, color: '#123456' }, { filamentId: null, color: null }], { filamentId: 4, color: null }),
    resolveAgainstProject([1, 2, 3, 4]),
    passthroughColor
  )
  assert.equal(result.uniformId, 4)
  assert.equal(result.mixedColors, undefined)
})

test('effectivePartFilamentId inherits the object material only for parts that can carry one', () => {
  assert.equal(effectivePartFilamentId({ filamentId: null, subtype: null }, 5), 5)
  assert.equal(effectivePartFilamentId({ filamentId: null, subtype: 'modifier_part' }, 5), 5)
  // An explicit choice always wins over the object's.
  assert.equal(effectivePartFilamentId({ filamentId: 2, subtype: null }, 5), 2)
  // Helper volumes have no material and must never inherit one: BambuStudio writes extruder 0.
  assert.equal(effectivePartFilamentId({ filamentId: null, subtype: 'support_blocker' }, 5), null)
  assert.equal(effectivePartFilamentId({ filamentId: null, subtype: 'negative_part' }, 5), null)
  // Nothing to inherit is still nothing: an unassigned part of an unassigned object.
  assert.equal(effectivePartFilamentId({ filamentId: null, subtype: null }, null), null)
})

test('a multi-part object with differing parts is indeterminate, with one band per distinct material in list order', () => {
  const result = summarizeInstanceMaterial(
    instance([
      { filamentId: 1, color: '#ff0000' },
      { filamentId: 2, color: '#00ff00' },
      // Repeat of material 1 must not add a second band.
      { filamentId: 1, color: '#ff0000' }
    ]),
    identity,
    passthroughColor
  )
  assert.equal(result.uniformId, null)
  assert.deepEqual(result.mixedColors, ['#ff0000', '#00ff00'])
})
