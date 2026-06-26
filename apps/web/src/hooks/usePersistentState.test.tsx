import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { JSDOM } from 'jsdom'
import { usePersistentState } from './usePersistentState'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/filament'
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

interface Prefs {
  group: 'none' | 'type'
  page: number
}

const DEFAULTS: Prefs = { group: 'none', page: 1 }

// Field-by-field sanitizer: keeps known values, falls back per-field otherwise.
function sanitize(value: unknown): Prefs {
  const raw = (value ?? {}) as Partial<Record<keyof Prefs, unknown>>
  return {
    group: raw.group === 'type' ? 'type' : 'none',
    page: typeof raw.page === 'number' && raw.page > 0 ? raw.page : 1
  }
}

function Harness({ storageKey }: { storageKey: string }) {
  const [prefs, setPrefs] = usePersistentState<Prefs>(storageKey, DEFAULTS, sanitize)
  return (
    <button type="button" onClick={() => setPrefs((prev) => ({ ...prev, group: 'type' }))}>
      {prefs.group}:{prefs.page}
    </button>
  )
}

test('usePersistentState hydrates a stored value and persists functional updates', async () => {
  window.localStorage.setItem('prefs', JSON.stringify({ group: 'type', page: 3 }))

  const view = render(<Harness storageKey="prefs" />)
  assert.equal(view.getByRole('button').textContent, 'type:3')

  fireEvent.click(view.getByRole('button'))
  await waitFor(() => {
    assert.deepEqual(JSON.parse(window.localStorage.getItem('prefs') ?? '{}'), { group: 'type', page: 3 })
  })
})

test('usePersistentState falls back to defaults for corrupt or partial entries', () => {
  window.localStorage.setItem('corrupt', 'not json{')
  const corrupt = render(<Harness storageKey="corrupt" />)
  assert.equal(corrupt.getByRole('button').textContent, 'none:1')
  cleanup()

  window.localStorage.setItem('partial', JSON.stringify({ group: 'bogus' }))
  const partial = render(<Harness storageKey="partial" />)
  // Unknown group drops to the default, missing page fills in the default.
  assert.equal(partial.getByRole('button').textContent, 'none:1')
})
