/**
 * Orders plugin (built-in, API side).
 *
 * Adds a lightweight production-order workflow on top of the library and
 * print dispatcher:
 *
 * - Order templates capture reusable sets of required library prints.
 * - Orders snapshot a template into individual print units that can be
 *   started, manually completed, or confirmed after a real printer job
 *   finishes successfully.
 * - Order print status is reconciled against persisted `PrintJob` rows so
 *   the plugin follows the actual printer lifecycle instead of guessing.
 */
import {
  JOBS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  isDirectPrintableFileName
} from '@printstream/shared'
import {
  orderCreateSchema,
  orderStatusSchema,
  orderTemplateCreateSchema,
  orderTemplateUpdateSchema,
  orderUpdateSchema,
  startOrderPrintSchema,
  threeMfProjectFilamentSchema,
  type ThreeMfProjectFilament,
  type OrderPrintActivityState
} from '@printstream/shared'
import type { ApiPlugin, PluginLogger } from '../../plugin/types.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import {
  inspectBridgeLibraryThreeMf,
  resolveLibraryFileToLocalPath
} from '../../lib/bridge-library-files.js'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'
import { requireRequestTenantId, requireRouteParam } from '../../lib/request-helpers.js'
import { enqueueLibraryPrint } from '../../lib/library-printing.js'
import { broadcastOrdersChanged, broadcastPrintDispatchChanged } from '../../lib/ws-resource-events.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { getCurrentTenant } from '../../lib/tenant-context.js'
import { readPlateIndex, type ThreeMfIndex } from '../../lib/three-mf.js'

type OrdersPluginDeps = {
  enqueueLibraryPrint: typeof enqueueLibraryPrint
  inspectBridgeLibraryThreeMf: typeof inspectBridgeLibraryThreeMf
  resolveLibraryFileToLocalPath: typeof resolveLibraryFileToLocalPath
  readPlateIndex: typeof readPlateIndex
}

const defaultDeps: OrdersPluginDeps = {
  enqueueLibraryPrint,
  inspectBridgeLibraryThreeMf,
  resolveLibraryFileToLocalPath,
  readPlateIndex
}

const templateInclude = {
  variants: {
    orderBy: { position: 'asc' as const },
    include: {
      items: {
        orderBy: { position: 'asc' as const },
        include: {
          libraryFile: {
            select: { id: true }
          }
        }
      }
    }
  }
}

const orderInclude = {
  selectedVariants: {
    orderBy: { position: 'asc' as const }
  },
  prints: {
    orderBy: [
      { groupPosition: 'asc' as const },
      { sequenceNumber: 'asc' as const }
    ],
    include: {
      libraryFile: {
        select: { id: true }
      },
      startedPrinter: {
        select: { id: true, name: true }
      }
    }
  }
}

export function createOrdersPlugin(deps: Partial<OrdersPluginDeps> = {}): ApiPlugin {
  const services: OrdersPluginDeps = {
    ...defaultDeps,
    ...deps
  }

  return {
    name: 'orders',
    version: '0.1.0',
    description: 'Templated production orders built from library files and tracked against real print completions.',
    async register(context) {
      context.router.get('/templates', requireRequestPermission(JOBS_VIEW_PERMISSION), async (_request, response) => {
        response.json({ templates: await listTemplates(context.prisma) })
      })

      context.router.post('/templates', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const parsed = orderTemplateCreateSchema.safeParse(request.body)
        if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid template payload')

        const variants = await Promise.all(
          parsed.data.variants.map((variant, position) => resolveTemplateVariant(context.prisma, services, variant, position, context.logger))
        )
        const tenantId = requireTenantId()

        const created = await context.prisma.orderTemplate.create({
          data: {
            tenantId,
            name: parsed.data.name,
            code: normalizeNullableText(parsed.data.code),
            description: normalizeNullableText(parsed.data.description),
            notesTemplate: normalizeNullableText(parsed.data.notesTemplate),
            variants: {
              create: variants.map((variant) => ({
                tenantId,
                name: variant.name,
                position: variant.position,
                items: {
                  create: variant.items.map((item) => ({
                    tenantId,
                    ...item
                  }))
                }
              }))
            }
          },
          include: templateInclude
        })

        annotateRequestAuditLog(request, {
          action: 'create-order-template',
          resource: 'order template',
          summary: `Created order template "${created.name}".`,
          metadata: {
            templateId: created.id,
            templateName: created.name
          }
        })
        broadcastOrdersChanged()
        response.status(201).json({ template: toTemplateDto(created) })
      })

      context.router.patch('/templates/:templateId', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const templateId = requireRouteParam(request.params.templateId, 'templateId')
        const parsed = orderTemplateUpdateSchema.safeParse(request.body)
        if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid template payload')

        const existing = await context.prisma.orderTemplate.findUnique({ where: { id: templateId } })
        if (!existing) throw notFound('Order template not found')

        const variants = parsed.data.variants
          ? await Promise.all(
            parsed.data.variants.map((variant, position) => resolveTemplateVariant(context.prisma, services, variant, position, context.logger))
          )
          : null

        await context.prisma.$transaction(async (tx) => {
          const tenantId = requireTenantId()
          await tx.orderTemplate.update({
            where: { id: existing.id },
            data: {
              name: parsed.data.name ?? undefined,
              code: parsed.data.code !== undefined ? normalizeNullableText(parsed.data.code) : undefined,
              description: parsed.data.description !== undefined ? normalizeNullableText(parsed.data.description) : undefined,
              notesTemplate: parsed.data.notesTemplate !== undefined ? normalizeNullableText(parsed.data.notesTemplate) : undefined
            }
          })

          if (variants) {
            await tx.orderTemplateVariant.deleteMany({ where: { templateId: existing.id } })
            await tx.orderTemplate.update({
              where: { id: existing.id },
              data: {
                variants: {
                  create: variants.map((variant) => ({
                    tenantId,
                    name: variant.name,
                    position: variant.position,
                    items: {
                      create: variant.items.map((item) => ({
                        tenantId,
                        ...item
                      }))
                    }
                  }))
                }
              }
            })
          }
        })

        const updated = await context.prisma.orderTemplate.findUnique({
          where: { id: existing.id },
          include: templateInclude
        })
        if (!updated) throw notFound('Order template not found')

        annotateRequestAuditLog(request, {
          action: 'update-order-template',
          resource: 'order template',
          summary: `Updated order template "${updated.name}".`,
          metadata: {
            templateId: updated.id,
            templateName: updated.name
          }
        })
        broadcastOrdersChanged()
        response.json({ template: toTemplateDto(updated) })
      })

      context.router.delete('/templates/:templateId', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const templateId = requireRouteParam(request.params.templateId, 'templateId')
        const existing = await context.prisma.orderTemplate.findUnique({ where: { id: templateId } })
        if (!existing) throw notFound('Order template not found')

        await context.prisma.orderTemplate.delete({ where: { id: existing.id } })
        annotateRequestAuditLog(request, {
          action: 'delete-order-template',
          resource: 'order template',
          summary: `Deleted order template "${existing.name}".`,
          metadata: {
            templateId: existing.id,
            templateName: existing.name
          }
        })
        broadcastOrdersChanged()
        response.status(204).end()
      })

      context.router.get('/orders', requireRequestPermission(JOBS_VIEW_PERMISSION), async (_request, response) => {
        response.json({ orders: await listOrders(context.prisma) })
      })

      context.router.post('/orders', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const parsed = orderCreateSchema.safeParse(request.body)
        if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid order payload')

        const template = await context.prisma.orderTemplate.findUnique({
          where: { id: parsed.data.templateId },
          include: {
            variants: {
              orderBy: { position: 'asc' },
              include: {
                items: {
                  orderBy: { position: 'asc' }
                }
              }
            }
          }
        })
        if (!template) throw notFound('Order template not found')
        const selectedVariants = normalizeSelectedTemplateVariants(template, parsed.data.variants)
        const printFilamentOverridesByTemplatePrintId = buildTemplatePrintFilamentOverrideMap(
          selectedVariants,
          parsed.data.printFilamentOverrides
        )
        const tenantId = requireTenantId()

        const created = await context.prisma.order.create({
          data: {
            tenantId,
            templateId: template.id,
            templateName: template.name,
            templateCode: template.code,
            templateDescription: template.description,
            name: parsed.data.name,
            notes: parsed.data.notes !== undefined
              ? normalizeNullableText(parsed.data.notes)
              : normalizeNullableText(template.notesTemplate),
            selectedVariants: {
              create: selectedVariants.map(({ variant, quantity }, position) => ({
                tenantId,
                templateVariantId: variant.id,
                templateVariantName: variant.name,
                quantity,
                position
              }))
            },
            prints: {
              create: buildOrderPrintsFromTemplateVariants(
                selectedVariants,
                tenantId,
                printFilamentOverridesByTemplatePrintId
              )
            }
          }
        })

        await syncOrderStatus(context.prisma, created.id)
        annotateRequestAuditLog(request, {
          action: 'create-order',
          resource: 'order',
          summary: `Created order "${created.name}".`,
          metadata: {
            orderId: created.id,
            orderName: created.name,
            templateId: template.id
          }
        })
        broadcastOrdersChanged()
        response.status(201).json({ order: await readOrder(context.prisma, created.id) })
      })

      context.router.patch('/orders/:orderId', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const orderId = requireRouteParam(request.params.orderId, 'orderId')
        const parsed = orderUpdateSchema.safeParse(request.body)
        if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid order payload')

        const existing = await context.prisma.order.findUnique({ where: { id: orderId } })
        if (!existing) throw notFound('Order not found')

        await context.prisma.order.update({
          where: { id: existing.id },
          data: {
            name: parsed.data.name ?? undefined,
            notes: parsed.data.notes !== undefined ? normalizeNullableText(parsed.data.notes) : undefined,
            status: parsed.data.status ?? undefined,
            completedAt: parsed.data.status === undefined
              ? undefined
              : parsed.data.status === 'completed'
                ? (existing.completedAt ?? new Date())
                : null
          }
        })

        annotateRequestAuditLog(request, {
          action: 'update-order',
          resource: 'order',
          summary: `Updated order "${existing.name}".`,
          metadata: {
            orderId: existing.id,
            orderName: existing.name,
            ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {})
          }
        })
        broadcastOrdersChanged()
        response.json({ order: await readOrder(context.prisma, existing.id) })
      })

      context.router.delete('/orders/:orderId', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const orderId = requireRouteParam(request.params.orderId, 'orderId')
        const existing = await context.prisma.order.findUnique({ where: { id: orderId } })
        if (!existing) throw notFound('Order not found')

        await context.prisma.order.delete({ where: { id: existing.id } })
        annotateRequestAuditLog(request, {
          action: 'delete-order',
          resource: 'order',
          summary: `Deleted order "${existing.name}".`,
          metadata: {
            orderId: existing.id,
            orderName: existing.name
          }
        })
        broadcastOrdersChanged()
        response.status(204).end()
      })

      context.router.post('/orders/:orderId/prints/:printId/start', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const orderId = requireRouteParam(request.params.orderId, 'orderId')
        const printId = requireRouteParam(request.params.printId, 'printId')
        const parsed = startOrderPrintSchema.safeParse(request.body)
        if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid print payload')

        const order = await context.prisma.order.findUnique({ where: { id: orderId } })
        if (!order) throw notFound('Order not found')
        if (order.status === orderStatusSchema.enum.completed) {
          throw conflict('Completed orders cannot start new prints')
        }

        const target = await context.prisma.orderPrint.findFirst({
          where: {
            id: printId,
            orderId: order.id
          }
        })
        if (!target) throw notFound('Order print not found')

        const synced = await syncOrderPrintState(context.prisma, target.id)
        if (synced.status === 'completed') {
          throw conflict('This order print is already completed')
        }

        const activityState = deriveActivityState(synced)
        if (activityState === 'queued' || activityState === 'printing') {
          throw conflict('This order print is already in progress')
        }
        if (activityState === 'awaiting-confirmation') {
          throw conflict('Confirm the finished print before starting it again')
        }

        if (!synced.libraryFileId) throw notFound('The library file for this order print is no longer available')
        const libraryFile = await context.prisma.libraryFile.findUnique({ where: { id: synced.libraryFileId } })
        if (!libraryFile) throw notFound('The library file for this order print is no longer available')

        const tenantId = requireRequestTenantId(request)
        // Unsliced project 3MF items dispatch a sliced output produced by the
        // client's slice-then-print flow; the order item keeps referencing the
        // source 3MF. Sync-by-name still works because the started print is
        // recorded under the dispatched file's name below.
        const { slicedFileId, ...printInput } = parsed.data
        let dispatchFile = libraryFile
        if (slicedFileId) {
          const sliced = await context.prisma.libraryFile.findUnique({ where: { id: slicedFileId } })
          if (!sliced || sliced.tenantId !== tenantId) {
            throw notFound('The sliced file for this order print is no longer available')
          }
          if (!isDirectPrintableFileName(sliced.name)) {
            throw badRequest('The sliced file is not directly printable')
          }
          dispatchFile = sliced
        } else if (!isDirectPrintableFileName(libraryFile.name)) {
          throw badRequest('This order item is an unsliced 3MF. Slice it first, then start the print from the sliced output.')
        }

        const job = await services.enqueueLibraryPrint({
          fileId: dispatchFile.id,
          ...printInput
        }, tenantId)

        await context.prisma.orderPrint.update({
          where: { id: synced.id },
          data: {
            libraryFileName: dispatchFile.name,
            status: 'started',
            completionSource: null,
            attemptCount: { increment: 1 },
            startedPrinterId: parsed.data.printerId,
            startedAt: new Date(),
            lastPrintJobId: null,
            lastPrintResult: null,
            lastPrintFinishedAt: null,
            completedAt: null
          }
        })

        context.logger.info('Started order print', {
          orderId: order.id,
          orderPrintId: synced.id,
          printerId: parsed.data.printerId,
          jobId: job.printJobId
        })
        annotateRequestAuditLog(request, {
          action: 'start-order-print',
          resource: 'order print',
          summary: `Started an order print on ${job.printerName}.`,
          metadata: {
            orderId: order.id,
            orderPrintId: synced.id,
            printerId: parsed.data.printerId,
            // `jobId` links this audit row to the durable PrintJob/job activity.
            jobId: job.printJobId
          }
        })
        broadcastPrintDispatchChanged(tenantId)
        broadcastOrdersChanged(tenantId)
        response.status(202).json({
          job,
          order: await readOrder(context.prisma, order.id)
        })
      })

      context.router.post('/orders/:orderId/prints/:printId/confirm', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const orderId = requireRouteParam(request.params.orderId, 'orderId')
        const printId = requireRouteParam(request.params.printId, 'printId')
        const order = await context.prisma.order.findUnique({ where: { id: orderId } })
        if (!order) throw notFound('Order not found')

        const target = await context.prisma.orderPrint.findFirst({
          where: {
            id: printId,
            orderId: order.id
          }
        })
        if (!target) throw notFound('Order print not found')

        const synced = await syncOrderPrintState(context.prisma, target.id)
        if (synced.status === 'completed') {
          response.json({ order: await readOrder(context.prisma, order.id) })
          return
        }

        if (!synced.lastPrintJobId || synced.lastPrintResult !== 'success' || !synced.lastPrintFinishedAt) {
          throw conflict(confirmBlockMessage(deriveActivityState(synced)))
        }

        await context.prisma.orderPrint.update({
          where: { id: synced.id },
          data: {
            status: 'completed',
            completionSource: 'confirmed',
            completedAt: new Date()
          }
        })
        await syncOrderStatus(context.prisma, order.id)

        context.logger.info('Confirmed order print', {
          orderId: order.id,
          orderPrintId: synced.id,
          jobId: synced.lastPrintJobId
        })
        annotateRequestAuditLog(request, {
          action: 'confirm-order-print',
          resource: 'order print',
          summary: 'Confirmed a finished order print.',
          metadata: {
            orderId: order.id,
            orderPrintId: synced.id,
            jobId: synced.lastPrintJobId
          }
        })
        broadcastOrdersChanged()
        response.json({ order: await readOrder(context.prisma, order.id) })
      })

      context.router.post('/orders/:orderId/prints/:printId/manual-complete', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const orderId = requireRouteParam(request.params.orderId, 'orderId')
        const printId = requireRouteParam(request.params.printId, 'printId')
        const order = await context.prisma.order.findUnique({ where: { id: orderId } })
        if (!order) throw notFound('Order not found')

        const target = await context.prisma.orderPrint.findFirst({
          where: {
            id: printId,
            orderId: order.id
          }
        })
        if (!target) throw notFound('Order print not found')

        await context.prisma.orderPrint.update({
          where: { id: target.id },
          data: {
            status: 'completed',
            completionSource: 'manual',
            completedAt: new Date(),
            startedPrinterId: null,
            startedAt: null
          }
        })
        await syncOrderStatus(context.prisma, order.id)

        context.logger.info('Manually completed order print', {
          orderId: order.id,
          orderPrintId: target.id
        })
        annotateRequestAuditLog(request, {
          action: 'manually-complete-order-print',
          resource: 'order print',
          summary: 'Manually marked an order print as complete.',
          metadata: {
            orderId: order.id,
            orderPrintId: target.id
          }
        })
        broadcastOrdersChanged()
        response.json({ order: await readOrder(context.prisma, order.id) })
      })

      context.router.post('/orders/:orderId/prints/:printId/reopen', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
        const orderId = requireRouteParam(request.params.orderId, 'orderId')
        const printId = requireRouteParam(request.params.printId, 'printId')
        const order = await context.prisma.order.findUnique({ where: { id: orderId } })
        if (!order) throw notFound('Order not found')

        const target = await context.prisma.orderPrint.findFirst({
          where: {
            id: printId,
            orderId: order.id
          }
        })
        if (!target) throw notFound('Order print not found')

        const synced = await syncOrderPrintState(context.prisma, target.id)
        if (synced.status !== 'completed') {
          throw conflict('Only completed order prints can be unmarked')
        }

        await context.prisma.orderPrint.update({
          where: { id: synced.id },
          data: {
            status: 'pending',
            completionSource: null,
            completedAt: null,
            startedPrinterId: null,
            startedAt: null,
            lastPrintJobId: null,
            lastPrintResult: null,
            lastPrintFinishedAt: null
          }
        })

        await context.prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'active',
            completedAt: null
          }
        })

        context.logger.info('Reopened order print', {
          orderId: order.id,
          orderPrintId: synced.id
        })
        annotateRequestAuditLog(request, {
          action: 'reopen-order-print',
          resource: 'order print',
          summary: 'Reopened a completed order print.',
          metadata: {
            orderId: order.id,
            orderPrintId: synced.id
          }
        })
        broadcastOrdersChanged()
        response.json({ order: await readOrder(context.prisma, order.id) })
      })
    }
  }
}

export const ordersPlugin = createOrdersPlugin()

async function listTemplates(prismaClient: AnyPrismaClient): Promise<ReturnType<typeof toTemplateDto>[]> {
  const rows = await prismaClient.orderTemplate.findMany({
    orderBy: { createdAt: 'desc' },
    include: templateInclude
  })
  return rows.map(toTemplateDto)
}

async function listOrders(prismaClient: AnyPrismaClient): Promise<Array<Awaited<ReturnType<typeof readOrder>>>> {
  const started = await prismaClient.orderPrint.findMany({
    where: { status: 'started' },
    select: { id: true }
  })
  await Promise.all(started.map((row) => syncOrderPrintState(prismaClient, row.id)))

  const orders = await prismaClient.order.findMany({ orderBy: { createdAt: 'desc' } })
  return Promise.all(orders.map((order) => readOrder(prismaClient, order.id)))
}

async function readOrder(prismaClient: AnyPrismaClient, orderId: string) {
  const row = await prismaClient.order.findUnique({
    where: { id: orderId },
    include: orderInclude
  })
  if (!row) throw notFound('Order not found')
  return toOrderDto(row)
}

async function resolveTemplateVariant(
  prismaClient: AnyPrismaClient,
  deps: OrdersPluginDeps,
  variant: { name: string; items: Array<{ libraryFileId: string; plate: number; quantity: number; notes?: string | null }> },
  position: number,
  logger: PluginLogger
) {
  const items = await Promise.all(
    variant.items.map((item, itemPosition) => resolveTemplateItem(prismaClient, deps, item, itemPosition, logger))
  )

  return {
    name: variant.name.trim(),
    position,
    items
  }
}

function normalizeSelectedTemplateVariants(
  template: {
    variants: Array<{
      id: string
      name: string
      position: number
      items: Array<{
        id: string
        libraryFileId: string | null
        libraryFileName: string
        plate: number
        quantity: number
        notes: string | null
        position: number
      }>
    }>
  },
  selections: Array<{ variantId: string; quantity: number }> | undefined
) {
  if (template.variants.length === 0) {
    throw conflict('Order template has no variants')
  }

  if (!selections || selections.length === 0) {
    if (template.variants.length === 1) {
      const [onlyVariant] = template.variants
      if (!onlyVariant || onlyVariant.items.length === 0) {
        throw conflict('Order template has no required prints')
      }
      return [{ variant: onlyVariant, quantity: 1 }]
    }
    throw conflict('Choose at least one template variant')
  }

  const quantityByVariantId = new Map<string, number>()
  for (const selection of selections) {
    quantityByVariantId.set(selection.variantId, (quantityByVariantId.get(selection.variantId) ?? 0) + selection.quantity)
  }

  const selectedVariants = Array.from(quantityByVariantId.entries())
    .map(([variantId, quantity]) => {
      const variant = template.variants.find((entry) => entry.id === variantId)
      if (!variant) {
        throw badRequest('Order template variant not found')
      }
      if (variant.items.length === 0) {
        throw conflict(`Template variant "${variant.name}" has no required prints`)
      }
      return { variant, quantity }
    })
    .sort((left, right) => left.variant.position - right.variant.position)

  if (selectedVariants.length === 0) {
    throw conflict('Choose at least one template variant')
  }

  return selectedVariants
}

function buildOrderPrintsFromTemplateVariants(
  selectedVariants: Array<{
    variant: {
      id: string
      name: string
      items: Array<{
        id: string
        libraryFileId: string | null
        libraryFileName: string
        plate: number
        quantity: number
        notes: string | null
      }>
    }
    quantity: number
  }>,
  tenantId: string,
  printFilamentOverridesByTemplatePrintVariantCopyKey: ReadonlyMap<string, ThreeMfProjectFilament[]>
) {
  let groupPosition = 0

  return selectedVariants.flatMap(({ variant, quantity }) => (
    Array.from({ length: quantity }, (_unused, variantCopyIndex) => (
      variant.items.flatMap((item) => {
        const sequenceCount = item.quantity
        const itemGroupPosition = groupPosition
        groupPosition += 1
        const notes = normalizeNullableText(item.notes)

        return Array.from({ length: sequenceCount }, (_value, index) => ({
          tenantId,
          templatePrintId: item.id,
          templateVariantId: variant.id,
          templateVariantName: variant.name,
          projectFilamentOverrides: printFilamentOverridesByTemplatePrintVariantCopyKey.get(
            buildTemplatePrintVariantCopyKey(item.id, variantCopyIndex)
          ),
          libraryFileId: item.libraryFileId,
          libraryFileName: item.libraryFileName,
          plate: item.plate,
          notes,
          groupPosition: itemGroupPosition,
          sequenceNumber: index + 1,
          sequenceCount
        }))
      })
    ))
  )).flat()
}

function buildTemplatePrintFilamentOverrideMap(
  selectedVariants: Array<{
    variant: {
      id: string
      name: string
      items: Array<{
        id: string
      }>
    }
    quantity: number
  }>,
  overrides: Array<{
    templatePrintId: string
    variantCopyIndex: number
    projectFilaments: ThreeMfProjectFilament[]
  }> | undefined
): Map<string, ThreeMfProjectFilament[]> {
  const selectedTemplatePrintQuantities = new Map(
    selectedVariants.flatMap(({ variant, quantity }) => variant.items.map((item) => [item.id, quantity] as const))
  )

  const next = new Map<string, ThreeMfProjectFilament[]>()
  for (const override of overrides ?? []) {
    const selectedQuantity = selectedTemplatePrintQuantities.get(override.templatePrintId)
    if (selectedQuantity == null) {
      throw badRequest('Order print filament override target not found')
    }
    if (override.variantCopyIndex >= selectedQuantity) {
      throw badRequest('Order print filament override copy index is out of range')
    }
    const overrideKey = buildTemplatePrintVariantCopyKey(override.templatePrintId, override.variantCopyIndex)
    if (next.has(overrideKey)) {
      throw badRequest('Duplicate order print filament overrides are not allowed')
    }
    next.set(overrideKey, normalizeProjectFilaments(override.projectFilaments))
  }

  return next
}

function buildTemplatePrintVariantCopyKey(templatePrintId: string, variantCopyIndex: number): string {
  return `${templatePrintId}:${variantCopyIndex}`
}

async function resolveTemplateItem(
  prismaClient: AnyPrismaClient,
  deps: OrdersPluginDeps,
  item: { libraryFileId: string; plate: number; quantity: number; notes?: string | null },
  position: number,
  logger: PluginLogger
) {
  const file = await prismaClient.libraryFile.findUnique({
    where: { id: item.libraryFileId },
    select: {
      id: true,
      name: true,
      ownerBridgeId: true,
      storedPath: true
    }
  })
  if (!file) throw notFound('Library file not found')
  // Sliced gcode files print directly; plain project 3MFs are sliced when an
  // order print is started, so both are valid template items.
  const isThreeMf = file.name.toLowerCase().endsWith('.3mf')
  if (!isDirectPrintableFileName(file.name) && !isThreeMf) {
    throw badRequest('Only .gcode, .gcode.3mf, or .3mf library files can be used in order templates')
  }

  if (!isThreeMf && item.plate !== 1) {
    throw badRequest('Plain G-code files only support plate 1')
  }
  if (isThreeMf) {
    let inspectionFailed = false
    const index = await readTemplateItemIndex(file, deps).catch((error) => {
      // A failed 3MF inspection (bridge offline, unreadable file) is not the
      // same as the plate being absent; log it so the resulting "Plate N does
      // not exist" error is not misread as a genuinely missing plate.
      inspectionFailed = true
      logger.warn(`Could not inspect 3MF to validate plate for order template item`, {
        libraryFileId: file.id,
        plate: item.plate,
        error
      })
      return null
    })
    if (!index?.plates.some((plate) => plate.index === item.plate)) {
      throw badRequest(
        inspectionFailed
          ? `Could not read ${file.name} to verify plate ${item.plate}. The file may be unavailable or unreadable.`
          : `Plate ${item.plate} does not exist in ${file.name}`
      )
    }
  }

  return {
    libraryFileId: file.id,
    libraryFileName: file.name,
    plate: item.plate,
    quantity: item.quantity,
    notes: normalizeNullableText(item.notes),
    position
  }
}

async function readTemplateItemIndex(
  file: {
    ownerBridgeId?: string | null
    storedPath: string
  },
  deps: OrdersPluginDeps
): Promise<ThreeMfIndex> {
  if (file.ownerBridgeId) {
    return await deps.inspectBridgeLibraryThreeMf(file)
  }

  const resolvedPath = await deps.resolveLibraryFileToLocalPath(file)
  return await deps.readPlateIndex(resolvedPath)
}

async function syncOrderPrintState(prismaClient: AnyPrismaClient, orderPrintId: string) {
  const existing = await prismaClient.orderPrint.findUnique({ where: { id: orderPrintId } })
  if (!existing) throw notFound('Order print not found')
  if (existing.status !== 'started' || !existing.startedAt || !existing.startedPrinterId) return existing

  const latestJob = await prismaClient.printJob.findFirst({
    where: {
      printerId: existing.startedPrinterId,
      fileName: existing.libraryFileName,
      plate: existing.plate,
      startedAt: { gte: existing.startedAt }
    },
    orderBy: { startedAt: 'desc' }
  })

  if (!latestJob) {
    return existing
  }

  if (!latestJob.finishedAt) {
    if (existing.lastPrintJobId === latestJob.id && existing.lastPrintResult == null && existing.lastPrintFinishedAt == null) {
      return existing
    }
    return prismaClient.orderPrint.update({
      where: { id: existing.id },
      data: {
        lastPrintJobId: latestJob.id,
        lastPrintResult: null,
        lastPrintFinishedAt: null
      }
    })
  }

  if (latestJob.result === 'success') {
    if (
      existing.lastPrintJobId === latestJob.id
      && existing.lastPrintResult === 'success'
      && existing.lastPrintFinishedAt?.getTime() === latestJob.finishedAt.getTime()
    ) {
      return existing
    }
    return prismaClient.orderPrint.update({
      where: { id: existing.id },
      data: {
        lastPrintJobId: latestJob.id,
        lastPrintResult: 'success',
        lastPrintFinishedAt: latestJob.finishedAt
      }
    })
  }

  return prismaClient.orderPrint.update({
    where: { id: existing.id },
    data: {
      status: 'pending',
      startedPrinterId: null,
      startedAt: null,
      lastPrintJobId: latestJob.id,
      lastPrintResult: latestJob.result,
      lastPrintFinishedAt: latestJob.finishedAt
    }
  })
}

async function syncOrderStatus(prismaClient: AnyPrismaClient, orderId: string): Promise<void> {
  const [order, incompleteCount] = await Promise.all([
    prismaClient.order.findUnique({ where: { id: orderId }, select: { status: true, completedAt: true } }),
    prismaClient.orderPrint.count({
      where: {
        orderId,
        status: { not: 'completed' }
      }
    })
  ])
  if (!order) throw notFound('Order not found')
  if (incompleteCount > 0 || order.status === 'completed') return

  await prismaClient.order.update({
    where: { id: orderId },
    data: {
      status: 'completed',
      completedAt: order.completedAt ?? new Date()
    }
  })
}

function toTemplateDto(row: {
  id: string
  name: string
  code: string | null
  description: string | null
  notesTemplate: string | null
  createdAt: Date
  updatedAt: Date
  variants: Array<{
    id: string
    name: string
    position: number
    items: Array<{
      id: string
      libraryFileId: string | null
      libraryFileName: string
      plate: number
      quantity: number
      notes: string | null
      position: number
      libraryFile?: { id: string } | null
    }>
  }>
}) {
  const variants = row.variants.map((variant) => ({
    id: variant.id,
    name: variant.name,
    position: variant.position,
    items: variant.items.map((item) => ({
      id: item.id,
      libraryFileId: item.libraryFileId,
      libraryFileName: item.libraryFileName,
      plate: item.plate,
      quantity: item.quantity,
      notes: item.notes,
      position: item.position,
      fileAvailable: Boolean(item.libraryFileId && item.libraryFile)
    }))
  }))

  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    notesTemplate: row.notesTemplate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    variants,
    items: variants.flatMap((variant) => variant.items)
  }
}

function toOrderDto(row: {
  id: string
  templateId: string | null
  templateName: string
  templateCode: string | null
  templateDescription: string | null
  name: string
  notes: string | null
  status: string
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  selectedVariants: Array<{
    id: string
    templateVariantId: string | null
    templateVariantName: string
    quantity: number
    position: number
  }>
  prints: Array<{
    id: string
    templatePrintId: string | null
    templateVariantId: string | null
    templateVariantName: string | null
    projectFilamentOverrides: unknown | null
    libraryFileId: string | null
    libraryFileName: string
    plate: number
    notes: string | null
    groupPosition: number
    sequenceNumber: number
    sequenceCount: number
    status: string
    completionSource: string | null
    attemptCount: number
    startedAt: Date | null
    startedPrinterId: string | null
    lastPrintJobId: string | null
    lastPrintResult: string | null
    lastPrintFinishedAt: Date | null
    completedAt: Date | null
    libraryFile?: { id: string } | null
    startedPrinter?: { id: string; name: string } | null
  }>
}) {
  const prints = row.prints.map((print) => {
    const activityState = deriveActivityState(print)
    return {
      id: print.id,
      templatePrintId: print.templatePrintId,
      templateVariantId: print.templateVariantId,
      templateVariantName: print.templateVariantName,
      projectFilamentOverrides: parseStoredProjectFilaments(print.projectFilamentOverrides),
      libraryFileId: print.libraryFileId,
      libraryFileName: print.libraryFileName,
      plate: print.plate,
      notes: print.notes,
      groupPosition: print.groupPosition,
      sequenceNumber: print.sequenceNumber,
      sequenceCount: print.sequenceCount,
      status: print.status,
      activityState,
      completionSource: print.completionSource,
      attemptCount: print.attemptCount,
      startedAt: print.startedAt?.toISOString() ?? null,
      startedPrinterId: print.startedPrinterId,
      startedPrinterName: print.startedPrinter?.name ?? null,
      lastPrintJobId: print.lastPrintJobId,
      lastPrintResult: normalizePrintResult(print.lastPrintResult),
      lastPrintFinishedAt: print.lastPrintFinishedAt?.toISOString() ?? null,
      completedAt: print.completedAt?.toISOString() ?? null,
      fileAvailable: Boolean(print.libraryFileId && print.libraryFile)
    }
  })

  return {
    id: row.id,
    templateId: row.templateId,
    templateName: row.templateName,
    templateCode: row.templateCode,
    templateDescription: row.templateDescription,
    name: row.name,
    notes: row.notes,
    status: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    selectedVariants: row.selectedVariants.map((variant) => ({
      id: variant.id,
      templateVariantId: variant.templateVariantId,
      templateVariantName: variant.templateVariantName,
      quantity: variant.quantity,
      position: variant.position
    })),
    progress: {
      total: prints.length,
      completed: prints.filter((print) => print.status === 'completed').length,
      pending: prints.filter((print) => print.activityState === 'pending' || print.activityState === 'failed' || print.activityState === 'cancelled').length,
      active: prints.filter((print) => print.activityState === 'queued' || print.activityState === 'printing').length,
      awaitingConfirmation: prints.filter((print) => print.activityState === 'awaiting-confirmation').length
    },
    prints
  }
}

function deriveActivityState(print: {
  status: string
  lastPrintResult: string | null
  lastPrintFinishedAt: Date | null
  startedAt: Date | null
  startedPrinterId: string | null
  lastPrintJobId: string | null
}): OrderPrintActivityState {
  const result = normalizePrintResult(print.lastPrintResult)
  if (print.status === 'completed') return 'completed'
  if (print.status === 'started') {
    if (result === 'success' && print.lastPrintFinishedAt) return 'awaiting-confirmation'
    if (print.lastPrintJobId) return 'printing'
    return 'queued'
  }
  if (result === 'failed' && print.lastPrintFinishedAt) return 'failed'
  if (result === 'cancelled' && print.lastPrintFinishedAt) return 'cancelled'
  return 'pending'
}

function confirmBlockMessage(activityState: OrderPrintActivityState): string {
  switch (activityState) {
    case 'queued':
      return 'This print has been queued but has not started on the printer yet'
    case 'printing':
      return 'Wait for the print to finish before confirming it'
    case 'failed':
      return 'The last print attempt failed; start it again or mark it manually complete'
    case 'cancelled':
      return 'The last print attempt was cancelled; start it again or mark it manually complete'
    case 'pending':
      return 'Start this print from the order before confirming it'
    case 'completed':
      return 'This print is already completed'
    case 'awaiting-confirmation':
    default:
      return 'This print is not ready to be confirmed'
  }
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function normalizeProjectFilaments(projectFilaments: readonly ThreeMfProjectFilament[]): ThreeMfProjectFilament[] {
  return projectFilaments.map((filament) => ({
    id: filament.id,
    filamentType: normalizeNullableText(filament.filamentType),
    filamentName: normalizeNullableText(filament.filamentName),
    color: normalizeNullableText(filament.color),
    nozzleId: filament.nozzleId ?? null,
    chamberTemperature: filament.chamberTemperature ?? null
  }))
}

function parseStoredProjectFilaments(value: unknown): ThreeMfProjectFilament[] | null {
  if (!value) return null
  const parsed = threeMfProjectFilamentSchema.array().safeParse(value)
  if (!parsed.success) return null
  return normalizeProjectFilaments(parsed.data)
}

function requireTenantId(): string {
  const tenantId = getCurrentTenant()?.id
  if (tenantId) {
    return tenantId
  }

  throw badRequest('Tenant context is required.')
}

function normalizePrintResult(value: string | null): 'success' | 'failed' | 'cancelled' | null {
  return value === 'success' || value === 'failed' || value === 'cancelled' ? value : null
}