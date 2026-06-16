/**
 * Home Assistant bridge plugin (built-in, API side).
 *
 * Exposes a snapshot endpoint for initial load and pushes real-time updates
 * over the shared WebSocket as `plugin.event` messages so the companion HA
 * integration never needs to poll.
 *
 * Routes:
 * - `GET /api/plugins/home-assistant` — bridge metadata and counts.
 * - `GET /api/plugins/home-assistant/snapshot` — full printer + AMS snapshot
 *   (used on first connect; thereafter updates arrive via WebSocket).
 *
 * WebSocket events emitted (type `plugin.event`, pluginName `home-assistant`):
 * - `{ type: 'printer.update', printer }` \u2014 fired on every status change,
 *   scoped to the owning tenant so each tenant only sees its printers.
 * - `{ type: 'snapshot', ... }` \u2014 fired when the printer list changes
 *   (add / remove), broadcast per-tenant so HA instances don't receive
 *   cross-tenant data.
 *
 * ## Startup & caching
 *
 * The printer list is cached at activation time using `rootPrisma`
 * (no tenant request context exists during plugin startup). Event
 * handlers resolve tenant ownership via `printerManager.getTenantId()`
 * to scope each broadcast.
 */
import {
  PRINTERS_VIEW_PERMISSION,
  SETTINGS_MANAGE_PERMISSION,
  homeAssistantAccessStatusSchema,
  homeAssistantCreateAccessTokenResponseSchema,
  type Printer,
  type PrinterStatus
} from '@printstream/shared'
import type { ApiPlugin } from '../../plugin/types.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { printerManager } from '../../lib/printer-manager.js'
import { listPrinters } from '../../lib/printer-list.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { rootPrisma } from '../../lib/prisma.js'
import { requireRequestTenantId } from '../../lib/request-helpers.js'
import { buildHomeAssistantBridgeInfo, buildHomeAssistantSnapshot } from './snapshot.js'
import { createHomeAssistantAccessToken, readHomeAssistantAccessStatus } from './access.js'

type HomeAssistantPluginDeps = {
  listPrinters(prisma: AnyPrismaClient): Promise<Printer[]>
  getStatus(printerId: string): PrinterStatus | undefined
}

const defaultDeps: HomeAssistantPluginDeps = {
  async listPrinters(prisma) {
    return listPrinters(prisma)
  },
  getStatus(printerId) {
    return printerManager.getStatus(printerId)
  }
}

export function createHomeAssistantPlugin(deps: Partial<HomeAssistantPluginDeps> = {}): ApiPlugin {
  const services: HomeAssistantPluginDeps = {
    ...defaultDeps,
    ...deps
  }

  const readSnapshot = async (prisma: AnyPrismaClient) => {
    const printers = await services.listPrinters(prisma)
    return buildHomeAssistantSnapshot(printers, services.getStatus)
  }

  return {
    name: 'home-assistant',
    version: '0.1.0',
    description: 'Expose printers and AMS units to Home Assistant with real-time WebSocket updates.',
    async register(context) {
      const isEnabledForTenant = (tenantId: string | null): boolean => context.isEnabledForTenant?.(tenantId) ?? true

      context.router.get('/', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (_request, response) => {
        response.json(buildHomeAssistantBridgeInfo(await readSnapshot(context.prisma)))
      })

      context.router.get('/snapshot', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (_request, response) => {
        response.json(await readSnapshot(context.prisma))
      })

      context.router.get('/access', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
        const tenantId = requireRequestTenantId(request)
        const settings = context.settings.forTenant(tenantId)
        response.json(homeAssistantAccessStatusSchema.parse(await readHomeAssistantAccessStatus(context.prisma, settings)))
      })

      context.router.post('/access/token', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
        const tenantId = requireRequestTenantId(request)
        const settings = context.settings.forTenant(tenantId)
        const result = await createHomeAssistantAccessToken(context.prisma, settings, tenantId)
        // Record that a token was issued and which service account it belongs
        // to. Never log the token value itself.
        annotateRequestAuditLog(request, {
          action: 'issue-home-assistant-token',
          resource: 'Home Assistant access token',
          summary: 'Issued a Home Assistant access token.',
          metadata: {
            serviceAccountId: result.serviceAccount.id,
            serviceAccountName: result.serviceAccount.name
          }
        })
        response.json(homeAssistantCreateAccessTokenResponseSchema.parse(result))
      })

      // Cache the printer list so status events don't hit the DB on every update.
      // Use rootPrisma for the initial load because this runs at plugin
      // activation time, outside any per-tenant request context.
      let cachedPrinters: Printer[] = await services.listPrinters(rootPrisma)

      const refreshPrinterCache = async () => {
        cachedPrinters = await services.listPrinters(rootPrisma)
      }

      // Broadcast a single-printer update on every status change.
      const onStatus = (status: PrinterStatus) => {
        try {
          const printer = cachedPrinters.find((p) => p.id === status.printerId)
          if (!printer) return
          const tenantId = printerManager.getTenantId(status.printerId)
          if (!tenantId || !isEnabledForTenant(tenantId)) return
          const snapshot = buildHomeAssistantSnapshot([printer], () => status)
          context.ws.broadcast({
            type: 'plugin.event',
            pluginName: 'home-assistant',
            event: { type: 'printer.update', printer: snapshot.printers[0] }
          }, tenantId)
        } catch (error) {
          // Fire-and-forget listener: a thrown error would otherwise be lost,
          // leaving HA out of sync without any trace.
          context.logger.warn('Failed to broadcast Home Assistant printer update', { printerId: status.printerId, error })
        }
      }

      // Broadcast the full snapshot when the printer list changes.
      const onPrinterListChanged = async () => {
        try {
          await refreshPrinterCache()
          // Group printers by tenant and broadcast per-tenant snapshots
          // so each tenant only sees its own printers.
          const byTenant = new Map<string, Printer[]>()
          for (const printer of cachedPrinters) {
            const tenantId = printerManager.getTenantId(printer.id)
            if (!tenantId) continue
            const list = byTenant.get(tenantId) ?? []
            list.push(printer)
            byTenant.set(tenantId, list)
          }
          for (const [tenantId, printers] of byTenant) {
            if (!isEnabledForTenant(tenantId)) continue
            const snapshot = buildHomeAssistantSnapshot(printers, services.getStatus)
            context.ws.broadcast({
              type: 'plugin.event',
              pluginName: 'home-assistant',
              event: { type: 'snapshot', ...snapshot }
            }, tenantId)
          }
        } catch (error) {
          // Fire-and-forget listener: surface refresh/broadcast failures so a
          // stale HA snapshot does not go unnoticed.
          context.logger.warn('Failed to refresh Home Assistant printer cache', { error })
        }
      }

      context.printerEvents.on('status', onStatus)
      context.printerEvents.on('printer.added', onPrinterListChanged)
      context.printerEvents.on('printer.updated', onPrinterListChanged)
      context.printerEvents.on('printer.removed', onPrinterListChanged)

      context.onShutdown(() => {
        context.printerEvents.off('status', onStatus)
        context.printerEvents.off('printer.added', onPrinterListChanged)
        context.printerEvents.off('printer.updated', onPrinterListChanged)
        context.printerEvents.off('printer.removed', onPrinterListChanged)
      })
    }
  }
}

export const homeAssistantPlugin = createHomeAssistantPlugin()
