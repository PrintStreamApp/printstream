import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import type { LibraryThreeMfScene } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { partSlotKey, seedEmptyEditorState, type EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorProcessOverrideHydration } = await import('./useEditorProcessOverrideHydration')

afterEach(cleanup)
after(() => dom.window.close())

function scene(objectSpeed: string, partHeight: string): LibraryThreeMfScene {
  return {
    instances: [{
      objectId: 12,
      processOverrides: { speed: objectSpeed },
      parts: [{ processOverrides: { layer_height: partHeight } }]
    }]
  } as unknown as LibraryThreeMfScene
}

test('saved object and part overrides seed once, then preserve session edits', () => {
  const perObject = {
    value: {} as Record<string, Record<string, string | string[]>>,
    onChange(value: Record<string, Record<string, string | string[]>>) {
      perObject.value = value
    }
  }
  const sliceConfigRef = {
    current: { perObjectSettings: perObject } as SliceSettingsController
  }
  const view = renderHook(() => {
    const [state, setState] = useState<EditorState | null>(seedEmptyEditorState)
    const stateRef = useRef(state)
    stateRef.current = state
    const [scenesByPlate, setScenesByPlate] = useState(
      () => new Map([[1, scene('50', '0.20')]])
    )
    useEditorProcessOverrideHydration({ scenesByPlate, sliceConfigRef, stateRef, setState })
    return { state, setState, setScenesByPlate }
  })
  const partKey = partSlotKey(12, 0)
  assert.deepEqual(perObject.value['12'], { speed: '50' })
  assert.deepEqual(view.result.current.state?.partProcessOverrides?.[partKey], { layer_height: '0.20' })

  act(() => {
    perObject.value = { '12': { speed: '65' } }
    view.result.current.setState((state) => state ? {
      ...state,
      partProcessOverrides: { [partKey]: { layer_height: '0.35' } }
    } : state)
    view.result.current.setScenesByPlate(new Map([[1, scene('30', '0.10')]]))
  })
  assert.deepEqual(perObject.value['12'], { speed: '65' })
  assert.deepEqual(view.result.current.state?.partProcessOverrides?.[partKey], { layer_height: '0.35' })
})
