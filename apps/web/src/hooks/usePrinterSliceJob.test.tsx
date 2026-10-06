import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { LibraryFile } from '@printstream/shared'
import type { SliceFileSubmitInput } from '../lib/libraryViewHelpers'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/printers' })
const React = (await import('react')).default
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { usePrinterSliceJob } = await import('./usePrinterSliceJob')
const originalFetch = globalThis.fetch

afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
after(() => dom.window.close())

test('a print-intent slice seeds the job and advances only after the request succeeds', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 }, queries: { gcTime: Infinity } } })
  const requests: Record<string, unknown>[] = []
  const ready: string[] = []
  const file = { id: 'file-1' } as LibraryFile
  const submit = {
    slicerTargetId: 'target-1',
    target: { mode: 'realPrinter', printerId: 'printer-1', printerProfileId: 'machine-1', filamentMappings: [] },
    outputFileName: 'plate.gcode.3mf',
    plate: 1
  } as SliceFileSubmitInput
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(String(url), 'http://localhost').pathname, '/api/slicing/jobs')
    requests.push(JSON.parse(String(options?.body)) as Record<string, unknown>)
    return Response.json({ job: { id: 'slice-1' } })
  }

  const { result } = renderHook(() => usePrinterSliceJob((target) => ready.push(target.jobId)), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  })
  await act(async () => {
    await result.current.mutateAsync({ ...submit, file, preferredPrinterId: 'printer-1', action: 'print' })
  })

  assert.equal(requests[0]?.sourceFileId, 'file-1')
  assert.equal(requests[0]?.hiddenOutput, true)
  assert.deepEqual(ready, ['slice-1'])
  assert.equal(client.getQueryData<{ job: { id: string } }>(['slicing-job', 'slice-1'])?.job.id, 'slice-1')

  await act(async () => {
    await result.current.mutateAsync({ ...submit, file, preferredPrinterId: 'printer-1', action: 'slice' })
  })
  assert.equal(requests[1]?.hiddenOutput, false)
  assert.deepEqual(ready, ['slice-1'])
  client.clear()
})
