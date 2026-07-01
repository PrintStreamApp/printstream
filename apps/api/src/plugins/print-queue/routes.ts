/**
 * HTTP routes for the print-queue plugin, mounted at `/api/plugins/print-queue`.
 *
 * The shared backlog: list/add/edit/reorder/remove queued items, manual single and
 * "start all idle" dispatch (which never bypasses `enqueueLibraryPrint`, so print
 * guards and the dispatcher still run), manual re-queue of failures, and per-tenant
 * settings. Dispatch claims an item (`queued -> dispatching`) atomically before
 * enqueuing so concurrent bulk-starts can't hand the same item or printer two jobs.
 */
import {
  JOBS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION,
  evaluateQueueItemForPrinter,
  isPrinterActiveJobStage,
  queueDispatchSchema,
  queueItemCreateSchema,
  queueItemUpdateSchema,
  queuePrintOptionsSchema,
  queueReorderSchema,
  queueSettingsSchema,
  type PrintFromLibrary,
  type QueueDryRunResult,
  type QueueRequiredFilament
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'
import { enqueueLibraryPrint, validateLibraryPrint } from '../../lib/library-printing.js'
import { getPrintSourceKind } from '../../lib/print-dispatcher.js'
import { printerEvents } from '../../lib/printer-events.js'
import { printerManager } from '../../lib/printer-manager.js'
import type { AnyPrismaClient } from '../../lib/prisma.js'
import { requireRequestTenantId, requireRouteParam } from '../../lib/request-helpers.js'
import { broadcastPluginSettingsChanged, broadcastPrintDispatchChanged, broadcastQueueChanged } from '../../lib/ws-resource-events.js'
import type { ApiPluginContext } from '../../plugin/types.js'
import {
  buildOrderedPrinterContexts,
  loadQueueSettings,
  resolveDispatchTarget,
  saveQueueSettings,
  toMatchOptions,
  type DispatchTarget,
  type ServerPrinterContext
} from './eligibility.js'
import {
  inspectQueuePlate,
  mergeAmsMapping,
  parseAmsMapping,
  parsePrintOptions,
  parseRequiredFilaments,
  queueItemInclude,
  resolveQueueableLibraryFile,
  toQueueItemDto,
  toQueueItemPlacement,
  withUsedGramsFrom,
  type QueueItemRow
} from './store.js'

const DISPATCHABLE_STATUSES = new Set(['queued', 'failed'])
/** Statuses whose details can still be edited (i.e. before the print has started). */
const EDITABLE_STATUSES = new Set(['queued', 'held', 'failed'])

export function registerQueueRoutes(context: ApiPluginContext): void {
  const { router, prisma, settings, logger } = context

  router.get('/items', requireRequestPermission(JOBS_VIEW_PERMISSION), async (_request, response) => {
    response.json({ items: await listQueueItems(prisma) })
  })

  router.post('/items', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const parsed = queueItemCreateSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid queue item payload')
    const tenantId = requireRequestTenantId(request)

    // Resolves the file by id, keeping (un-hiding) a slice-to-queue output so it
    // persists past the unreferenced-slice cleanup; rejects recycled/non-printable files.
    const file = await resolveQueueableLibraryFile(prisma, parsed.data.libraryFileId)
    await assertTargetPrinter(prisma, parsed.data.target)

    const plate = await inspectQueuePlate(file, parsed.data.plate, logger)
    if (!plate.plateExists) throw badRequest(`Plate ${parsed.data.plate} does not exist in ${file.name}`)

    const options = queuePrintOptionsSchema.parse(parsed.data.options ?? {})
    // Explicit required-material overrides (general "any printer" mapping) win over what the plate reports
    // for identity, but per-filament grams always come from the slice (the override omits them).
    const requiredFilaments = withUsedGramsFrom(parsed.data.requiredFilaments ?? plate.requiredFilaments, plate.requiredFilaments)
    const sortKey = await nextSortKey(prisma)

    // An order-linked item maps 1:1 to a single order print, so it is always a single
    // copy (the quantity control is hidden for order items on the client).
    const orderLink = parsed.data.orderLink ?? null
    const created = await prisma.queueItem.create({
      data: {
        tenantId,
        libraryFileId: file.id,
        fileName: file.name,
        kind: getPrintSourceKind(file.name),
        plateIndex: parsed.data.plate,
        plateName: plate.plateName,
        quantity: orderLink ? 1 : parsed.data.quantity,
        sortKey,
        targetKind: parsed.data.target.kind,
        targetPrinterId: parsed.data.target.kind === 'printer' ? parsed.data.target.printerId ?? null : null,
        targetModel: parsed.data.target.kind === 'model' ? parsed.data.target.model ?? null : null,
        printOptionsJson: JSON.stringify(options),
        requiredFilamentsJson: JSON.stringify(requiredFilaments),
        compatibleModelsJson: JSON.stringify(plate.compatibleModels),
        plateType: plate.plateType,
        nozzleDiametersJson: JSON.stringify(plate.nozzleDiameters),
        amsMappingJson: parsed.data.amsMapping?.length ? JSON.stringify(parsed.data.amsMapping) : null,
        label: normalizeLabel(parsed.data.label),
        orderId: orderLink?.orderId ?? null,
        orderPrintId: orderLink?.orderPrintId ?? null,
        status: 'queued'
      },
      include: queueItemInclude
    })

    annotateRequestAuditLog(request, {
      action: 'queue-item-add',
      resource: 'queue item',
      summary: `Added "${created.fileName}" to the print queue.`,
      metadata: { queueItemId: created.id, libraryFileId: file.id, quantity: created.quantity }
    })
    // Mirror the queued state onto the order print (shows "queued", blocks a double start).
    if (orderLink) {
      context.printerEvents.emit('order-print.queued', { tenantId, orderPrintId: orderLink.orderPrintId })
    }
    broadcastQueueChanged(tenantId)
    response.status(201).json({ item: toQueueItemDto(created) })
  })

  router.patch('/items/:id', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const id = requireRouteParam(request.params.id, 'id')
    const parsed = queueItemUpdateSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid queue item payload')

    const existing = await prisma.queueItem.findUnique({ where: { id } })
    if (!existing) throw notFound('Queue item not found')
    if (!EDITABLE_STATUSES.has(existing.status)) {
      throw conflict('This queued item can no longer be edited because it has already started')
    }

    if (parsed.data.status === 'held' && existing.status !== 'queued') {
      throw conflict('Only a queued item can be held')
    }
    if (parsed.data.status === 'queued' && existing.status !== 'held') {
      throw conflict('Only a held item can be resumed')
    }
    if (parsed.data.target) await assertTargetPrinter(prisma, parsed.data.target)

    // A plate change re-inspects the 3MF to refresh the plate name and the default
    // required materials (unless the caller also sent an explicit material override).
    let plateIndex: number | undefined
    let plateName: string | null | undefined
    let inspectedRequiredFilaments: QueueRequiredFilament[] | undefined
    let inspectedCompatibleModels: string[] | undefined
    let inspectedPlateType: string | null | undefined
    let inspectedNozzleDiameters: string[] | undefined
    if (parsed.data.plate !== undefined && parsed.data.plate !== existing.plateIndex) {
      if (!existing.libraryFileId) throw notFound('The library file for this queued item is no longer available')
      const file = await prisma.libraryFile.findUnique({ where: { id: existing.libraryFileId } })
      if (!file) throw notFound('The library file for this queued item is no longer available')
      const plate = await inspectQueuePlate(file, parsed.data.plate, logger)
      if (!plate.plateExists) throw badRequest(`Plate ${parsed.data.plate} does not exist in ${file.name}`)
      plateIndex = parsed.data.plate
      plateName = plate.plateName
      inspectedRequiredFilaments = plate.requiredFilaments
      inspectedCompatibleModels = plate.compatibleModels
      inspectedPlateType = plate.plateType
      inspectedNozzleDiameters = plate.nozzleDiameters
    }

    // Grams come from the slice, not the user's identity override: source them from the freshly-inspected
    // plate (when the plate changed) or the prior stored row, matched by filament id.
    const gramsSource = inspectedRequiredFilaments ?? parseRequiredFilaments(existing.requiredFilamentsJson)
    const requiredFilamentsJson = parsed.data.requiredFilaments !== undefined
      ? JSON.stringify(withUsedGramsFrom(parsed.data.requiredFilaments, gramsSource))
      : inspectedRequiredFilaments !== undefined
        ? JSON.stringify(inspectedRequiredFilaments)
        : undefined
    const amsMappingJson = parsed.data.amsMapping === undefined
      ? undefined
      : parsed.data.amsMapping === null || parsed.data.amsMapping.length === 0
        ? null
        : JSON.stringify(parsed.data.amsMapping)

    await prisma.queueItem.update({
      where: { id: existing.id },
      data: {
        plateIndex,
        plateName,
        quantity: parsed.data.quantity ?? undefined,
        targetKind: parsed.data.target?.kind ?? undefined,
        targetPrinterId: parsed.data.target
          ? (parsed.data.target.kind === 'printer' ? parsed.data.target.printerId ?? null : null)
          : undefined,
        targetModel: parsed.data.target
          ? (parsed.data.target.kind === 'model' ? parsed.data.target.model ?? null : null)
          : undefined,
        printOptionsJson: parsed.data.options !== undefined ? JSON.stringify(parsed.data.options) : undefined,
        requiredFilamentsJson,
        compatibleModelsJson: inspectedCompatibleModels !== undefined ? JSON.stringify(inspectedCompatibleModels) : undefined,
        plateType: inspectedPlateType !== undefined ? inspectedPlateType : undefined,
        nozzleDiametersJson: inspectedNozzleDiameters !== undefined ? JSON.stringify(inspectedNozzleDiameters) : undefined,
        amsMappingJson,
        label: parsed.data.label !== undefined ? normalizeLabel(parsed.data.label) : undefined,
        status: parsed.data.status ?? undefined
      }
    })

    broadcastQueueChanged(requireRequestTenantId(request))
    response.json({ item: await readQueueItem(prisma, existing.id) })
  })

  router.post('/items/reorder', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const parsed = queueReorderSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid reorder payload')

    // updateMany is tenant-scoped (foreign/unknown ids no-op), so a fractional rank
    // is unnecessary — small backlogs renumber cheaply and unambiguously.
    await Promise.all(parsed.data.orderedIds.map((id, index) => (
      prisma.queueItem.updateMany({ where: { id }, data: { sortKey: index } })
    )))

    broadcastQueueChanged(requireRequestTenantId(request))
    response.json({ items: await listQueueItems(prisma) })
  })

  router.post('/items/:id/dispatch', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const id = requireRouteParam(request.params.id, 'id')
    const parsed = queueDispatchSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid dispatch payload')
    const tenantId = requireRequestTenantId(request)

    const item = await prisma.queueItem.findUnique({ where: { id }, include: queueItemInclude })
    if (!item) throw notFound('Queue item not found')
    assertDispatchable(item)

    const queueSettings = await loadQueueSettings(settings, tenantId)
    const contexts = await buildOrderedPrinterContexts(prisma, queueSettings)
    const target = resolveDispatchTarget(
      toQueueItemPlacement(item),
      contexts,
      toMatchOptions(queueSettings),
      parsed.data.printerId,
      parsed.data.amsMapping
    )

    // Dry run ("Check"): report what a real Start would do — without uploading or starting.
    if (parsed.data.dryRun) {
      response.json(await buildQueueDryRunResult(item, target, contexts, parsed.data.amsMapping, tenantId))
      return
    }

    if (!target.ok) throw conflict(target.reason)

    // An explicit mapping is the user's per-start material choice and wins outright; the auto path still
    // merges the item's stored slot overrides with the matcher's result.
    const job = await applyDispatch(prisma, item, target.printerId, target.amsMapping, tenantId, parsed.data.amsMapping)

    annotateRequestAuditLog(request, {
      action: 'queue-item-dispatch',
      resource: 'queue item',
      summary: `Dispatched a queued print to ${job.printerName}.`,
      metadata: { queueItemId: item.id, printerId: target.printerId, jobId: job.printJobId }
    })
    broadcastQueueChanged(tenantId)
    broadcastPrintDispatchChanged(tenantId)
    response.status(202).json({ item: await readQueueItem(prisma, item.id), job })
  })

  router.post('/items/dispatch-all', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const tenantId = requireRequestTenantId(request)
    const queueSettings = await loadQueueSettings(settings, tenantId)
    const matchOptions = toMatchOptions(queueSettings)
    const contexts = await buildOrderedPrinterContexts(prisma, queueSettings)
    const idleContexts = contexts.filter((entry) => entry.status.online && !isPrinterActiveJobStage(entry.status.stage))

    const queuedItems = await prisma.queueItem.findMany({
      where: { status: 'queued' },
      orderBy: [{ sortKey: 'asc' }, { createdAt: 'asc' }],
      include: queueItemInclude
    })

    const claimed = new Set<string>()
    const dispatched: Array<{ itemId: string; printerId: string; jobId: string }> = []

    for (const printer of idleContexts) {
      for (const item of queuedItems) {
        if (claimed.has(item.id)) continue
        const evaluation = evaluateQueueItemForPrinter(toQueueItemPlacement(item), printer, matchOptions)
        if (!evaluation.eligible || !evaluation.idle) continue

        // Atomic claim: only the bulk-start that flips queued -> dispatching proceeds.
        const claimResult = await prisma.queueItem.updateMany({ where: { id: item.id, status: 'queued' }, data: { status: 'dispatching' } })
        claimed.add(item.id)
        if (claimResult.count !== 1) break

        try {
          const job = await applyDispatch(prisma, item, printer.printerId, evaluation.amsMapping, tenantId)
          dispatched.push({ itemId: item.id, printerId: printer.printerId, jobId: job.printJobId })
        } catch (error) {
          await prisma.queueItem.updateMany({ where: { id: item.id, status: 'dispatching' }, data: { status: 'queued' } }).catch(() => undefined)
          logger.warn('Queue auto-dispatch failed for item', { queueItemId: item.id, printerId: printer.printerId, error })
        }
        break
      }
    }

    if (dispatched.length > 0) {
      annotateRequestAuditLog(request, {
        action: 'queue-dispatch-all',
        resource: 'queue',
        summary: `Started ${dispatched.length} queued print${dispatched.length === 1 ? '' : 's'} across idle printers.`,
        metadata: { dispatchedCount: dispatched.length }
      })
      broadcastQueueChanged(tenantId)
      broadcastPrintDispatchChanged(tenantId)
    }
    response.json({ dispatched, items: await listQueueItems(prisma) })
  })

  router.post('/items/:id/requeue', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const id = requireRouteParam(request.params.id, 'id')
    const existing = await prisma.queueItem.findUnique({ where: { id } })
    if (!existing) throw notFound('Queue item not found')
    if (existing.status !== 'failed') throw conflict('Only a failed item can be re-queued')

    await prisma.queueItem.update({
      where: { id: existing.id },
      data: { status: 'queued', lastPrintJobId: null, lastDispatchJobId: null }
    })
    broadcastQueueChanged(requireRequestTenantId(request))
    response.json({ item: await readQueueItem(prisma, existing.id) })
  })

  router.delete('/items/:id', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const id = requireRouteParam(request.params.id, 'id')
    const existing = await prisma.queueItem.findUnique({ where: { id } })
    if (!existing) throw notFound('Queue item not found')

    await prisma.queueItem.delete({ where: { id: existing.id } })
    annotateRequestAuditLog(request, {
      action: 'queue-item-remove',
      resource: 'queue item',
      summary: `Removed "${existing.fileName}" from the print queue.`,
      metadata: { queueItemId: existing.id }
    })
    // Removing a still-queued order item releases its order print back to pending.
    // (A dispatched/printing/done item has already advanced the order — leave it.)
    if (existing.orderPrintId && (existing.status === 'queued' || existing.status === 'held')) {
      printerEvents.emit('order-print.unqueued', {
        tenantId: requireRequestTenantId(request),
        orderPrintId: existing.orderPrintId
      })
    }
    broadcastQueueChanged(requireRequestTenantId(request))
    response.status(204).end()
  })

  router.get('/settings', requireRequestPermission(JOBS_VIEW_PERMISSION), async (request, response) => {
    response.json({ settings: await loadQueueSettings(settings, requireRequestTenantId(request)) })
  })

  router.put('/settings', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const parsed = queueSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid settings payload')
    const tenantId = requireRequestTenantId(request)
    await saveQueueSettings(settings, tenantId, parsed.data)
    broadcastPluginSettingsChanged(context.pluginName, tenantId)
    response.json({ settings: parsed.data })
  })
}

async function listQueueItems(prisma: AnyPrismaClient) {
  const rows = await prisma.queueItem.findMany({
    orderBy: [{ sortKey: 'asc' }, { createdAt: 'asc' }],
    include: queueItemInclude
  })
  return rows.map(toQueueItemDto)
}

async function readQueueItem(prisma: AnyPrismaClient, id: string) {
  const row = await prisma.queueItem.findUnique({ where: { id }, include: queueItemInclude })
  if (!row) throw notFound('Queue item not found')
  return toQueueItemDto(row)
}

async function nextSortKey(prisma: AnyPrismaClient): Promise<number> {
  const last = await prisma.queueItem.findFirst({ orderBy: { sortKey: 'desc' }, select: { sortKey: true } })
  return (last?.sortKey ?? 0) + 1
}

function assertDispatchable(item: QueueItemRow): void {
  if (DISPATCHABLE_STATUSES.has(item.status)) return
  if (item.status === 'held') throw conflict('Resume this item before dispatching it')
  if (item.status === 'done') throw conflict('This queued item is already complete')
  throw conflict('This queued item is already in progress')
}

/**
 * Enqueue a queued item to a printer through the shared library-print path and record
 * the dispatch linkage used for completion reconciliation. When not pre-claimed, the
 * status is flipped to `dispatching` here; on a pre-claimed bulk dispatch the row is
 * already `dispatching`.
 */
async function applyDispatch(
  prisma: AnyPrismaClient,
  item: QueueItemRow,
  printerId: string,
  computedAmsMapping: number[] | null,
  tenantId: string,
  explicitAmsMapping?: number[]
) {
  if (!item.libraryFileId) throw notFound('The library file for this queued item is no longer available')

  // A per-start manual override is used verbatim (the user picked every slot). Otherwise: explicit
  // stored slot choices win per filament; -1 "auto" entries (material-mode filaments pinned to a
  // library / custom material) resolve from the matcher's computed mapping for this printer.
  const amsMapping = explicitAmsMapping ?? mergeAmsMapping(parseAmsMapping(item.amsMappingJson), computedAmsMapping ?? undefined)

  const job = await enqueueLibraryPrint(buildQueueDispatchInput(item, item.libraryFileId, printerId, amsMapping), tenantId)

  await prisma.queueItem.update({
    where: { id: item.id },
    data: {
      status: 'dispatching',
      lastPrinterId: printerId,
      lastDispatchJobId: job.id,
      lastPrintJobId: job.printJobId,
      lastJobName: job.jobName,
      lastDispatchedAt: new Date(),
      lastResult: null,
      lastFinishedAt: null
    }
  })
  // Record the dispatch against the linked order print (the orders plugin listens);
  // it marks the print started so its existing PrintJob poll-sync tracks the result.
  if (item.orderPrintId) {
    printerEvents.emit('order-print.dispatched', {
      tenantId,
      orderPrintId: item.orderPrintId,
      printerId,
      fileName: item.fileName,
      plate: item.plateIndex
    })
  }
  return job
}

/**
 * Build a dry-run ("Check") result: report whether a real Start would succeed and, if not, the first
 * failure — placement (no idle/eligible printer) or, via {@link validateLibraryPrint}, a resolved-but-
 * broken file ("File not found" / "File missing on bridge"), an offline printer, a print guard, or a
 * plate/filament incompatibility. Nothing is uploaded, started, or claimed.
 */
async function buildQueueDryRunResult(
  item: QueueItemRow,
  target: DispatchTarget,
  contexts: ServerPrinterContext[],
  explicitAmsMapping: number[] | undefined,
  tenantId: string
): Promise<QueueDryRunResult> {
  if (!item.libraryFileId) {
    return { ok: false, reason: 'The library file for this queued item is no longer available', printerId: null, printerName: null }
  }
  if (!target.ok) {
    return { ok: false, reason: target.reason, printerId: null, printerName: null }
  }
  const printerName = contexts.find((ctx) => ctx.printerId === target.printerId)?.name ?? null
  const amsMapping = explicitAmsMapping ?? mergeAmsMapping(parseAmsMapping(item.amsMappingJson), target.amsMapping ?? undefined)
  const input = buildQueueDispatchInput(item, item.libraryFileId, target.printerId, amsMapping)
  try {
    await validateLibraryPrint(input, tenantId)
    return { ok: true, reason: null, printerId: target.printerId, printerName }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'A real Start would fail', printerId: target.printerId, printerName }
  }
}

/**
 * Build the `PrintFromLibrary` input for a queued dispatch. The queue resolves the printer at dispatch
 * time, so the **printer-specific** plate type + nozzle diameters come from the resolved printer — not the
 * create-time options, which had no printer (a null plate type made the compatibility check throw a false
 * "choose the printer's current plate type" mismatch). Nozzle already falls back to the live status; we
 * still pass the configured value for parity with the print dialog.
 */
function buildQueueDispatchInput(
  item: QueueItemRow,
  libraryFileId: string,
  printerId: string,
  amsMapping: number[] | undefined
): PrintFromLibrary {
  const printer = printerManager.getPrinter(printerId)
  return {
    ...parsePrintOptions(item.printOptionsJson),
    fileId: libraryFileId,
    printerId,
    plate: item.plateIndex,
    amsMapping,
    currentPlateType: printer?.currentPlateType ?? null,
    currentNozzleDiameters: printer?.currentNozzleDiameters ?? []
  }
}

async function assertTargetPrinter(prisma: AnyPrismaClient, target: { kind: string; printerId?: string | null }): Promise<void> {
  if (target.kind !== 'printer' || !target.printerId) return
  const printer = await prisma.printer.findFirst({ where: { id: target.printerId }, select: { id: true } })
  if (!printer) throw badRequest('Pinned printer not found')
}

function normalizeLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}
