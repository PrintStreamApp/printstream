/**
 * The domain rule for what counts as "the dispatch queue" shown to users: a
 * dispatch job is in the queue while it is `queued`, `uploading`, or `failed`
 * (a finished/started job has left the queue). One place so the queue view and
 * the linked-jobs selector agree.
 */
import type { PrintDispatchJob } from '@printstream/shared'

export function selectDispatchQueueJobs(jobs: readonly PrintDispatchJob[]): PrintDispatchJob[] {
  return jobs.filter((job) => job.status === 'queued' || job.status === 'uploading' || job.status === 'failed')
}