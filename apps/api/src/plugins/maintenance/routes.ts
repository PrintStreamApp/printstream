/**
 * HTTP routes for the maintenance plugin, mounted at `/api/plugins/maintenance`.
 *
 * Reads use `printers.view`; mutations use `printers.manage` rather than
 * `printers.control`: logging a service or retiming an interval administers the
 * printer record and sends nothing to the machine.
 *
 * Handlers stay thin: data access is in `store.ts`, the catalog/override merge in
 * `resolve.ts`, and the interval arithmetic in `@printstream/shared`. The one
 * thing every handler does itself is resolve `printerId -> printerSerial`, since
 * maintenance rows are keyed by the physical machine (see the model docs) while
 * the client addresses printers by id.
 *
 * Counterpart: `apps/web/src/plugins/maintenance/api.ts`.
 */
import {
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION,
  isCustomMaintenanceTaskKey,
  maintenanceCompleteRequestSchema,
  maintenanceCustomTaskRequestSchema,
  maintenanceTaskPatchRequestSchema,
  resolveMaintenanceSchedule,
  type MaintenanceHistoryResponse,
  type MaintenancePrinterResponse,
  type MaintenanceSummaryResponse
} from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest, notFound } from '../../lib/http-error.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../../lib/request-helpers.js'
import { printerManager } from '../../lib/printer-manager.js'
import { resolvePrinterTasks } from './resolve.js'
import {
  completionsForPrinter,
  createCustomTask,
  deleteCustomTask,
  listLatestCompletions,
  listTaskHistory,
  listTaskRows,
  recordCompletion,
  resetTaskOverride,
  upsertTaskOverride
} from './store.js'
import { EMPTY_PRINTER_USAGE, readPrinterUsageBySerial } from './usage.js'

/** How many past completions the history endpoint returns. */
const HISTORY_LIMIT = 20

/** Canonical HMS codes the printer is currently reporting, or none when offline. */
function activeHmsCodes(printerId: string): string[] {
  return (printerManager.getStatus(printerId)?.hmsErrors ?? []).map((entry) => entry.code)
}

function actingUserId(request: { auth: { actor: { type: string; userId?: string } } }): string | null {
  return request.auth.actor.type === 'user' ? request.auth.actor.userId ?? null : null
}

export function registerMaintenanceRoutes(context: ApiPluginContext): void {
  const { router, prisma } = context

  async function requirePrinter(printerId: string) {
    const printer = await prisma.printer.findFirst({
      where: { id: printerId },
      select: { id: true, name: true, serial: true, model: true }
    })
    if (!printer) throw notFound('Printer not found')
    return printer
  }

  /** Roll-up for the printers grid: every printer in one request, not one per card. */
  router.get('/summary', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const printers = await prisma.printer.findMany({ select: { id: true, serial: true, model: true } })
    const serials = printers.map((printer) => printer.serial)
    const [taskRows, completions, usageBySerial] = await Promise.all([
      listTaskRows(prisma, serials),
      listLatestCompletions(prisma, serials),
      readPrinterUsageBySerial(prisma, serials)
    ])
    const now = new Date()

    const body: MaintenanceSummaryResponse = {
      printers: printers.map((printer) => {
        const { tasks } = resolvePrinterTasks({
          printerModel: printer.model,
          overrides: taskRows.filter((row) => row.printerSerial === printer.serial),
          completions: completionsForPrinter(completions, printer.serial),
          usage: usageBySerial.get(printer.serial) ?? EMPTY_PRINTER_USAGE,
          activeHmsCodes: activeHmsCodes(printer.id),
          now
        })
        return {
          printerId: printer.id,
          dueCount: tasks.filter((task) => task.status === 'due').length,
          dueSoonCount: tasks.filter((task) => task.status === 'due-soon').length,
          printerRequested: tasks.some((task) => task.printerRequested && !task.disabled)
        }
      })
    }
    response.json(body)
  })

  router.get('/printers/:printerId', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const printer = await requirePrinter(requireRouteParam(request.params.printerId, 'Printer id'))
    const [taskRows, completions, usageBySerial] = await Promise.all([
      listTaskRows(prisma, [printer.serial]),
      listLatestCompletions(prisma, [printer.serial]),
      readPrinterUsageBySerial(prisma, [printer.serial])
    ])
    const usage = usageBySerial.get(printer.serial) ?? EMPTY_PRINTER_USAGE

    const { schedule, tasks } = resolvePrinterTasks({
      printerModel: printer.model,
      overrides: taskRows,
      completions: completionsForPrinter(completions, printer.serial),
      usage,
      activeHmsCodes: activeHmsCodes(printer.id),
      now: new Date()
    })

    const body: MaintenancePrinterResponse = {
      printerId: printer.id,
      printerName: printer.name,
      printerModel: printer.model,
      schedule: {
        id: schedule.id,
        label: schedule.label,
        wikiUrl: schedule.wikiUrl,
        generic: schedule.generic === true
      },
      usage,
      tasks
    }
    response.json(body)
  })

  router.get('/printers/:printerId/tasks/:taskKey/history', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const printer = await requirePrinter(requireRouteParam(request.params.printerId, 'Printer id'))
    const taskKey = requireRouteParam(request.params.taskKey, 'Task key')
    const rows = await listTaskHistory(prisma, printer.serial, taskKey, HISTORY_LIMIT)

    const body: MaintenanceHistoryResponse = {
      entries: rows.map((row) => ({
        id: row.id,
        completedAt: row.completedAt.toISOString(),
        printHours: row.printHours == null ? null : Number(row.printHours),
        filamentKilograms: row.filamentKilograms == null ? null : Number(row.filamentKilograms),
        note: row.note,
        performedBy: row.performedByUserId
      }))
    }
    response.json(body)
  })

  router.post('/printers/:printerId/tasks/:taskKey/complete', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
    const parsed = maintenanceCompleteRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid maintenance completion')

    const workspaceId = requireRequestWorkspaceId(request)
    const printer = await requirePrinter(requireRouteParam(request.params.printerId, 'Printer id'))
    const taskKey = requireRouteParam(request.params.taskKey, 'Task key')
    assertKnownTask(printer.model, taskKey, await listTaskRows(prisma, [printer.serial]))

    const usageBySerial = await readPrinterUsageBySerial(prisma, [printer.serial])
    const usage = usageBySerial.get(printer.serial) ?? EMPTY_PRINTER_USAGE

    // Snapshot the counters as they read NOW, not at read time later: the next due
    // date is measured from this row, so a subsequent manual stats adjustment must
    // not retroactively move it.
    await recordCompletion(prisma, {
      workspaceId,
      printerSerial: printer.serial,
      taskKey,
      completedAt: parsed.data.completedAt ? new Date(parsed.data.completedAt) : new Date(),
      printHours: usage.printHours,
      filamentKilograms: usage.filamentKilograms,
      performedByUserId: actingUserId(request),
      note: parsed.data.note ?? null
    })

    annotateRequestAuditLog(request, {
      action: 'log-printer-maintenance',
      resource: 'printer maintenance',
      summary: `Logged maintenance "${taskKey}" on ${printer.name}.`,
      metadata: { printerId: printer.id, taskKey }
    })
    response.status(204).end()
  })

  router.patch('/printers/:printerId/tasks/:taskKey', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
    const parsed = maintenanceTaskPatchRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid maintenance task update')

    const workspaceId = requireRequestWorkspaceId(request)
    const printer = await requirePrinter(requireRouteParam(request.params.printerId, 'Printer id'))
    const taskKey = requireRouteParam(request.params.taskKey, 'Task key')
    const existing = await listTaskRows(prisma, [printer.serial])
    assertKnownTask(printer.model, taskKey, existing)

    if (!isCustomMaintenanceTaskKey(taskKey) && (parsed.data.title !== undefined || parsed.data.lubricant !== undefined)) {
      // The catalog owns the wording for its own tasks; letting a workspace retitle
      // one would make the same job read differently on two printers.
      throw badRequest('Only custom maintenance tasks can be retitled')
    }

    await upsertTaskOverride(prisma, { workspaceId, printerSerial: printer.serial, taskKey, patch: parsed.data })
    annotateRequestAuditLog(request, {
      action: 'update-printer-maintenance-task',
      resource: 'printer maintenance',
      summary: `Updated maintenance task "${taskKey}" on ${printer.name}.`,
      metadata: { printerId: printer.id, taskKey }
    })
    response.status(204).end()
  })

  /** Drop a catalog task's customization, returning it to the catalog defaults. */
  router.post('/printers/:printerId/tasks/:taskKey/reset', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
    const printer = await requirePrinter(requireRouteParam(request.params.printerId, 'Printer id'))
    const taskKey = requireRouteParam(request.params.taskKey, 'Task key')
    if (isCustomMaintenanceTaskKey(taskKey)) throw badRequest('A custom task has no catalog defaults to reset to')

    await resetTaskOverride(prisma, { printerSerial: printer.serial, taskKey })
    annotateRequestAuditLog(request, {
      action: 'reset-printer-maintenance-task',
      resource: 'printer maintenance',
      summary: `Reset maintenance task "${taskKey}" to its recommended interval on ${printer.name}.`,
      metadata: { printerId: printer.id, taskKey }
    })
    response.status(204).end()
  })

  router.post('/printers/:printerId/tasks', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
    const parsed = maintenanceCustomTaskRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid maintenance task')

    const workspaceId = requireRequestWorkspaceId(request)
    const printer = await requirePrinter(requireRouteParam(request.params.printerId, 'Printer id'))
    const created = await createCustomTask(prisma, { workspaceId, printerSerial: printer.serial, request: parsed.data })

    annotateRequestAuditLog(request, {
      action: 'create-printer-maintenance-task',
      resource: 'printer maintenance',
      summary: `Added maintenance task "${parsed.data.title}" to ${printer.name}.`,
      metadata: { printerId: printer.id, taskKey: created.taskKey }
    })
    response.status(201).json({ taskKey: created.taskKey })
  })

  router.delete('/printers/:printerId/tasks/:taskKey', requireRequestPermission(PRINTERS_MANAGE_PERMISSION), async (request, response) => {
    const printer = await requirePrinter(requireRouteParam(request.params.printerId, 'Printer id'))
    const taskKey = requireRouteParam(request.params.taskKey, 'Task key')
    if (!isCustomMaintenanceTaskKey(taskKey)) {
      // Deleting a catalog task is meaningless: the next read re-supplies it from
      // the catalog. Switching it off is the supported way to silence one.
      throw badRequest('Catalog maintenance tasks cannot be deleted; disable the task instead')
    }

    await deleteCustomTask(prisma, { printerSerial: printer.serial, taskKey })
    annotateRequestAuditLog(request, {
      action: 'delete-printer-maintenance-task',
      resource: 'printer maintenance',
      summary: `Removed maintenance task "${taskKey}" from ${printer.name}.`,
      metadata: { printerId: printer.id, taskKey }
    })
    response.status(204).end()
  })
}

/**
 * Reject a task key that is neither in this printer's catalog schedule nor an
 * existing custom row, so a typo cannot create orphan history that no view can
 * ever show.
 */
function assertKnownTask(
  printerModel: string | null,
  taskKey: string,
  existingRows: Array<{ taskKey: string }>
): void {
  if (existingRows.some((row) => row.taskKey === taskKey)) return
  if (isCustomMaintenanceTaskKey(taskKey)) throw notFound('Maintenance task not found')
  const schedule = resolveMaintenanceSchedule(printerModel)
  if (!schedule.tasks.some((task) => task.key === taskKey)) throw notFound('Maintenance task not found')
}
