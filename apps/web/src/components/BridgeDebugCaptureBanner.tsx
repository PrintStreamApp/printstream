import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Chip, Stack, Typography } from '@mui/joy'
import {
  extractErrorMessage,
  type BridgeDebugCaptureStatus,
  type BridgeListResponse,
  type BridgeSummary
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { buildApiUrl } from '../lib/apiUrl'
import { invalidateBridgeQueries } from '../lib/bridgeQueryInvalidation'

/**
 * Cross-page reminder that a bridge debug traffic capture is running. Mounted
 * once above tenant page content (next to {@link BridgeUpdateBanner}) so the
 * operator can't forget a capture is recording — it shows wherever they are, with
 * a live frame counter and inline Stop / Download actions. The capture is started
 * from Settings; this banner is the always-visible half of that control.
 *
 * Renders nothing when no bridge is capturing, or when the bridges list is
 * unavailable (e.g. the viewer lacks settings access).
 */
export function BridgeDebugCaptureBanner() {
  const bridgesQuery = useQuery({
    queryKey: ['bridges'],
    queryFn: ({ signal }) => apiFetch<BridgeListResponse>('/api/bridges', { signal }),
    retry: false,
    staleTime: 30_000
  })

  const capturing = (bridgesQuery.data?.bridges ?? []).filter((bridge) => bridge.debugCapture.active)
  if (capturing.length === 0) return null

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {capturing.map((bridge) => (
        <BridgeDebugCaptureBannerItem key={bridge.id} bridge={bridge} />
      ))}
    </Stack>
  )
}

function frameSummary(status: BridgeDebugCaptureStatus): string {
  const parts = [`${status.frameCount.toLocaleString()} frame${status.frameCount === 1 ? '' : 's'}`]
  if (status.droppedFrames > 0) parts.push(`${status.droppedFrames.toLocaleString()} dropped`)
  if (status.truncated) parts.push('size limit reached')
  return parts.join(' · ')
}

function BridgeDebugCaptureBannerItem({ bridge }: { bridge: BridgeSummary }) {
  const queryClient = useQueryClient()
  const status = bridge.debugCapture

  const stopCapture = useMutation({
    mutationFn: () => apiFetch<BridgeDebugCaptureStatus>(
      `/api/bridges/${encodeURIComponent(bridge.id)}/debug-capture/stop`,
      { method: 'POST' }
    ),
    onSuccess: () => invalidateBridgeQueries(queryClient)
  })

  const stopError = stopCapture.error ? extractErrorMessage(stopCapture.error) : null
  const startedLabel = status.startedAt ? new Date(status.startedAt).toLocaleTimeString() : null

  return (
    <Alert color="primary" variant="soft">
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }} sx={{ flexWrap: 'wrap' }}>
          <Chip size="sm" color="primary" variant="solid">Recording</Chip>
          <Typography level="title-sm">Debug traffic capture is running on “{bridge.name}”</Typography>
          <Chip size="sm" variant="plain">{frameSummary(status)}</Chip>
        </Stack>

        <Typography level="body-sm">
          Capturing bridge↔printer traffic{startedLabel ? ` since ${startedLabel}` : ''}. Stop it when you’re done and download the recording to share.
        </Typography>

        {stopError && <Typography level="body-xs" color="danger">{stopError}</Typography>}

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Button
            size="sm"
            color="primary"
            loading={stopCapture.isPending}
            onClick={() => stopCapture.mutate()}
          >
            Stop capture
          </Button>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            component="a"
            href={buildApiUrl(`/api/bridges/${encodeURIComponent(bridge.id)}/debug-capture/download`)}
            download={`traffic-${bridge.name}.jsonl`}
          >
            Download
          </Button>
        </Stack>
      </Stack>
    </Alert>
  )
}
