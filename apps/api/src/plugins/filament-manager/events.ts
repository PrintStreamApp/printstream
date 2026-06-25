/**
 * Live inventory-change broadcasts for the filament-manager plugin. Reuses the
 * generic `plugin.event` envelope (the web plugin filters on `pluginName`) so we
 * don't grow the shared WS union per plugin. Events are intentionally coarse:
 * the web client reacts by invalidating its spool queries.
 */
import type { FilamentManagerEvent } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'

export const FILAMENT_MANAGER_PLUGIN_NAME = 'filament-manager'

function broadcast(context: ApiPluginContext, tenantId: string | null, event: FilamentManagerEvent): void {
  // A null tenant would fan out across every workspace; skip rather than leak.
  if (!tenantId) return
  context.ws.broadcast({ type: 'plugin.event', pluginName: FILAMENT_MANAGER_PLUGIN_NAME, event }, tenantId)
}

export function broadcastSpoolChanged(context: ApiPluginContext, tenantId: string | null, spoolId: string): void {
  broadcast(context, tenantId, { kind: 'spool.changed', spoolId })
}

export function broadcastSpoolsChanged(context: ApiPluginContext, tenantId: string | null): void {
  broadcast(context, tenantId, { kind: 'spools.changed' })
}
