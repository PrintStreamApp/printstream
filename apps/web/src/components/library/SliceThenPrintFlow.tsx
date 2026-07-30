/**
 * Slice-then-print flow for a project 3MF, as a self-contained dialog stack.
 *
 * The same two steps `LibraryView`/`PrintersView` run inline — slice settings
 * (`SliceFileModal`, `flow="print"`) and then the print setup once the output is ready
 * (`SliceThenPrintModal`) — packaged for callers that hold only a file ID and want the
 * whole flow. Sibling of `SliceToQueueFlow`, which ends at the queue instead of a printer.
 *
 * Its caller today is print history's "Slice again": re-slicing the project a finished print
 * was produced from. That is why the file is FETCHED here rather than passed in — the preserved
 * project is a hidden library row no listing carries, so the caller has an id and nothing else.
 *
 * The output is always hidden (`hiddenOutput`), matching every other print-now path: the user
 * asked for a print, not for a second copy of the G-code in their library. `SliceThenPrintModal`
 * owns discarding it if they leave without printing.
 */
import { useCallback, useState, type ComponentProps } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LibraryFile, Printer, SlicingCapabilities, SlicingJobResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { refreshSlicingJobs, seedSlicingJob } from '../../lib/slicingJobsCache'
import { buildCreateSlicingJobBody } from '../../lib/libraryViewHelpers'
import { SliceFileModal } from './SliceFileModal'
import { SliceThenPrintModal } from './SliceThenPrintModal'

type SliceFlowSubmitInput = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[0]
type SliceFlowSubmitAction = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[1]

export function SliceThenPrintFlow({
  fileId,
  printers,
  preferredPrinterId,
  defaultPlate,
  initialSlicerTargetId,
  flowCopy,
  onClose
}: {
  /** Library file to slice. Fetched here; may be a hidden row (e.g. a preserved project). */
  fileId: string
  printers: Printer[]
  /** Preselect this printer in the print setup (e.g. the printer that ran the original job). */
  preferredPrinterId?: string
  defaultPlate?: number
  /** Preselect the engine the original slice used, when it is still installed. */
  initialSlicerTargetId?: string
  flowCopy?: ComponentProps<typeof SliceFileModal>['flowCopy']
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)

  const fileQuery = useQuery({
    queryKey: ['library-file', fileId],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${fileId}`, { signal })
  })
  const slicingCapabilitiesQuery = useQuery<SlicingCapabilities>({
    queryKey: ['slicing-capabilities'],
    queryFn: ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal })
  })

  const startSlicingJob = useMutation({
    mutationFn: async (input: { action: SliceFlowSubmitAction } & SliceFlowSubmitInput) => {
      const body = buildCreateSlicingJobBody(input, {
        sourceFileId: fileId,
        outputFolderId: null,
        hiddenOutput: true
      })
      return apiFetch<SlicingJobResponse>('/api/slicing/jobs', { method: 'POST', body })
    },
    onSuccess: (response) => {
      // Seeded rather than awaited — see slicingJobsCache: waiting on a list refetch to
      // hand the job over is what wedges the button.
      seedSlicingJob(queryClient, response.job)
      refreshSlicingJobs(queryClient)
      setJobId(response.job.id)
    }
  })

  // Back steps out of the print setup to the still-mounted slice settings, discarding the
  // throwaway output so re-slicing starts clean.
  const handleBackToSettings = useCallback(() => {
    if (jobId) {
      // Swallowed deliberately: this is best-effort tidy-up on a navigation the user already made,
      // and the server sweeps an undiscarded output (and its preserved project) on its own. An
      // error toast here would blame the user's Back press for a cleanup they never asked about.
      void apiFetch(`/api/slicing/jobs/${jobId}/discard`, { method: 'POST' }).catch(() => undefined)
    }
    setJobId(null)
  }, [jobId])

  const file = fileQuery.data?.file
  if (!file) return null

  return (
    <>
      <SliceFileModal
        // Re-mount per file: the dialog's per-file state (materials, one-shot default
        // seeding) must not survive a target swap. See LibraryView's mount.
        key={file.id}
        file={file}
        printers={printers}
        capabilities={slicingCapabilitiesQuery.data ?? null}
        capabilitiesLoading={slicingCapabilitiesQuery.isLoading && !slicingCapabilitiesQuery.data}
        capabilitiesError={slicingCapabilitiesQuery.error instanceof Error ? slicingCapabilitiesQuery.error.message : null}
        submitting={startSlicingJob.isPending}
        submitAction={startSlicingJob.variables?.action ?? null}
        submitError={startSlicingJob.error instanceof Error ? startSlicingJob.error.message : null}
        flow="print"
        preferredPrinterId={preferredPrinterId}
        defaultPlateNumber={defaultPlate}
        initialSlicerTargetId={initialSlicerTargetId}
        flowCopy={flowCopy}
        onClose={onClose}
        onSubmit={(input, action) => startSlicingJob.mutate({ action, ...input })}
      />
      {jobId && (
        <SliceThenPrintModal
          sourceFile={file}
          jobId={jobId}
          printers={printers}
          preferredPrinterId={preferredPrinterId}
          onBack={handleBackToSettings}
          onClose={onClose}
        />
      )}
    </>
  )
}
