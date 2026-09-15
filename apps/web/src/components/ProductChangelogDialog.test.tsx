import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'

let dom: JSDOM
let createElement: typeof import('react').createElement
let cleanup: typeof import('@testing-library/react').cleanup
let render: typeof import('@testing-library/react').render
let ProductChangelogDialog: typeof import('./ProductChangelogDialog').ProductChangelogDialog

before(async () => {
  // Joy decides whether it can mount a modal at import time, so install the DOM first.
  dom = installJsdomGlobals()
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 0)
  dom.window.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)
  createElement = (await import('react')).createElement
  const testingLibrary = await import('@testing-library/react')
  cleanup = testingLibrary.cleanup
  render = testingLibrary.render
  ProductChangelogDialog = (await import('./ProductChangelogDialog')).ProductChangelogDialog
})

after(() => {
  cleanup()
  dom.window.close()
})

test('focuses a dialog action so Escape reaches the modal close handler', () => {
  let closeCount = 0
  const view = render(createElement(ProductChangelogDialog, {
    currentVersion: '1.0.6',
    onClose: () => { closeCount += 1 }
  }))
  const closeButton = view.getByRole('button', { name: 'Close' })

  assert.equal(dom.window.document.activeElement, closeButton)
  closeButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(closeCount, 1)
})
