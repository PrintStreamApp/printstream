import type { PrintDispatchJob } from '@printstream/shared'

const RECENT_MS = 90_000

export function isActiveDispatchJob(job: Pick<PrintDispatchJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'uploading'
}

export function selectVisibleDispatchJobs(
  jobs: readonly PrintDispatchJob[],
  dismissed: ReadonlySet<string>,
  now = Date.now()
): PrintDispatchJob[] {
  return jobs
    .filter((job) => isActiveDispatchJob(job) || now - Date.parse(job.updatedAt) <= RECENT_MS)
    .filter((job) => !dismissed.has(job.id))
}

export { RECENT_MS }