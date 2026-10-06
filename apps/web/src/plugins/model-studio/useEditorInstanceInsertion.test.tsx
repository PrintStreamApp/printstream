import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import type { StagedImport } from '@printstream/shared'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { addedPartHostId, seedEmptyEditorState, supportPaintKey, type EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorInstanceInsertion } = await import('./useEditorInstanceInsertion')

afterEach(cleanup)
after(() => dom.window.close())

test('staged geometry, source colour, and primitives share the insertion gate', async () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 } }
  const staged: StagedImport = {
    importId: 'source', name: 'Colour.stl', format: 'stl', triangleCount: 12, bounds,
    parts: [{ name: 'Colour.stl', triangleCount: 12, bounds, subtype: null }]
  }
  let checkpoints = 0
  let primitiveFileName: string | null = null
  let primitiveNormalization: string | null = null
  const view = renderHook(() => {
    const [state, setState] = useState<EditorState | null>(seedEmptyEditorState())
    const stateRef = useRef(state)
    stateRef.current = state
    const [selectedKey, setSelectedKey] = useState<string | null>(null)
    const [importing, setImporting] = useState(false)
    const sliceConfigRef = useRef({ projectFilaments: [{}] } as SliceSettingsController)
    const groupsRef = useRef(new Map<string, THREE.Group>())
    const insertion = useEditorInstanceInsertion({
      activePlateIndex: 1,
      sliceConfigRef,
      stateRef,
      setState,
      groupsRef,
      updatePlates: (updater, _kind, options) => {
        if (options.recordHistory !== false) checkpoints += 1
        setState((current) => current ? { ...current, plates: updater(current.plates) } : current)
      },
      setSelectedKey,
      setImporting,
      importStore: {
        meshUrl: (id) => `/mesh/${id}`,
        stageFile: async (file, normalization) => {
          primitiveFileName = file.name
          primitiveNormalization = normalization
          return { ...staged, importId: 'primitive', name: file.name }
        }
      }
    })
    return { state, selectedKey, importing, ...insertion }
  })

  let added = false
  act(() => { added = view.result.current.addStagedImport(staged, {
    filamentId: 2,
    colorPaint: { 0: '2' }
  }) })
  assert.equal(added, true)
  assert.equal(checkpoints, 1)
  const instance = view.result.current.state?.plates[0]?.instances[0]
  assert.ok(instance)
  assert.equal(view.result.current.selectedKey, instance.key)
  assert.equal(instance.filamentId, 2)
  const hostId = addedPartHostId(instance)
  assert.ok(hostId != null)
  assert.deepEqual(view.result.current.state?.colorPaint?.[supportPaintKey(hostId, 0)], { 0: '2' })

  await act(async () => { await view.result.current.addPrimitive('cube') })
  assert.equal(primitiveFileName, 'Cube.stl')
  assert.equal(primitiveNormalization, 'object')
  assert.equal(view.result.current.importing, false)
  assert.equal(checkpoints, 2)
  const primitive = view.result.current.state?.plates[0]?.instances[1]
  assert.ok(primitive)
  assert.equal(view.result.current.selectedKey, primitive.key)
})
