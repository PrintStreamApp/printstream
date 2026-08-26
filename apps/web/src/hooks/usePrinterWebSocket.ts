/**
 * Subscribes to the API WebSocket and feeds React Query caches with
 * incoming events. One connection per page, shared across components
 * via the {@link wsClient} singleton.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { wsEventSchema, type DiscoveredPrinter, type PrinterStatus } from '@printstream/shared'
import { observeServedWebBuildId } from '../lib/appStaleness'
import { applyBridgeBackupStatus, applyBridgeDebugCaptureStatus, invalidateBridgeQueries } from '../lib/bridgeQueryInvalidation'
import { clearPrinterFtpActivity, markPrinterFtpActivity } from './usePrinterFtpActivity'
import { markSnapshotUpdated } from './useSnapshotInterest'
import { invalidateLibraryListQueries } from '../lib/libraryQueryInvalidation'
import { invalidatePluginRelatedQueries } from '../lib/pluginQueryInvalidation'
import { workspaceQueryKeys } from '../lib/workspaceScope'
import { wsClient } from '../lib/wsClient'

export function usePrinterWebSocket(enabled = true, scopeKey = 'default'): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!enabled) return

    let seenSocketOpen = false
    const removeOpenListener = wsClient.onOpen(() => {
      clearPrinterFtpActivity()
      if (seenSocketOpen) {
        void queryClient.invalidateQueries({ queryKey: ['jobs'] })
        void queryClient.invalidateQueries({ queryKey: ['job-history'] })
        void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
        return
      }

      seenSocketOpen = true
    })
    wsClient.start()

    const removeListener = wsClient.onJson((raw) => {
      const parsed = wsEventSchema.safeParse(raw)
      if (!parsed.success) {
        // A parse failure here means the WS contract drifted (server sent an
        // event/field this client cannot decode). Silent in production, but
        // surface it in dev so contract drift is observable rather than a
        // mysteriously-missing update.
        if (import.meta.env.DEV) {
          const eventType = (raw as { type?: unknown } | null)?.type
          console.warn('[ws] dropped unparseable event', { type: eventType, issues: parsed.error.issues.slice(0, 5) })
        }
        return
      }

      const event = parsed.data
      if (event.type === 'hello') {
        // Every reconnect re-runs the hello, which is what makes this the load-bearing
        // channel for a phone waking up: the socket died while the app was suspended, so
        // coming back always re-asks whether this build is still the current one.
        observeServedWebBuildId(event.webBuildId)
      }
      if (event.type === 'printer.status') {
        queryClient.setQueryData<Record<string, PrinterStatus>>(
          workspaceQueryKeys.printerStatus(scopeKey),
          (existing) => ({ ...(existing ?? {}), [event.status.printerId]: event.status })
        )
      }
      if (event.type === 'printer.removed' || event.type === 'printer.list') {
        void queryClient.invalidateQueries({ queryKey: ['printers'] })
      }
      if (event.type === 'printer.discovered') {
        queryClient.setQueryData<{ printers: DiscoveredPrinter[] }>(
          workspaceQueryKeys.printersDiscovered(scopeKey),
          { printers: event.printers }
        )
      }
      if (event.type === 'camera.snapshot.updated') {
        markSnapshotUpdated(event.printerId, event.capturedAt)
      }
      if (event.type === 'printer.ftps.active') {
        markPrinterFtpActivity(event.printerId, event.active)
      }
      if (event.type === 'resource.changed') {
        if (event.resource === 'bridges') {
          void invalidateBridgeQueries(queryClient)
        }
        if (event.resource === 'delete-operations') {
          void queryClient.invalidateQueries({ queryKey: ['delete-operations'] })
        }
        if (event.resource === 'library') {
          // List-only: a background library change (another file, a print snapshot, a
          // bridge re-index) must refresh the grid but NOT refetch an open editor's scene,
          // which would rebuild the 3D view mid-edit. The editor refreshes on its own save.
          void invalidateLibraryListQueries(queryClient)
        }
        if (event.resource === 'printer.storage') {
          const storageKey = event.printerId ? ['printer-storage', event.printerId] : ['printer-storage']
          const platesKey = event.printerId ? ['printer-storage-plates', event.printerId] : ['printer-storage-plates']
          void queryClient.invalidateQueries({ queryKey: storageKey })
          void queryClient.invalidateQueries({ queryKey: platesKey })
        }
        if (event.resource === 'billing') {
          // Every surface that shows a plan, plus the plugin catalogue the plan
          // gates. `billing-me` and the customer queries are separate keys, so
          // the plan flip has to reach all of them or one surface keeps saying
          // Free after another says Pro.
          void queryClient.invalidateQueries({ queryKey: ['billing-me'] })
          void queryClient.invalidateQueries({ queryKey: ['customer'] })
          void queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] })
          void invalidatePluginRelatedQueries(queryClient)
        }
        if (event.resource === 'notification.templates') {
          void queryClient.invalidateQueries({ queryKey: ['notification-templates'] })
        }
        if (event.resource === 'printer.views') {
          void queryClient.invalidateQueries({ queryKey: ['printer-views'] })
        }
        if (event.resource === 'plugins') {
          void invalidatePluginRelatedQueries(queryClient)
        }
        if (event.resource === 'plugin.settings') {
          const key = event.pluginName ? ['plugin-settings', event.pluginName] : ['plugin-settings']
          void queryClient.invalidateQueries({ queryKey: key })
        }
        if (event.resource === 'print-dispatch') {
          void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
        }
        if (event.resource === 'support') {
          void queryClient.invalidateQueries({ queryKey: ['support'] })
        }
        if (event.resource === 'print-queue') {
          void queryClient.invalidateQueries({ queryKey: ['print-queue'] })
        }
        if (event.resource === 'slicing') {
          // Job state/progress only, NOT the profiles catalogue. Slice progress fires sub-second;
          // refetching the (slow) profiles query on every tick is the slice-time network spam.
          // Every source a slicing change can be read through goes stale together: the active
          // list, any watched single job, and the merged history (a finishing job moves there).
          void queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
          void queryClient.invalidateQueries({ queryKey: ['slicing-job'] })
          void queryClient.invalidateQueries({ queryKey: ['job-history'] })
        }
        if (event.resource === 'slicing.profiles') {
          void queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
        }
        if (event.resource === 'jobs') {
          void queryClient.invalidateQueries({ queryKey: ['jobs'] })
          // Print jobs are half of the merged Jobs history.
          void queryClient.invalidateQueries({ queryKey: ['job-history'] })
          // A finished job also rewrites the durable counters derived from it
          // (`recordFinishedPrinterStats`), and nothing else refreshed them. The printer
          // detail page renders the stats grid directly ABOVE the job history, so the two
          // sat side by side disagreeing about whether the print had happened: the kind
          // of staleness that reads as a bug in the numbers rather than in the cache.
          void queryClient.invalidateQueries({ queryKey: ['printer-stats'] })
          void queryClient.invalidateQueries({ queryKey: ['workspace-stats'] })
        }
        if (event.resource === 'logs') {
          void queryClient.invalidateQueries({ queryKey: ['logs'] })
        }
        if (event.resource === 'orders') {
          void queryClient.invalidateQueries({ queryKey: ['orders'] })
          void queryClient.invalidateQueries({ queryKey: ['orders', 'templates'] })
        }
      }
      if (event.type === 'bridge.debug.capture') {
        applyBridgeDebugCaptureStatus(queryClient, event.bridgeId, event.status)
      }
      if (event.type === 'bridge.backup') {
        applyBridgeBackupStatus(queryClient, event.bridgeId, event.status)
      }
      if (event.type === 'auth.changed') {
        clearPrinterFtpActivity()
        queryClient.removeQueries({ queryKey: ['printer-status'] })
        queryClient.removeQueries({ queryKey: ['printers-discovered'] })
        void queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] })
        void queryClient.invalidateQueries({ queryKey: ['plugin-catalog'] })
        void queryClient.invalidateQueries({ queryKey: ['general-settings'] })
      }
    })

    return () => {
      removeListener()
      removeOpenListener()
      wsClient.stop()
    }
  }, [enabled, queryClient, scopeKey])
}
