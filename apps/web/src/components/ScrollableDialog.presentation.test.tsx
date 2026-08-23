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

// Joy's Modal does SSR detection at import time, so load @mui/joy and the component under test only
// after the jsdom globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { default: Modal } = await import('@mui/joy/Modal')
const { cleanup, render } = await import('@testing-library/react')
const { ScrollableModalDialog } = await import('./ScrollableDialog')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function renderShell(presentation?: 'standard' | 'maximized' | 'fullscreen') {
  render(
    <CssVarsProvider>
      <Modal open>
        <ScrollableModalDialog presentation={presentation}>
          <div>body</div>
        </ScrollableModalDialog>
      </Modal>
    </CssVarsProvider>
  )
  const dialog = dom.window.document.querySelector('.MuiModalDialog-root')
  assert.ok(dialog, 'expected the dialog to render')
  return dialog
}

/**
 * The attribute is the ONLY way an enlarged dialog escapes the theme's app-wide viewport clamp: Joy
 * applies theme `styleOverrides` after `sx`, so the clamp cannot be lifted from the dialog's own
 * styles. Dropping it fails silently: the dialog still renders, just short of the screen edge.
 */
test('the shell marks its presentation on the dialog root', () => {
  assert.equal(renderShell('fullscreen').getAttribute('data-dialog-presentation'), 'fullscreen')
  cleanup()
  assert.equal(renderShell('maximized').getAttribute('data-dialog-presentation'), 'maximized')
  cleanup()
  assert.equal(renderShell().getAttribute('data-dialog-presentation'), 'standard')
})

test('full screen switches the dialog to Joy\'s fullscreen layout', () => {
  // The scroller's own rules for a fullscreen child are what cancel its padding; a centred layout
  // inside the same scroller keeps it and leaves a gutter round a "full screen" view.
  assert.ok(renderShell('fullscreen').classList.contains('MuiModalDialog-layoutFullscreen'))
  cleanup()
  assert.ok(renderShell('maximized').classList.contains('MuiModalDialog-layoutCenter'))
})
