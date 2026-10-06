import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import type { StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { instanceFromStagedImport, seedEmptyEditorState,
  type EditorState } from './lib/editorModel'
import type { EditorImportStore } from './lib/editorImportStore'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorShellSplit } = await import('./useEditorShellSplit')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } }
function staged(importId: string): StagedImport {
  return {
    importId, name: importId, format: 'stl', triangleCount: 12,
    bounds, parts: [{ name: importId, triangleCount: 12, bounds, subtype: null }]
  }
}

function twoShellGroup(): THREE.Group {
  const group = new THREE.Group()
  for (const x of [10, 40]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
    mesh.position.set(x, 5, 1)
    group.add(mesh)
  }
  group.updateMatrixWorld(true)
  return group
}

function fixture(stageFile?: (file: File) => Promise<StagedImport>) {
  const state = seedEmptyEditorState()
  const source = instanceFromStagedImport(staged('source'))
  state.plates[0]!.instances.push(source)
  const stateRef: { current: EditorState | null } = { current: state }
  const groupByKeyRef = { current: new Map([[source.key, twoShellGroup()]]) }
  const stagedFiles: string[] = []
  const replacements: string[] = []
  let history = 0
  const importStore = {
    stageFile: async (file: File) => {
      stagedFiles.push(file.name)
      return stageFile ? stageFile(file) : staged(`piece-${stagedFiles.length}`)
    },
    meshUrl: (importId: string) => `/mesh/${importId}`
  } as unknown as EditorImportStore
  const replaceWithStagedRef = {
    current: (key: string) => { replacements.push(key); return true }
  }
  const view = renderHook(() => {
    const [selectedKey, setSelectedKey] = useState<string | null>(source.key)
    const [importing, setImporting] = useState(false)
    const actions = useEditorShellSplit({
      activePlateIndex: 1,
      stateRef,
      groupByKeyRef,
      importStore,
      countHelperVolumes: () => 0,
      updatePlates: (updater) => {
        history += 1
        stateRef.current = { ...stateRef.current!, plates: updater(stateRef.current!.plates) }
      },
      setSelectedKey,
      setImporting,
      replaceWithStagedRef
    })
    return { selectedKey, importing, ...actions }
  })
  return { ...view, source, stateRef, stagedFiles, replacements, get history() { return history } }
}

test('Split to objects stages each shell, replaces the source, and selects one result', async () => {
  const setup = fixture()
  await act(async () => setup.result.current.handleSplitToObjects(setup.source.key))

  assert.deepEqual(setup.stagedFiles, ['source (part 1).stl', 'source (part 2).stl'])
  const instances = setup.stateRef.current!.plates[0]!.instances
  assert.equal(instances.length, 2)
  assert.ok(instances.every((entry) => entry.key !== setup.source.key))
  assert.equal(setup.result.current.selectedKey, instances[0]!.key)
  assert.equal(setup.history, 1)
  assert.equal(setup.result.current.importing, false)
})

test('Split to parts uses one staged assembly and ignores a late result after the state changes', async () => {
  let resolveStage!: (value: StagedImport) => void
  const stagePromise = new Promise<StagedImport>((resolve) => { resolveStage = resolve })
  const setup = fixture(async () => stagePromise)
  let splitPromise!: Promise<void>
  act(() => { splitPromise = setup.result.current.handleSplitToParts(setup.source.key) })
  setup.stateRef.current = { ...setup.stateRef.current! }
  await act(async () => { resolveStage(staged('assembled')); await splitPromise })

  assert.deepEqual(setup.stagedFiles, ['source.3mf'])
  assert.deepEqual(setup.replacements, [])
  assert.equal(setup.history, 0)
  assert.equal(setup.result.current.importing, false)

  const current = fixture()
  await act(async () => current.result.current.handleSplitToParts(current.source.key))
  assert.deepEqual(current.stagedFiles, ['source.3mf'])
  assert.deepEqual(current.replacements, [current.source.key])
})
