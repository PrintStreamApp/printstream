/**
 * Coarse resource invalidation broadcasts.
 *
 * Some views are backed by ordinary HTTP queries rather than hot-path
 * MQTT snapshots. When one client mutates those resources, other
 * clients need a cheap push signal telling them which query slice to
 * refetch. These helpers keep the payloads consistent.
 */
import { wsBroadcaster } from './ws-server.js'
import { getCurrentWorkspace } from './workspace-context.js'

type ResourceName =
  | 'bridges'
  | 'delete-operations'
  | 'jobs'
  | 'library'
  | 'logs'
  | 'orders'
  | 'printer.views'
  | 'billing'
  | 'notification.templates'
  | 'plugin.settings'
  | 'plugins'
  | 'print-dispatch'
  | 'print-queue'
  | 'slicing'
  | 'slicing.profiles'
  | 'printer.storage'

export function broadcastResourceChange(input: {
  resource: ResourceName
  printerId?: string
  pluginName?: string
  workspaceId?: string | null
}): void {
  const workspaceId = input.workspaceId !== undefined ? input.workspaceId : (getCurrentWorkspace()?.id ?? null)
  wsBroadcaster.broadcast({
    type: 'resource.changed',
    resource: input.resource,
    printerId: input.printerId,
    pluginName: input.pluginName
  }, workspaceId)
}

/**
 * A workspace's plan changed. Broadcast on the webhook, so a browser sitting on
 * the post-checkout screen learns the plan is live from the SERVER rather than
 * from Paddle's client-side "completed".
 */
export function broadcastBillingChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'billing', workspaceId })
}

export function broadcastJobsChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'jobs', workspaceId })
}

export function broadcastDeleteOperationsChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'delete-operations', workspaceId })
}

export function broadcastBridgesChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'bridges', workspaceId })
}

export function broadcastLibraryChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'library', workspaceId })
}

export function broadcastLogsChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'logs', workspaceId })
}

export function broadcastOrdersChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'orders', workspaceId })
}

export function broadcastNotificationTemplatesChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'notification.templates', workspaceId })
}

export function broadcastPluginSettingsChanged(pluginName: string, workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'plugin.settings', pluginName, workspaceId })
}

export function broadcastPluginsChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'plugins', workspaceId })
}

export function broadcastPrintDispatchChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'print-dispatch', workspaceId })
}

export function broadcastQueueChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'print-queue', workspaceId })
}

export function broadcastSlicingChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'slicing', workspaceId })
}

/**
 * The slicer PROFILE catalogue changed (custom profile create/delete). Distinct from
 * {@link broadcastSlicingChanged} so a slice's sub-second progress stream does not invalidate the
 * (slow) profiles query — only profile mutations do.
 */
export function broadcastSlicingPresetsChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'slicing.profiles', workspaceId })
}

export function broadcastPrinterViewsChanged(workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'printer.views', workspaceId })
}

export function broadcastPrinterStorageChanged(printerId: string, workspaceId?: string | null): void {
  broadcastResourceChange({ resource: 'printer.storage', printerId, workspaceId })
}