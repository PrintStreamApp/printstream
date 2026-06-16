import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { JSDOM } from 'jsdom'
import { useLocalStorageState } from './useLocalStorageState'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/printers'
})

before(() => {
  const { window } = dom
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver
  })
})

afterEach(() => {
  window.localStorage.clear()
  cleanup()
})

after(() => {
  dom.window.close()
})

function StoredValue({ storageKey }: { storageKey: string }) {
  const [value, setValue] = useLocalStorageState(storageKey, 'fallback', (raw) => raw, String)
  return (
    <button type="button" onClick={() => setValue('updated')}>
      {value}
    </button>
  )
}

test('useLocalStorageState reloads changed keys without overwriting the next key first', async () => {
  window.localStorage.setItem('tenant-a', 'alpha')
  window.localStorage.setItem('tenant-b', 'bravo')

  const view = render(<StoredValue storageKey="tenant-a" />)
  assert.equal(view.getByRole('button').textContent, 'alpha')

  fireEvent.click(view.getByRole('button'))
  await waitFor(() => assert.equal(window.localStorage.getItem('tenant-a'), 'updated'))

  view.rerender(<StoredValue storageKey="tenant-b" />)

  await waitFor(() => assert.equal(view.getByRole('button').textContent, 'bravo'))
  assert.equal(window.localStorage.getItem('tenant-b'), 'bravo')
})
