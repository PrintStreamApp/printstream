/**
 * Print-queue plugin (built-in, API side).
 *
 * A shared, reorderable print backlog on top of the library and print dispatcher:
 * queued items are matched to printers by their loaded AMS material and dispatched
 * on demand (manual single dispatch or "start all idle"). Dispatch always flows
 * through `enqueueLibraryPrint`, so print guards (e.g. plate-clearing) and the
 * per-printer dispatcher still apply. Copies count down and failures surface for
 * manual re-queue as real printer jobs complete. v1 is manual-dispatch only;
 * autonomous auto-advance is a deliberate later phase.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { createQueueCompletionHandlers } from './completion.js'
import { registerQueueRoutes } from './routes.js'

export function createPrintQueuePlugin(): ApiPlugin {
  return {
    name: 'print-queue',
    version: '0.1.0',
    description: 'A shared, reorderable print backlog that matches queued jobs to printers by loaded AMS material and dispatches them on demand.',
    register(context) {
      registerQueueRoutes(context)

      const handlers = createQueueCompletionHandlers({
        isEnabledForTenant: (tenantId) => context.isEnabledForTenant?.(tenantId) ?? true,
        logger: context.logger
      })
      context.printerEvents.on('print-job.started', handlers.onStarted)
      context.printerEvents.on('print-job.finished', handlers.onFinished)
      context.onShutdown(() => {
        context.printerEvents.off('print-job.started', handlers.onStarted)
        context.printerEvents.off('print-job.finished', handlers.onFinished)
      })
    }
  }
}

export const printQueuePlugin = createPrintQueuePlugin()
