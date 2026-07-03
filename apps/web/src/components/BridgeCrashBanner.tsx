import { useQuery } from '@tanstack/react-query'
import { Alert, Chip, Stack, Typography } from '@mui/joy'
import { deriveBridgeCrashState, type BridgeListResponse, type BridgeSummary } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'

/**
 * Cross-page notice for bridges that are actively crash-looping. Mounted once
 * above tenant page content so a persistently-crashing bridge is visible wherever
 * the operator is, not only in settings — its printers keep disconnecting while it
 * flaps, so this warrants app-wide attention. A one-off crash is deliberately NOT
 * shown here (it is surfaced by a settings chip + a user notification); this banner
 * is reserved for the ongoing crash-loop case.
 *
 * Renders nothing when no bridge is looping, or when the bridges list is
 * unavailable (e.g. the viewer lacks settings access).
 */
export function BridgeCrashBanner() {
  const bridgesQuery = useQuery({
    queryKey: ['bridges'],
    queryFn: ({ signal }) => apiFetch<BridgeListResponse>('/api/bridges', { signal }),
    retry: false,
    staleTime: 30_000
  })

  const looping = (bridgesQuery.data?.bridges ?? []).filter(
    (bridge) => deriveBridgeCrashState(bridge.crash, Date.now()) === 'looping'
  )
  if (looping.length === 0) return null

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {looping.map((bridge) => (
        <BridgeCrashBannerItem key={bridge.id} bridge={bridge} />
      ))}
    </Stack>
  )
}

function BridgeCrashBannerItem({ bridge }: { bridge: BridgeSummary }) {
  return (
    <Alert color="danger" variant="soft">
      <Stack spacing={0.5} sx={{ width: '100%', minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
          <Typography level="title-sm">Bridge “{bridge.name}” is crash-looping</Typography>
          <Chip size="sm" variant="outlined" color="danger">
            {bridge.crash.recentCrashCount} crashes in the last hour
          </Chip>
        </Stack>
        <Typography level="body-sm">
          It keeps stopping and restarting, so its printers may repeatedly disconnect. Check the bridge machine and its logs.
        </Typography>
        {bridge.crash.lastReason && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ wordBreak: 'break-word' }}>
            {bridge.crash.lastReason}
          </Typography>
        )}
      </Stack>
    </Alert>
  )
}
