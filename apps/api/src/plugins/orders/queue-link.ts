/**
 * Cross-plugin bridge: the print-queue emits `order-print.*` events on the shared
 * printerEvents bus when a queued item is linked to an order print. These handlers
 * mirror the queue lifecycle onto the order print so queuing and dispatching from the
 * queue advance the order — without either plugin importing the other.
 *
 * The state reuses the existing order-print machinery (no new columns): an order print
 * with `status='started'` but no `startedPrinterId` reads as **queued**; setting the
 * printer at dispatch flips it to **printing**, after which the existing PrintJob
 * poll-sync (`syncOrderPrintState`) records the result → awaiting-confirmation.
 *
 * Runs outside a request, so it uses `rootPrisma` with the event's explicit `tenantId`
 * (mirrors the print-queue's completion handlers).
 */
import { rootPrisma } from '../../lib/prisma.js'
import { broadcastOrdersChanged } from '../../lib/ws-resource-events.js'
import type { PluginLogger } from '../../plugin/types.js'

interface OrderQueueLinkDeps {
  logger: PluginLogger
}

export interface OrderQueueLinkHandlers {
  onQueued: (event: { tenantId: string; orderPrintId: string }) => Promise<void>
  onUnqueued: (event: { tenantId: string; orderPrintId: string }) => Promise<void>
  onDispatched: (event: {
    tenantId: string
    orderPrintId: string
    printerId: string
    fileName: string
    plate: number
  }) => Promise<void>
}

export function createOrderQueueLinkHandlers(deps: OrderQueueLinkDeps): OrderQueueLinkHandlers {
  async function onQueued(event: { tenantId: string; orderPrintId: string }): Promise<void> {
    try {
      // Mark a not-yet-started print as queued; never clobber a started/completed one.
      const result = await rootPrisma.orderPrint.updateMany({
        where: { id: event.orderPrintId, tenantId: event.tenantId, status: 'pending' },
        data: {
          status: 'started',
          startedAt: new Date(),
          startedPrinterId: null,
          lastPrintJobId: null,
          lastPrintResult: null,
          lastPrintFinishedAt: null,
          completionSource: null,
          completedAt: null
        }
      })
      if (result.count > 0) broadcastOrdersChanged(event.tenantId)
    } catch (error) {
      deps.logger.warn('Failed to mark order print as queued', { orderPrintId: event.orderPrintId, error })
    }
  }

  async function onUnqueued(event: { tenantId: string; orderPrintId: string }): Promise<void> {
    try {
      // Revert only if still in the pre-dispatch queued pseudo-state (started, no printer/job).
      const result = await rootPrisma.orderPrint.updateMany({
        where: {
          id: event.orderPrintId,
          tenantId: event.tenantId,
          status: 'started',
          startedPrinterId: null,
          lastPrintJobId: null
        },
        data: { status: 'pending', startedAt: null }
      })
      if (result.count > 0) broadcastOrdersChanged(event.tenantId)
    } catch (error) {
      deps.logger.warn('Failed to release order print from the queue', { orderPrintId: event.orderPrintId, error })
    }
  }

  async function onDispatched(event: {
    tenantId: string
    orderPrintId: string
    printerId: string
    fileName: string
    plate: number
  }): Promise<void> {
    try {
      // Record the started print (mirrors the direct start route) so the existing
      // PrintJob poll-sync tracks its result. Only while queued/pending (no job yet),
      // so a print already tracking a job isn't clobbered.
      const result = await rootPrisma.orderPrint.updateMany({
        where: {
          id: event.orderPrintId,
          tenantId: event.tenantId,
          status: { in: ['pending', 'started'] },
          lastPrintJobId: null
        },
        data: {
          status: 'started',
          libraryFileName: event.fileName,
          plate: event.plate,
          startedPrinterId: event.printerId,
          startedAt: new Date(),
          attemptCount: { increment: 1 },
          lastPrintJobId: null,
          lastPrintResult: null,
          lastPrintFinishedAt: null,
          completionSource: null,
          completedAt: null
        }
      })
      if (result.count > 0) broadcastOrdersChanged(event.tenantId)
    } catch (error) {
      deps.logger.warn('Failed to record a queue-dispatched order print', { orderPrintId: event.orderPrintId, error })
    }
  }

  return { onQueued, onUnqueued, onDispatched }
}
