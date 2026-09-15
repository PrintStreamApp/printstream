import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { LibraryFile, SlicingJobResponse } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

// ScrollableDialogBody measures overflow via rAF, which jsdom does not provide.
const animationFrameWindow = dom.window as unknown as {
  requestAnimationFrame: (callback: () => void) => number
  cancelAnimationFrame: (handle: number) => void
}
animationFrameWindow.requestAnimationFrame = (callback) => dom.window.setTimeout(callback, 0) as unknown as number
animationFrameWindow.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)

const React = (await import('react')).default
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { SliceResultModal } = await import('./SliceThenPrintModal')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

test('a cancelled slice explains the outcome without showing active progress', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData<SlicingJobResponse>(['slicing-job', 'slice-1'], {
    job: {
      id: 'slice-1',
      sourceFileId: 'project-1',
      sourceFileName: 'project.3mf',
      outputFileId: null,
      outputFileName: null,
      target: { mode: 'manualProfile', printerModel: 'A1', printerProfileId: 'printer', filamentMappings: [] },
      plate: 1,
      status: 'cancelled',
      queuePosition: null,
      slicerName: null,
      metadata: undefined,
      output: [],
      error: null,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:01.000Z',
      startedAt: '2026-09-10T00:00:00.000Z',
      finishedAt: '2026-09-10T00:00:01.000Z',
      cancelRequested: true
    }
  })

  render(
    <QueryClientProvider client={queryClient}>
      <SliceResultModal
        sourceFile={{ id: 'project-1', name: 'project.3mf' } as LibraryFile}
        jobId="slice-1"
        printers={[]}
        canPrint={false}
        folders={[]}
        bridgeId={null}
        bridgeName={null}
        showRoot={false}
        onClose={() => undefined}
      />
    </QueryClientProvider>
  )

  assert.ok(screen.getByText('Slicing was cancelled. No sliced file was saved.'))
  assert.equal(screen.queryByRole('progressbar'), null)
})

test('an editor-owned ready result can close without discarding its hidden output', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } }
  })
  queryClient.setQueryData<SlicingJobResponse>(['slicing-job', 'slice-ready'], {
    job: {
      id: 'slice-ready',
      sourceFileId: 'project-1',
      sourceFileName: 'project.3mf',
      outputFileId: 'output-1',
      outputFileName: 'project.gcode.3mf',
      target: { mode: 'manualProfile', printerModel: 'A1', printerProfileId: 'printer', filamentMappings: [] },
      plate: 1,
      status: 'ready',
      queuePosition: null,
      slicerName: 'stable',
      metadata: undefined,
      output: [],
      error: null,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:01.000Z',
      startedAt: '2026-09-10T00:00:00.000Z',
      finishedAt: '2026-09-10T00:00:01.000Z',
      cancelRequested: false
    }
  })
  let retained = false

  render(
    <QueryClientProvider client={queryClient}>
      <SliceResultModal
        sourceFile={{ id: 'project-1', name: 'project.3mf' } as LibraryFile}
        jobId="slice-ready"
        printers={[]}
        canPrint={false}
        folders={[]}
        bridgeId={null}
        bridgeName={null}
        showRoot={false}
        retainReadyResultOnClose
        onClose={(result) => { retained = result.retained }}
      />
    </QueryClientProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  assert.equal(retained, true)
})
