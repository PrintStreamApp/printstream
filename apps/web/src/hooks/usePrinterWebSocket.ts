/**
 * Subscribes to the API WebSocket and feeds React Query caches with
 * incoming events. One connection per page, shared across components
 * via the {@link wsClient} singleton.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { wsEventSchema, type DiscoveredPrinter, type PrinterStatus } from '@printstream/shared'
import { applyBridgeDebugCaptureStatus, invalidateBridgeQueries } from '../lib/bridgeQueryInvalidation'
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
        void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
        return
      }

      seenSocketOpen = true
    })
    wsClient.start()

    const removeListener = wsClient.onJson((raw) => {
      const parsed = wsEventSchema.safeParse(raw)
      if (!parsed.success) return

      const event = parsed.data
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
        if (event.resource === 'slicing') {
          // Job state/progress only — NOT the profiles catalogue. Slice progress fires sub-second;
          // refetching the (slow) profiles query on every tick is the slice-time network spam.
          void queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
        }
        if (event.resource === 'slicing.profiles') {
          void queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
        }
        if (event.resource === 'jobs') {
          void queryClient.invalidateQueries({ queryKey: ['jobs'] })
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
