import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'

let dom: JSDOM
let createElement: typeof import('react').createElement
let cleanup: typeof import('@testing-library/react').cleanup
let render: typeof import('@testing-library/react').render
let ProductChangelogDialog: typeof import('./ProductChangelogDialog').ProductChangelogDialog
let productReleases: typeof import('../lib/productChangelog').productReleases

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
  productReleases = (await import('../lib/productChangelog')).productReleases
})

afterEach(() => cleanup())

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

test('keeps previous releases visible in order when reopened after reading', () => {
  // Substitute a multi-release catalogue without publishing invented release notes.
  const originalReleases = [...productReleases]
  productReleases.splice(0, productReleases.length,
    { version: '2.0.0', releasedOn: '2026-09-16', changes: ['Current release change.'] },
    { version: '1.9.0', releasedOn: '2026-09-15', changes: ['Previously missed change.'] },
    { version: '1.8.0', releasedOn: '2026-09-14', changes: ['Older release change.'] }
  )
  try {
    for (let opening = 0; opening < 2; opening += 1) {
      const view = render(createElement(ProductChangelogDialog, {
        currentVersion: '2.0.0', onClose: () => undefined
      }))
      assert.deepEqual(view.getAllByRole('listitem').map((item) => item.textContent), [
        'Current release change.', 'Previously missed change.', 'Older release change.'
      ])
      assert.equal(view.getAllByText('Current').length, 1)
      for (const version of ['v2.0.0', 'v1.9.0', 'v1.8.0']) {
        assert.ok(view.getByText(version))
      }
      cleanup()
    }
  } finally {
    cleanup()
    productReleases.splice(0, productReleases.length, ...originalReleases)
  }
})
