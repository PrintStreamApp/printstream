/**
 * HTTP routes for the filament-manager plugin, mounted at
 * `/api/plugins/filament-manager`. Reads use `LIBRARY_VIEW`; mutations use
 * `LIBRARY_MANAGE`; the auto-add toggle uses `SETTINGS_MANAGE`. Handlers stay
 * thin — data logic lives in `store.ts`, serialization in `dto.ts`.
 */
import {
  LIBRARY_MANAGE_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  SETTINGS_MANAGE_PERMISSION,
  spoolCreateSchema,
  spoolUpdateSchema,
  spoolAdjustSchema,
  spoolAssignSchema,
  filamentManagerSettingsSchema,
  type FilamentUsageEntry,
  type FilamentUsageSource
} from '@printstream/shared'
import type { FilamentSpoolUsage } from '@prisma/client'
import type { ApiPluginContext } from '../../plugin/types.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireRequestTenantId, requireRouteParam } from '../../lib/request-helpers.js'
import { broadcastPluginSettingsChanged } from '../../lib/ws-resource-events.js'
import { toSpoolDto } from './dto.js'
import { broadcastSpoolsChanged } from './events.js'
import { loadAutoAddBambuSpools, setAutoAddBambuSpools } from './settings.js'
import {
  adjustSpoolRow,
  assignSpoolRow,
  createSpoolRow,
  deleteSpoolRow,
  getSpoolRow,
  listSpoolRows,
  listUsageRows,
  readFilamentUsageStats,
  recycleSpoolRow,
  restoreSpoolRow,
  unassignSpoolRow,
  updateSpoolRow
} from './store.js'

function usageToDto(row: FilamentSpoolUsage): FilamentUsageEntry {
  return {
    id: row.id,
    spoolId: row.spoolId,
    jobId: row.jobId,
    grams: row.grams,
    source: row.source as FilamentUsageSource,
    note: row.note,
    recordedAt: row.recordedAt.toISOString()
  }
}

export function registerFilamentManagerRoutes(context: ApiPluginContext): void {
  const db = context.prisma

  // --- settings -----------------------------------------------------
  context.router.get('/settings', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    response.json({ autoAddBambuSpools: await loadAutoAddBambuSpools(context.settings, tenantId) })
  })

  context.router.put('/settings', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const parsed = filamentManagerSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid settings payload')
    await setAutoAddBambuSpools(context.settings, tenantId, parsed.data.autoAddBambuSpools)
    annotateRequestAuditLog(request, {
      action: 'update-filament-manager-settings',
      resource: 'filament-manager settings',
      summary: `Auto-add Bambu spools ${parsed.data.autoAddBambuSpools ? 'enabled' : 'disabled'}.`,
      metadata: { autoAddBambuSpools: parsed.data.autoAddBambuSpools }
    })
    broadcastPluginSettingsChanged(context.pluginName, tenantId)
    response.json({ autoAddBambuSpools: parsed.data.autoAddBambuSpools })
  })

  // --- stats --------------------------------------------------------
  context.router.get('/stats', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    response.json(await readFilamentUsageStats(db, tenantId))
  })

  // --- spools -------------------------------------------------------
  context.router.get('/spools', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const rows = await listSpoolRows(db, tenantId, {
      includeArchived: request.query.includeArchived === 'true',
      includeDeleted: request.query.includeDeleted === 'true'
    })
    response.json({ spools: rows.map(toSpoolDto) })
  })

  context.router.post('/spools', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const parsed = spoolCreateSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid spool payload')
    const row = await createSpoolRow(db, tenantId, parsed.data)
    annotateRequestAuditLog(request, {
      action: 'create-filament-spool',
      resource: 'filament spool',
      summary: `Added ${row.brand ?? ''} ${row.filamentType} spool to the filament library.`.trim(),
      metadata: { spoolId: row.id, filamentType: row.filamentType }
    })
    broadcastSpoolsChanged(context, tenantId)
    response.status(201).json(toSpoolDto(row))
  })

  context.router.get('/spools/:id', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const row = await getSpoolRow(db, tenantId, id)
    if (!row) throw notFound('Filament spool not found')
    response.json(toSpoolDto(row))
  })

  context.router.patch('/spools/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const parsed = spoolUpdateSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid spool payload')
    const row = await updateSpoolRow(db, tenantId, id, parsed.data)
    if (!row) throw notFound('Filament spool not found')
    annotateRequestAuditLog(request, {
      action: 'update-filament-spool',
      resource: 'filament spool',
      summary: `Updated ${row.filamentType} spool.`,
      metadata: { spoolId: row.id }
    })
    broadcastSpoolsChanged(context, tenantId)
    response.json(toSpoolDto(row))
  })

  context.router.post('/spools/:id/adjust', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const parsed = spoolAdjustSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid adjustment payload')
    const row = await adjustSpoolRow(db, tenantId, id, parsed.data)
    if (!row) throw notFound('Filament spool not found')
    annotateRequestAuditLog(request, {
      action: 'adjust-filament-spool',
      resource: 'filament spool',
      summary: `Adjusted remaining filament to ${Math.round(row.remainingGrams)}g.`,
      metadata: { spoolId: row.id, remainingGrams: row.remainingGrams }
    })
    broadcastSpoolsChanged(context, tenantId)
    response.json(toSpoolDto(row))
  })

  context.router.post('/spools/:id/assign', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const parsed = spoolAssignSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid assignment payload')
    const row = await assignSpoolRow(db, tenantId, id, parsed.data)
    if (!row) throw notFound('Filament spool not found')
    annotateRequestAuditLog(request, {
      action: 'assign-filament-spool',
      resource: 'filament spool',
      summary: `Loaded ${row.filamentType} spool into a printer slot.`,
      metadata: { spoolId: row.id, printerId: parsed.data.printerId, amsId: parsed.data.amsId, slotId: parsed.data.slotId ?? null }
    })
    broadcastSpoolsChanged(context, tenantId)
    response.json(toSpoolDto(row))
  })

  context.router.post('/spools/:id/unassign', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const row = await unassignSpoolRow(db, tenantId, id)
    if (!row) throw notFound('Filament spool not found')
    broadcastSpoolsChanged(context, tenantId)
    response.json(toSpoolDto(row))
  })

  context.router.post('/spools/:id/recycle', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const recycled = await recycleSpoolRow(db, tenantId, id)
    if (!recycled) throw notFound('Filament spool not found')
    annotateRequestAuditLog(request, {
      action: 'recycle-filament-spool',
      resource: 'filament spool',
      summary: 'Moved a filament spool to the recycle bin.',
      metadata: { spoolId: id }
    })
    broadcastSpoolsChanged(context, tenantId)
    response.json({ id, deleted: true })
  })

  context.router.post('/spools/:id/restore', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const row = await restoreSpoolRow(db, tenantId, id)
    if (!row) throw notFound('Filament spool not found')
    broadcastSpoolsChanged(context, tenantId)
    response.json(toSpoolDto(row))
  })

  context.router.delete('/spools/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const deleted = await deleteSpoolRow(db, tenantId, id)
    if (!deleted) throw notFound('Filament spool not found')
    annotateRequestAuditLog(request, {
      action: 'delete-filament-spool',
      resource: 'filament spool',
      summary: 'Permanently deleted a filament spool.',
      metadata: { spoolId: id }
    })
    broadcastSpoolsChanged(context, tenantId)
    response.json({ id, deleted: true })
  })

  context.router.get('/spools/:id/usage', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const id = requireRouteParam(request.params.id, 'id')
    const spool = await getSpoolRow(db, tenantId, id)
    if (!spool) throw notFound('Filament spool not found')
    const rows = await listUsageRows(db, tenantId, id)
    response.json({ usage: rows.map(usageToDto) })
  })
}
