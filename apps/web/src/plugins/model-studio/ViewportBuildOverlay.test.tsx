import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, render, screen } = await import('@testing-library/react')
const { ViewportBuildOverlay } = await import('./ViewportBuildOverlay')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

test('uses the shared viewport build language with determinate progress', () => {
  render(React.createElement(ViewportBuildOverlay, {
    progress: { done: 2, total: 4 }
  }))

  assert.equal(screen.getByRole('status').textContent, 'Building the 3D view… 2 of 4')
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '50')
})
