/**
 * Which dispatch jobs the toast stack shows.
 *
 * The WINDOW rule is shared with the slicing and delete stacks (`toastJobVisibility.ts`); what is
 * decided here is only what "active" and "failed" mean for a dispatch.
 */
import type { PrintDispatchJob } from '@printstream/shared'
import { jobBelongsInToastStack } from './toastJobVisibility'

/**
 * Still in flight: queued, uploading, or `starting` (the start command is out and the printer
 * has not confirmed it yet). Active jobs keep the toast up, so a start the printer ignores turns
 * into a visible failure there instead of a "sent" that has already been auto-dismissed.
 */
export function isActiveDispatchJob(job: Pick<PrintDispatchJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'uploading' || job.status === 'starting'
}

/**
 * Whether a send can still be called off. Not once it is `starting`: the command has already
 * reached the printer, and the server leaves a `starting` job as it is.
 */
export function isCancellableDispatchJob(job: Pick<PrintDispatchJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'uploading'
}

export function isFailedDispatchJob(job: Pick<PrintDispatchJob, 'status'>): boolean {
  return job.status === 'failed'
}

export function selectVisibleDispatchJobs(
  jobs: readonly PrintDispatchJob[],
  dismissed: ReadonlySet<string>,
  watchedRunning: ReadonlySet<string>,
  now = Date.now()
): PrintDispatchJob[] {
  return jobs
    .filter((job) => jobBelongsInToastStack(job, {
      isActive: isActiveDispatchJob(job),
      isFailed: isFailedDispatchJob(job),
      watchedRunning: watchedRunning.has(job.id)
    }, now))
    .filter((job) => !dismissed.has(job.id))
}
