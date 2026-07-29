import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

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
const { cleanup, render, screen } = await import('@testing-library/react')
const { EditorSettingsDialog } = await import('./EditorSettingsDialog')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function renderDialog() {
  // gcTime: Infinity — react-query imported after jsdom detects a browser and would otherwise
  // leave a ref'd 5-minute timer holding the runner open.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  return render(
    <CssVarsProvider>
      <QueryClientProvider client={queryClient}>
        <EditorSettingsDialog open onClose={() => {}} />
      </QueryClientProvider>
    </CssVarsProvider>
  )
}

/**
 * The preset manager is a separate dialog now, reached only from the sidebar's Manage action —
 * this dialog must not grow it back, as either a tab or a link. Both are `BackAwareModal`s, so a
 * link that closes this one to open that one is popped straight back shut.
 */

test('editor settings shows only the viewport preferences, with no preset tabs', () => {
  renderDialog()
  assert.ok(screen.getByText('3D build plate'))
  assert.ok(screen.getByText('Panel position'))
  assert.equal(screen.queryAllByRole('tab').length, 0)
})

test('editor settings does not open the preset manager itself', () => {
  renderDialog()
  const buttonNames = screen.getAllByRole('button').map((button) => button.textContent ?? '')
  assert.deepEqual(buttonNames.filter((name) => /preset/i.test(name)), [])
})
