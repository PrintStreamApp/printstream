import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { PrinterFormValues } from '../components/printers/PrinterFormModal'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/printers' })
const React = (await import('react')).default
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { usePrinterManagementMutations } = await import('./usePrinterManagementMutations')
const { toast } = await import('../lib/toast')
const originalFetch = globalThis.fetch

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; toast.clear() })
after(() => dom.window.close())

test('printer edits preserve blank write-only codes and refresh lifetime stats', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 }, queries: { gcTime: Infinity } } })
  const events: string[] = []
  const bodies: Record<string, unknown>[] = []
  const input = {
    name: 'Workshop', host: '192.0.2.1', serial: 'serial', accessCode: '',
    model: 'X1C', bridgeId: 'bridge', currentPlateType: null, currentNozzleDiameters: []
  } as PrinterFormValues

  client.setQueryData(['printers'], { printers: [] })
  client.setQueryData(['printer-stats', 'printer-1'], { stats: {} })
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(String(url), 'http://localhost').pathname, '/api/printers/printer-1')
    assert.equal(options?.method, 'PATCH')
    bodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>)
    return Response.json({ printer: { id: 'printer-1' } })
  }

  const { result } = renderHook(() => usePrinterManagementMutations({
    closeAddDialog: () => events.push('add'),
    closeEditDialog: () => events.push('edit'),
    closeSortDialog: () => events.push('sort')
  }), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })

  await act(async () => { await result.current.edit.mutateAsync({ id: 'printer-1', input }) })
  const blankEditBody = bodies[0]
  assert.ok(blankEditBody)
  assert.equal(Object.hasOwn(blankEditBody, 'accessCode'), false)
  assert.equal(client.getQueryState(['printer-stats', 'printer-1'])?.isInvalidated, true)

  await act(async () => {
    await result.current.edit.mutateAsync({ id: 'printer-1', input: { ...input, accessCode: 'new-code' } })
  })
  assert.equal(bodies[1]?.accessCode, 'new-code')
  assert.deepEqual(events, ['edit', 'edit'])
  client.clear()
})

test('printer add, remove, and reorder close only their owning dialogs', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 }, queries: { gcTime: 0 } } })
  const events: string[] = []
  const requests: string[] = []
  const input = {
    name: 'Workshop', host: '192.0.2.1', serial: 'serial', accessCode: 'code',
    model: 'X1C', bridgeId: 'bridge', currentPlateType: null, currentNozzleDiameters: []
  } as PrinterFormValues

  globalThis.fetch = async (url, options) => {
    requests.push(`${options?.method} ${new URL(String(url), 'http://localhost').pathname}`)
    return options?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json({ printer: { id: 'printer-1' } })
  }
  const { result } = renderHook(() => usePrinterManagementMutations({
    closeAddDialog: () => events.push('add'),
    closeEditDialog: () => events.push('edit'),
    closeSortDialog: () => events.push('sort')
  }), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })

  await act(async () => { await result.current.add.mutateAsync(input) })
  await act(async () => { await result.current.remove.mutateAsync('printer-1') })
  await act(async () => { await result.current.reorder.mutateAsync(['printer-1']) })

  assert.deepEqual(requests, [
    'POST /api/printers', 'DELETE /api/printers/printer-1', 'POST /api/printers/reorder'
  ])
  assert.deepEqual(events, ['add', 'edit', 'sort'])
  client.clear()
})
