import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { PrintJob } from '@printstream/shared'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/printers' })
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react')
const { selectPrinterHistoryJobs, usePrinterDetailHistory } = await import('./usePrinterDetailHistory')

afterEach(() => { cleanup(); dom.window.localStorage.clear() })
after(() => dom.window.close())

function job(id: string, printerId: string, finishedAt: string | null, result: PrintJob['result']): PrintJob {
  return {
    id,
    printerId,
    finishedAt,
    result,
    startedAt: '2026-09-01T12:00:00.000Z',
    fileName: `${id}.3mf`,
    jobName: id
  } as PrintJob
}

test('detail history selects only finished jobs for the route printer and preserves source order', () => {
  const jobs = [
    job('early', 'p1', '2026-09-01T12:00:00.000Z', 'success'),
    job('other', 'p2', '2026-09-03T12:00:00.000Z', 'success'),
    job('active', 'p1', null, 'success'),
    job('late', 'p1', '2026-09-02T12:00:00.000Z', 'failed')
  ]
  assert.deepEqual(selectPrinterHistoryJobs(jobs, 'p1', 'desc').map((entry) => entry.id), ['late', 'early'])
  assert.deepEqual(selectPrinterHistoryJobs(jobs, 'p1', 'asc').map((entry) => entry.id), ['early', 'late'])
  assert.deepEqual(jobs.map((entry) => entry.id), ['early', 'other', 'active', 'late'])
})

test('detail history retains saved filters while the route printer changes', async () => {
  const jobs = [
    job('one', 'p1', '2026-09-01T12:00:00.000Z', 'success'),
    job('two', 'p1', '2026-09-02T12:00:00.000Z', 'failed'),
    job('three', 'p2', '2026-09-03T12:00:00.000Z', 'success')
  ]
  const { result, rerender } = renderHook(({ printerId }) => usePrinterDetailHistory(jobs, printerId), {
    initialProps: { printerId: 'p1' }
  })

  act(() => result.current.setDetailHistoryResults(['success']))
  assert.deepEqual(result.current.visibleSelectedPrinterJobs.map((entry) => entry.id), ['one'])
  await waitFor(() => assert.equal(dom.window.localStorage.getItem('printstream.printers.history.resultFilter'), '["success"]'))

  rerender({ printerId: 'p2' })
  assert.deepEqual(result.current.visibleSelectedPrinterJobs.map((entry) => entry.id), ['three'])
  assert.deepEqual(result.current.detailHistoryResults, ['success'])
})
