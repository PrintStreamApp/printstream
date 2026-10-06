/**
 * Printer administration and ordered printer-route composition.
 *
 * Persistent state lives in Prisma; the in-memory MQTT manager is kept
 * in lock-step through the printer event bus. Validation and DTO shaping
 * goes through `@printstream/shared` so the web client and the API agree
 * on the wire format. Storage handlers live in focused `printer-storage-*` modules;
 * cover media also has a focused registrar. This router owns their registration
 * order and the remaining printer administration endpoints.
 */
import { removePrinterSlotMaterials } from '../lib/slot-materials.js'
import { Router } from 'express'
import { z } from 'zod'
import {
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  printerConnectionValidationInputSchema,
  printerMutationInputSchema,
  printerReorderSchema,
  printerStatsResponseSchema
} from '@printstream/shared'
import { registerPrinterActiveObjectsRoute } from './printer-active-objects-route.js'
import { registerPrinterCommandRoutes } from './printer-command-routes.js'
import { registerPrinterCoverRoutes } from './printer-cover-routes.js'
import { registerPrinterStorageDownloadRoute } from './printer-storage-download.js'
import { registerPrinterStorageListRoute } from './printer-storage-list.js'
import { registerPrinterStorageMutationRoutes } from './printer-storage-mutations.js'
import { registerPrinterStoragePlatesRoute } from './printer-storage-plates.js'
import { registerPrinterStoragePrintRoute } from './printer-storage-print.js'
import { registerPrinterStorageThumbnailRoute } from './printer-storage-thumbnail.js'
import { registerPrinterStorageUploadRoute } from './printer-storage-upload.js'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { serializePrinterNozzleDiameters, toPrinterDto, toPublicPrinterDto } from '../lib/printer-record.js'
import { printerManager } from '../lib/printer-manager.js'
import { syncBridgePrinterConfig } from '../lib/bridge-printer-config.js'
import { printerDiscovery } from '../lib/printer-discovery.js'
import { assertPrinterQuotaOrThrow, notifyPrinterCountChanged } from '../lib/printer-quota.js'
import { assertLicenseAllowsPrinterAdd } from '../lib/license-enforcement.js'
import { validatePrinterLanConnection } from '../lib/printer-connection-validation.js'
import { readPrinterStats, setManualPrinterStats } from '../lib/printer-stats.js'
import { parseStatsDateRangeQuery } from '../lib/stats-date-range.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { assertPrinterMutationsAllowed } from '../lib/demo-mode.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { listPrinters } from '../lib/printer-list.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../lib/request-helpers.js'

export const printersRouter = Router()

const printerConnectionValidationRequestSchema = printerConnectionValidationInputSchema.extend({
  bridgeId: z.string({ required_error: 'Bridge assignment is required' }).trim().min(1, 'Bridge assignment is required')
})

async function assertBridgeAssignmentExists(bridgeId: string | null | undefined): Promise<void> {
  if (!bridgeId) {
    throw badRequest('Bridge assignment is required')
  }
  const bridge = await prisma.bridge.findUnique({
    where: { id: bridgeId },
    select: { id: true }
  })
  if (!bridge) {
    throw badRequest('Bridge not found')
  }
}

printersRouter.get('/', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  response.json({ printers: await listPrinters(prisma, workspaceId) })
})

printersRouter.get('/status', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const visiblePrinterIds = new Set((await prisma.printer.findMany({
    where: { workspaceId },
    select: { id: true }
  })).map((printer) => printer.id))

  const statuses = Object.fromEntries(
    printerManager
      .snapshots()
      .filter((status) => visiblePrinterIds.has(status.printerId))
      .map((status) => [status.printerId, status])
  )

  response.json({ statuses })
})

printersRouter.get('/:id/stats', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
  const printerId = requireRouteParam(request.params.id, 'Printer id')
  const stats = await readPrinterStats(printerId, parseStatsDateRangeQuery(request.query))
  if (!stats) throw notFound('Printer not found')
  response.json(printerStatsResponseSchema.parse({ stats }))
})

/**
 * LAN-discovered printers the user has not yet adopted. The discovery
 * service keeps an in-memory map keyed by serial number so a follow-up
 * `POST /api/printers` (with the access code from the printer screen)
 * can complete adoption. Returns an empty list if discovery never
 * received a packet (e.g. host without UDP multicast).
 */
printersRouter.get('/discovered', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  const workspaceId = requireRequestWorkspaceId(request)
  const bridges = await rootPrisma.bridge.findMany({
    where: { workspaceId },
    select: { id: true }
  })
  const bridgeIds = bridges.map((bridge) => bridge.id)
  if (bridgeIds.length === 0) {
    response.json({ printers: [] })
    return
  }
  const adopted = await prisma.printer.findMany({
    where: { workspaceId },
    select: { serial: true }
  })
  const adoptedSerials = new Set(adopted.map((row) => row.serial))
  const printers = printerDiscovery
    .list({ workspaceId, bridgeIds })
    .filter((entry) => !adoptedSerials.has(entry.serial))
  response.json({ printers })
})

/** Forget a discovered entry (e.g. user dismissed it from the UI). */
printersRouter.delete('/discovered/:serial', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), (request, response) => {
  const serial = requireRouteParam(request.params.serial, 'Printer serial')
  printerDiscovery.dismiss(serial, requireRequestWorkspaceId(request))
  annotateRequestAuditLog(request, {
    action: 'dismiss-discovered-printer',
    resource: 'printer',
    summary: `Dismissed discovered printer ${serial}.`,
    metadata: {
      serial
    }
  })
  response.status(204).end()
})

printersRouter.post('/validate', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  requireRequestWorkspaceId(request)
  const parsed = printerConnectionValidationRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid printer validation payload')
  }

  await assertBridgeAssignmentExists(parsed.data.bridgeId)
  const validation = await validatePrinterLanConnection({
    host: parsed.data.host,
    serial: parsed.data.serial,
    accessCode: parsed.data.accessCode
  }, parsed.data.bridgeId)
  response.json(validation)
})

printersRouter.post('/', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const parsed = printerMutationInputSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid printer payload')
  }
  await assertBridgeAssignmentExists(parsed.data.bridgeId)
  const workspaceId = requireRequestWorkspaceId(request)
  // Licence mode first: it is free to check and refuses outright, while the
  // quota check may BUY capacity (`raiseLimit` on a metered licence charges the
  // card). Money must be the last gate the request passes.
  await assertLicenseAllowsPrinterAdd()
  await assertPrinterQuotaOrThrow(workspaceId)
  const last = await prisma.printer.findFirst({ orderBy: { position: 'desc' } })
  const created = await prisma.printer.create({
    data: {
      workspaceId,
      name: parsed.data.name,
      host: parsed.data.host,
      serial: parsed.data.serial,
      accessCode: parsed.data.accessCode,
      model: parsed.data.model,
      bridgeId: parsed.data.bridgeId ?? null,
      currentPlateType: parsed.data.currentPlateType,
      currentNozzleDiameters: serializePrinterNozzleDiameters(parsed.data.currentNozzleDiameters),
      position: (last?.position ?? -1) + 1
    }
  })
  const dto = toPrinterDto(created)
  printerManager.add(dto, created.workspaceId, created.bridgeId)
  await syncBridgePrinterConfig(created.bridgeId)
  // Hide the discovery entry only for the adopting workspace so the same
  // serial can still be adopted elsewhere if printers are shared or
  // migrated between workspaces.
  printerDiscovery.dismiss(dto.serial, created.workspaceId)
  notifyPrinterCountChanged(created.workspaceId)
  // Never record the LAN access code in the audit trail.
  annotateRequestAuditLog(request, {
    action: 'add-printer',
    resource: 'printer',
    summary: `Added printer ${created.name} (${created.model}).`,
    metadata: {
      printerId: created.id,
      printerName: created.name,
      model: created.model,
      host: created.host,
      bridgeId: created.bridgeId
    }
  })
  response.status(201).json({ printer: toPublicPrinterDto(created) })
})

printersRouter.patch('/:id', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const printerId = requireRouteParam(request.params.id, 'Printer id')
  const existing = await prisma.printer.findUnique({ where: { id: printerId } })
  if (!existing) throw notFound('Printer not found')
  const current = toPrinterDto(existing)
  const parsed = printerMutationInputSchema.safeParse({ ...current, ...request.body })
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid printer payload')
  }
  await assertBridgeAssignmentExists(parsed.data.bridgeId)
  const updated = await prisma.printer.update({
    where: { id: existing.id },
    data: {
      ...(request.body.name !== undefined ? { name: parsed.data.name } : {}),
      ...(request.body.host !== undefined ? { host: parsed.data.host } : {}),
      ...(request.body.serial !== undefined ? { serial: parsed.data.serial } : {}),
      ...(request.body.accessCode !== undefined ? { accessCode: parsed.data.accessCode } : {}),
      ...(request.body.model !== undefined ? { model: parsed.data.model } : {}),
      ...(request.body.bridgeId !== undefined ? { bridgeId: parsed.data.bridgeId ?? null } : {}),
      ...(request.body.currentPlateType !== undefined ? { currentPlateType: parsed.data.currentPlateType } : {}),
      ...(request.body.currentNozzleDiameters !== undefined
        ? { currentNozzleDiameters: serializePrinterNozzleDiameters(parsed.data.currentNozzleDiameters) }
        : {})
    }
  })
  if (request.body.manualPrints !== undefined || request.body.manualPrintHours !== undefined) {
    await setManualPrinterStats({
      workspaceId: updated.workspaceId,
      printerSerial: updated.serial,
      manualPrints: parsed.data.manualPrints,
      manualPrintHours: parsed.data.manualPrintHours
    })
  }
  const dto = toPrinterDto(updated)
  printerManager.update(dto, updated.workspaceId, updated.bridgeId)
  await Promise.all(Array.from(new Set([existing.bridgeId, updated.bridgeId].filter((bridgeId): bridgeId is string => Boolean(bridgeId)))).map(syncBridgePrinterConfig))
  // Record which fields were edited. The LAN access code is a secret: never
  // record its value, only note that it changed.
  const editableFields = ['name', 'host', 'serial', 'accessCode', 'model', 'bridgeId', 'currentPlateType', 'currentNozzleDiameters', 'manualPrints', 'manualPrintHours'] as const
  const changedFields = editableFields.filter((field) => request.body[field] !== undefined)
  annotateRequestAuditLog(request, {
    action: 'edit-printer',
    resource: 'printer',
    summary: changedFields.length > 0
      ? `Edited printer ${updated.name} (${changedFields.join(', ')}).`
      : `Edited printer ${updated.name}.`,
    metadata: {
      printerId: updated.id,
      printerName: updated.name,
      changedFields
    }
  })
  response.json({ printer: toPublicPrinterDto(updated) })
})

printersRouter.delete('/:id', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const printerId = requireRouteParam(request.params.id, 'Printer id')
  const existing = await prisma.printer.findUnique({ where: { id: printerId } })
  if (!existing) throw notFound('Printer not found')
  annotateRequestAuditLog(request, {
    action: 'delete-printer',
    resource: 'printer',
    summary: `Deleted printer ${existing.name}.`,
    metadata: {
      printerId: existing.id,
      printerName: existing.name
    }
  })
  await prisma.printer.delete({ where: { id: existing.id } })
  await removePrinterSlotMaterials(existing.workspaceId, existing.id)
  printerManager.remove(existing.id)
  notifyPrinterCountChanged(existing.workspaceId)
  await syncBridgePrinterConfig(existing.bridgeId)
  response.status(204).end()
})

printersRouter.post('/reorder', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
  assertPrinterMutationsAllowed(request)
  const parsed = printerReorderSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid reorder payload')
  }
  await prisma.$transaction(
    parsed.data.orderedIds.map((id, index) =>
      prisma.printer.update({ where: { id }, data: { position: index } })
    )
  )
  response.status(204).end()
})

registerPrinterCommandRoutes(printersRouter)

registerPrinterActiveObjectsRoute(printersRouter)

registerPrinterCoverRoutes(printersRouter)

registerPrinterStorageListRoute(printersRouter)

registerPrinterStorageUploadRoute(printersRouter)

registerPrinterStorageThumbnailRoute(printersRouter)

registerPrinterStorageDownloadRoute(printersRouter)

registerPrinterStoragePlatesRoute(printersRouter)

registerPrinterStorageMutationRoutes(printersRouter)

registerPrinterStoragePrintRoute(printersRouter)

export { resolvePrinterStorageJobName } from './printer-storage-print.js'
