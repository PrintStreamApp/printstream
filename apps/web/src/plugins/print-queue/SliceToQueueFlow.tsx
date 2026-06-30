/**
 * Slice-then-queue flow for an unsliced project 3MF. Slicing needs a target model
 * (gcode is machine-specific), but the queued item must NOT be pinned to a specific
 * printer — the matcher picks the printer at dispatch. So once slicing finishes this
 * hands the sliced output to the queue's own add dialog (which defaults to "any
 * eligible printer", auto-constrained to the sliced model), instead of the print
 * setup's forced printer selection.
 */
import { useCallback, useState, type ComponentProps } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LibraryFile, Printer, PrinterStatus, SlicingCapabilities, SlicingJobResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { SliceFileModal } from '../../components/library/SliceFileModal'
import { SliceThenPrintModal } from '../../components/library/SliceThenPrintModal'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import { QueueItemDialog } from './QueueItemDialog'

type SliceFlowSubmitInput = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[0]
type SliceFlowSubmitAction = Parameters<ComponentProps<typeof SliceFileModal>['onSubmit']>[1]

export function SliceToQueueFlow({ file, onClose }: { file: LibraryFile; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)

  // If the user leaves before the sliced output is added to the queue it's still a hidden
  // slice artifact — discard it so it isn't orphaned. Once the add "keeps" (un-hides) it,
  // discard is a server-side no-op, so this is safe to call on every close.
  const handleClose = useCallback(() => {
    if (jobId) {
      void apiFetch(`/api/slicing/jobs/${jobId}/discard`, { method: 'POST' }).catch(() => undefined)
    }
    onClose()
  }, [jobId, onClose])

  const printersQuery = useQuery<{ printers: Printer[] }>({
    queryKey: ['printers'],
    queryFn: ({ signal }) => apiFetch<{ printers: Printer[] }>('/api/printers', { signal })
  })
  const slicingCapabilitiesQuery = useQuery<SlicingCapabilities>({
    queryKey: ['slicing-capabilities'],
    queryFn: ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal })
  })
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  const startSlicingJob = useMutation({
    mutationFn: async (input: { action: SliceFlowSubmitAction } & SliceFlowSubmitInput) => {
      const body = {
        sourceFileId: file.id,
        slicerTargetId: input.slicerTargetId,
        target: input.target.mode === 'realPrinter'
          ? {
              mode: 'realPrinter',
              printerId: input.target.printerId,
              printerProfileId: input.target.printerProfileId,
              plateType: input.target.plateType,
              nozzleDiameters: input.target.nozzleDiameters,
              toolheads: input.target.toolheads,
              processProfileId: input.target.processProfileId,
              processSettingOverrides: input.target.processSettingOverrides,
              filamentMappings: input.target.filamentMappings
            }
          : {
              mode: 'manualProfile',
              printerProfileId: input.target.printerProfileId,
              printerModel: input.target.printerModel ?? 'unknown',
              plateType: input.target.plateType,
              nozzleDiameters: input.target.nozzleDiameters,
              toolheads: input.target.toolheads,
              processProfileId: input.target.processProfileId,
              processSettingOverrides: input.target.processSettingOverrides,
              filamentMappings: input.target.filamentMappings
            },
        outputFileName: input.outputFileName,
        outputFolderId: null,
        hiddenOutput: true,
        plate: input.plate,
        selectedObjectIds: input.selectedObjectIds,
        objectProcessOverrides: input.objectProcessOverrides
      }
      return apiFetch<SlicingJobResponse>('/api/slicing/jobs', { method: 'POST', body })
    },
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
      setJobId(response.job.id)
    }
  })

  if (!printersQuery.data) return null

  if (!jobId) {
    return (
      <SliceFileModal
        file={file}
        printers={printersQuery.data.printers}
        printerStatuses={statusQuery.data ?? {}}
        capabilities={slicingCapabilitiesQuery.data ?? null}
        capabilitiesLoading={slicingCapabilitiesQuery.isLoading && !slicingCapabilitiesQuery.data}
        capabilitiesError={slicingCapabilitiesQuery.error instanceof Error ? slicingCapabilitiesQuery.error.message : null}
        submitting={startSlicingJob.isPending}
        submitAction={startSlicingJob.variables?.action ?? null}
        submitError={startSlicingJob.error instanceof Error ? startSlicingJob.error.message : null}
        flow="print"
        defaultPlateNumber={1}
        flowCopy={{
          title: 'Slice for the queue',
          description: 'Review slicing settings, then continue to add the sliced result to the print queue.',
          continueLabel: 'Continue'
        }}
        onClose={handleClose}
        onSubmit={(input, action) => startSlicingJob.mutate({ action, ...input })}
      />
    )
  }

  return (
    <SliceThenPrintModal
      sourceFile={file}
      jobId={jobId}
      printers={printersQuery.data.printers}
      trackingCopy={{
        title: 'Add to queue',
        pendingText: 'This stays here until slicing is ready, then continues to the queue setup.',
        readyText: 'Slicing finished. Opening the queue setup…'
      }}
      renderReady={(outputFile) => (
        <QueueItemDialog open onClose={handleClose} fixedFile={{ id: outputFile.id, name: outputFile.name }} />
      )}
      onClose={handleClose}
    />
  )
}
