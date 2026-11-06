import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import type { StagedImport } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { createEditorIndependentCopyImports } from './lib/editorIndependentCopyImports'
import { instanceFromStagedImport, seedEmptyEditorState, type EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorObjectDuplication } = await import('./useEditorObjectDuplication')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 10 } }
const staged: StagedImport = {
  importId: 'shared', name: 'Bracket', format: 'stl', triangleCount: 12, bounds,
  parts: [{ name: 'Bracket', triangleCount: 12, bounds, subtype: null }]
}

function duplicationFixture() {
  const initial = seedEmptyEditorState()
  const source = instanceFromStagedImport(staged)
  initial.plates[0]!.instances.push(source)
  const stateRef: { current: EditorState | null } = { current: initial }
  const restages: Array<{ key: string; live: boolean }> = []
  const history = { frames: 0 }
  const imports = {
    copyProcessOverrides() {},
    async restageVolumes() {},
    async restageMesh(key: string) {
      const live = stateRef.current?.plates.some((plate) =>
        plate.instances.some((instance) => instance.key === key)) ?? false
      restages.push({ key, live })
    }
  } as ReturnType<typeof createEditorIndependentCopyImports>

  const view = renderHook(() => {
    const [state, setState] = useState<EditorState | null>(initial)
    stateRef.current = state
    const actions = useEditorObjectDuplication({
      activePlateIndex: 1,
      state,
      stateRef,
      selectionFor: (key) => [key],
      updatePlates: (updater) => setState((current) => current
        ? { ...current, plates: updater(current.plates) }
        : current),
      selectExclusive: () => {},
      independentCopyImports: imports,
      promptText: async () => null,
      recordHistoryRef: { current: () => { history.frames += 1 } },
      refreshAddedPartMeshes: () => {},
      regenerateThumbnailRef: { current: null },
      setState
    })
    return { state, ...actions }
  })
  return { ...view, source, restages, history }
}

test('independent duplication re-homes an import only after its clone is on the live plate', () => {
  const fixture = duplicationFixture()
  act(() => fixture.result.current.handleDuplicate(fixture.source.key, true))

  const clone = fixture.result.current.state!.plates[0]!.instances[1]!
  assert.equal(fixture.result.current.state!.plates[0]!.instances.length, 2)
  assert.notEqual(clone.source.kind === 'import' ? clone.source.replacedObjectId : null,
    fixture.source.source.kind === 'import' ? fixture.source.source.replacedObjectId : null)
  assert.deepEqual(fixture.restages, [{ key: clone.key, live: true }])
  assert.equal(fixture.result.current.linkedCopyCountFor(clone.key), 1)
})

test('linked duplication retains one editable identity and does not restage an import', () => {
  const fixture = duplicationFixture()
  act(() => fixture.result.current.handleDuplicate(fixture.source.key))

  const clone = fixture.result.current.state!.plates[0]!.instances[1]!
  assert.equal(fixture.result.current.linkedCopyCountFor(clone.key), 2)
  assert.deepEqual(fixture.restages, [])
})

test('making copies independent unlinks every copy but the first, as one undo step', () => {
  const fixture = duplicationFixture()
  act(() => fixture.result.current.handleDuplicate(fixture.source.key, false, 2))
  const keys = fixture.result.current.state!.plates[0]!.instances.map((instance) => instance.key)
  assert.equal(fixture.result.current.linkedCopyCountFor(keys[0]!), 3)

  const framesBefore = fixture.history.frames
  act(() => fixture.result.current.handleMakeCopiesIndependent(keys))
  assert.equal(fixture.history.frames - framesBefore, 1)

  for (const key of keys) assert.equal(fixture.result.current.linkedCopyCountFor(key), 1, key)
  // The unlinked copies re-stage their own meshes; the first keeps the original's.
  assert.deepEqual(fixture.restages.map((entry) => entry.key), keys.slice(1))
})
