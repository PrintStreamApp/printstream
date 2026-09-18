/** Library tag search/facets run before the browse cap, so older tagged files remain reachable. */
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { badRequest } from './http-error.js'

const tagIdsSchema = z.array(z.string().min(1).max(100)).max(100)

export function parseLibraryTagIds(value: unknown): string[] {
  if (value === undefined || value === '') return []
  if (typeof value !== 'string') throw badRequest('Invalid tag filter')
  const parsed = tagIdsSchema.safeParse(value.split(','))
  if (!parsed.success) throw badRequest('Invalid tag filter')
  return [...new Set(parsed.data)]
}

/** Every selected tag is required; text search remains an independent OR across searchable fields. */
export function libraryTagWhere(workspaceId: string | null, search: string, tagIds: string[]): Prisma.LibraryFileWhereInput {
  const where: Prisma.LibraryFileWhereInput = {}
  if (tagIds.length) {
    where.AND = tagIds.map((id) => ({ tags: { some: { entityKind: 'file', workspaceId: workspaceId ?? undefined, id } } }))
  }
  if (search) {
    const contains = { contains: search, mode: 'insensitive' as const }
    where.OR = [
      { name: contains },
      { tags: { some: { entityKind: 'file', workspaceId: workspaceId ?? undefined, OR: [{ name: contains }, { group: contains }] } } }
    ]
  }
  return where
}
