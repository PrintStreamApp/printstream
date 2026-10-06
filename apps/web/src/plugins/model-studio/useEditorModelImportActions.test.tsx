import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import type { StagedImport } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorImportStore } from './lib/editorImportStore'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorModelImportActions } = await import('./useEditorModelImportActions')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'staged', name: 'Model', format: 'stl', triangleCount: 1,
  bounds, parts: [{ name: 'Model', triangleCount: 1, bounds, subtype: null }]
}

function fixture(pauseForColours = false, failStaging = false) {
  const stagedSources: string[] = []
  const additions: string[] = []
  const replacements: string[] = []
  const mappingTargets: string[] = []
  let clearedRequests = 0
  const importStore = {
    stageFile: async (file: File) => {
      stagedSources.push(`file:${file.name}`)
      if (failStaging) throw new Error('staging failed')
      return staged
    },
    stageFromLibrary: async (fileId: string) => {
      stagedSources.push(`library:${fileId}`)
      return staged
    }
  } as unknown as EditorImportStore
  const replaceWithStagedRef = { current: (key: string) => { replacements.push(key); return true } }
  const view = renderHook(() => {
    const [importing, setImporting] = useState(false)
    const [libraryPickerOpen, setLibraryPickerOpen] = useState(true)
    const actions = useEditorModelImportActions({
      importStore,
      setImporting,
      setLibraryPickerOpen,
      clearModelRequest: () => { clearedRequests += 1 },
      addOrMapStagedImport: async (item) => { additions.push(item.importId); return true },
      queueSourceColorMapping: async (_item, target) => {
        mappingTargets.push(target.kind)
        return pauseForColours
      },
      replaceWithStagedRef
    })
    return { importing, libraryPickerOpen, ...actions }
  })
  return {
    ...view, stagedSources, additions, replacements, mappingTargets,
    get clearedRequests() { return clearedRequests }
  }
}

test('file add and library replacement stage through the matching commit boundary', async () => {
  const setup = fixture()
  await act(async () => setup.result.current.handleImportFile(new File(['mesh'], 'mesh.stl')))
  assert.deepEqual(setup.stagedSources, ['file:mesh.stl'])
  assert.deepEqual(setup.additions, ['staged'])
  assert.equal(setup.result.current.importing, false)
  assert.equal(setup.result.current.libraryPickerOpen, true)

  await act(async () => setup.result.current.handleReplaceFromLibrary('old', 'library-file'))
  assert.deepEqual(setup.stagedSources, ['file:mesh.stl', 'library:library-file'])
  assert.deepEqual(setup.mappingTargets, ['replace'])
  assert.deepEqual(setup.replacements, ['old'])
  assert.equal(setup.result.current.libraryPickerOpen, false)
  assert.equal(setup.clearedRequests, 1)
  assert.equal(setup.result.current.importing, false)
})

test('a colour-mapping pause and a staging failure leave geometry unchanged and end loading', async () => {
  const paused = fixture(true)
  await act(async () => paused.result.current.handleReplaceFromFile('old', new File(['mesh'], 'mesh.stl')))
  assert.deepEqual(paused.mappingTargets, ['replace'])
  assert.deepEqual(paused.replacements, [])
  assert.equal(paused.result.current.importing, false)

  const failed = fixture(false, true)
  await act(async () => failed.result.current.handleImportFile(new File(['mesh'], 'broken.stl')))
  assert.deepEqual(failed.additions, [])
  assert.equal(failed.result.current.importing, false)
})
