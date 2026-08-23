import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { JSDOM } from 'jsdom'
import { useDirectorySortState } from './useDirectorySortState'

/**
 * What a persisted sort must survive.
 *
 * The migration case is the one worth a test: the workspace directory stored its
 * sort as JSON through `usePersistentState` (`"createdAt"`, with quotes) and now
 * reads through this hook, which writes the bare value. If the read did not
 * accept both, every operator's saved sort would silently reset to the default on
 * the first load after deploy: the exact failure `legacyDirectoryKey` exists to
 * prevent, and one nobody reports as a bug because it looks like they never set
 * it.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/platform'
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

type Field = 'name' | 'createdAt'

const OPTIONS = [
  { value: 'name' as const, label: 'Name' },
  { value: 'createdAt' as const, label: 'Created' }
]

let pageResets = 0

function SortHarness({ legacySortByKeys = [] }: { legacySortByKeys?: ReadonlyArray<string> }) {
  const { sortBy, sortDirection, sortProps } = useDirectorySortState<Field>({
    sortByKey: 'directory.sortBy',
    sortDirectionKey: 'directory.sortDirection',
    options: OPTIONS,
    defaultSortBy: 'name',
    defaultDirection: 'asc',
    ariaLabel: 'Sort things',
    legacySortByKeys,
    onChange: () => { pageResets += 1 }
  })
  return (
    <div>
      <span data-testid="state">{`${sortBy}/${sortDirection}`}</span>
      <button type="button" onClick={() => sortProps.onSortValueChange('createdAt')}>field</button>
      <button type="button" onClick={() => sortProps.onSortDirectionChange('desc')}>direction</button>
    </div>
  )
}

test('a sort saved in the old JSON format is read, not silently reset', () => {
  // Exactly what usePersistentState wrote for these keys.
  window.localStorage.setItem('directory.sortBy', JSON.stringify('createdAt'))
  window.localStorage.setItem('directory.sortDirection', JSON.stringify('desc'))

  const view = render(<SortHarness />)

  assert.equal(view.getByTestId('state').textContent, 'createdAt/desc')
})

test('a sort saved in the bare format is read too', () => {
  window.localStorage.setItem('directory.sortBy', 'createdAt')
  window.localStorage.setItem('directory.sortDirection', 'desc')

  const view = render(<SortHarness />)

  assert.equal(view.getByTestId('state').textContent, 'createdAt/desc')
})

test('a renamed key migrates its value forward', () => {
  window.localStorage.setItem('directory.legacySortBy', JSON.stringify('createdAt'))

  const view = render(<SortHarness legacySortByKeys={['directory.legacySortBy']} />)

  assert.equal(view.getByTestId('state').textContent, 'createdAt/asc')
})

test('a field the build no longer offers falls back instead of reaching the server', () => {
  window.localStorage.setItem('directory.sortBy', 'aFieldThisBuildDropped')

  const view = render(<SortHarness />)

  assert.equal(view.getByTestId('state').textContent, 'name/asc')
})

test('an unreadable direction falls back rather than throwing', () => {
  window.localStorage.setItem('directory.sortDirection', '{ not json')

  const view = render(<SortHarness />)

  assert.equal(view.getByTestId('state').textContent, 'name/asc')
})

test('changing either half writes the bare form and resets the page', async () => {
  pageResets = 0
  const view = render(<SortHarness />)

  fireEvent.click(view.getByText('field'))
  await waitFor(() => assert.equal(window.localStorage.getItem('directory.sortBy'), 'createdAt'))
  assert.equal(pageResets, 1)

  // The DIRECTION half is the one both hand-rolled call sites forgot to reset on.
  fireEvent.click(view.getByText('direction'))
  await waitFor(() => assert.equal(window.localStorage.getItem('directory.sortDirection'), 'desc'))
  assert.equal(pageResets, 2)
})
