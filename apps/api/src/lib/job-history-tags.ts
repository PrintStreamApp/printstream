/** History filters use only durable tag copies, never mutable catalogs or entity relations. */
import { compareTags, tagSearchText, type JobHistoryEntry, type JobTag, type SlicingJob } from '@printstream/shared'
import { prisma } from './prisma.js'
import { historicalTag, readJobTagSnapshot } from './job-tag-snapshots.js'

/** Load print snapshots once per request; slicing copies arrive from the persisted job manager. */
export async function readJobHistoryTags(workspaceId: string, slicingJobs: readonly SlicingJob[]) {
  const rows = await prisma.printJob.findMany({
    where: { workspaceId, finishedAt: { not: null } },
    select: { id: true, tagSnapshotJson: true }
  })
  const byJob = new Map<string, JobTag[]>()
  for (const row of rows) byJob.set(`print:${row.id}`, readJobTagSnapshot(row.tagSnapshotJson).tags.map(historicalTag))
  for (const job of slicingJobs) byJob.set(`slicing:${job.id}`, (job.tagSnapshot ?? []).map(historicalTag))
  return byJob
}

/** Preserve distinct historical versions and entity catalogs, even after their live tags disappear. */
export function jobHistoryTagCatalog(byJob: ReadonlyMap<string, JobTag[]>): JobTag[] {
  const tags = new Map<string, JobTag>()
  for (const entries of byJob.values()) for (const tag of entries) tags.set(tag.id, tag)
  return [...tags.values()].sort(compareTags)
}

/** All selected snapshots must match. Text uses the captured names/groups; empty criteria match no extra text. */
export function jobHistoryTagMatcher(byJob: ReadonlyMap<string, JobTag[]>, search: string, tagIds: readonly string[] = []): (entry: JobHistoryEntry) => boolean {
  const query = search.toLocaleLowerCase()
  return (entry) => {
    const id = entry.kind === 'print' ? entry.printJob.id : entry.slicingJob.id
    const tags = byJob.get(`${entry.kind}:${id}`) ?? []
    if (tagIds.length) return tagIds.every((id) => tags.some((tag) => tag.id === id))
    return Boolean(query) && tagSearchText(tags).toLocaleLowerCase().includes(query)
  }
}
