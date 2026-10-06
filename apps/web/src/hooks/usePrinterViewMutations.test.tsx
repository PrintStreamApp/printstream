import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { PrinterView, PrinterViewInput } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/printers' })
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react')
const { usePrinterViewMutations } = await import('./usePrinterViewMutations')
const { toast } = await import('../lib/toast')
const originalFetch = globalThis.fetch

afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
after(() => dom.window.close())

test('saved-view mutations reconcile the scoped list and call route owners in order', async () => {
  const queryKey = ['printer-views', 'test']
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 }, queries: { gcTime: 0 } } })
  const view = { id: 'view-1', name: 'Workshop' } as PrinterView
  const input = { name: 'Workshop' } as PrinterViewInput
  const events: string[] = []
  client.setQueryData(queryKey, { views: [] })
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path === '/api/printer-views' && options?.method === 'POST') {
      assert.deepEqual(client.getQueryData(queryKey), { views: [] })
      return Response.json({ view })
    }
    if (path === '/api/printer-views/view-1' && options?.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected request: ${options?.method} ${path}`)
  }
  const { result } = renderHook(() => usePrinterViewMutations({
    queryKey,
    clearDraft: () => events.push('draft'),
    closeDialog: () => events.push('dialog'),
    onCreated: (id) => {
      assert.deepEqual(client.getQueryData(queryKey), { views: [view] })
      events.push(`created:${id}`)
    },
    onDeleted: (id) => {
      assert.deepEqual(client.getQueryData(queryKey), { views: [] })
      events.push(`deleted:${id}`)
    }
  }), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })

  await act(async () => { await result.current.create.mutateAsync(input) })
  assert.deepEqual(events, ['draft', 'dialog', 'created:view-1'])

  await act(async () => { await result.current.remove.mutateAsync('view-1') })
  assert.deepEqual(events, ['draft', 'dialog', 'created:view-1', 'deleted:view-1', 'dialog'])
  cleanup()
  client.clear()
  toast.clear()
})

test('toolbar save updates the active view without closing its dialog or changing its route', async () => {
  const queryKey = ['printer-views', 'test']
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 }, queries: { gcTime: Infinity } } })
  const original = {
    id: 'view-1', name: 'Workshop', cardsPerRow: 3, cardContentSettings: {},
    sort: { key: 'name', direction: 'asc' }, group: 'none', stateFilter: 'all',
    modelFilter: [], nozzleDiameterFilter: [], plateTypeFilter: [], printerIds: []
  } as unknown as PrinterView
  const serverView = { ...original, name: 'Workshop from server', modelFilter: ['X1C'] }
  const events: string[] = []
  let finishPatch!: (response: Response) => void
  client.setQueryData(queryKey, { views: [original] })
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url), 'http://localhost').pathname
    assert.equal(path, '/api/printer-views/view-1')
    assert.equal(options?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(options?.body)).modelFilter, ['X1C'])
    return new Promise<Response>((resolve) => { finishPatch = resolve })
  }
  const { result } = renderHook(() => usePrinterViewMutations({
    queryKey,
    clearDraft: () => events.push('draft'),
    closeDialog: () => events.push('dialog'),
    onCreated: () => events.push('created'),
    onDeleted: () => events.push('deleted')
  }), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })

  act(() => result.current.saveToolbarContent(original, { ...original, modelFilter: ['X1C'] }))
  assert.deepEqual((client.getQueryData<{ views: PrinterView[] }>(queryKey)?.views ?? [])[0]?.modelFilter, ['X1C'])
  assert.deepEqual(events, ['draft'])

  await waitFor(() => assert.equal(typeof finishPatch, 'function'))
  await act(async () => { finishPatch(Response.json({ view: serverView })) })
  await waitFor(() => assert.equal(client.getQueryData<{ views: PrinterView[] }>(queryKey)?.views[0]?.name, 'Workshop from server'))
  assert.deepEqual(events, ['draft'])

  cleanup()
  client.clear()
  toast.clear()
})
