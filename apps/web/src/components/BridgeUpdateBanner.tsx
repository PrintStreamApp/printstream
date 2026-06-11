import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/joy'
import {
  bridgeUpdateBlocksPrinting,
  bridgeUpdateNeedsAttention,
  bridgeUpdateSupportsInAppUpdate,
  extractErrorMessage,
  type BridgeListResponse,
  type BridgeSummary,
  type BridgeUpdateActionResponse
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { invalidateBridgeQueries } from '../lib/bridgeQueryInvalidation'
import { formatBridgeUpdateStatus } from '../lib/bridgeUpdateStatus'

/**
 * Cross-page notice for bridges that need updating. Mounted once above tenant page
 * content so an out-of-date bridge is surfaced wherever the operator is — not only in
 * settings — with an in-place "Update bridge" action. Bridges whose status blocks
 * printing are shown in danger; the server also refuses to dispatch through them
 * (see `print-dispatcher.ts`), so this banner is the user-facing half of that gate.
 *
 * Renders nothing when no bridge needs attention, or when the bridges list is
 * unavailable (e.g. the viewer lacks settings access) — the server guard still
 * protects the print path in that case.
 */
export function BridgeUpdateBanner() {
  const bridgesQuery = useQuery({
    queryKey: ['bridges'],
    queryFn: ({ signal }) => apiFetch<BridgeListResponse>('/api/bridges', { signal }),
    retry: false,
    staleTime: 30_000
  })

  const bridges = (bridgesQuery.data?.bridges ?? []).filter((bridge) => bridgeUpdateNeedsAttention(bridge.update.status))
  if (bridges.length === 0) return null

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {bridges.map((bridge) => (
        <BridgeUpdateBannerItem key={bridge.id} bridge={bridge} />
      ))}
    </Stack>
  )
}

function BridgeUpdateBannerItem({ bridge }: { bridge: BridgeSummary }) {
  const queryClient = useQueryClient()
  const status = bridge.update.status
  const blocks = bridgeUpdateBlocksPrinting(status)
  const canSelfUpdate = bridgeUpdateSupportsInAppUpdate(status)

  const startUpdate = useMutation({
    mutationFn: () => apiFetch<BridgeUpdateActionResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/update/start`, { method: 'POST' }),
    onSuccess: () => invalidateBridgeQueries(queryClient)
  })
  const checkUpdate = useMutation({
    mutationFn: () => apiFetch<BridgeUpdateActionResponse>(`/api/bridges/${encodeURIComponent(bridge.id)}/update/check`, { method: 'POST' }),
    onSuccess: () => invalidateBridgeQueries(queryClient)
  })

  const pending = startUpdate.isPending || checkUpdate.isPending
  const actionError = startUpdate.error
    ? extractErrorMessage(startUpdate.error)
    : checkUpdate.error
      ? extractErrorMessage(checkUpdate.error)
      : null
  const actionResult = startUpdate.data ?? checkUpdate.data ?? null

  const versionLabel = bridge.update.latestVersion && bridge.update.latestVersion !== bridge.update.currentVersion
    ? `${bridge.update.currentVersion ?? 'unknown'} → ${bridge.update.latestVersion}`
    : bridge.update.currentVersion ?? null

  return (
    <Alert color={blocks ? 'danger' : 'warning'} variant="soft">
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }} sx={{ flexWrap: 'wrap' }}>
          <Typography level="title-sm">Bridge “{bridge.name}” needs updating</Typography>
          <Chip size="sm" variant="outlined" color={blocks ? 'danger' : 'warning'}>{formatBridgeUpdateStatus(status)}</Chip>
          {versionLabel && <Chip size="sm" variant="plain">{versionLabel}</Chip>}
        </Stack>

        <Typography level="body-sm">
          {blocks
            ? 'Printing through this bridge is blocked until it is updated.'
            : 'An update is available for this bridge.'}
        </Typography>

        {(status === 'imageUpdateRequired' || status === 'runnerUpdateRequired') && (
          <Typography level="body-sm">
            {bridge.update.manualUpdateCommand
              ? 'This needs the bridge image pulled and restarted (it cannot self-update):'
              : 'This needs the bridge image pulled and restarted on the bridge host (it cannot self-update).'}
            {bridge.update.manualUpdateCommand && (
              <Box component="code" sx={{ display: 'block', mt: 0.5, fontFamily: 'code', fontSize: 'sm', whiteSpace: 'pre-wrap' }}>
                {bridge.update.manualUpdateCommand}
              </Box>
            )}
          </Typography>
        )}

        {bridge.update.lastError && <Typography level="body-xs" color="danger">Last error: {bridge.update.lastError}</Typography>}
        {actionError && <Typography level="body-xs" color="danger">{actionError}</Typography>}
        {!actionError && actionResult && <Typography level="body-xs">{actionResult.message}</Typography>}

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          {canSelfUpdate && (
            <Button
              size="sm"
              color={blocks ? 'danger' : 'warning'}
              loading={startUpdate.isPending}
              disabled={pending}
              onClick={() => startUpdate.mutate()}
            >
              Update bridge
            </Button>
          )}
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            loading={checkUpdate.isPending}
            disabled={pending}
            onClick={() => checkUpdate.mutate()}
          >
            Check again
          </Button>
        </Stack>
      </Stack>
    </Alert>
  )
}
