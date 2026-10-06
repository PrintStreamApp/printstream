import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { ReactNode } from 'react'
import { threeMfIndexSchema } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { seedEmptyEditorState, type EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { useEditorLibraryFileMetadata } = await import('./useEditorLibraryFileMetadata')

afterEach(cleanup)
after(() => dom.window.close())

test('repair reasons follow the opened version and disappear when repaired in this session', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  client.setQueryData(['library-file', 'file-1'], {
    file: {
      name: 'Model.3mf',
      needsSettingsRepair: true,
      settingsRepairReasons: ['flushMatrix'],
      unrepairableSettingsRepairReasons: []
    }
  })
  const sourceIndex = threeMfIndexSchema.parse({
    plates: [],
    projectFilaments: [],
    compatiblePrinterModels: [],
    settingsRepairReasons: ['filamentPhysics', 'inheritsGroup'],
    unrepairableSettingsRepairReasons: ['inheritsGroup']
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = renderHook(
    ({ baseVersionId, state }: { baseVersionId: string | null; state: EditorState }) => (
      useEditorLibraryFileMetadata({
        baseFileId: 'file-1',
        baseVersionId,
        isNewProject: false,
        bridgeId: null,
        folderId: null,
        sourceIndex,
        repairReasons: [],
        unrepairableRepairReasons: [],
        state
      })
    ),
    { initialProps: { baseVersionId: null as string | null, state: seedEmptyEditorState() }, wrapper }
  )
  assert.deepEqual(view.result.current.settingsRepairReasons, ['flushMatrix'])
  assert.equal(view.result.current.projectName, 'Model.3mf')
  assert.equal(view.result.current.saveAsSuggestedName, 'Model')

  view.rerender({ baseVersionId: 'older-version', state: seedEmptyEditorState() })
  assert.deepEqual(view.result.current.settingsRepairReasons, ['filamentPhysics', 'inheritsGroup'])
  assert.deepEqual(view.result.current.unrepairableRepairReasonsResolved, ['inheritsGroup'])

  view.rerender({
    baseVersionId: 'older-version',
    state: { ...seedEmptyEditorState(), settingsRepairStaged: true, repairedFilamentConfigs: {} }
  })
  assert.deepEqual(view.result.current.settingsRepairReasons, [])
  client.clear()
})
