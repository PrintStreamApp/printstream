/**
 * Queue completion tracking. Reconciles queued items against real printer lifecycle
 * events so copies count down, completed backlog work leaves the queue, reusable
 * pinned items reset, and failures surface for manual re-queue.
 *
 * Runs in the background (printer-event handlers have no workspace request context), so
 * it uses `rootPrisma` with an explicit `workspaceId` taken from the event's printer.
 * Items are matched fast by the tracked `PrintJob` id stored at dispatch, with an
 * orders-style printer + job-name fallback for reconciliation edge cases.
 */
import type { Printer } from '@printstream/shared'
import { printerManager } from '../../lib/printer-manager.js'
import { rootPrisma } from '../../lib/prisma.js'
import { broadcastQueueChanged } from '../../lib/ws-resource-events.js'
import type { PluginLogger } from '../../plugin/types.js'

interface QueueCompletionDeps {
  isEnabledForWorkspace: (workspaceId: string | null) => boolean
  logger: PluginLogger
}

type JobStartedEvent = { jobId: string; printer: Printer; jobName: string }
type JobFinishedEvent = { jobId: string; printer: Printer; jobName: string; result: 'success' | 'failed' | 'cancelled' }

export interface QueueCompletionHandlers {
  onStarted: (event: JobStartedEvent) => void | Promise<void>
  onFinished: (event: JobFinishedEvent) => void | Promise<void>
}

export function createQueueCompletionHandlers(deps: QueueCompletionDeps): QueueCompletionHandlers {
  async function findItemForJob(
    workspaceId: string,
    jobId: string,
    printerId: string,
    jobName: string,
    statuses: string[]
  ): Promise<{ id: string; quantity: number; completedCount: number; pinned: boolean } | null> {
    const byJob = await rootPrisma.queueItem.findFirst({
      where: { workspaceId, lastPrintJobId: jobId, status: { in: statuses } },
      select: { id: true, quantity: true, completedCount: true, pinned: true }
    })
    if (byJob) return byJob
    return rootPrisma.queueItem.findFirst({
      where: { workspaceId, lastPrinterId: printerId, lastJobName: jobName, status: { in: statuses } },
      orderBy: { lastDispatchedAt: 'desc' },
      select: { id: true, quantity: true, completedCount: true, pinned: true }
    })
  }

  async function handleStarted(event: JobStartedEvent): Promise<void> {
    const workspaceId = printerManager.getWorkspaceId(event.printer.id)
    if (!workspaceId || !deps.isEnabledForWorkspace(workspaceId)) return
    const item = await findItemForJob(workspaceId, event.jobId, event.printer.id, event.jobName, ['dispatching'])
    if (!item) return
    await rootPrisma.queueItem.update({
      where: { id: item.id },
      data: { status: 'printing', lastPrintJobId: event.jobId }
    })
    broadcastQueueChanged(workspaceId)
  }

  async function handleFinished(event: JobFinishedEvent): Promise<void> {
    const workspaceId = printerManager.getWorkspaceId(event.printer.id)
    if (!workspaceId || !deps.isEnabledForWorkspace(workspaceId)) return
    const item = await findItemForJob(workspaceId, event.jobId, event.printer.id, event.jobName, ['dispatching', 'printing'])
    if (!item) return

    if (event.result === 'success') {
      const completedCount = item.completedCount + 1
      const done = completedCount >= item.quantity
      if (done && !item.pinned) {
        // Completed backlog work leaves the queue. A user who wants a reusable
        // print template explicitly pins it instead.
        await rootPrisma.queueItem.delete({ where: { id: item.id } })
      } else {
        await rootPrisma.queueItem.update({
          where: { id: item.id },
          data: {
            completedCount: done ? 0 : completedCount,
            status: 'queued',
            lastResult: 'success',
            lastFinishedAt: new Date(),
            // Every reusable or remaining-copy cycle gets fresh dispatch linkage.
            lastPrintJobId: null,
            lastDispatchJobId: null
          }
        })
      }
    } else {
      await rootPrisma.queueItem.update({
        where: { id: item.id },
        data: { status: 'failed', lastResult: event.result, lastFinishedAt: new Date() }
      })
    }
    broadcastQueueChanged(workspaceId)
  }

  // Listeners ignore the return value, but returning the promise (with its own catch)
  // keeps the handlers awaitable in tests while staying fire-and-forget on the bus.
  return {
    onStarted: (event) => handleStarted(event).catch((error) => deps.logger.error('Failed to apply queue print-start', { error })),
    onFinished: (event) => handleFinished(event).catch((error) => deps.logger.error('Failed to apply queue print-finish', { error }))
  }
}
