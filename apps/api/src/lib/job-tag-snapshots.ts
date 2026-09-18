/**
 * Captures historical tag vocabulary independently of live entities. Print rows own their
 * snapshot; slicing jobs persist the same tag copies in their durable state file.
 * History reads never consult live tags. Spool capture is independent of consumption accounting.
 */
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { jobTagSnapshotSchema, type JobTag } from '@printstream/shared'

type SnapshotDb = Pick<Prisma.TransactionClient, 'workspaceTag'>

/** Capture only explicitly identified, workspace-local sources at the recording boundary. */
export async function captureJobTags(db: SnapshotDb, workspaceId: string, sources: {
  printerId?: string | null; fileIds?: string[]; spoolIds?: string[]
}): Promise<JobTag[]> {
  const OR: Prisma.WorkspaceTagWhereInput[] = []
  if (sources.printerId) OR.push({ entityKind: 'printer', printers: { some: { id: sources.printerId, workspaceId } } })
  if (sources.fileIds?.length) OR.push({ entityKind: 'file', files: { some: { id: { in: sources.fileIds }, workspaceId } } })
  if (sources.spoolIds?.length) OR.push({ entityKind: 'spool', spools: { some: { id: { in: sources.spoolIds }, workspaceId } } })
  if (!OR.length) return []
  return await db.workspaceTag.findMany({
    where: { workspaceId, OR },
    select: { id: true, entityKind: true, name: true, group: true, color: true }
  })
}

/** Null means a legacy unknown snapshot, never a request to resolve current tags. */
export function readJobTagSnapshot(raw: string | null | undefined) {
  if (!raw) return { tags: [], spoolIds: [] }
  return jobTagSnapshotSchema.parse(JSON.parse(raw))
}

/** Versioned picker identity keeps a renamed/recolored tag distinct from its historical copy. */
export function historicalTag(tag: JobTag): JobTag {
  const id = createHash('sha256').update(JSON.stringify([tag.entityKind, tag.id, tag.name, tag.group, tag.color])).digest('hex')
  return { ...tag, id }
}

