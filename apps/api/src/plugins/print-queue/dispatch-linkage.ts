/**
 * Builds the queue row's durable linkage for an accepted dispatch.
 *
 * The dispatcher creates its own job immediately, but the related `PrintJob` database
 * row does not exist until the printer confirms the start. The two ids may currently
 * share a value, but the dispatch id must never be written through the PrintJob foreign
 * key. Queue completion fills `lastPrintJobId` from the later start event.
 */
import type { PrintDispatchJob } from '@printstream/shared'

export function buildQueueDispatchLinkage(
  job: PrintDispatchJob,
  printerId: string,
  dispatchedAt = new Date()
) {
  return {
    status: 'dispatching',
    lastPrinterId: printerId,
    lastDispatchJobId: job.id,
    lastPrintJobId: null,
    lastJobName: job.jobName,
    lastDispatchedAt: dispatchedAt,
    lastResult: null,
    lastFinishedAt: null
  } as const
}
