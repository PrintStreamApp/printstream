import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { cleanup, render, screen } = await import('@testing-library/react')
const { EditorOpeningStatus } = await import('./EditorOpeningStatus')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

test('always shows one linear progress indicator while project progress is unknown', () => {
  render(React.createElement(EditorOpeningStatus, { label: 'Reading project' }))

  const progress = screen.getAllByRole('progressbar')
  assert.equal(progress.length, 1)
  assert.equal(progress[0]!.getAttribute('aria-valuenow'), null)
})

test('uses reported download bytes without replacing the progress indicator', () => {
  const { rerender } = render(React.createElement(EditorOpeningStatus, { label: 'Downloading project' }))

  rerender(React.createElement(EditorOpeningStatus, {
    label: 'Downloading project',
    downloadProgress: { loadedBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 }
  }))

  const progress = screen.getAllByRole('progressbar')
  assert.equal(progress.length, 1)
  assert.equal(progress[0]!.getAttribute('aria-valuenow'), '50')
  assert.ok(screen.getByText('5.0 MB of 10 MB'))
})
