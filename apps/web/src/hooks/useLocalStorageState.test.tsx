import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { useLocalStorageState } from './useLocalStorageState'

let dom: JSDOM

before(() => {
  dom = installJsdomGlobals({ url: 'http://localhost/printers' })
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

/**
 * Two instances of one key whose parsers disagree: the writer stores plain text, the reader parses
 * it as JSON and THROWS on it. Not contrived: the parameter table's column preference parses with
 * `JSON.parse`, and any value another surface (or an older build) left under that key reaches it.
 */
function PlainWriter() {
  // A RAW serializer, so what lands in storage is not JSON at all. The default is `JSON.stringify`,
  // which would have made the reader's `JSON.parse` succeed and prove nothing.
  const [value, setValue] = useLocalStorageState<string>('mixed-parsers', 'a', (raw) => raw, (plain) => plain)
  return <button type="button" data-testid="plain" onClick={() => setValue('not json')}>{value}</button>
}

function StrictJsonReader() {
  // No try/catch here ON PURPOSE: the hook is what must survive a throwing parser.
  const [value] = useLocalStorageState<{ n: number }>('mixed-parsers', { n: 7 }, (raw) => JSON.parse(raw) as { n: number })
  return <span data-testid="strict">{String(value.n)}</span>
}

test('a parser that throws on another instance\'s value falls back without clobbering the writer', async () => {
  // Two regressions in one gesture. The notification path used to call `parse` unguarded, and it
  // runs SYNCHRONOUSLY inside the writing instance's effect, so one component's unparseable value
  // threw out of an unrelated component's render. Guarding it was not enough: recording the
  // unreadable string as this instance's SYNCED form then made its own write effect fire, push the
  // fallback into storage and notify, so the reader's fallback silently replaced the writer's value
  // and the WRITER's displayed state flipped to it.
  //
  // The stored value is pre-seeded so the reader mounts holding a parsed value rather than its
  // fallback: the first version of this test asserted against a reader whose state never changed,
  // so React bailed out of the re-render and the clobber it was supposed to catch never ran.
  window.localStorage.setItem('mixed-parsers', JSON.stringify({ n: 1 }))
  const view = render(<><PlainWriter /><StrictJsonReader /></>)
  await waitFor(() => assert.equal(view.getByTestId('strict').textContent, '1'))

  fireEvent.click(view.getByTestId('plain'))

  // The writer completes AND keeps its own value: it used to throw, and then to be overwritten.
  await waitFor(() => assert.equal(view.getByTestId('plain').textContent, 'not json'))
  assert.equal(window.localStorage.getItem('mixed-parsers'), 'not json', 'the reader must not write over it')
  // And the reader falls back rather than rendering a half-parsed value.
  assert.equal(view.getByTestId('strict').textContent, '7')
})
