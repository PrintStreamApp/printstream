import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { Alert, Stack } from '@mui/joy'
import type { AuthBootstrap } from '@printstream/shared'
import React from 'react'

/**
 * Platform-scoped authentication summary.
 *
 * Platform auth configures host-level users and roles. Workspace roles, users,
 * and service accounts stay managed inside the selected workspace.
 */
export function PlatformAuthSummarySection({
  authBootstrap,
  authProviders = []
}: {
  authBootstrap?: AuthBootstrap
  authProviders?: AuthBootstrap['providers']
}) {
  void authBootstrap
  void authProviders

  return (
    <Stack spacing={1.5}>
      <Alert color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />}>
        Platform Authentication controls how platform users access the host workspace. Workspace auth is managed from each workspace settings page.
      </Alert>
    </Stack>
  )
}