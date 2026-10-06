import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import type { SceneEdit } from '@printstream/shared'
import type { FilamentConfigResolver } from '../../components/library/FilamentSettingsDialog'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorMaterials } from './lib/editorMaterials'
import type { EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorFilamentSaveAuthoring } = await import('./useEditorFilamentSaveAuthoring')

afterEach(cleanup)
after(() => dom.window.close())

function materials(ids: number[]): EditorMaterials {
  return { options: ids.map((id) => ({ id })), colorById: {} } as EditorMaterials
}

test('save and slice authoring rekeys repair pins and preset choices into baked slot order', async () => {
  const requests: Array<{ filamentProfileId: string; projectFilamentId: number | null }> = []
  const resolver: FilamentConfigResolver = async (request) => {
    requests.push(request)
    return { config: { nozzle_temperature: ['220'] } } as never
  }
  const controller = {
    projectFilaments: [{ projectFilamentId: 3 }, { projectFilamentId: 1 }],
    filamentMaterialOptionIds: { 3: 'petg-option', 1: 'pla-option' },
    materialOptions: [
      { id: 'petg-option', profileId: 'petg-preset' },
      { id: 'pla-option', profileId: 'pla-preset' }
    ],
    selectedSlicerTargetId: 'target-1'
  } as unknown as SliceSettingsController
  const pinned = { nozzle_temperature: ['245'] }
  const initial = {
    plates: [],
    repairedFilamentConfigs: { 3: { config: pinned, inherits: 'PETG base', changedKeys: ['nozzle_temperature'] } }
  } as unknown as EditorState
  const view = renderHook(() => {
    const [state, setState] = useState<EditorState | null>(initial)
    const stateRef = useRef(state)
    stateRef.current = state
    const sliceConfigRef = useRef<SliceSettingsController | undefined>(controller)
    const [, setMaterialSyncToken] = useState(0)
    return useEditorFilamentSaveAuthoring({
      stateRef, setState, sliceConfigRef, materials: materials([3, 1]), setMaterialSyncToken,
      resolveFilamentConfig: resolver, baseFileId: 'file-1'
    })
  })
  const edit = {
    plates: [],
    filaments: [
      { settingsId: 'PETG', sourceIndex: 1 },
      { settingsId: 'PLA', sourceIndex: 0 }
    ]
  } as unknown as SceneEdit

  let authored!: SceneEdit
  await act(async () => { authored = await view.result.current.authorFilamentConfigs(edit) })
  assert.deepEqual(authored.filaments?.[0]?.config, pinned)
  assert.equal(authored.filaments?.[0]?.presetInherits, 'PETG base')
  assert.deepEqual(authored.filaments?.[1]?.config, { nozzle_temperature: ['220'] })
  assert.deepEqual(requests, [{
    filamentProfileId: 'pla-preset', targetId: 'target-1', sourceFileId: 'file-1', projectFilamentId: 1
  }])
})

test('saved filament ids recolour only after the controller exposes the new ids', () => {
  const controller = { projectFilaments: [] } as unknown as SliceSettingsController
  const view = renderHook(({ visibleIds }) => {
    const [state, setState] = useState<EditorState | null>({ plates: [] })
    const stateRef = useRef(state)
    stateRef.current = state
    const sliceConfigRef = useRef<SliceSettingsController | undefined>(controller)
    const [materialSyncToken, setMaterialSyncToken] = useState(0)
    const authoring = useEditorFilamentSaveAuthoring({
      stateRef, setState, sliceConfigRef, materials: materials(visibleIds), setMaterialSyncToken,
      baseFileId: null
    })
    return { ...authoring, materialSyncToken }
  }, { initialProps: { visibleIds: [3] } })

  act(() => view.result.current.handleFilamentsRenumbered(new Map([[3, 1]])))
  assert.equal(view.result.current.materialSyncToken, 0)
  view.rerender({ visibleIds: [3] })
  assert.equal(view.result.current.materialSyncToken, 0)
  view.rerender({ visibleIds: [1] })
  assert.equal(view.result.current.materialSyncToken, 1)
  view.rerender({ visibleIds: [1] })
  assert.equal(view.result.current.materialSyncToken, 1)
})
