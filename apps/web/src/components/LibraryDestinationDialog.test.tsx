import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

// ScrollableDialogBody measures overflow via rAF, which jsdom does not provide.
const animationFrameWindow = dom.window as unknown as {
  requestAnimationFrame: (callback: () => void) => number
  cancelAnimationFrame: (handle: number) => void
}
animationFrameWindow.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0) as unknown as number
animationFrameWindow.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)

// Joy's Modal does SSR detection at import time, so load @mui/joy and the component under test
// only after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { LibraryDestinationDialog } = await import('./LibraryDestinationDialog')
const { PromptDialogProvider } = await import('./PromptDialogProvider')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

type SubmitInput = { outputFileName?: string; outputFolderId: string | null }

function renderDialog(onSubmit: (input: SubmitInput) => void) {
  // gcTime: Infinity — react-query imported after jsdom detects a browser and would otherwise
  // leave a ref'd 5-minute timer holding the runner open.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  return render(
    <CssVarsProvider>
      <QueryClientProvider client={queryClient}>
        <PromptDialogProvider>
          <LibraryDestinationDialog
            title="Save project"
            description="Choose where to save."
            fileNameField={{ label: 'File name', initialValue: 'benchy', extension: '.3mf' }}
            initialFolderId={null}
            folders={[]}
            bridgeId={null}
            bridgeName="Bridge"
            showRoot
            submitting={false}
            error={null}
            confirmActionLabel={() => 'Save here'}
            onClose={() => {}}
            onSubmit={onSubmit}
          />
        </PromptDialogProvider>
      </QueryClientProvider>
    </CssVarsProvider>
  )
}

/**
 * The save-a-new-file dialog: its name field is the only thing the user types, so it must open
 * ready to overtype and commit on Enter. It is not a <form>, so nothing gives it Enter for free.
 */

test('the suggested name is selected on open', () => {
  renderDialog(() => {})
  const input = screen.getByLabelText('File name') as HTMLInputElement
  assert.equal(input.value, 'benchy')
  assert.equal(input.selectionStart, 0)
  assert.equal(input.selectionEnd, 'benchy'.length)
})

test('Enter in the name field saves, without a trip to the button', () => {
  const submissions: SubmitInput[] = []
  renderDialog((input) => submissions.push(input))
  const input = screen.getByLabelText('File name')
  fireEvent.change(input, { target: { value: 'benchy-v2' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  assert.deepEqual(submissions, [{ outputFileName: 'benchy-v2', outputFolderId: null }])
})

test('Enter does nothing when the name has been cleared', () => {
  const submissions: SubmitInput[] = []
  renderDialog((input) => submissions.push(input))
  const input = screen.getByLabelText('File name')
  fireEvent.change(input, { target: { value: '   ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  assert.deepEqual(submissions, [])
})
