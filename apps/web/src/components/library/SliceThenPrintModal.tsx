/**
 * Slice-then-print and slice-result dialogs extracted from `pages/LibraryView.tsx`.
 *
 * `SliceThenPrintModal` tracks a slicing job spawned by the "print" action and,
 * once the job is ready, swaps itself for the shared `PrintModal` against the
 * sliced output. `SliceResultModal` tracks a "slice without saving" job, shows
 * the usage estimates when ready, and lets the user preview, keep (un-hide), or
 * print the gcode. Both are exported for reuse by the printers and orders flows.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert, Box, Button, Chip, CircularProgress, DialogActions, LinearProgress, Sheet, Stack, Typography
} from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LibraryFile, LibraryFolder, Printer, StartOrderPrintInput } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { invalidateLibraryListQueries } from '../../lib/libraryQueryInvalidation'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { PluginSlot } from '../../plugin/PluginSlot'
import { formatLibraryFileName, splitLibraryFileNameForRename } from '../../lib/libraryDisplay'
import { LibraryDestinationDialog } from '../LibraryDestinationDialog'
import {
  formatSlicingProgress,
  getLatestSlicingProgressFrame,
  getSlicingJobStatusLabel,
  slicingStatusColor
} from '../../lib/slicingJobPresentation'
import { formatSecondsDuration } from '../../lib/time'
import { buildDefaultAmsMappingFromSlicingTarget, resolveSlicingLeaveAction } from '../../lib/slicingPrintHandoff'
import { toast } from '../../lib/toast'
import { suppressJobToast } from '../../lib/dialogToastSuppression'
import { useSlicingJobs } from '../../hooks/useSlicingJobs'
import { PrintModal } from './PrintModal'

/** A slicing job is still running (and therefore cancellable) until a terminal state. */
function isSlicingInProgress(status: string): boolean {
  return status !== 'ready' && status !== 'failed' && status !== 'cancelled'
}

/**
 * Run an orphan-cleanup (cancel an in-flight slice / discard an unkept output) on a REAL unmount
 * only — NOT React 18 StrictMode's dev mount→unmount→remount. StrictMode runs setup→cleanup→setup
 * synchronously to stress-test effects; a naive unmount cleanup here would fire that throwaway
 * cleanup and cancel a slice the instant the tracker opens. So the side effect is deferred a
 * macrotask and cleared if the component re-mounts in the same tick (StrictMode), while a genuine
 * unmount has no follow-up setup to clear it. `cleanup` is read from a ref so it sees the latest
 * job/commit state.
 */
function useOrphanSliceCleanup(cleanup: () => void): void {
  const cleanupRef = useRef(cleanup)
  cleanupRef.current = cleanup
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    return () => {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        cleanupRef.current()
      }, 0)
    }
  }, [])
}

export function SliceThenPrintModal({
  sourceFile,
  jobId,
  printers,
  preferredPrinterId,
  lockPrinterSelection = false,
  submitPrint,
  printTitle,
  printSubmitLabel,
  renderReady,
  trackingCopy,
  onBack,
  onClose
}: {
  sourceFile: LibraryFile
  jobId: string
  printers: Printer[]
  preferredPrinterId?: string
  lockPrinterSelection?: boolean
  /** Override the final PrintModal heading/submit label (e.g. for "add to queue"). */
  printTitle?: string
  printSubmitLabel?: string
  /**
   * When set, render this instead of the print setup once slicing is ready — e.g. the
   * queue flow hands the sliced output to its own add dialog (no forced printer choice)
   * rather than going to printer selection.
   */
  renderReady?: (outputFile: LibraryFile) => ReactNode
  /**
   * Copy for the transient progress dialog shown while slicing runs (before the
   * handoff to the terminal step). Defaults describe the print handoff; flows that
   * end somewhere other than printing (e.g. "add to queue") override it so the
   * heading and helper text stay accurate.
   */
  trackingCopy?: { title?: string; pendingText?: string; readyText?: string }
  /**
   * Override the final print submission (default posts to the slicing job's
   * own print endpoint). `outputFile` is the sliced library file being
   * dispatched — e.g. the orders flow records it against the order item.
   */
  submitPrint?: (input: {
    printerId: string
    body: Omit<StartOrderPrintInput, 'printerId'>
    outputFile: LibraryFile
  }) => Promise<void>
  /**
   * When provided, the print setup shows a "Back" action that returns to the
   * still-mounted slice settings underneath (discarding the throwaway output so
   * re-slicing starts clean). Without it, only Cancel/Print are offered.
   */
  onBack?: () => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const slicingJobsQuery = useSlicingJobs({ suppressGlobalErrorToast: true })
  // While this dialog tracks the job, suppress its redundant global toast.
  useEffect(() => suppressJobToast('slicing', jobId), [jobId])
  const job = useMemo(
    () => slicingJobsQuery.data?.jobs.find((entry) => entry.id === jobId) ?? null,
    [jobId, slicingJobsQuery.data?.jobs]
  )
  const defaultAmsMapping = useMemo(
    () => (job?.target.mode === 'realPrinter' ? buildDefaultAmsMappingFromSlicingTarget(job.target) : null),
    [job?.target]
  )
  const outputFileQuery = useQuery({
    queryKey: ['library-file', job?.outputFileId ?? 'missing'],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${job?.outputFileId}`, { signal }),
    enabled: Boolean(job?.status === 'ready' && job.outputFileId)
  })

  // Cancelling/leaving must not orphan an in-flight job, and once the user has dismissed
  // we must never hand off to the next step: the cancel can race a near-complete slice, and
  // proceeding would present a possibly-incomplete output as a finished one.
  const jobRef = useRef(job)
  jobRef.current = job
  const dismissHandledRef = useRef(false)
  // Set once the sliced output has actually been dispatched to a printer, so leaving
  // the dialog afterwards keeps the printed file instead of discarding it (PrintModal
  // calls onClose on a successful print).
  const printedRef = useRef(false)
  // Cancel a still-running slice, or discard a finished-but-unused hidden output, so
  // leaving never orphans the job. A printed output is kept.
  const runOrphanCleanup = useCallback(() => {
    dismissHandledRef.current = true
    const current = jobRef.current
    const action = resolveSlicingLeaveAction({
      status: current?.status,
      outputFileId: current?.outputFileId,
      printed: printedRef.current
    })
    if (action === 'cancel') {
      void apiFetch(`/api/slicing/jobs/${jobId}/cancel`, { method: 'POST' })
        .then(() => queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] }))
        .catch(() => undefined)
    } else if (action === 'discard') {
      // Sliced but left before printing: discard the hidden throwaway output.
      void apiFetch(`/api/slicing/jobs/${jobId}/discard`, { method: 'POST' }).catch(() => undefined)
    }
  }, [jobId, queryClient])
  // Dismiss (Cancel / backdrop / Escape) abandons the whole flow.
  const handleDismiss = useCallback(() => {
    runOrphanCleanup()
    onClose()
  }, [runOrphanCleanup, onClose])
  // Back steps out of the print setup and returns to the slice settings still mounted
  // underneath; the throwaway output is discarded so re-slicing starts clean.
  const handleBack = useCallback(() => {
    runOrphanCleanup()
    onBack?.()
  }, [runOrphanCleanup, onBack])
  // Unmounted without an explicit dismiss (e.g. navigated away): cancel a running
  // slice, or discard an unprinted finished output, rather than orphaning it.
  useOrphanSliceCleanup(() => {
    if (dismissHandledRef.current) return
    const current = jobRef.current
    const action = resolveSlicingLeaveAction({
      status: current?.status,
      outputFileId: current?.outputFileId,
      printed: printedRef.current
    })
    if (action === 'cancel') {
      void apiFetch(`/api/slicing/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => undefined)
    } else if (action === 'discard') {
      void apiFetch(`/api/slicing/jobs/${jobId}/discard`, { method: 'POST' }).catch(() => undefined)
    }
  })

  if (job?.status === 'ready' && outputFileQuery.data?.file && !dismissHandledRef.current) {
    const outputFile = outputFileQuery.data.file
    if (renderReady) return <>{renderReady(outputFile)}</>
    return (
      <PrintModal
        file={outputFile}
        printers={printers}
        title={printTitle}
        submitLabel={printSubmitLabel}
        defaultPrinterId={job.target.mode === 'realPrinter' ? job.target.printerId : preferredPrinterId}
        lockPrinterSelection={lockPrinterSelection}
        defaultPlate={job.plate > 0 ? job.plate : 1}
        defaultAmsMapping={defaultAmsMapping}
        submitPrint={async ({ printerId, body }) => {
          if (submitPrint) {
            await submitPrint({ printerId, body, outputFile })
          } else {
            await apiFetch(`/api/slicing/jobs/${job.id}/print`, {
              method: 'POST',
              body: {
                printerId,
                ...body
              }
            })
          }
          // The output is now consumed by a real print; leaving must not discard it.
          printedRef.current = true
        }}
        onBack={onBack ? handleBack : undefined}
        onClose={handleDismiss}
      />
    )
  }

  const progressFrame = job ? getLatestSlicingProgressFrame(job) : null
  const progressPercent = progressFrame?.displayPercent ?? progressFrame?.totalPercent ?? null
  const displayName = formatLibraryFileName(job?.outputFileName ?? sourceFile.name)
  const loadingOutputFile = job?.status === 'ready' && outputFileQuery.isLoading
  const jobError = outputFileQuery.error instanceof Error
    ? outputFileQuery.error.message
    : job?.error ?? null

  return (
    <Modal open onClose={handleDismiss}>
      <ScrollableModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <Typography level="h4">{trackingCopy?.title ?? 'Print now'}</Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Stack spacing={1.25}>
            <Typography level="body-sm" textColor="text.tertiary">
              {job && (job.status === 'ready'
                ? (trackingCopy?.readyText ?? 'Slicing finished. Loading the print setup…')
                : (trackingCopy?.pendingText ?? 'This stays here until slicing is ready, then it switches into the normal print setup.'))}
            </Typography>

            {slicingJobsQuery.isLoading && !job && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size="sm" />
                <Typography level="body-sm" textColor="text.secondary">Loading slicing job…</Typography>
              </Stack>
            )}

            {!slicingJobsQuery.isLoading && !job && (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                The slicing job is no longer available. If it already finished, you can find it in Jobs.
              </Alert>
            )}

            {job && (
              <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'sm' }}>
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {displayName}
                    </Typography>
                    <Chip size="sm" variant="soft" color={slicingStatusColor(job.status)}>
                      {getSlicingJobStatusLabel(job)}
                    </Chip>
                  </Stack>
                  <LinearProgress
                    determinate={progressPercent != null}
                    value={progressPercent ?? 0}
                    color={slicingStatusColor(job.status)}
                  />
                  <Typography level="body-sm" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {loadingOutputFile ? 'Loading sliced file…' : formatSlicingProgress(job, progressFrame)}
                  </Typography>
                  {jobError && (
                    <Alert color={job.status === 'cancelled' ? 'warning' : 'danger'} variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                      {jobError}
                    </Alert>
                  )}
                </Stack>
              </Sheet>
            )}
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          {job && isSlicingInProgress(job.status) ? (
            // No plain "Close" while slicing runs — dismissing would orphan the job and
            // could hand off a half-finished slice, so the only exit cancels the slice.
            <Button type="button" variant="plain" color="danger" onClick={handleDismiss}>
              Cancel slicing
            </Button>
          ) : (
            <Button type="button" variant="plain" color="neutral" onClick={handleDismiss}>Close</Button>
          )}
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

/**
 * Results dialog for a "slice without saving" run: tracks the slicing job, shows the
 * estimates (print time, filament, cost) when ready, and lets the user preview the sliced
 * toolpaths (via the model-studio plugin's `library.overlays` slot, which works on the
 * still-hidden output file), keep the gcode (un-hide it into the library) and/or print it.
 * Stays open after saving.
 */
export function SliceResultModal({
  sourceFile,
  jobId,
  printers,
  canPrint,
  folders,
  bridgeId,
  bridgeName,
  showRoot,
  onClose
}: {
  sourceFile: LibraryFile
  jobId: string
  printers: Printer[]
  canPrint: boolean
  folders: LibraryFolder[]
  bridgeId: string | null
  bridgeName: string | null
  showRoot: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const slicingJobsQuery = useSlicingJobs({ suppressGlobalErrorToast: true })
  useEffect(() => suppressJobToast('slicing', jobId), [jobId])
  const [printing, setPrinting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [printed, setPrinted] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const job = useMemo(
    () => slicingJobsQuery.data?.jobs.find((entry) => entry.id === jobId) ?? null,
    [jobId, slicingJobsQuery.data?.jobs]
  )
  // Keep the latest job/commit state in refs so the close handler and the unmount cleanup
  // act on current values without re-subscribing.
  const jobRef = useRef(job)
  jobRef.current = job
  const savedRef = useRef(saved)
  savedRef.current = saved
  const printedRef = useRef(printed)
  printedRef.current = printed
  const dismissHandledRef = useRef(false)
  // Closing must not orphan the slice: cancel a still-running job, or discard the
  // still-hidden output if it finished but was never saved or printed.
  const handleClose = useCallback(() => {
    dismissHandledRef.current = true
    const current = jobRef.current
    if (current && isSlicingInProgress(current.status)) {
      void apiFetch(`/api/slicing/jobs/${jobId}/cancel`, { method: 'POST' })
        .then(() => queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] }))
        .catch(() => undefined)
    } else if (!savedRef.current && !printedRef.current && current?.status === 'ready' && current.outputFileId) {
      void apiFetch(`/api/slicing/jobs/${jobId}/discard`, { method: 'POST' }).catch(() => undefined)
    }
    onClose()
  }, [jobId, queryClient, onClose])
  // Torn down without an explicit close (e.g. navigated away): apply the same cleanup so a
  // running job is cancelled and an unkept output discarded rather than orphaned.
  useOrphanSliceCleanup(() => {
    if (dismissHandledRef.current) return
    const current = jobRef.current
    if (current && isSlicingInProgress(current.status)) {
      void apiFetch(`/api/slicing/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => undefined)
    } else if (!savedRef.current && !printedRef.current && current?.status === 'ready' && current.outputFileId) {
      void apiFetch(`/api/slicing/jobs/${jobId}/discard`, { method: 'POST' }).catch(() => undefined)
    }
  })
  const defaultAmsMapping = useMemo(
    () => (job?.target.mode === 'realPrinter' ? buildDefaultAmsMappingFromSlicingTarget(job.target) : null),
    [job?.target]
  )
  const cancelSlicing = useMutation({
    mutationFn: async () => { await apiFetch(`/api/slicing/jobs/${jobId}/cancel`, { method: 'POST' }) },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] }) }
  })
  const [saveDestinationOpen, setSaveDestinationOpen] = useState(false)
  const saveToLibrary = useMutation({
    mutationFn: async (vars: { outputFolderId: string | null; outputFileName?: string }) =>
      apiFetch<{ file: { id: string; name: string } }>(`/api/slicing/jobs/${jobId}/save`, { method: 'POST', body: vars }),
    onSuccess: async (response) => {
      setSaved(true)
      setSaveDestinationOpen(false)
      toast.success(`Saved ${formatLibraryFileName(response.file.name)} to the library`)
      // The sliced output is a brand-new library file; the open editor's own source scene is
      // unchanged, so invalidate only the LIST (not editor scene caches, which would force a
      // mid-edit viewport rebuild). The editor's own save uses the full variant.
      await invalidateLibraryListQueries(queryClient)
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Unable to save the sliced file.')
    }
  })
  const outputFileQuery = useQuery({
    queryKey: ['library-file', job?.outputFileId ?? 'missing'],
    queryFn: ({ signal }) => apiFetch<{ file: LibraryFile }>(`/api/library/${job?.outputFileId}`, { signal }),
    enabled: Boolean(printing && job?.status === 'ready' && job.outputFileId)
  })

  if (printing && canPrint && job?.status === 'ready' && outputFileQuery.data?.file) {
    return (
      <PrintModal
        file={outputFileQuery.data.file}
        printers={printers}
        defaultPrinterId={job.target.mode === 'realPrinter' ? job.target.printerId : undefined}
        defaultPlate={job.plate > 0 ? job.plate : 1}
        defaultAmsMapping={defaultAmsMapping}
        submitPrint={async ({ printerId, body }) => {
          await apiFetch(`/api/slicing/jobs/${job.id}/print`, { method: 'POST', body: { printerId, ...body } })
          setPrinted(true)
        }}
        onClose={() => setPrinting(false)}
      />
    )
  }

  const ready = job?.status === 'ready'
  const progressFrame = job ? getLatestSlicingProgressFrame(job) : null
  const progressPercent = progressFrame?.displayPercent ?? progressFrame?.totalPercent ?? null
  const displayName = formatLibraryFileName(job?.outputFileName ?? sourceFile.name)
  const jobError = job?.error ?? null
  const metadata = job?.metadata
  const stats: Array<{ label: string; value: string }> = []
  if (metadata?.estimatedPrintTimeSeconds != null && metadata.estimatedPrintTimeSeconds >= 1) {
    stats.push({ label: 'Estimated print time', value: formatSecondsDuration(metadata.estimatedPrintTimeSeconds) })
  }
  if (metadata?.estimatedPrepareTimeSeconds != null && metadata.estimatedPrepareTimeSeconds >= 1) {
    stats.push({ label: 'Prepare time', value: formatSecondsDuration(metadata.estimatedPrepareTimeSeconds) })
  }
  if (metadata?.estimatedFilamentWeightGrams != null) {
    stats.push({ label: 'Material used', value: `${metadata.estimatedFilamentWeightGrams.toFixed(1)} g` })
  }
  if (metadata?.estimatedFilamentLengthMm != null) {
    stats.push({ label: 'Material length', value: `${(metadata.estimatedFilamentLengthMm / 1000).toFixed(2)} m` })
  }
  if (metadata?.estimatedFilamentCost != null) {
    stats.push({ label: 'Estimated cost', value: `$${metadata.estimatedFilamentCost.toFixed(2)}` })
  }
  // result.json reports per-material weight by filament id but no name/colour, so enrich
  // each row from the slice request's chosen material (keyed by projectFilamentId == id).
  const materialInfoById = new Map<number, { name: string | null; color: string | null }>()
  for (const mapping of job?.target.filamentMappings ?? []) {
    materialInfoById.set(mapping.projectFilamentId, { name: mapping.material ?? null, color: mapping.color ?? null })
  }

  const outputNameParts = splitLibraryFileNameForRename(job?.outputFileName ?? sourceFile.name)
  return (
    <>
    <Modal open onClose={handleClose}>
      <ScrollableModalDialog sx={{ maxWidth: 480, width: '100%' }}>
        <Typography level="h4">Slice results</Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          <Stack spacing={1.25}>
            {slicingJobsQuery.isLoading && !job && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size="sm" />
                <Typography level="body-sm" textColor="text.secondary">Loading slicing job…</Typography>
              </Stack>
            )}
            {!slicingJobsQuery.isLoading && !job && (
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                The slicing job is no longer available. If it already finished, you can find it in Jobs.
              </Alert>
            )}
            {job && (
              <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'sm' }}>
                <Stack spacing={1}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Typography level="title-md" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{displayName}</Typography>
                    <Chip size="sm" variant="soft" color={slicingStatusColor(job.status)}>{getSlicingJobStatusLabel(job)}</Chip>
                  </Stack>
                  {!ready && job.status !== 'failed' && job.status !== 'cancelled' && (
                    <>
                      <LinearProgress determinate={progressPercent != null} value={progressPercent ?? 0} color={slicingStatusColor(job.status)} />
                      <Typography level="body-sm" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                        {formatSlicingProgress(job, progressFrame)}
                      </Typography>
                    </>
                  )}
                  {ready && (
                    stats.length > 0 ? (
                      <Stack spacing={1}>
                        <Stack spacing={0.5}>
                          {stats.map((stat) => (
                            <Stack key={stat.label} direction="row" justifyContent="space-between" spacing={2}>
                              <Typography level="body-sm" textColor="text.tertiary">{stat.label}</Typography>
                              <Typography level="body-sm" fontWeight="md">{stat.value}</Typography>
                            </Stack>
                          ))}
                        </Stack>
                        {(metadata?.materials?.length ?? 0) > 1 && (
                          <Stack spacing={0.5}>
                            <Typography level="body-xs" textColor="text.tertiary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>Per material</Typography>
                            {metadata!.materials!.map((material, index) => {
                              const info = material.id != null ? materialInfoById.get(material.id) : undefined
                              const color = info?.color || material.color || null
                              const name = info?.name || material.type || `Material ${material.id ?? index + 1}`
                              return (
                              <Stack key={material.id ?? index} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                                  <Box sx={{ width: 14, height: 14, borderRadius: '3px', flexShrink: 0, bgcolor: color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
                                  <Typography level="body-sm" textColor="text.tertiary" noWrap>{name}</Typography>
                                </Stack>
                                <Typography level="body-sm" fontWeight="md">{material.weightGrams != null ? `${material.weightGrams.toFixed(1)} g` : '—'}</Typography>
                              </Stack>
                            )})}
                          </Stack>
                        )}
                      </Stack>
                    ) : (
                      <Typography level="body-sm" textColor="text.secondary">
                        Slicing finished. The slicer did not report usage estimates for this job.
                      </Typography>
                    )
                  )}
                  {ready && job.outputFileId && (
                    <Button
                      type="button"
                      variant="outlined"
                      color="neutral"
                      size="sm"
                      startDecorator={<VisibilityRoundedIcon />}
                      onClick={() => setPreviewing(true)}
                      sx={{ width: { xs: '100%', sm: 'auto' }, alignSelf: { sm: 'flex-start' } }}
                    >
                      Preview
                    </Button>
                  )}
                  {jobError && (
                    <Alert color={job.status === 'cancelled' ? 'warning' : 'danger'} variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                      {jobError}
                    </Alert>
                  )}
                </Stack>
              </Sheet>
            )}
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          {job && isSlicingInProgress(job.status) ? (
            // No plain "Close" while slicing runs — leaving would orphan the output, so the
            // explicit exit cancels (backdrop/escape also cancel via handleClose).
            <Button type="button" variant="plain" color="danger" loading={cancelSlicing.isPending} onClick={() => cancelSlicing.mutate()}>
              Cancel slicing
            </Button>
          ) : (
            <Button type="button" variant="plain" color="neutral" onClick={handleClose}>Close</Button>
          )}
          {ready && (
            <Button
              type="button"
              variant="outlined"
              color="neutral"
              loading={saveToLibrary.isPending}
              disabled={saved}
              onClick={() => setSaveDestinationOpen(true)}
            >
              {saved ? 'Saved' : 'Save to library'}
            </Button>
          )}
          {ready && canPrint && (
            <Button type="button" startDecorator={<PrintRoundedIcon />} onClick={() => setPrinting(true)}>Print</Button>
          )}
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
    {saveDestinationOpen && (
      <LibraryDestinationDialog
        title="Save sliced file"
        description="Choose where to save the sliced file, then confirm the file name. Picking an existing file saves over it."
        showFiles
        fileNameField={{ label: 'File name', initialValue: outputNameParts.baseName, extension: outputNameParts.extension || '.gcode.3mf' }}
        initialFolderId={sourceFile.folderId ?? null}
        folders={folders}
        bridgeId={bridgeId}
        bridgeName={bridgeName}
        showRoot={showRoot}
        dialogWidth={720}
        submitting={saveToLibrary.isPending}
        error={saveToLibrary.error instanceof Error ? saveToLibrary.error.message : null}
        confirmActionLabel={({ outputFolderId, rootDestinationLabel }) => outputFolderId ? 'Save here' : `Save to ${rootDestinationLabel}`}
        onClose={() => setSaveDestinationOpen(false)}
        onSubmit={({ outputFileName, outputFolderId }) => saveToLibrary.mutate({
          outputFolderId,
          outputFileName: outputFileName ? `${outputFileName}${outputNameParts.extension}` : undefined
        })}
      />
    )}
    {/* Sliced-toolpath preview of the (possibly still hidden) output file; the model-studio
        plugin renders it on top of this dialog, mirroring the slice dialog's own slot. */}
    <PluginSlot
      name="library.overlays"
      context={{
        previewFileId: previewing && ready ? job?.outputFileId ?? null : null,
        previewPlateIndex: job && job.plate > 0 ? job.plate : undefined,
        onPreviewClose: () => setPreviewing(false)
      }}
    />
    </>
  )
}
