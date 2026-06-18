/**
 * Plate-clearing plugin (built-in).
 *
 * Gates print starts behind an explicit "plate cleared" confirmation.
 * The flow:
 *
 * - When a print finishes (success, failure, or cancellation) the plugin marks the
 *   printer as needing a plate clear.
 * - Until the user posts the "clear" confirmation, every print
 *   initiated through PrintStream (initial dispatch and SD-card reprints)
 *   is rejected with HTTP 409.
 * - Prints started outside of PrintStream (slicer, printer screen, other
 *   software) bypass the gate because the API cannot intercept them, but
 *   once any print finishes the next PrintStream print is still blocked until
 *   the user explicitly marks the plate clear.
 *
 * Per-printer state is persisted in the plugin's `Setting` store under
 * `cleared:<printerId>`, defaulting to "cleared" so existing installs
 * are not retroactively blocked.
 *
 * Plugin setting `clearLastJobOnClear` controls whether confirming the
 * plate as cleared also removes the cached last job shown on printer cards.
 * It defaults to enabled.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { z } from 'zod'
import {
  PRINTERS_CLEAR_PLATE_PERMISSION,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  SETTINGS_MANAGE_PERMISSION
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { printerManager } from '../../lib/printer-manager.js'
import { assertTenantOwnsPrinter } from '../../lib/printer-access.js'
import { resolvePrintJobIdByTaskId } from '../../lib/print-job-recorder.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { requireRouteParam } from '../../lib/request-helpers.js'
import { broadcastPluginSettingsChanged } from '../../lib/ws-resource-events.js'
import { rootPrisma } from '../../lib/prisma.js'

const STATE_KEY_PREFIX = 'cleared:'
const CLEAR_LAST_JOB_ON_CLEAR_KEY = 'clearLastJobOnClear'

const plateClearingSettingsSchema = z.object({
  clearLastJobOnClear: z.boolean()
})

export const plateClearingPlugin: ApiPlugin = {
  name: 'plate-clearing',
  version: '0.1.0',
  description: 'Block new prints until the build plate has been confirmed cleared.',
  async register(context) {
    const isEnabledForPrinter = (printerId: string): boolean => {
      const tenantId = printerManager.getTenantId(printerId) ?? null
      return context.isEnabledForTenant?.(tenantId) ?? true
    }

    /** Settings helpers (persisted, survives restart). */
    const stateKey = (printerId: string) => `${STATE_KEY_PREFIX}${printerId}`
    const isCleared = async (printerId: string): Promise<boolean> => {
      const value = await context.settings.get(stateKey(printerId))
      // Default to cleared so installing the plugin does not retroactively
      // block prints on printers whose previous job we never observed.
      return value == null ? true : value !== 'false'
    }
    const setCleared = async (printerId: string, cleared: boolean): Promise<void> => {
      await context.settings.set(stateKey(printerId), cleared ? 'true' : 'false')
    }
    const loadClearLastJobOnClear = async (): Promise<boolean> => {
      const value = await context.settings.get(CLEAR_LAST_JOB_ON_CLEAR_KEY)
      return value == null ? true : value !== 'false'
    }
    let clearLastJobOnClear = await loadClearLastJobOnClear()

    // --- print guard --------------------------------------------------
    context.registerPrintGuard((decision) => {
      // We can't await inside the guard, but the cached `Setting` row
      // is already persisted — readers are cheap. To keep the guard
      // synchronous we cache the latest known state per printer in
      // memory, refreshed on every event below.
      const cached = clearedCache.get(decision.printerId)
      if (cached === false) {
        return { allowed: false, reason: 'Plate has not been confirmed cleared. Confirm in PrintStream before printing again.' }
      }
      return true
    })
    /** Cache mirroring `Setting` rows so the guard can stay sync. */
    const clearedCache = new Map<string, boolean>()
    const refreshCache = async (printerId: string): Promise<void> => {
      clearedCache.set(printerId, await isCleared(printerId))
    }

    // --- event listeners ---------------------------------------------
    const onJobFinished = async (event: { printer: { id: string } }) => {
      try {
        if (!isEnabledForPrinter(event.printer.id)) return
        await setCleared(event.printer.id, false)
        await refreshCache(event.printer.id)
        broadcast(event.printer.id, false)
      } catch (error) {
        // A silently-dropped rejection here would leave the clear gate stuck
        // (cache and persisted state out of sync), so surface it.
        context.logger.error('Failed to update plate-clear state on job.finished', { printerId: event.printer.id, error })
      }
    }

    context.printerEvents.on('job.finished', onJobFinished)
    context.onShutdown(() => {
      context.printerEvents.off('job.finished', onJobFinished)
    })

    /** Push a state change to WS subscribers so the UI updates live. */
    const broadcast = (printerId: string, cleared: boolean): void => {
      // A null tenantId fans out to every client across all tenants; skip rather than
      // leak this printer's plate state when its tenant can't be resolved.
      const tenantId = printerManager.getTenantId(printerId)
      if (!tenantId) return
      // Re-use the generic plugin sub-event format so we don't have to
      // touch the shared discriminated union for every plugin. The
      // web plugin filters on `pluginName`.
      context.ws.broadcast({
        type: 'plugin.event',
        pluginName: 'plate-clearing',
        event: { kind: 'state', printerId, cleared }
      }, tenantId)
    }

    // Prime the cache on startup so the guard has accurate data
    // before the first event. Use rootPrisma because this runs at
    // plugin activation time, outside any per-tenant request context.
    {
      const printers = await rootPrisma.printer.findMany({ select: { id: true } })
      for (const row of printers) await refreshCache(row.id)
    }

    // --- HTTP routes -------------------------------------------------
    context.router.get('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), (_request, response) => {
      response.json({ clearLastJobOnClear })
    })

    context.router.put('/settings', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const parsed = plateClearingSettingsSchema.safeParse(request.body)
      if (!parsed.success) {
        response.status(400).json({ error: 'clearLastJobOnClear must be a boolean' })
        return
      }

      clearLastJobOnClear = parsed.data.clearLastJobOnClear
      if (clearLastJobOnClear) {
        await context.settings.delete(CLEAR_LAST_JOB_ON_CLEAR_KEY)
      } else {
        await context.settings.set(CLEAR_LAST_JOB_ON_CLEAR_KEY, 'false')
      }
      annotateRequestAuditLog(request, {
        action: 'update-plate-clearing-settings',
        resource: 'plate-clearing settings',
        summary: `Updated plate-clearing settings (clear last job on clear ${clearLastJobOnClear ? 'enabled' : 'disabled'}).`,
        metadata: {
          clearLastJobOnClear
        }
      })
      broadcastPluginSettingsChanged(context.pluginName)
      response.json({ clearLastJobOnClear })
    })

    context.router.get('/state', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (_request, response) => {
      const printers = await context.prisma.printer.findMany({ select: { id: true } })
      const states = await Promise.all(
        printers.map(async (printer) => ({
          printerId: printer.id,
          cleared: await isCleared(printer.id)
        }))
      )
      response.json({ printers: states })
    })

    context.router.post('/state/:printerId/clear', requireRequestPermission(PRINTERS_CLEAR_PLATE_PERMISSION), async (request, response) => {
      const printerId = requireRouteParam(request.params.printerId, 'printerId')
      await assertTenantOwnsPrinter(printerId)
      const printerName = printerManager.getPrinter(printerId)?.name ?? printerId
      const relatedJobId = await resolvePrintJobIdByTaskId(printerId, printerManager.getStatus(printerId)?.taskId ?? null)
      await setCleared(printerId, true)
      await refreshCache(printerId)
      if (clearLastJobOnClear) {
        printerManager.clearLastJobName(printerId)
      }
      annotateRequestAuditLog(request, {
        action: 'clear-plate',
        resource: 'printer plate',
        summary: `Marked plate as cleared on ${printerName}.`,
        metadata: {
          printerId,
          printerName,
          jobId: relatedJobId
        }
      })
      broadcast(printerId, true)
      response.json({ printerId, cleared: true })
    })

    context.router.post('/state/:printerId/needs-clear', requireRequestPermission(PRINTERS_CONTROL_PERMISSION), async (request, response) => {
      const printerId = requireRouteParam(request.params.printerId, 'printerId')
      await assertTenantOwnsPrinter(printerId)
      const printerName = printerManager.getPrinter(printerId)?.name ?? printerId
      await setCleared(printerId, false)
      await refreshCache(printerId)
      annotateRequestAuditLog(request, {
        action: 'mark-plate-needs-clear',
        resource: 'printer plate',
        summary: `Marked plate as needing a clear on ${printerName}.`,
        metadata: {
          printerId,
          printerName
        }
      })
      broadcast(printerId, false)
      response.json({ printerId, cleared: false })
    })
  }
}
