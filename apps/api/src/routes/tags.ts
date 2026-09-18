/** Workspace tag routes. Assignment follows entity edit rights; catalog edits require settings rights. */
import { Router } from 'express'
import { LIBRARY_MANAGE_PERMISSION, LIBRARY_VIEW_PERMISSION, PRINTERS_MANAGE_PERMISSION, PRINTERS_VIEW_PERMISSION, SETTINGS_MANAGE_PERMISSION, tagAssignmentInputSchema, tagEntityKindSchema, tagInputSchema, type TagEntityKind } from '@printstream/shared'
import { assertRequestPermission } from '../lib/authorization.js'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../lib/request-helpers.js'
import { prisma } from '../lib/prisma.js'
import { broadcastResourceChange } from '../lib/ws-resource-events.js'
import { assignWorkspaceTags, readTagSnapshot, saveWorkspaceTag } from '../lib/workspace-tags.js'
import type { Request } from 'express'

export const tagsRouter = Router()

/** Resolve kind and rights before reading any assignments, including on auth-disabled installs. */
function tagContext(request: Request, write = false) {
  const parsed = tagEntityKindSchema.safeParse(request.params.kind)
  if (!parsed.success) throw badRequest('Invalid tagged item type')
  const kind: TagEntityKind = parsed.data
  assertRequestPermission(request, kind === 'printer'
    ? (write ? PRINTERS_MANAGE_PERMISSION : PRINTERS_VIEW_PERMISSION)
    : (write ? LIBRARY_MANAGE_PERMISSION : LIBRARY_VIEW_PERMISSION))
  return { kind, workspaceId: requireRequestWorkspaceId(request) }
}

/** Emit only an invalidation hint; tag names and entity IDs never cross workspace boundaries. */
function changed(request: Request, workspaceId: string, action: string, metadata: Record<string, unknown> = {}) {
  annotateRequestAuditLog(request, { action, resource: 'tags', summary: action.replaceAll('-', ' '), metadata })
  broadcastResourceChange({ resource: 'tags', workspaceId })
}

tagsRouter.get('/:kind', async (request, response) => {
  const { workspaceId, kind } = tagContext(request)
  response.json(await readTagSnapshot(workspaceId, kind))
})

tagsRouter.post('/:kind/assign', async (request, response) => {
  const { workspaceId, kind } = tagContext(request, true)
  const parsed = tagAssignmentInputSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid tag assignment')
  await assignWorkspaceTags(workspaceId, kind, parsed.data)
  changed(request, workspaceId, 'assign-tags', { kind, ...parsed.data })
  response.status(204).end()
})

tagsRouter.post('/:kind', async (request, response) => {
  const { workspaceId, kind } = tagContext(request, true)
  const parsed = tagInputSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid tag')
  const tag = await saveWorkspaceTag(workspaceId, kind, parsed.data)
  changed(request, workspaceId, 'create-tag', { tagId: tag.id })
  response.status(201).json({ tag })
})

tagsRouter.put('/:kind/:id', async (request, response) => {
  const { workspaceId, kind } = tagContext(request)
  assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)
  const parsed = tagInputSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid tag')
  const tag = await saveWorkspaceTag(workspaceId, kind, parsed.data, requireRouteParam(request.params.id, 'id'))
  changed(request, workspaceId, 'update-tag', { tagId: tag.id })
  response.json({ tag })
})

tagsRouter.delete('/:kind/:id', async (request, response) => {
  const { workspaceId, kind } = tagContext(request)
  assertRequestPermission(request, SETTINGS_MANAGE_PERMISSION)
  const id = requireRouteParam(request.params.id, 'id')
  const result = await prisma.workspaceTag.deleteMany({ where: { id, workspaceId, entityKind: kind } })
  if (!result.count) throw notFound('Tag not found')
  changed(request, workspaceId, 'delete-tag', { tagId: id })
  response.status(204).end()
})
