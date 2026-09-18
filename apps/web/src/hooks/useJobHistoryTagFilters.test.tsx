import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/jobs' })
const React = (await import('react')).default
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { renderHook, waitFor, cleanup, act } = await import('@testing-library/react')
const { useJobHistoryTagFilters } = await import('./useJobHistoryTagFilters')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; dom.window.localStorage.clear() })
after(() => dom.window.close())

test('history filters offer deleted tag snapshots with only jobs-view permission and keep their selection', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  client.setQueryData(['auth-bootstrap', 'workspace:test'], {
    workspace: { id: 'w1', slug: 'test', name: 'Test' }, authEnabled: true, permissions: ['jobs.view']
  })
  const tag = { id: 'historical-id', entityKind: 'file', name: 'Deleted tag', group: 'Original group', color: '#123456' }
  const urls: string[] = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    assert.ok(String(url).includes('/api/jobs/history/tags'))
    return new Response(JSON.stringify({ tags: [tag] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const { result } = renderHook(() => useJobHistoryTagFilters(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  })
  await waitFor(() => assert.deepEqual(result.current.filters[1]?.filter.tags, [tag]))
  act(() => result.current.filters[1]!.filter.onChange(['historical-id']))
  await act(async () => { await client.invalidateQueries({ queryKey: ['job-history'] }) })
  assert.deepEqual(result.current.ids, ['historical-id'])
  assert.ok(urls.length >= 2)
  client.clear()
})
