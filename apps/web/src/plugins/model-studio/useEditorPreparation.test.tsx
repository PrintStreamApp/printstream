import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SceneEdit, SlicingTarget } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorPersistenceLifecycle } from './lib/editorSaveTarget'
import type { EditorState } from './lib/editorModel'
import type { EditorSave } from './useEditorSave'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorPreparation } = await import('./useEditorPreparation')

afterEach(cleanup)
after(() => dom.window.close())

test('save preparation allows early cancellation but protects commit and clears after completion', () => {
  let lifecycle: EditorPersistenceLifecycle | undefined
  const requests: string[] = []
  const save: Pick<EditorSave, 'saving' | 'savedFile' | 'contentBase' | 'stageSnapshotFor' | 'handleSaveVersion' | 'handleSaveAs'> = {
    saving: false,
    savedFile: null,
    contentBase: null,
    stageSnapshotFor: async () => null,
    handleSaveVersion: (next) => { requests.push('version'); lifecycle = next },
    handleSaveAs: (name, folder, next) => { requests.push(`saveAs:${name}:${folder}`); lifecycle = next }
  }
  const stateRef = { current: null }
  const view = renderHook(({ saving }: { saving: boolean }) => useEditorPreparation({
    stateRef,
    save: { ...save, saving },
    slicingProp: false,
    buildSceneEdit: () => ({} as SceneEdit),
    authorFilamentConfigs: async (edit) => edit
  }), { initialProps: { saving: false } })

  act(() => view.result.current.startSaveVersion())
  assert.deepEqual(requests, ['version'])
  assert.equal(view.result.current.dialogProps.action, 'save')
  assert.equal(view.result.current.dialogProps.savePhase, 'checking')
  const earlySignal = lifecycle?.signal
  assert.equal(earlySignal?.aborted, false)
  act(() => view.result.current.dialogProps.onCancel())
  assert.equal(earlySignal?.aborted, true)
  assert.equal(view.result.current.dialogProps.action, null)

  act(() => view.result.current.startSaveAs('copy.3mf', null))
  assert.deepEqual(requests, ['version', 'saveAs:copy.3mf:null'])
  assert.equal(view.result.current.dialogProps.savePhase, 'creating')
  const committingSignal = lifecycle?.signal
  act(() => lifecycle?.onCommitStart?.())
  act(() => view.result.current.dialogProps.onCancel())
  assert.equal(committingSignal?.aborted, false)
  assert.equal(view.result.current.dialogProps.finalizing, true)

  view.rerender({ saving: true })
  view.rerender({ saving: false })
  assert.equal(view.result.current.dialogProps.action, null)
})

test('slice preparation forwards the authored edit and staged snapshot through the host', async () => {
  const edit = { plates: [] } as unknown as SceneEdit
  const target = { printerModel: 'X1C' } as unknown as SlicingTarget
  const calls: string[] = []
  const save: Pick<EditorSave, 'saving' | 'savedFile' | 'contentBase' | 'stageSnapshotFor' | 'handleSaveVersion' | 'handleSaveAs'> = {
    saving: false,
    savedFile: null,
    contentBase: null,
    stageSnapshotFor: async (received, receivedTarget, id) => {
      assert.equal(received, edit)
      assert.equal(receivedTarget, target)
      assert.equal(id, 'slicer-1')
      calls.push('stage')
      return 'snapshot-1'
    },
    handleSaveVersion: () => {},
    handleSaveAs: () => {}
  }
  const view = renderHook(() => useEditorPreparation({
    stateRef: { current: {} as EditorState },
    save,
    slicingProp: false,
    buildSceneEdit: () => edit,
    authorFilamentConfigs: async (received) => { calls.push('author'); return received },
    onSlice: async (request) => {
      assert.equal(request.plate, 2)
      assert.equal(request.sceneEdit, edit)
      assert.equal(request.contentBase, null)
      assert.equal(await request.stageSnapshot(target, 'slicer-1'), 'snapshot-1')
      calls.push('host')
    }
  }))

  act(() => view.result.current.startSlice(2))
  assert.equal(view.result.current.dialogProps.action, 'slice')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  assert.deepEqual(calls, ['author', 'stage', 'host'])
  assert.equal(view.result.current.dialogProps.action, null)
})
