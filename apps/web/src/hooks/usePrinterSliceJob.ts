/**
 * Start a slice from the PrintersView print flow.
 *
 * The page owns the slice and print dialogs. This hook owns the request, the
 * slicing-job cache update, and the transition to print after a successful
 * print-intent slice.
 */
import type { ComponentProps } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { LibraryFile, SlicingJobResponse } from '@printstream/shared'
import type { SliceFileModal } from '../components/library/SliceFileModal'
import { apiFetch } from '../lib/apiClient'
import { buildCreateSlicingJobBody } from '../lib/libraryViewHelpers'
import { refreshSlicingJobs, seedSlicingJob } from '../lib/slicingJobsCache'

type SliceSubmitInput = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[0]
type SliceSubmitAction = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[1]
type StartSliceInput = SliceSubmitInput & {
  file: LibraryFile
  preferredPrinterId: string
  action: SliceSubmitAction
}

type PrintReadyTarget = {
  sourceFile: LibraryFile
  jobId: string
  preferredPrinterId: string
}

/** Preserve the slice dialog while handing successful print-intent slices to the print step. */
export function usePrinterSliceJob(onPrintReady: (target: PrintReadyTarget) => void) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: StartSliceInput) => {
      const body = buildCreateSlicingJobBody(input, {
        sourceFileId: input.file.id,
        outputFolderId: null,
        hiddenOutput: input.action === 'print'
      })
      return await apiFetch<SlicingJobResponse>('/api/slicing/jobs', { method: 'POST', body })
    },
    onSuccess: (response, variables) => {
      // Keep the slice dialog mounted beneath the print flow so Back returns to
      // slice settings. The list refresh is not awaited; see slicingJobsCache.
      seedSlicingJob(queryClient, response.job)
      refreshSlicingJobs(queryClient)
      if (variables.action === 'print') {
        onPrintReady({
          sourceFile: variables.file,
          jobId: response.job.id,
          preferredPrinterId: variables.preferredPrinterId
        })
      }
    }
  })
}
