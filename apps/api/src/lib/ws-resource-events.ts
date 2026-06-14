/**
 * Coarse resource invalidation broadcasts.
 *
 * Some views are backed by ordinary HTTP queries rather than hot-path
 * MQTT snapshots. When one client mutates those resources, other
 * clients need a cheap push signal telling them which query slice to
 * refetch. These helpers keep the payloads consistent.
 */
import { wsBroadcaster } from './ws-server.js'
import { getCurrentTenant } from './tenant-context.js'

type ResourceName =
  | 'bridges'
  | 'delete-operations'
  | 'jobs'
  | 'library'
  | 'logs'
  | 'orders'
  | 'printer.views'
  | 'notification.templates'
  | 'plugin.settings'
  | 'plugins'
  | 'print-dispatch'
  | 'slicing'
  | 'printer.storage'

export function broadcastResourceChange(input: {
  resource: ResourceName
  printerId?: string
  pluginName?: string
  tenantId?: string | null
}): void {
  const tenantId = input.tenantId !== undefined ? input.tenantId : (getCurrentTenant()?.id ?? null)
  wsBroadcaster.broadcast({
    type: 'resource.changed',
    resource: input.resource,
    printerId: input.printerId,
    pluginName: input.pluginName
  }, tenantId)
}

export function broadcastJobsChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'jobs', tenantId })
}

export function broadcastDeleteOperationsChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'delete-operations', tenantId })
}

export function broadcastBridgesChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'bridges', tenantId })
}

export function broadcastLibraryChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'library', tenantId })
}

export function broadcastLogsChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'logs', tenantId })
}

export function broadcastOrdersChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'orders', tenantId })
}

export function broadcastNotificationTemplatesChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'notification.templates', tenantId })
}

export function broadcastPluginSettingsChanged(pluginName: string, tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'plugin.settings', pluginName, tenantId })
}

export function broadcastPluginsChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'plugins', tenantId })
}

export function broadcastPrintDispatchChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'print-dispatch', tenantId })
}

export function broadcastSlicingChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'slicing', tenantId })
}

export function broadcastPrinterViewsChanged(tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'printer.views', tenantId })
}

export function broadcastPrinterStorageChanged(printerId: string, tenantId?: string | null): void {
  broadcastResourceChange({ resource: 'printer.storage', printerId, tenantId })
}