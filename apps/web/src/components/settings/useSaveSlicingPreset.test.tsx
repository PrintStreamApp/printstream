/** A dialog publishes its saved result before the preset lists refresh; a failed save does neither. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { renderHook, cleanup } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const React = await import('react')
const { useSaveSlicingPreset } = await import('./useSaveSlicingPreset')
afterEach(cleanup)
after(() => dom.window.close())

/** Render the hook with a query client, answering the save request with `response`. */
function renderSave(response: () => Response, events: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => response()
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client }, children)
  const view = renderHook(() => useSaveSlicingPreset(() => { events.push('refresh') }), { wrapper })
  return { save: view.result.current, done: () => { view.unmount(); client.clear(); globalThis.fetch = previousFetch } }
}

test('a successful save publishes the dialog result before the preset lists refresh', async () => {
  const events: string[] = []
  const { save, done } = renderSave(() => Response.json({}), events)
  try {
    await save({ kind: 'process', name: 'draft', overwrite: false, config: {} }, () => { events.push('apply', 'close') })
    assert.deepEqual(events, ['apply', 'close', 'refresh'])
  } finally {
    done()
  }
})

test('a rejected save neither publishes the dialog result nor refreshes the preset lists', async () => {
  const events: string[] = []
  const { save, done } = renderSave(() => Response.json({ error: 'Save rejected' }, { status: 400 }), events)
  try {
    await assert.rejects(save({ kind: 'process', name: 'draft', overwrite: false, config: {} }, () => { events.push('apply') }), /Save rejected/)
    assert.deepEqual(events, [])
  } finally {
    done()
  }
})
