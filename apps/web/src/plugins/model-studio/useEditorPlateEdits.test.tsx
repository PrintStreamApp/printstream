import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { INHERITED_PLATE_SETTINGS, type EditorPlate, type EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorPlateEdits } = await import('./useEditorPlateEdits')

afterEach(cleanup)
after(() => dom.window.close())

function plate(index: number): EditorPlate {
  return {
    index,
    plateId: index,
    sourcePlateIndex: null,
    name: null,
    ...INHERITED_PLATE_SETTINGS,
    bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, maxZ: null, excludeAreas: [] },
    instances: [],
    primeTower: null,
    filamentChanges: [],
    pauses: []
  }
}

test('plate writer checkpoints edits and invalidates only the requested scene path', () => {
  let checkpoints = 0
  const initial = { plates: [plate(1), plate(2)], removedEmbeddedPresets: ['keep'] } as EditorState
  const view = renderHook(({ index }: { index: number }) => {
    const [state, setState] = useState<EditorState | null>(initial)
    const [rebuilds, setRebuilds] = useState(0)
    const [transforms, setTransforms] = useState(0)
    const [materials, setMaterials] = useState(0)
    const edits = useEditorPlateEdits({
      activePlateIndex: index,
      recordHistory: () => { checkpoints += 1 },
      setState,
      setRebuildToken: setRebuilds,
      setTransformSyncToken: setTransforms,
      setMaterialSyncToken: setMaterials
    })
    return { state, rebuilds, transforms, materials, ...edits }
  }, { initialProps: { index: 1 } })

  act(() => view.result.current.setActivePlateFilamentChanges([{ z: 1, filamentId: 2 }]))
  assert.equal(view.result.current.state?.plates[0]?.filamentChangesOverride?.[0]?.filamentId, 2)
  assert.equal(view.result.current.state?.plates[1]?.filamentChangesOverride, undefined)
  assert.deepEqual([view.result.current.rebuilds, view.result.current.transforms, view.result.current.materials], [0, 0, 0])
  assert.equal(checkpoints, 1)

  view.rerender({ index: 2 })
  act(() => view.result.current.setActivePlatePauses([{ z: 4 }]))
  assert.equal(view.result.current.state?.plates[1]?.pausesOverride?.[0]?.z, 4)
  assert.equal(checkpoints, 2)

  act(() => view.result.current.updatePlates((plates) => plates, 'transform', { recordHistory: false }))
  act(() => view.result.current.updatePlates((plates) => plates, 'material'))
  act(() => view.result.current.updatePlates((plates) => plates, 'visibility'))
  act(() => view.result.current.updatePlates((plates) => plates))
  assert.deepEqual([view.result.current.rebuilds, view.result.current.transforms, view.result.current.materials], [1, 1, 1])
  assert.equal(checkpoints, 5)
  assert.deepEqual(view.result.current.state?.removedEmbeddedPresets, ['keep'])
})
