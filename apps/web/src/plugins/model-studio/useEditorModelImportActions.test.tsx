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

function fixture(
  pauseForColours = false,
  failStaging: boolean | string = false,
  beforeStage?: (file: File) => Promise<void>
) {
  const stagedSources: string[] = []
  const additions: string[] = []
  const replacements: string[] = []
  const mappingTargets: string[] = []
  const loading: boolean[] = []
  const companions: string[][] = []
  let clearedRequests = 0
  const importStore = {
    stageFile: async (file: File, _normalize: unknown, _signal: unknown, companionFiles: readonly File[]) => {
      stagedSources.push(`file:${file.name}`)
      companions.push(companionFiles.map((companion) => companion.name))
      await beforeStage?.(file)
      if (failStaging === true || failStaging === file.name) throw new Error('staging failed')
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
      setImporting: (value) => { loading.push(value as boolean); setImporting(value) },
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
    ...view, stagedSources, additions, replacements, mappingTargets, loading, companions,
    get clearedRequests() { return clearedRequests }
  }
}

test('file add and library replacement stage through the matching commit boundary', async () => {
  const setup = fixture()
  await act(async () => setup.result.current.handleImportFiles([{ file: new File(['mesh'], 'mesh.stl'), companionFiles: [] }]))
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
  await act(async () => failed.result.current.handleImportFiles([{ file: new File(['mesh'], 'broken.stl'), companionFiles: [] }]))
  assert.deepEqual(failed.additions, [])
  assert.equal(failed.result.current.importing, false)
})

test('a batch imports every valid model after a failed file, keeping one loading boundary and OBJ companions', async () => {
  const setup = fixture(false, 'broken.stl')
  await act(async () => setup.result.current.handleImportFiles([
    { file: new File(['mesh'], 'first.obj'), companionFiles: [new File(['material'], 'first.mtl')] },
    { file: new File(['broken'], 'broken.stl'), companionFiles: [] },
    { file: new File(['mesh'], 'last.stl'), companionFiles: [] }
  ]))
  assert.deepEqual(setup.stagedSources, ['file:first.obj', 'file:broken.stl', 'file:last.stl'])
  assert.deepEqual(setup.companions, [['first.mtl'], [], []])
  assert.equal(setup.additions.length, 2)
  assert.deepEqual(setup.loading, [true, false])
  assert.equal(setup.result.current.importing, false)
})

test('a slow model keeps the batch busy and prevents another parser from starting', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const setup = fixture(false, false, async (file) => { if (file.name === 'first.step') await gate })
  let completion!: Promise<void>
  await act(async () => {
    completion = setup.result.current.handleImportFiles(['first.step', 'second.stl'].map((name) => ({
      file: new File(['mesh'], name), companionFiles: []
    })))
  })
  assert.deepEqual(setup.stagedSources, ['file:first.step'])
  assert.equal(setup.result.current.importing, true)
  await act(async () => { release(); await completion })
  assert.deepEqual(setup.stagedSources, ['file:first.step', 'file:second.stl'])
  assert.equal(setup.additions.length, 2)
  assert.deepEqual(setup.loading, [true, false])
})
