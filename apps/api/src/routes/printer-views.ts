/**
 * Saved printer-view CRUD.
 *
 * Views persist Printers page preferences such as printer subsets,
 * cards-per-row, sort mode, and per-card content visibility so the web
 * app can restore named dashboard layouts from the database.
 */
import { Router } from 'express'
import { PRINTERS_VIEW_PERMISSION, printerViewInputSchema } from '@printstream/shared'
import { requireRequestPermission } from '../lib/authorization.js'
import { conflict, badRequest, notFound } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import {
  serializePrinterCardContentSettings,
  serializePrinterViewIds,
  serializePrinterViewModelFilter,
  serializePrinterViewNozzleDiameterFilter,
  serializePrinterViewPlateTypeFilter,
  toPrinterViewDto
} from '../lib/printer-view-record.js'
import { requireRequestTenantId } from '../lib/request-helpers.js'
import { broadcastPrinterViewsChanged } from '../lib/ws-resource-events.js'

export const printerViewsRouter = Router()

printerViewsRouter.use(requireRequestPermission(PRINTERS_VIEW_PERMISSION))

printerViewsRouter.get('/', async (_request, response) => {
  const rows = await prisma.printerView.findMany({ orderBy: { name: 'asc' } })
  response.json({ views: rows.map(toPrinterViewDto) })
})

printerViewsRouter.post('/', async (request, response) => {
  const parsed = printerViewInputSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid printer view payload')
  }
  const tenantId = requireRequestTenantId(request)

  await assertKnownPrinterIds(parsed.data.printerIds)

  try {
    const created = await prisma.printerView.create({
      data: {
        tenantId,
        name: parsed.data.name,
        printerIds: serializePrinterViewIds(parsed.data.printerIds),
        cardsPerRow: parsed.data.cardsPerRow,
        stateFilter: parsed.data.stateFilter,
        modelFilter: serializePrinterViewModelFilter(parsed.data.modelFilter),
        nozzleDiameterFilter: serializePrinterViewNozzleDiameterFilter(parsed.data.nozzleDiameterFilter),
        plateTypeFilter: serializePrinterViewPlateTypeFilter(parsed.data.plateTypeFilter),
        sortKey: parsed.data.sort.key,
        sortDirection: parsed.data.sort.direction,
        cardContentSettings: serializePrinterCardContentSettings(parsed.data.cardContentSettings)
      }
    })
    broadcastPrinterViewsChanged(tenantId)
    response.status(201).json({ view: toPrinterViewDto(created) })
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('A printer view with that name already exists')
    throw error
  }
})

printerViewsRouter.patch('/:id', async (request, response) => {
  const parsed = printerViewInputSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid printer view payload')
  }
  const tenantId = requireRequestTenantId(request)

  const existing = await prisma.printerView.findUnique({ where: { id: request.params.id } })
  if (!existing) throw notFound('Printer view not found')

  await assertKnownPrinterIds(parsed.data.printerIds)

  try {
    const updated = await prisma.printerView.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name,
        printerIds: serializePrinterViewIds(parsed.data.printerIds),
        cardsPerRow: parsed.data.cardsPerRow,
        stateFilter: parsed.data.stateFilter,
        modelFilter: serializePrinterViewModelFilter(parsed.data.modelFilter),
        nozzleDiameterFilter: serializePrinterViewNozzleDiameterFilter(parsed.data.nozzleDiameterFilter),
        plateTypeFilter: serializePrinterViewPlateTypeFilter(parsed.data.plateTypeFilter),
        sortKey: parsed.data.sort.key,
        sortDirection: parsed.data.sort.direction,
        cardContentSettings: serializePrinterCardContentSettings(parsed.data.cardContentSettings)
      }
    })
    broadcastPrinterViewsChanged(tenantId)
    response.json({ view: toPrinterViewDto(updated) })
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('A printer view with that name already exists')
    throw error
  }
})

printerViewsRouter.delete('/:id', async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const existing = await prisma.printerView.findUnique({ where: { id: request.params.id } })
  if (!existing) throw notFound('Printer view not found')
  await prisma.printerView.delete({ where: { id: existing.id } })
  broadcastPrinterViewsChanged(tenantId)
  response.status(204).end()
})

async function assertKnownPrinterIds(printerIds: readonly string[]): Promise<void> {
  if (printerIds.length === 0) return
  const rows = await prisma.printer.findMany({
    where: { id: { in: [...printerIds] } },
    select: { id: true }
  })
  const knownIds = new Set(rows.map((row) => row.id))
  const unknownId = printerIds.find((id) => !knownIds.has(id))
  if (unknownId) {
    throw badRequest(`Unknown printer id: ${unknownId}`)
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

