import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import type { TenantSummary } from '@printstream/shared'
import { useEffect, useRef } from 'react'
import { WorkspaceSelectionView } from './WorkspaceSelectionView'

/**
 * Landing page for the `/connect-bridge?code=…` deep link a bridge surfaces.
 *
 * It resolves which workspace should receive the bridge: a single accessible
 * workspace (or the active one) connects straight through; multiple workspaces
 * prompt a chooser. Either way `onConnect` switches into that workspace and
 * lands on its Bridges settings page, where the code (carried separately in
 * session storage) is pre-filled for a one-click connect.
 */
export function ConnectBridgeView({
  code,
  workspaces,
  activeTenantId,
  pending,
  onConnect
}: {
  code: string | null
  workspaces: ReadonlyArray<TenantSummary>
  activeTenantId: string | null
  pending: boolean
  onConnect: (tenantId: string) => void
}) {
  // A single accessible workspace (or, in single-tenant contexts, the active
  // one) needs no chooser — route straight to its Bridges page.
  const soleTarget = workspaces.length === 1
    ? workspaces[0]?.id ?? null
    : workspaces.length === 0 && activeTenantId
      ? activeTenantId
      : null
  const autoConnected = useRef(false)

  useEffect(() => {
    if (!code || soleTarget == null || autoConnected.current) return
    autoConnected.current = true
    onConnect(soleTarget)
  }, [code, soleTarget, onConnect])

  if (!code) {
    return (
      <Box sx={{ py: 2 }}>
        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
          This link is missing a bridge connect code. Open the link shown by your bridge again, or
          enter the code under Settings → Bridges.
        </Alert>
      </Box>
    )
  }

  if (workspaces.length >= 2) {
    return (
      <WorkspaceSelectionView
        tenantOptions={workspaces}
        title="Connect your bridge"
        description="Choose the workspace this bridge should belong to."
        onTenantSelect={onConnect}
        selectionPending={pending}
      />
    )
  }

  if (soleTarget == null) {
    return (
      <Box sx={{ py: 2 }}>
        <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
          You don&apos;t have a workspace to connect this bridge to yet.
        </Alert>
      </Box>
    )
  }

  return (
    <Stack spacing={1.5} alignItems="center" sx={{ py: 6 }}>
      <CircularProgress />
      <Typography level="body-sm" textColor="text.tertiary">
        Opening your workspace…
      </Typography>
    </Stack>
  )
}
