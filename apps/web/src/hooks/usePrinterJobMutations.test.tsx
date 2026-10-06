import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { workspaceQueryKeys } from '../lib/workspaceScope'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/printers' })
const React = (await import('react')).default
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { usePrinterJobMutations } = await import('./usePrinterJobMutations')
const { toast } = await import('../lib/toast')
const originalFetch = globalThis.fetch

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; toast.clear() })
after(() => dom.window.close())

test('reprint refreshes history, dispatch, and current workspace status', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 }, queries: { gcTime: Infinity } } })
  const statusKey = workspaceQueryKeys.printerStatus('workspace-1')
  client.setQueryData(['jobs'], { jobs: [] })
  client.setQueryData(['print-dispatch'], { jobs: [] })
  client.setQueryData(statusKey, {})
  const requests: string[] = []
  globalThis.fetch = async (url, options) => {
    requests.push(`${options?.method} ${new URL(String(url), 'http://localhost').pathname}`)
    return Response.json({ job: { id: 'dispatch-1' } })
  }

  const { result } = renderHook(() => usePrinterJobMutations('workspace-1'), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  })

  await act(async () => { await result.current.restartJob.mutateAsync({ jobId: 'job-1' }) })
  assert.deepEqual(requests, ['POST /api/jobs/job-1/reprint'])
  assert.equal(result.current.replayingJobId, null)
  assert.equal(client.getQueryState(['jobs'])?.isInvalidated, true)
  assert.equal(client.getQueryState(['print-dispatch'])?.isInvalidated, true)
  assert.equal(client.getQueryState(statusKey)?.isInvalidated, true)
  client.clear()
})

test('deleting a history entry refreshes history without touching dispatch status', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 }, queries: { gcTime: Infinity } } })
  client.setQueryData(['jobs'], { jobs: [] })
  client.setQueryData(['print-dispatch'], { jobs: [] })
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(String(url), 'http://localhost').pathname, '/api/jobs/job-1')
    assert.equal(options?.method, 'DELETE')
    return new Response(null, { status: 204 })
  }

  const { result } = renderHook(() => usePrinterJobMutations('workspace-1'), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  })
  await act(async () => { await result.current.deleteHistoryJob.mutateAsync('job-1') })
  assert.equal(client.getQueryState(['jobs'])?.isInvalidated, true)
  assert.equal(client.getQueryState(['print-dispatch'])?.isInvalidated, false)
  client.clear()
})
