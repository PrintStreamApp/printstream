import React from 'react'
import HubRoundedIcon from '@mui/icons-material/HubRounded'
import { Button } from '@mui/joy'
import { EmptyState } from './EmptyState'
import { useRuntimePolicy } from '../lib/runtimePolicy'

/**
 * Placeholder shown when a workspace has no connected bridge.
 *
 * In normal installs this means the operator has not paired a bridge yet, so we
 * point them at Settings > Bridges. In managed-bridge mode the server owns a
 * single bundled bridge the operator never manages, so the same condition
 * instead means that bundled printer connection service has not come online
 * yet — the copy drops all "bridge" wording and we never offer the (hidden)
 * bridges settings page.
 */
export function NoConnectedBridgesEmptyState({
  title,
  description,
  managedTitle,
  managedDescription,
  canOpenBridgesSettings = false,
  onOpenBridgesSettings
}: {
  title: string
  description: string
  managedTitle?: string
  managedDescription?: string
  canOpenBridgesSettings?: boolean
  onOpenBridgesSettings?: () => void
}) {
  const { managedBridge } = useRuntimePolicy()

  if (managedBridge) {
    return (
      <EmptyState
        icon={<HubRoundedIcon />}
        title={managedTitle ?? 'Connecting to your printers'}
        description={managedDescription
          ?? 'PrintStream is still starting its printer connection service. If this persists, make sure all PrintStream services are running.'}
      />
    )
  }

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
