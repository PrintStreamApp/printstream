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
  window.localStorage.setItem('workspace-a', 'alpha')
  window.localStorage.setItem('workspace-b', 'bravo')

  const view = render(<StoredValue storageKey="workspace-a" />)
  assert.equal(view.getByRole('button').textContent, 'alpha')

  fireEvent.click(view.getByRole('button'))
  await waitFor(() => assert.equal(window.localStorage.getItem('workspace-a'), 'updated'))

  view.rerender(<StoredValue storageKey="workspace-b" />)

  await waitFor(() => assert.equal(view.getByRole('button').textContent, 'bravo'))
  assert.equal(window.localStorage.getItem('workspace-b'), 'bravo')
})

/**
 * Two independent readers of ONE key, a settings dialog and the surface its preference governs.
 * The write must reach both, or the setting looks broken until the surface remounts. This is the
 * public editor's viewport preferences: localStorage is their only tier, so nothing else propagates.
 */
function TwoReaders() {
  return (
    <>
      <div data-testid="writer"><StoredValue storageKey="shared" /></div>
      <div data-testid="reader"><StoredValue storageKey="shared" /></div>
    </>
  )
}

test('a write reaches every instance reading the same key', async () => {
  window.localStorage.setItem('shared', 'before')
  const view = render(<TwoReaders />)
  const writer = view.getByTestId('writer').querySelector('button')!
  const reader = view.getByTestId('reader').querySelector('button')!
  assert.equal(reader.textContent, 'before')

  fireEvent.click(writer)

  await waitFor(() => assert.equal(writer.textContent, 'updated'))
  await waitFor(() => assert.equal(reader.textContent, 'updated'))
})

/** A JSON preference: `parse` returns a fresh object each call, so a naive sync loops forever. */
function JsonReader({ testid }: { testid: string }) {
  const [value, setValue] = useLocalStorageState<{ n: number }>(
    'json-pref',
    { n: 0 },
    (raw) => { try { return JSON.parse(raw) as { n: number } } catch { return null } }
  )
  return (
    <button type="button" data-testid={testid} onClick={() => setValue({ n: value.n + 1 })}>
      {String(value.n)}
    </button>
  )
}

test('an object-valued preference syncs without bouncing between instances', async () => {
  const view = render(<><JsonReader testid="a" /><JsonReader testid="b" /></>)
  fireEvent.click(view.getByTestId('a'))
  await waitFor(() => assert.equal(view.getByTestId('b').textContent, '1'))
  // Settled, not oscillating: both agree and storage holds exactly one increment.
  assert.equal(view.getByTestId('a').textContent, '1')
  assert.equal(window.localStorage.getItem('json-pref'), JSON.stringify({ n: 1 }))
})
