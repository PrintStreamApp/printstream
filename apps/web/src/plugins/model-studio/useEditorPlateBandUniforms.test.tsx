import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { INHERITED_PLATE_SETTINGS, type EditorPlate } from './lib/editorModel'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorPlateBandUniforms } = await import('./useEditorPlateBandUniforms')

afterEach(cleanup)
after(() => dom.window.close())

const plate: EditorPlate = {
  index: 1,
  plateId: 1,
  sourcePlateIndex: null,
  name: null,
  ...INHERITED_PLATE_SETTINGS,
  bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, maxZ: null, excludeAreas: [] },
  instances: [],
  primeTower: null,
  filamentChanges: [{ z: 2, filamentId: 2 }, { z: 1, filamentId: 1 }],
  pauses: [{ z: 3 }]
}

test('plate band uniforms follow sorted changes, overrides, and active-plate removal', () => {
  const resolveColorFilamentId = (id: number | null) => id
  const { result, rerender } = renderHook(
    ({ activePlate, filamentColors }: { activePlate: EditorPlate | null; filamentColors: Record<number, string> }) =>
      useEditorPlateBandUniforms({ activePlate, state: null, filamentColors, resolveColorFilamentId }),
    { initialProps: { activePlate: plate as EditorPlate | null, filamentColors: { 1: '#ff0000', 2: '#00ff00' } as Record<number, string> } }
  )
  const uniforms = result.current.current

  assert.equal(uniforms.uFcCount.value, 2)
  assert.deepEqual(uniforms.uFcHeights.value.slice(0, 2), [1, 2])
  assert.equal(uniforms.uFcColors.value[0]?.getHexString(), 'ff0000')
  assert.equal(uniforms.uFcColors.value[1]?.getHexString(), '00ff00')
  assert.equal(uniforms.uPauseCount.value, 1)
  assert.equal(uniforms.uPauseHeights.value[0], 3)

  rerender({
    activePlate: { ...plate, filamentChangesOverride: [{ z: 4, filamentId: 9 }], pausesOverride: [] },
    filamentColors: { 1: '#ff0000', 2: '#00ff00' }
  })
  assert.equal(result.current.current, uniforms)
  assert.equal(uniforms.uFcCount.value, 1)
  assert.equal(uniforms.uFcHeights.value[0], 4)
  assert.equal(uniforms.uFcColors.value[0]?.getHexString(), '9aa4ad')
  assert.equal(uniforms.uPauseCount.value, 0)

  rerender({ activePlate: null, filamentColors: {} })
  assert.equal(uniforms.uFcCount.value, 0)
  assert.equal(uniforms.uPauseCount.value, 0)
})
