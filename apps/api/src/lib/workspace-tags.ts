/**
 * Owns tag persistence and assignments. Every nested relation is explicitly workspace-scoped;
 * Prisma does not scope relation connects for us. Incremental connect/disconnect preserves other
 * tags during bulk edits, and database foreign keys clean assignments on permanent deletion.
 */
import type { TagAssignmentInput, TagEntityKind, TagInput, TagSnapshot } from '@printstream/shared'
import { visibleLibraryFilesWhere } from './library-visibility.js'
import { prisma } from './prisma.js'
import { badRequest, conflict, notFound } from './http-error.js'
import { isUniqueConstraintError } from './prisma-errors.js'

const relations = { printer: 'printers', file: 'files', spool: 'spools' } as const

/** Return only the requested kind's vocabulary and visible assignments. */
export async function readTagSnapshot(workspaceId: string, kind: TagEntityKind): Promise<TagSnapshot> {
  const relation = relations[kind]
  const rows = await prisma.workspaceTag.findMany({
    where: { workspaceId, entityKind: kind },
    orderBy: [{ group: 'asc' }, { name: 'asc' }],
    include: {
      printers: kind === 'printer' ? { where: { workspaceId }, select: { id: true } } : false,
      files: kind === 'file' ? { where: visibleLibraryFilesWhere({ workspaceId }), select: { id: true } } : false,
      spools: kind === 'spool' ? { where: { workspaceId, deletedAt: null }, select: { id: true } } : false
    }
  })
  const assignments: Record<string, string[]> = {}
  for (const row of rows) {
    for (const entity of row[relation] ?? []) {
      (assignments[entity.id] ??= []).push(row.id)
    }
  }
  return { tags: rows.map(({ id, name, color, group }) => ({ id, name, color, group })), assignments }
}

/** Create/update vocabulary; duplicate normalized names fail without changing assignments. */
export async function saveWorkspaceTag(workspaceId: string, kind: TagEntityKind, input: TagInput, id?: string) {
  const data = { ...input, nameKey: input.name.toLowerCase() }
  try {
    if (id) {
      const existing = await prisma.workspaceTag.findFirst({ where: { id, workspaceId, entityKind: kind } })
      if (!existing) throw notFound('Tag not found')
      return await prisma.workspaceTag.update({ where: { id, workspaceId, entityKind: kind }, data })
    }
    return await prisma.workspaceTag.create({ data: { ...data, workspaceId, entityKind: kind } })
  } catch (error) {
    if (isUniqueConstraintError(error)) throw conflict('A tag with that name already exists')
    throw error
  }
}

/** Validate the whole batch before any assignment changes, then apply atomically. */
export async function assignWorkspaceTags(workspaceId: string, kind: TagEntityKind, input: TagAssignmentInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const ids = [...new Set(input.entityIds)]
    const where = { workspaceId, id: { in: ids } }
    let entities: Array<{ id: string }>
    if (kind === 'printer') {
      entities = await tx.printer.findMany({ where, select: { id: true } })
    } else if (kind === 'file') {
      entities = await tx.libraryFile.findMany({ where: visibleLibraryFilesWhere(where), select: { id: true } })
    } else {
      entities = await tx.filamentSpool.findMany({ where: { ...where, deletedAt: null }, select: { id: true } })
    }
    if (entities.length !== ids.length) throw badRequest('One or more selected items are unavailable')
    const tagIds = [...new Set([...input.add, ...input.remove])]
    const tags = await tx.workspaceTag.findMany({ where: { workspaceId, entityKind: kind, id: { in: tagIds } }, select: { id: true } })
    if (tags.length !== tagIds.length) throw badRequest('One or more tags are unavailable')

    for (const id of tagIds) {
      const operation = input.add.includes(id) ? { connect: entities } : { disconnect: entities }
      await tx.workspaceTag.update({ where: { id, workspaceId, entityKind: kind }, data: { [relations[kind]]: operation } })
    }
  })
}
