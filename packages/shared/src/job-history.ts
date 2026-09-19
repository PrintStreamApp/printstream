/**
 * The merged job-history contract: finished PRINT jobs and terminal SLICING jobs presented as
 * one filterable, sortable, server-paginated list (the Jobs view's "Job history" section).
 *
 * The history must page as a MERGED list, interleaving two independently-paged sources cannot
 * produce correct random-access pages, so the API merges, filters, sorts, and pages here
 * (`selectJobHistoryPage`, called by `GET /api/jobs/history`) and the web renders the page it is
 * given (`JobsView`, the counterpart). The derivation of an entry's identity/result/sort-keys/
 * search text lives in ONE place (`deriveJobHistoryFields`) used by both sides, so what the
 * server filters on cannot drift from what the client displays.
 *
 * Search matches the display text users see on the cards (display file name, printer name,
 * result/status label, slicer name) plus the ISO timestamp. This deliberately diverges from the
 * old client-side search in one way: dates match in ISO form ("2026-08-10"), not the browser's
 * locale rendering: the server has no client locale, and two half-matching haystacks would be
 * worse than one predictable form.
 *
 * The query's list parameters (`printerIds`, `results`) ride the URL comma-separated.
 */
import { z } from 'zod'
import { formatLibraryFileName } from './library-display.js'
import { printJobSchema, type PrintJob } from './printer-contracts.js'
import { getSlicingJobStatusLabel, slicingJobSchema, type SlicingJob } from './slicing.js'

const printJobResultSchema = printJobSchema.shape.result

/** A slicing job's outcome in the print-history result vocabulary (drives the shared filter). */
export function slicingHistoryResult(job: SlicingJob): PrintJob['result'] {
  switch (job.status) {
    case 'ready': return 'success'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    default: return 'unknown'
  }
}

const commaSeparated = z.string().default('').transform((value) => value.split(',').filter(Boolean))

export const jobHistoryKindSchema = z.enum(['print', 'slicing'])
export type JobHistoryKind = z.infer<typeof jobHistoryKindSchema>

export const jobHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(200).default(''),
  printerIds: commaSeparated,
  tagIds: commaSeparated.pipe(z.array(z.string().min(1).max(100)).max(100)),
  kinds: commaSeparated.pipe(z.array(jobHistoryKindSchema)),
  results: commaSeparated.pipe(z.array(printJobResultSchema)),
  sortBy: z.enum(['started', 'ended']).default('ended'),
  sortDirection: z.enum(['asc', 'desc']).default('desc')
})
export type JobHistoryQuery = z.infer<typeof jobHistoryQuerySchema>

export const jobHistoryEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('print'), printJob: printJobSchema }),
  z.object({ kind: z.literal('slicing'), slicingJob: slicingJobSchema })
])
export type JobHistoryEntry = z.infer<typeof jobHistoryEntrySchema>

export const jobHistoryResponseSchema = z.object({
  entries: z.array(jobHistoryEntrySchema),
  /** Entries matching the current filters (drives the pager). */
  total: z.number().int().nonnegative(),
  /**
   * Entries the workspace has at all, filters aside. Load-bearing for the view's gates: an
   * empty `total` with a non-zero `totalUnfiltered` means "no matches" (keep the toolbar), while
   * zero here means "no history yet" (show the empty state, hide the toolbar).
   */
  totalUnfiltered: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  /** Printer filter facet, derived from the WHOLE history so a filtered page never shrinks it. */
  printerOptions: z.array(z.object({ id: z.string(), name: z.string() }))
})
export type JobHistoryResponse = z.infer<typeof jobHistoryResponseSchema>

export interface JobHistoryDerivedFields {
  id: string
  printerId: string | null
  result: PrintJob['result']
  startedAt: string
  endedAt: string
  searchHaystack: string
}

/**
 * An entry's identity, filterable fields, sort keys, and search text. `printerNameFor` resolves
 * a slicing target's printer id to its current name (print jobs carry a name snapshot of their
 * own); unknown ids fall back to the id, matching what the card renders.
 */
export function deriveJobHistoryFields(
  entry: JobHistoryEntry,
  printerNameFor: (printerId: string) => string | null
): JobHistoryDerivedFields {
  if (entry.kind === 'print') {
    const job = entry.printJob
    return {
      id: job.id,
      printerId: job.printerId,
      result: job.result,
      startedAt: job.startedAt,
      endedAt: job.finishedAt ?? job.startedAt,
      searchHaystack: [
        formatLibraryFileName(job.fileName || job.jobName || 'Untitled'),
        job.printerName,
        job.result,
        job.startedAt
      ].join(' ').toLowerCase()
    }
  }
  const job = entry.slicingJob
  const printerId = job.target.mode === 'realPrinter' ? job.target.printerId : null
  const printerName = printerId ? (printerNameFor(printerId) ?? printerId) : 'Manual profile'
  const startedAt = job.startedAt ?? job.createdAt
  return {
    id: job.id,
    printerId,
    result: slicingHistoryResult(job),
    startedAt,
    endedAt: job.finishedAt ?? job.updatedAt,
    searchHaystack: [
      formatLibraryFileName(job.outputFileName ?? job.sourceFileName),
      printerName,
      job.slicerName ?? 'Slicer',
      getSlicingJobStatusLabel(job),
      startedAt
    ].join(' ').toLowerCase()
  }
}

/**
 * Merge, filter, sort, and page the history. Callers pass FINISHED print jobs and TERMINAL
 * slicing jobs only: active work belongs to the live sections, not history.
 *
 * Materializes both full sets to merge them; fine into the tens of thousands of jobs this
 * bounds the WIRE payload for (the old endpoint shipped the whole set to the browser instead).
 * Revisit with a database-side union if server-side cost ever matters.
 */
export function selectJobHistoryPage(input: {
  printJobs: ReadonlyArray<PrintJob>
  slicingJobs: ReadonlyArray<SlicingJob>
  query: JobHistoryQuery
  /** Server-resolved matches on linked entity tags, OR with the ordinary search text. */
  matchesAdditionalSearch?: (entry: JobHistoryEntry) => boolean
  /** ALL selected tag IDs must match, together with ordinary search and other facets. */
  matchesTags?: (entry: JobHistoryEntry) => boolean
  printerNameFor: (printerId: string) => string | null
}): JobHistoryResponse {
  const { query } = input
  const entries: Array<{ entry: JobHistoryEntry; derived: JobHistoryDerivedFields }> = [
    ...input.slicingJobs.map((slicingJob) => ({ kind: 'slicing', slicingJob } as const)),
    ...input.printJobs.map((printJob) => ({ kind: 'print', printJob } as const))
  ].map((entry) => ({ entry, derived: deriveJobHistoryFields(entry, input.printerNameFor) }))

  const printerOptions = entries
    .flatMap(({ entry, derived }) => {
      if (derived.printerId == null) return []
      const name = entry.kind === 'print'
        ? entry.printJob.printerName
        : input.printerNameFor(derived.printerId) ?? derived.printerId
      return [{ id: derived.printerId, name }]
    })
    .filter((printer, index, printers) => printers.findIndex((entry) => entry.id === printer.id) === index)
    .sort((left, right) => left.name.localeCompare(right.name))

  const printerIds = new Set(query.printerIds)
  const kinds = new Set(query.kinds)
  const results = new Set(query.results)
  const search = query.search.toLowerCase()
  const filtered = entries.filter(({ entry, derived }) => {
    if (kinds.size > 0 && !kinds.has(entry.kind)) return false
    if (printerIds.size > 0 && (derived.printerId == null || !printerIds.has(derived.printerId))) return false
    if (results.size > 0 && !results.has(derived.result)) return false
    if (query.tagIds.length > 0 && !input.matchesTags?.(entry)) return false
    if (!search) return true
    return derived.searchHaystack.includes(search) || (input.matchesAdditionalSearch?.(entry) ?? false)
  })

  filtered.sort((left, right) => {
    const leftDate = query.sortBy === 'started' ? left.derived.startedAt : left.derived.endedAt
    const rightDate = query.sortBy === 'started' ? right.derived.startedAt : right.derived.endedAt
    return query.sortDirection === 'desc'
      ? rightDate.localeCompare(leftDate)
      : leftDate.localeCompare(rightDate)
  })

  const start = (query.page - 1) * query.pageSize
  return {
    entries: filtered.slice(start, start + query.pageSize).map(({ entry }) => entry),
    total: filtered.length,
    totalUnfiltered: entries.length,
    page: query.page,
    pageSize: query.pageSize,
    printerOptions
  }
}
