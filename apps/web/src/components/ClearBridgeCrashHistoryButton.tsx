import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Stack, Typography } from '@mui/joy'
import { extractErrorMessage, type BridgeResponse } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { invalidateBridgeQueries } from '../lib/bridgeQueryInvalidation'

/**
 * Clears a bridge's recorded crash history (API counterpart:
 * `DELETE /api/bridges/:id/crash-history`).
 *
 * Shared by the cross-page {@link BridgeCrashBanner} and the bridge Manage
 * dialog's crash alert so both surfaces offer one action with one wording: the
 * banner is the whole reason this exists, and a second, differently-labelled
 * copy in settings is how the two would drift apart.
 *
 * This is NOT a local dismissal: the crash summary is cleared for the whole
 * workspace, and the alert reappears if the bridge crashes again (the bridge
 * keeps its own rolling crash window). The label says "clear" for that reason.
 */
export function ClearBridgeCrashHistoryButton({
  bridgeId,
  color = 'danger',
  disabled = false
}: {
  bridgeId: string
  /** Match the surrounding alert's severity colour. */
  color?: 'danger' | 'warning'
  disabled?: boolean
}) {
  const queryClient = useQueryClient()
  const clearCrashHistory = useMutation({
    mutationFn: () => apiFetch<BridgeResponse>(
      `/api/bridges/${encodeURIComponent(bridgeId)}/crash-history`,
      { method: 'DELETE' }
    ),
    onSuccess: () => invalidateBridgeQueries(queryClient)
  })
  const clearError = clearCrashHistory.error ? extractErrorMessage(clearCrashHistory.error) : null

  return (
    <Stack spacing={0.5} alignItems="flex-start">
      <Button
        size="sm"
        variant="outlined"
        color={color}
        loading={clearCrashHistory.isPending}
        disabled={disabled}
        onClick={() => {
          clearCrashHistory.reset()
          clearCrashHistory.mutate()
        }}
      >
        Clear crash history
      </Button>
      {clearError && <Typography level="body-xs" color="danger">{clearError}</Typography>}
    </Stack>
  )
}
