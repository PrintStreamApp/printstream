import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { StagedImport } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { triangleSoupToBinaryStl } from './lib/meshCut'
import type { EditorImportStore } from './lib/editorImportStore'
import type { SourceColorPaintCommit } from './lib/editorGeometryReplacement'
import { APPEND_SOURCE_COLOR } from './lib/sourceColorImport'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorSourceColorImport } = await import('./useEditorSourceColorImport')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } }
const staged: StagedImport = {
  importId: 'colour-mesh', name: 'Colour mesh', format: 'obj', triangleCount: 1,
  bounds, sourceColorMode: 'vertex',
  parts: [{ name: 'Colour mesh', triangleCount: 1, bounds, subtype: null }]
}
const triangle = triangleSoupToBinaryStl(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))

function fixture() {
  let history = 0
  const appended: Array<{ optionId: string; color: string; label: string }> = []
  const additions: Array<{ paint: SourceColorPaintCommit | undefined; recordHistory: boolean | undefined }> = []
  const replacements: string[] = []
  const importStore = {
    fetchSourceColors: async () => new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    fetchMesh: async () => triangle
  } as unknown as EditorImportStore
  const replaceWithStagedRef = {
    current: (key: string) => { replacements.push(key); return true }
  }
  const view = renderHook(() => useEditorSourceColorImport({
    importStore,
    filaments: [{ id: 1, number: 1, label: 'PLA', color: '#ff0000', colorName: 'Red' }],
    materialOptionIds: { 1: 'pla-preset' },
    onAddFilament: (filament) => { appended.push(filament) },
    recordCombinedHistory: () => { history += 1 },
    addStagedImport: (_import, paint, options) => {
      additions.push({ paint, recordHistory: options?.recordHistory })
      return true
    },
    replaceWithStagedRef
  }))
  return {
    ...view, appended, additions, replacements,
    get history() { return history }
  }
}

test('source-colour apply commits geometry and paint with one combined history frame', async () => {
  const setup = fixture()
  await act(async () => {
    assert.equal(await setup.result.current.queueSourceColorMapping(staged, { kind: 'add' }), true)
  })
  assert.equal(setup.result.current.pending?.staged.importId, staged.importId)
  assert.equal(setup.result.current.canAppend, true)

  act(() => setup.result.current.applySourceColors({
    quantized: { clusters: [{ color: [1, 0, 0], count: 3 }], labels: [0, 0, 0] },
    mappings: [APPEND_SOURCE_COLOR]
  }))

  assert.equal(setup.history, 1)
  assert.deepEqual(setup.additions, [{ paint: { filamentId: 2, colorPaint: {} }, recordHistory: false }])
  assert.deepEqual(setup.appended, [{ optionId: 'pla-preset', color: '#ff0000', label: 'PLA' }])
  assert.equal(setup.result.current.pending, null)
})

test('source-colour skip replaces staged geometry without changing filaments', async () => {
  const setup = fixture()
  await act(async () => {
    assert.equal(await setup.result.current.queueSourceColorMapping(staged, { kind: 'replace', key: 'old' }), true)
  })
  act(() => setup.result.current.skipSourceColors())

  assert.deepEqual(setup.replacements, ['old'])
  assert.deepEqual(setup.appended, [])
  assert.equal(setup.history, 0)
  assert.equal(setup.result.current.pending, null)
})
