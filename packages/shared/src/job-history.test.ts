/**
 * Pins the merged job-history semantics behind GET /api/jobs/history: the merge order, the
 * shared filters (printer/result/search) the server applies before paging, the facet rules,
 * and the paging math — including the totalUnfiltered/total split the view's gates rely on.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { jobHistoryQuerySchema, selectJobHistoryPage, type JobHistoryQuery } from './job-history.js'
import type { PrintJob } from './printer-contracts.js'
import type { SlicingJob } from './slicing.js'

function printJob(overrides: Partial<PrintJob>): PrintJob {
  return {
    id: 'print-1',
    printerId: 'printer-a',
    printerName: 'Voron... not really',
    jobName: 'Benchy',
    startedAt: '2026-08-01T10:00:00.000Z',
    finishedAt: '2026-08-01T11:00:00.000Z',
    progressPercent: 100,
    durationSeconds: 3600,
    result: 'success',
    jobKind: 'file',
    calibrationOption: null,
    fileId: 'file-1',
    fileName: 'Benchy.gcode.3mf',
    fileSizeBytes: 1000,
    sourceProjectFileId: null,
    sourceProjectFileName: null,
    sliceSettings: null,
    projectFilamentChips: [],
    plate: 1,
    useAms: null,
    bedLevel: null,
    amsMapping: null,
    activity: [],
    thumbnailPath: null,
    snapshotPath: null,
    ...overrides
  }
}

function slicingJob(overrides: Partial<SlicingJob>): SlicingJob {
  return {
    id: 'slice-1',
    sourceFileId: 'file-2',
    sourceFileName: 'Widget.3mf',
    outputFileId: null,
    outputFileName: null,
    target: { mode: 'realPrinter', printerId: 'printer-b', filamentMappings: [] } as SlicingJob['target'],
    plate: 1,
    status: 'ready',
    queuePosition: null,
    slicerName: 'BambuStudio',
    metadata: {},
    output: [],
    error: null,
    createdAt: '2026-08-02T09:00:00.000Z',
    updatedAt: '2026-08-02T09:30:00.000Z',
    startedAt: '2026-08-02T09:05:00.000Z',
    finishedAt: '2026-08-02T09:30:00.000Z',
    cancelRequested: false,
    ...overrides
  }
}

function query(overrides: Partial<JobHistoryQuery>): JobHistoryQuery {
  return { ...jobHistoryQuerySchema.parse({}), ...overrides }
}

const printerNameFor = (id: string) => (id === 'printer-b' ? 'Bee' : null)

test('query schema parses URL-shaped input with comma-separated lists', () => {
  const parsed = jobHistoryQuerySchema.parse({
    page: '2',
    pageSize: '25',
    printerIds: 'a,b',
    results: 'success,failed',
    sortBy: 'started',
    sortDirection: 'asc'
  })
  assert.equal(parsed.page, 2)
  assert.equal(parsed.pageSize, 25)
  assert.deepEqual(parsed.printerIds, ['a', 'b'])
  assert.deepEqual(parsed.results, ['success', 'failed'])
})

test('merges both sources sorted by end date, newest first by default', () => {
  const page = selectJobHistoryPage({
    printJobs: [printJob({})],
    slicingJobs: [slicingJob({})],
    query: query({}),
    printerNameFor
  })
  assert.deepEqual(page.entries.map((entry) => entry.kind), ['slicing', 'print'])
  assert.equal(page.total, 2)
  assert.equal(page.totalUnfiltered, 2)
})

test('printer filter matches both kinds and excludes manual-profile slices', () => {
  const manual = slicingJob({ id: 'slice-manual', target: { mode: 'manualProfile', machineProfileId: 'm', filamentMappings: [] } as unknown as SlicingJob['target'] })
  const page = selectJobHistoryPage({
    printJobs: [printJob({})],
    slicingJobs: [slicingJob({}), manual],
    query: query({ printerIds: ['printer-b'] }),
    printerNameFor
  })
  assert.deepEqual(page.entries.map((entry) => (entry.kind === 'slicing' ? entry.slicingJob.id : entry.printJob.id)), ['slice-1'])
  assert.equal(page.total, 1)
  assert.equal(page.totalUnfiltered, 3)
})

test('result filter speaks the print vocabulary for slicing jobs too', () => {
  const failed = slicingJob({ id: 'slice-failed', status: 'failed' })
  const page = selectJobHistoryPage({
    printJobs: [printJob({ result: 'cancelled' })],
    slicingJobs: [slicingJob({}), failed],
    query: query({ results: ['success'] }),
    printerNameFor
  })
  assert.equal(page.total, 1)
  assert.equal((page.entries[0] as { slicingJob: SlicingJob }).slicingJob.id, 'slice-1')
})

test('search matches the DISPLAY file name (hidden extension stripped) case-insensitively', () => {
  const page = selectJobHistoryPage({
    printJobs: [printJob({})],
    slicingJobs: [slicingJob({})],
    query: query({ search: 'BENCHY' }),
    printerNameFor
  })
  assert.equal(page.total, 1)
  assert.equal((page.entries[0] as { printJob: PrintJob }).printJob.id, 'print-1')
})

test('search matches the resolved printer name of a slicing entry', () => {
  const page = selectJobHistoryPage({
    printJobs: [printJob({})],
    slicingJobs: [slicingJob({})],
    query: query({ search: 'bee' }),
    printerNameFor
  })
  assert.equal(page.total, 1)
  assert.equal(page.entries[0]?.kind, 'slicing')
})

test('pages after filtering, 1-based', () => {
  const printJobs = Array.from({ length: 5 }, (_unused, index) => printJob({
    id: `print-${index}`,
    startedAt: `2026-08-0${index + 1}T10:00:00.000Z`,
    finishedAt: `2026-08-0${index + 1}T11:00:00.000Z`
  }))
  const page = selectJobHistoryPage({
    printJobs,
    slicingJobs: [],
    query: query({ page: 2, pageSize: 2 }),
    printerNameFor
  })
  // ended desc: print-4, print-3 | print-2, print-1 | print-0
  assert.deepEqual(page.entries.map((entry) => (entry as { printJob: PrintJob }).printJob.id), ['print-2', 'print-1'])
  assert.equal(page.total, 5)
})

test('sortBy started ascending', () => {
  const early = printJob({ id: 'early', startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-05T00:00:00.000Z' })
  const late = printJob({ id: 'late', startedAt: '2026-08-03T00:00:00.000Z', finishedAt: '2026-08-04T00:00:00.000Z' })
  const page = selectJobHistoryPage({
    printJobs: [late, early],
    slicingJobs: [],
    query: query({ sortBy: 'started', sortDirection: 'asc' }),
    printerNameFor
  })
  assert.deepEqual(page.entries.map((entry) => (entry as { printJob: PrintJob }).printJob.id), ['early', 'late'])
})

test('printer facet is unfiltered, deduped, name-sorted, and name-resolved per kind', () => {
  const page = selectJobHistoryPage({
    printJobs: [printJob({}), printJob({ id: 'print-2' })],
    slicingJobs: [slicingJob({}), slicingJob({ id: 'slice-2', target: { mode: 'realPrinter', printerId: 'printer-c', filamentMappings: [] } as SlicingJob['target'] })],
    query: query({ printerIds: ['printer-a'] }),
    printerNameFor
  })
  // Filter active, but the facet still lists every printer; unknown slicing ids fall back to the id.
  assert.deepEqual(page.printerOptions, [
    { id: 'printer-b', name: 'Bee' },
    { id: 'printer-c', name: 'printer-c' },
    { id: 'printer-a', name: 'Voron... not really' }
  ])
})
