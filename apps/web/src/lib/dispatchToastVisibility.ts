/**
 * Which dispatch jobs the toast stack shows.
 *
 * The WINDOW rule is shared with the slicing and delete stacks (`toastJobVisibility.ts`); what is
 * decided here is only what "active" and "failed" mean for a dispatch.
 */
import type { PrintDispatchJob } from '@printstream/shared'
import { jobBelongsInToastStack } from './toastJobVisibility'

export function isActiveDispatchJob(job: Pick<PrintDispatchJob, 'status'>): boolean {
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
