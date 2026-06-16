import type { PrintDispatchJob } from '@printstream/shared'

export function selectDispatchQueueJobs(jobs: readonly PrintDispatchJob[]): PrintDispatchJob[] {
  return jobs.filter((job) => job.status === 'queued' || job.status === 'uploading' || job.status === 'failed')
}