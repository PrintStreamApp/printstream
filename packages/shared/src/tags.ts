/** Workspace tag vocabulary and incremental assignment contract, shared by all entity kinds. */
import { z } from 'zod'

export const tagEntityKindSchema = z.enum(['printer', 'file', 'spool'])
export type TagEntityKind = z.infer<typeof tagEntityKindSchema>
export const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  group: z.string().trim().max(80).default('')
})
export const workspaceTagSchema = tagInputSchema.extend({ id: z.string() })
export type WorkspaceTag = z.infer<typeof workspaceTagSchema>
/** Historical copies have no foreign key to the editable tag catalog. */
export const jobTagSchema = workspaceTagSchema.extend({ entityKind: tagEntityKindSchema })
export type JobTag = z.infer<typeof jobTagSchema>
export const jobTagSnapshotSchema = z.object({
  tags: z.array(jobTagSchema),
  spoolIds: z.array(z.string()).default([])
})
export type JobTagSnapshot = z.infer<typeof jobTagSnapshotSchema>
export const jobTagCatalogSchema = z.object({ tags: z.array(jobTagSchema) })
export type TagInput = z.infer<typeof tagInputSchema>
export const tagSnapshotSchema = z.object({
  tags: z.array(workspaceTagSchema),
  assignments: z.record(z.string(), z.array(z.string()))
})
export type TagSnapshot = z.infer<typeof tagSnapshotSchema>
export const tagAssignmentInputSchema = z.object({
  entityIds: z.array(z.string().min(1)).min(1).max(1000),
  add: z.array(z.string().min(1)).max(100).default([]),
  remove: z.array(z.string().min(1)).max(100).default([])
}).refine((value) => !value.add.some((id) => value.remove.includes(id)), 'A tag cannot be added and removed together')
export type TagAssignmentInput = z.infer<typeof tagAssignmentInputSchema>

/** Every selected tag is required, regardless of group; an empty selection includes untagged entities. */
export function matchesTagFilter(assigned: readonly string[], selected: readonly string[]): boolean {
  return selected.length === 0 || selected.every((id) => assigned.includes(id))
}

/** Search uses the visible vocabulary (including categories), never opaque IDs. */
export function tagSearchText(tags: readonly WorkspaceTag[]): string {
  return tags.map((tag) => `${tag.name} ${tag.group}`).join(' ')
}

const tagCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Natural group/name order for chips and pickers; IDs break ties without mutating input. */
export function compareTags(left: WorkspaceTag, right: WorkspaceTag): number {
  return tagCollator.compare(left.group, right.group)
    || tagCollator.compare(left.name, right.name)
    || left.id.localeCompare(right.id)
}
