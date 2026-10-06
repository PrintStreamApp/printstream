import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { ReactNode } from 'react'
import { PRINTERS_VIEW_PERMISSION, JOBS_VIEW_PERMISSION } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/printers' })
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { cleanup, renderHook, waitFor } = await import('@testing-library/react')
const { usePrinterDashboardData } = await import('./usePrinterDashboardData')
const originalFetch = globalThis.fetch

afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
after(() => dom.window.close())

test('bridge placeholder suppresses data queries on overview but detail keeps its own data', async () => {
  const paths: string[] = []
  globalThis.fetch = async (url) => {
    const path = new URL(String(url), 'http://localhost').pathname
    paths.push(path)
    switch (path) {
      case '/api/auth/bootstrap':
        return Response.json({
          workspace: { id: 'workspace-1', slug: 'test', name: 'Test' },
          workspaceHasConnectedBridges: false,
          authEnabled: true,
          permissions: [PRINTERS_VIEW_PERMISSION, JOBS_VIEW_PERMISSION],
          capabilities: { canManageSettings: false }
        })
      case '/api/printers':
        return Response.json({ printers: [{ id: 'printer-1', name: 'Test printer' }] })
      case '/api/printer-views':
        return Response.json({ views: [] })
      case '/api/jobs':
      case '/api/print-dispatch':
        return Response.json({ jobs: [] })
      case '/api/printers/status':
        return Response.json({ statuses: {} })
      default:
        throw new Error(`Unexpected request: ${path}`)
    }
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result, rerender } = renderHook(
    ({ singlePrinterView }) => usePrinterDashboardData(singlePrinterView),
    { initialProps: { singlePrinterView: false }, wrapper }
  )

  await waitFor(() => assert.equal(result.current.authBootstrapQuery.isSuccess, true))
  assert.equal(result.current.showNoConnectedBridgesPlaceholder, true)
  assert.deepEqual(paths, ['/api/auth/bootstrap'])

  rerender({ singlePrinterView: true })
  await waitFor(() => assert.equal(result.current.printers.length, 1))
  await waitFor(() => assert.ok(paths.includes('/api/jobs')))
  assert.equal(result.current.showNoConnectedBridgesPlaceholder, false)
  assert.equal(result.current.canViewPrinters, true)
  assert.equal(result.current.canManagePrinters, false)
  assert.equal(paths.includes('/api/bridges'), false)
  assert.equal(paths.includes('/api/slicing/capabilities'), false)
  client.clear()
})

test('restricted printer access never starts printer-dependent requests', async () => {
  const paths: string[] = []
  globalThis.fetch = async (url) => {
    const path = new URL(String(url), 'http://localhost').pathname
    paths.push(path)
    if (path !== '/api/auth/bootstrap') throw new Error(`Unexpected request: ${path}`)

    return Response.json({
      workspace: { id: 'workspace-1', slug: 'test', name: 'Test' },
      workspaceHasConnectedBridges: true,
      authEnabled: true,
      permissions: [],
      capabilities: { canManageSettings: false }
    })
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result, rerender } = renderHook(
    ({ singlePrinterView }) => usePrinterDashboardData(singlePrinterView),
    { initialProps: { singlePrinterView: false }, wrapper }
  )

  await waitFor(() => assert.equal(result.current.authBootstrapQuery.isSuccess, true))
  assert.equal(result.current.canViewPrinters, false)
  assert.equal(result.current.printersQuery.isLoading, false)
  assert.deepEqual(paths, ['/api/auth/bootstrap'])

  rerender({ singlePrinterView: true })
  assert.equal(result.current.canViewPrinters, false)
  assert.deepEqual(paths, ['/api/auth/bootstrap'])
  client.clear()
})

test('printer request exposes loading then HTTP failure without inventing an empty inventory', async () => {
  let resolvePrinterRequest!: (response: Response) => void
  const pendingPrinterResponse = new Promise<Response>((resolve) => {
    resolvePrinterRequest = resolve
  })
  const paths: string[] = []
  globalThis.fetch = async (url) => {
    const path = new URL(String(url), 'http://localhost').pathname
    paths.push(path)
    if (path === '/api/auth/bootstrap') {
      return Response.json({
        workspace: { id: 'workspace-1', slug: 'test', name: 'Test' },
        workspaceHasConnectedBridges: true,
        authEnabled: true,
        permissions: [PRINTERS_VIEW_PERMISSION],
        capabilities: { canManageSettings: false }
      })
    }
    if (path === '/api/printers') {
      return pendingPrinterResponse
    }
    if (path === '/api/printer-views') return Response.json({ views: [] })
    if (path === '/api/printers/status') return Response.json({ statuses: {} })
    throw new Error(`Unexpected request: ${path}`)
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => usePrinterDashboardData(false), { wrapper })

  await waitFor(() => assert.equal(result.current.printersQuery.isLoading, true))
  assert.deepEqual(result.current.printers, [])
  assert.ok(paths.includes('/api/printers'))

  resolvePrinterRequest(Response.json({ error: 'Printer service unavailable' }, { status: 503 }))
  await waitFor(() => assert.equal(result.current.printersQuery.isError, true))
  assert.match((result.current.printersQuery.error as Error).message, /Printer service unavailable/)
  assert.deepEqual(result.current.printers, [])
  client.clear()
})
