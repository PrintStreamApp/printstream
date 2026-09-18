import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const React = (await import('react')).default
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { LibraryAddToNewProjectAction } = await import('./LibraryAddToNewProjectAction')
const { MenuList } = await import('@mui/joy')

function MenuHost({ children }: { children: React.ReactNode }) {
  return React.createElement(MenuList, null, children)
}

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})
after(() => { dom.window.close() })

test('creates a scaffold and forwards the chosen model and cleanup to the editor', async () => {
  const requests: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ file: { id: 'scaffold', name: 'Untitled.3mf' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })
  }
  let opened: { file: { id: string }; options: { initialImportFileId: string; onDiscard: () => void } } | undefined
  let menuClosed = false
  render(React.createElement(LibraryAddToNewProjectAction, {
    fileId: 'source-step', kind: 'step', canUpload: true, bridgeId: 'bridge', folderId: 'folder',
    onAction: () => { menuClosed = true },
    onRequestSlice: (file: { id: string }, options: { initialImportFileId: string; onDiscard: () => void }) => {
      opened = { file, options }
    }
  }), { wrapper: MenuHost })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add to new 3MF' }))
  await waitFor(() => { assert.ok(opened) })
  assert.equal(menuClosed, true)
  assert.equal(opened!.file.id, 'scaffold')
  assert.equal(opened!.options.initialImportFileId, 'source-step')
  assert.equal(new URL(requests[0]!.url, 'http://localhost').pathname, '/api/editor/new-project')
  assert.deepEqual(requests[0]!.body, { bridgeId: 'bridge', folderId: 'folder' })
  opened!.options.onDiscard()
  await waitFor(() => { assert.equal(requests.length, 2) })
  assert.equal(new URL(requests[1]!.url, 'http://localhost').pathname, '/api/editor/scaffold/scaffold/discard')
})

test('offers supported bare models only, and requires upload permission', () => {
  const props = { fileId: 'model', canUpload: true, onRequestSlice: () => {} }
  const { rerender } = render(React.createElement(LibraryAddToNewProjectAction, { ...props, kind: 'stl' }), { wrapper: MenuHost })
  assert.ok(screen.getByRole('menuitem', { name: 'Add to new 3MF' }))
  for (const kind of ['3mf', 'gcode', 'unknown']) {
    rerender(React.createElement(LibraryAddToNewProjectAction, { ...props, kind }))
    assert.equal(screen.queryByRole('menuitem'), null)
  }
  rerender(React.createElement(LibraryAddToNewProjectAction, { ...props, kind: 'step', canUpload: false }))
  assert.equal(screen.queryByRole('menuitem'), null)
})
