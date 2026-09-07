/**
 * Regression coverage for the editor's close guard raising ONE prompt per close.
 *
 * "Discard unsaved changes?" is raised through `PromptDialogProvider`, which QUEUES a confirm
 * raised while another is open rather than dropping it. So two close requests do not merge into
 * the prompt on screen: the second waits behind the first and asks the identical question again
 * the moment the user answers, which reads as being asked twice for one gesture.
 *
 * A close path that fires twice is not hypothetical -- Joy's `ModalClose` calls the modal's own
 * `onClose` AND any `onClick` it is given (see `components/BackAwareModal.test.ts`) -- and neither
 * is an impatient second click on a dialog that takes a moment to respond. Both land here.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SceneEdit } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorState } from './lib/editorModel'
import type { ConfirmDialogOptions } from '../../components/PromptDialogProvider'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { act, cleanup, render } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { useEditorSave } = await import('./useEditorSave')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

/** A confirm the test answers by hand, so a close can be held mid-prompt exactly as a user holds it. */
function manualConfirm() {
  const asked: ConfirmDialogOptions[] = []
  let answer: ((value: boolean) => void) | null = null
  return {
    asked,
    confirm: (options: ConfirmDialogOptions) => {
      asked.push(options)
      return new Promise<boolean>((resolve) => { answer = resolve })
    },
    /** Answer the prompt currently on screen. */
    respond: async (value: boolean) => {
      const resolve = answer
      answer = null
      assert.ok(resolve, 'nothing was asked')
      await act(async () => { resolve(value) })
    }
  }
}

function mountCloseGuard(dirty: boolean) {
  const prompt = manualConfirm()
  const closes: number[] = []
  let requestClose: ((source?: string) => Promise<void>) | null = null

  function Probe() {
    const save = useEditorSave({
      stateRef: { current: null } as React.MutableRefObject<EditorState | null>,
      sliceConfigRef: { current: undefined },
      dirtyRef: { current: dirty },
      // Required now that the target is not defaulted: the bake runs in the tab, so a target needs
      // the archive and import store only a host can supply. This guard never saves.
      saveTarget: {
        isLibraryBacked: false,
        persist: async () => null,
        exportBytes: async () => new Uint8Array()
      },
      markSaved: () => {},
      buildSceneEditOut: () => ({} as SceneEdit),
      captureAllPlateThumbnails: async () => [],
      worldFootprintCenterFor: () => null,
      baseFileId: 'file-1',
      baseVersionId: null,
      saveAsBridgeId: null,
      editorBorn: false,
      onApply: undefined,
      onSaved: undefined,
      onSavedAs: undefined,
      onClose: () => { closes.push(1) },
      confirm: prompt.confirm
    })
    requestClose = save.handleCloseRequest
    return null
  }

  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)))
  assert.ok(requestClose, 'the probe must expose the close handler')
  return { prompt, closes, requestClose: requestClose as unknown as (source?: string) => Promise<void> }
}

test('two close requests for one gesture raise ONE discard prompt, and name the pair', async () => {
  const { prompt, closes, requestClose } = mountCloseGuard(true)
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (message: unknown) => { warnings.push(String(message)) }

  try {
    // Both arrive before anything is answered, which is what a doubled close path looks like.
    await act(async () => { void requestClose('escape'); void requestClose('dialog:backdropClick') })
    assert.equal(prompt.asked.length, 1, 'the second request must not queue a second prompt')

    await prompt.respond(true)
    assert.equal(closes.length, 1, 'discarding must close the editor once')
    assert.equal(prompt.asked.length, 1, 'answering must not reveal a queued duplicate')
  } finally {
    console.warn = realWarn
  }

  // The report is the point: an intermittent duplicate is only diagnosable if it says what raced.
  assert.equal(warnings.length, 1, 'the suppressed duplicate must be reported')
  assert.match(warnings[0]!, /escape then dialog:backdropClick/)
})

test('declining leaves the editor open and askable again', async () => {
  const { prompt, closes, requestClose } = mountCloseGuard(true)

  await act(async () => { void requestClose() })
  await prompt.respond(false)
  assert.equal(closes.length, 0, 'Keep editing must not close the editor')

  // The guard covers a prompt that is UP, never a later close: the next gesture must still ask.
  await act(async () => { void requestClose() })
  assert.equal(prompt.asked.length, 2, 'a fresh close gesture must raise its own prompt')
  await prompt.respond(true)
  assert.equal(closes.length, 1)
})

test('a clean project closes with no prompt at all', async () => {
  const { prompt, closes, requestClose } = mountCloseGuard(false)

  await act(async () => { await requestClose() })
  assert.equal(prompt.asked.length, 0, 'nothing unsaved, nothing to ask')
  assert.equal(closes.length, 1)
})
