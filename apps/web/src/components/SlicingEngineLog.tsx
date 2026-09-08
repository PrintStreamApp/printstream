/**
 * The slicer engine's own output for one job, behind a disclosure.
 *
 * OWNS the only surface that shows a slice's raw `stdout`/`stderr`. Until this existed the engine's
 * lines were fetched and then discarded at the UI: `slicingJobPresentation.ts` reads only the
 * `system` lines and the progress frames, so an engine failure that EXPLAINED itself still reached
 * the user as one summarised sentence. A real case (a toolpath collision whose cause was supports on
 * one model reaching into another) took an operator with server access to diagnose, because the line
 * naming both models only existed in the container log.
 *
 * Fetches the job by id rather than taking a `SlicingJob` prop, and that is deliberate: the LIST
 * response strips engine output down to the last system line (`toFinishedListDto` in
 * `apps/api/src/lib/slicing-jobs.ts`, because the log dwarfs everything else on a growing history),
 * so a caller holding a list job has nothing to pass. `GET /slicing/jobs/:id` keeps the full record,
 * and the query is shared with whatever else on screen already watches this job.
 *
 * Collapsed by default: this is diagnostic depth, not the failure message. The error itself belongs
 * in the surface above (see `formatSlicingProgress` and the dialogs' Alert).
 */
import { useMemo, useState } from 'react'
import { Box, Button, Sheet, Stack, Typography } from '@mui/joy'
import { extractErrorMessage } from '@printstream/shared'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import { useSlicingJob } from '../hooks/useSlicingJob'
import { selectEngineLogLines } from '../lib/slicingEngineLog'
import { useCopyToClipboard } from '../lib/useCopyToClipboard'

export function SlicingEngineLog({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false)
  const { copied, copy } = useCopyToClipboard()
  // Same query key as the dialogs watching this job, so opening the log costs no extra request.
  // Passing null while collapsed keeps the (large) single-job fetch off the closed case entirely.
  const jobQuery = useSlicingJob(open ? jobId : null)

  const { shown, hidden, all } = useMemo(
    () => selectEngineLogLines(jobQuery.data?.job.output),
    [jobQuery.data]
  )

  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button
          type="button"
          size="sm"
          variant="plain"
          color="neutral"
          startDecorator={open ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? 'Hide engine log' : 'Show engine log'}
        </Button>
        {open && all.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="plain"
            color="neutral"
            startDecorator={<ContentCopyRoundedIcon />}
            onClick={() => void copy(all.map((line) => line.text).join('\n'))}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        )}
      </Stack>

      {open && (
        <Sheet
          variant="outlined"
          sx={{ borderRadius: 'md', overflow: 'hidden', fontFamily: 'monospace', fontSize: 'xs' }}
        >
          <Box sx={{ maxHeight: 240, overflow: 'auto', p: 1 }}>
            {jobQuery.isLoading && (
              <Typography level="body-xs" textColor="text.tertiary">Loading the engine log…</Typography>
            )}
            {/* A failed fetch must never be reported as an empty log. "The engine produced no
                output" is a claim about the SLICE, and making it when the request errored (an API
                restart, a job aged out of the store, the network dropping) states the opposite of
                the truth on the one surface that exists to show the engine's own words. */}
            {jobQuery.isError && (
              <Typography level="body-xs" textColor="danger.300">
                The engine log could not be loaded: {extractErrorMessage(jobQuery.error)}
              </Typography>
            )}
            {!jobQuery.isLoading && !jobQuery.isError && all.length === 0 && (
              <Typography level="body-xs" textColor="text.tertiary">
                The engine produced no output for this slice.
              </Typography>
            )}
            {shown.map((line, index) => (
              <Typography
                // The engine emits duplicate lines constantly, so the index is the only stable key
                // available; the list is append-only and never reordered, so it is a safe one.
                key={`${index}-${line.createdAt}`}
                level="body-xs"
                textColor={line.stream === 'stderr' ? 'danger.300' : 'text.secondary'}
                sx={{ fontFamily: 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {line.text}
              </Typography>
            ))}
          </Box>
        </Sheet>
      )}

      {open && hidden > 0 && (
        <Typography level="body-xs" textColor="text.tertiary">
          Showing the last {shown.length} of {all.length} lines. Copy takes all of them.
        </Typography>
      )}
    </Stack>
  )
}
