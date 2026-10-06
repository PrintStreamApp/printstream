import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StagedImport } from '@printstream/shared'
import { createEditorIndependentCopyImports } from './editorIndependentCopyImports'
import type { EditorImportStore } from './editorImportStore'
import type { EditorInstance, EditorState } from './editorModel'

function importedCopy(): EditorInstance {
  return {
    key: 'copy',
    name: 'Copied model',
    source: { kind: 'import', importId: 'shared', meshUrl: '/mesh/shared' }
  } as EditorInstance
}

test('independent copies get separate process overrides, base meshes, and added volumes', async () => {
  const copy = importedCopy()
  const volume = {
    key: 'volume',
    name: 'Blocker',
    soup: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    importId: 'shared-volume'
  }
  const state = {
    plates: [{ instances: [copy] }],
    addedParts: { 42: [volume] }
  } as unknown as EditorState
  const staged: Array<{ name: string; normalization: string }> = []
  const store = {
    async fetchMesh() { return new Uint8Array([1, 2, 3]).buffer },
    async stageFile(file: File, normalization: string) {
      staged.push({ name: file.name, normalization })
      return { importId: `private-${staged.length}` } as StagedImport
    },
    meshUrl(importId: string) { return `/mesh/${importId}` }
  } as unknown as EditorImportStore
  let changed = 0
  let nextSettings: Record<string, Record<string, string | string[]>> | null = null
  const sourceSettings = { 12: { wall_loops: '4' } }
  const controller = createEditorIndependentCopyImports({
    stateRef: { current: state },
    importStore: store,
    getPerObjectSettings: () => ({
      value: sourceSettings,
      onChange: (next) => { nextSettings = next }
    }),
    onImportsChanged: () => { changed += 1 }
  })

  controller.copyProcessOverrides(12, 42)
  await controller.restageMesh('copy')
  await controller.restageVolumes(42)

  assert.deepEqual(nextSettings, { 12: { wall_loops: '4' }, 42: { wall_loops: '4' } })
  assert.notEqual(nextSettings?.['42'], sourceSettings[12])
  assert.deepEqual(staged, [
    { name: 'Copied model.stl', normalization: 'part' },
    { name: 'Blocker.stl', normalization: 'part' }
  ])
  assert.equal(copy.source.kind === 'import' ? copy.source.importId : null, 'private-1')
  assert.equal(state.addedParts?.[42]?.[0]?.importId, 'private-2')
  assert.equal(changed, 2)
})

test('late mesh staging cannot attach an import to a copy removed by undo', async () => {
  const copy = importedCopy()
  const state = { plates: [{ instances: [copy] }] } as EditorState
  let finishFetch: ((bytes: ArrayBuffer) => void) | null = null
  const store = {
    fetchMesh: () => new Promise<ArrayBuffer>((resolve) => { finishFetch = resolve }),
    async stageFile() { return { importId: 'late-import' } as StagedImport },
    meshUrl: (importId: string) => `/mesh/${importId}`
  } as unknown as EditorImportStore
  let changed = 0
  const controller = createEditorIndependentCopyImports({
    stateRef: { current: state },
    importStore: store,
    getPerObjectSettings: () => null,
    onImportsChanged: () => { changed += 1 }
  })

  const pending = controller.restageMesh('copy')
  state.plates[0]!.instances.length = 0
  finishFetch!(new Uint8Array([1, 2, 3]).buffer)
  await pending

  assert.equal(copy.source.kind === 'import' ? copy.source.importId : null, 'shared')
  assert.equal(changed, 0)
})
