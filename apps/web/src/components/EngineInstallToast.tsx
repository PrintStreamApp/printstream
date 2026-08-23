/**
 * "The slicer is still downloading": said to whoever is waiting on it.
 *
 * The container ships no engine and fetches one on first start, so there is a
 * window on a brand-new install where slicing simply does not work. Without
 * this, that window looks like a broken feature: the slice dialog reports no
 * slicer configured and nothing says a 220 MB download is three minutes from
 * finishing.
 *
 * Reads `/api/slicing/capabilities` and not the engines route, deliberately:
 * the engines route needs `settings.manage` and does not exist on the hosted
 * plan, while the person staring at an unavailable slicer is an ordinary user.
 *
 * **Polls only when something is happening.** An install in flight refreshes
 * every few seconds; an install-less workspace with a working slicer never
 * refetches at all, because the common case must cost nothing. The query key is
 * the one the slice surfaces already use, so this shares their cache rather
 * than adding a second fetch of the same thing.
 *
 * Counterpart: `apps/slicer/src/engines/progress.ts`, which is what
 * `engineInstall` is reporting.
 */
import { Box, Stack, Typography } from '@mui/joy'
import type { SlicingCapabilities } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../lib/apiClient'
import { StatusToast, StatusToastDismissButton } from './StatusToast'
import { ProgressBar } from './ProgressBar'

/** Brisk while a download runs: the label and percentage are the whole point. */
const INSTALLING_POLL_MS = 4_000
/**
 * Slow, and only while there is no slicer: this is what NOTICES an install that
 * started after the page loaded (a fresh container, or an operator adding an
 * engine from another tab). A configured slicer polls nothing.
 */
const UNCONFIGURED_POLL_MS = 20_000

export function EngineInstallToast() {
  const [dismissed, setDismissed] = useState<string | null>(null)

  const capabilitiesQuery = useQuery<SlicingCapabilities>({
    queryKey: ['slicing-capabilities'],
    queryFn: ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal }),
    // A workspace whose user cannot slice answers 403; that is not an error
    // worth a toast of its own, and retrying it helps nobody.
    retry: false,
    meta: { suppressGlobalErrorToast: true },
    refetchInterval: (query) => {
      const data = query.state.data
      if (data?.engineInstall) return INSTALLING_POLL_MS
      return data && !data.configured ? UNCONFIGURED_POLL_MS : false
    }
  })

  const install = capabilitiesQuery.data?.engineInstall ?? null
  if (!install) return null
  // Keyed by state so dismissing the progress toast does not also swallow the
  // failure that follows it.
  const key = `${install.state}:${install.label}`
  if (dismissed === install.state) return null

  const failed = install.state === 'failed'
  const percent = install.fraction != null ? Math.round(install.fraction * 100) : null

  return (
    <StatusToast key={key} color={failed ? 'danger' : 'primary'}>
      <Stack spacing={0.75} sx={{ width: '100%' }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Typography level="title-sm">
            {failed ? 'Slicer engine install failed' : 'Preparing the slicer'}
          </Typography>
          <StatusToastDismissButton
            ariaLabel={failed ? 'Dismiss the engine install failure' : 'Dismiss the slicer preparation notice'}
            onClick={() => setDismissed(install.state)}
          />
        </Stack>
        <Typography level="body-sm" textColor="text.tertiary">
          {failed
            ? install.error ?? 'The engine could not be installed.'
            : 'Slicing becomes available when this finishes. You can keep using everything else.'}
        </Typography>
        {failed ? null : (
          <Box>
            <Typography level="body-xs" textColor="text.tertiary">
              {percent != null ? `${install.label}: ${percent}%` : install.label}
            </Typography>
            {/* Determinate only where there is a real total: a bar that invents
                a position is worse than one that admits it is working. */}
            <ProgressBar
              size="sm"
              value={percent}
              sx={{ mt: 0.5 }}
            />
          </Box>
        )}
      </Stack>
    </StatusToast>
  )
}
