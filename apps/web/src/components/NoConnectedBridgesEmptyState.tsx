import React from 'react'
import HubRoundedIcon from '@mui/icons-material/HubRounded'
import { Button } from '@mui/joy'
import { EmptyState } from './EmptyState'

/**
 * Tenant-scoped placeholder shown when a workspace has not connected any bridges yet.
 */
export function NoConnectedBridgesEmptyState({
  title,
  description,
  canOpenBridgesSettings = false,
  onOpenBridgesSettings
}: {
  title: string
  description: string
  canOpenBridgesSettings?: boolean
  onOpenBridgesSettings?: () => void
}) {
  return (
    <EmptyState
      icon={<HubRoundedIcon />}
      title={title}
      description={canOpenBridgesSettings
        ? description
        : `${description} A workspace manager can connect one in Settings > Bridges.`}
      action={canOpenBridgesSettings && onOpenBridgesSettings
        ? (
            <Button size="sm" onClick={onOpenBridgesSettings}>
              Open bridges
            </Button>
          )
        : undefined}
    />
  )
}