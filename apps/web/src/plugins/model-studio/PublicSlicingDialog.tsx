/** Polling result dialog for the workspace-less public slicer. */
import { useEffect, useState } from 'react'
import { Alert, Button, Stack, Typography } from '@mui/joy'
import type { PublicSlicingJob } from '@printstream/shared'
import { FormDialog } from '../../components/FormDialog'
import { SliceEstimates } from '../../components/library/SliceEstimates'
import { SliceResultPanel } from '../../components/library/SliceResultPanel'
import { ProgressBar } from '../../components/ProgressBar'
import { downloadBlob } from '../../lib/downloadBlob'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { openClientThreeMfProjectFromBytes } from './lib/clientThreeMfProject'
import type { InMemoryGcodePreviewSource } from './lib/inMemoryGcodePreview'
import { PublicGcodePreview } from './PublicGcodePreview'
import {
  cancelPublicSlice,
  downloadPublicSlice,
  readPublicSlice,
  readPublicSliceLog,
  retryPublicSlice,
  type PublicSlicingSession
} from './lib/publicSlicingClient'

export function PublicSlicingDialog({ session, onSessionChange, onClose }: {
  session: PublicSlicingSession
  onSessionChange: (session: PublicSlicingSession) => void
  onClose: () => void
}) {
  const [log, setLog] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [artifact, setArtifact] = useState<{ blob: Blob; source: InMemoryGcodePreviewSource } | null>(null)
  const [previewPlateIndex, setPreviewPlateIndex] = useState<number | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const job = session.job
  const jobId = session.job.id
  const accessToken = session.accessToken

  useEffect(() => {
    if (job.status !== 'ready' || artifact || previewError) return
    const controller = new AbortController()
    const load = async () => {
      setBusy(true)
      try {
        const blob = await downloadPublicSlice({ ...session, job })
        if (controller.signal.aborted) return
        const fileName = job.outputFileName ?? 'slice.gcode.3mf'
        const project = await openClientThreeMfProjectFromBytes(fileName, new Uint8Array(await blob.arrayBuffer()))
        if (controller.signal.aborted) {
          project.dispose()
          return
        }
        setArtifact({ blob, source: { fileName, project } })
      } catch (error) {
        if (!controller.signal.aborted) {
          setPreviewError(error instanceof Error ? error.message : 'The G-code preview could not be opened.')
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [artifact, job, previewError, session])

  useEffect(() => () => artifact?.source.project.dispose(), [artifact])

  useEffect(() => {
    if (job.status !== 'queued' && job.status !== 'slicing') return
    const controller = new AbortController()
    const poll = async () => {
      try {
        const next = await readPublicSlice({ accessToken, job: { id: jobId } }, controller.signal)
        onSessionChange({ accessToken, job: next.job })
      } catch (error) {
        if (!controller.signal.aborted) console.warn('[public-slicing] status poll failed', error)
      }
    }
    const timer = setInterval(() => { void poll() }, 1500)
    void poll()
    return () => { controller.abort(); clearInterval(timer) }
  }, [accessToken, job.status, jobId, onSessionChange])

  const act = async (operation: () => Promise<{ job: PublicSlicingJob }>) => {
    setBusy(true)
    try {
      const next = await operation()
      onSessionChange({ ...session, job: next.job })
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    setBusy(true)
    try {
      const blob = artifact?.blob ?? await downloadPublicSlice({ ...session, job })
      downloadBlob(blob, job.outputFileName ?? 'slice.gcode.3mf')
    } finally {
      setBusy(false)
    }
  }

  const active = job.status === 'uploading' || job.status === 'queued' || job.status === 'slicing'
  const dismiss = () => {
    if (!active) {
      onClose()
      return
    }
    setBusy(true)
    void cancelPublicSlice({ ...session, job })
      .catch((error) => console.warn('[public-slicing] cancellation while closing failed', error))
      .finally(onClose)
  }

  return (
    <>
      <FormDialog
        open
        title="Slice results"
        onClose={dismiss}
        busy={busy}
        submitLabel={job.status === 'ready' ? 'Download G-code' : job.status === 'failed' ? 'Retry' : active ? 'Cancel slice' : 'Close'}
        onSubmit={() => {
          if (job.status === 'ready') void download()
          else if (job.status === 'failed') void act(() => retryPublicSlice({ ...session, job }))
          else if (active) void act(() => cancelPublicSlice({ ...session, job }))
          else onClose()
        }}
        secondaryActions={job.status === 'ready' && (job.metadata?.plates?.length ?? 0) <= 1 ? (
          <Button
            type="button"
            variant="outlined"
            color="neutral"
            disabled={busy || !artifact}
            onClick={() => setPreviewPlateIndex(job.metadata?.plates?.[0]?.index ?? 1)}
          >
            Preview G-code
          </Button>
        ) : null}
      >
        <Stack spacing={2}>
        {job.status === 'uploading' ? (
          <ProgressBar value={job.sizeBytes > 0 ? (job.uploadedBytes / job.sizeBytes) * 100 : 0} />
        ) : (job.status === 'queued' || job.status === 'slicing') && <ProgressBar />}
        {job.status !== 'ready' && (
          <Typography level="body-sm">
            {job.status === 'queued' && job.queuePosition
              ? `Waiting in the public queue, position ${job.queuePosition}${job.estimatedWaitSeconds ? `, about ${Math.max(1, Math.ceil(job.estimatedWaitSeconds / 60))} minute${job.estimatedWaitSeconds > 60 ? 's' : ''}` : ''}. Workspace slices run first.`
              : job.message ?? 'Preparing slice…'}
          </Typography>
        )}
        {job.error && <Alert color="danger">{job.error}</Alert>}
        {job.status === 'ready' && (
          <SliceResultPanel
            displayName={formatLibraryFileName(job.outputFileName ?? job.fileName)}
            statusLabel="Ready"
            statusColor="success"
          >
            <SliceEstimates
              metadata={job.metadata}
              filamentMappings={job.filamentMappings}
              onPreviewPlate={artifact ? setPreviewPlateIndex : undefined}
            />
            {!artifact && !previewError && (
              <Typography level="body-sm" textColor="text.secondary">Loading G-code preview…</Typography>
            )}
          </SliceResultPanel>
        )}
        {job.status === 'ready' && previewError && (
          <Stack spacing={1}>
            <Alert color="warning">{previewError}</Alert>
            <Button variant="plain" size="sm" onClick={() => setPreviewError(null)}>
              Retry G-code preview
            </Button>
          </Stack>
        )}
        {job.status === 'failed' && (
          <Button variant="plain" size="sm" onClick={() => void readPublicSliceLog({ ...session, job }).then((result) => setLog(result.output.map((line) => line.text).join('\n') || 'No engine log was returned.'))}>
            {log == null ? 'Show engine log' : 'Refresh engine log'}
          </Button>
        )}
        {log != null && <Typography component="pre" level="body-xs" sx={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{log}</Typography>}
        <Alert color="neutral" variant="soft">
          Slicing temporarily uploads this prepared project. It is deleted automatically within one hour. This tool cannot connect to or control a printer.
        </Alert>
        </Stack>
      </FormDialog>
      {artifact && previewPlateIndex != null && (
        <PublicGcodePreview source={artifact.source} plateIndex={previewPlateIndex} onClose={() => setPreviewPlateIndex(null)} />
      )}
    </>
  )
}
