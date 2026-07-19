import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeInstanceMaterial } from './lib/editorModel'
import type { EditorInstance } from './lib/editorModel'

const identity = (id: number | null) => id
const passthroughColor = (_id: number | null, fallback: string | null) => fallback

function instance(parts: Array<{ filamentId: number | null; color: string | null }>, own?: { filamentId: number | null; color: string | null }): EditorInstance {
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
