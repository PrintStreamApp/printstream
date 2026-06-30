/**
 * Server-side eligibility + dispatch-target resolution for the print-queue plugin.
 *
 * The actual material matching is the shared pure matcher; this module only assembles
 * its inputs from live server state: the tenant's connected printers (with model +
 * least-recently-used ordering for load-balancing) and the per-tenant queue settings,
 * then resolves which idle printer a manual dispatch should target and the AMS tray
 * mapping to send.
 */
import {
  evaluateQueueItemForPrinter,
  evaluateQueuePlacementConstraints,
  summarizeQueueItemEligibility,
  queueSettingsSchema,
  type QueueItemPlacement,
  type QueueMatchOptions,
  type QueuePrinterContext,
  type QueueSettings
} from '@printstream/shared'
import { printerManager } from '../../lib/printer-manager.js'
import type { TenantScopedPrismaClient } from '../../lib/prisma.js'
import type { PluginSettingStore } from '../../plugin/types.js'

const SETTINGS_KEY = 'settings'

export interface ServerPrinterContext extends QueuePrinterContext {
  name: string
}

export async function loadQueueSettings(settings: PluginSettingStore, tenantId: string): Promise<QueueSettings> {
  const raw = await settings.forTenant(tenantId).get(SETTINGS_KEY)
  if (!raw) return queueSettingsSchema.parse({})
  try {
    return queueSettingsSchema.parse(JSON.parse(raw))
  } catch {
    return queueSettingsSchema.parse({})
  }
}

export async function saveQueueSettings(settings: PluginSettingStore, tenantId: string, value: QueueSettings): Promise<void> {
  await settings.forTenant(tenantId).set(SETTINGS_KEY, JSON.stringify(value))
}

export function toMatchOptions(settings: QueueSettings): QueueMatchOptions {
  return { allowTypeOnlyMatch: settings.allowTypeOnlyMatch }
}

/**
 * Build the live printer contexts for the current tenant, ordered to express the
 * configured load-balancing: `idle-lru` puts the least-recently-finished printer
 * first (so work spreads across the fleet), `sort-order` keeps the dashboard order.
 * Only printers with a live status snapshot (connected) are included.
 */
export async function buildOrderedPrinterContexts(
  prisma: TenantScopedPrismaClient,
  settings: QueueSettings
): Promise<ServerPrinterContext[]> {
  const printers = await prisma.printer.findMany({
    select: { id: true, name: true, model: true, position: true },
    orderBy: { position: 'asc' }
  })

  const contexts: ServerPrinterContext[] = []
  for (const printer of printers) {
    const status = printerManager.getStatus(printer.id)
    if (!status) continue
    contexts.push({ printerId: printer.id, name: printer.name, model: printer.model, status })
  }

  if (settings.loadBalance === 'sort-order') return contexts

  const lastFinishedByPrinter = await readLastFinishedByPrinter(prisma, contexts.map((entry) => entry.printerId))
  return contexts.sort((left, right) => {
    const leftMs = lastFinishedByPrinter.get(left.printerId) ?? 0
    const rightMs = lastFinishedByPrinter.get(right.printerId) ?? 0
    return leftMs - rightMs
  })
}

async function readLastFinishedByPrinter(prisma: TenantScopedPrismaClient, printerIds: string[]): Promise<Map<string, number>> {
  if (printerIds.length === 0) return new Map()
  const rows = await prisma.printJob.groupBy({
    by: ['printerId'],
    where: { printerId: { in: printerIds }, finishedAt: { not: null } },
    _max: { finishedAt: true }
  })
  const result = new Map<string, number>()
  for (const row of rows) {
    if (row._max.finishedAt) result.set(row.printerId, row._max.finishedAt.getTime())
  }
  return result
}

export type DispatchTarget =
  | { ok: true; printerId: string; amsMapping: number[] | null }
  | { ok: false; reason: string }

/**
 * Resolve which connected, idle printer a manual dispatch should target and the AMS
 * mapping to send. With an explicit printer the request honours it (and surfaces why
 * it can't run there); otherwise it recommends the first idle eligible printer in the
 * load-balanced order.
 *
 * When `explicitAmsMapping` is supplied (the single-item "redo the materials" override), the
 * automatic material match is skipped — the user chose the slots — and only placement is validated
 * (printer connected, target/model/sliced-model fit, idle). The given mapping is returned verbatim.
 */
export function resolveDispatchTarget(
  placement: QueueItemPlacement,
  contexts: ServerPrinterContext[],
  options: QueueMatchOptions,
  explicitPrinterId?: string,
  explicitAmsMapping?: number[]
): DispatchTarget {
  if (explicitAmsMapping) {
    if (!explicitPrinterId) return { ok: false, reason: 'Choose a printer to start this item' }
    const context = contexts.find((entry) => entry.printerId === explicitPrinterId)
    if (!context) return { ok: false, reason: 'That printer is not connected' }
    const constraints = evaluateQueuePlacementConstraints(placement, context)
    if (!constraints.eligible) return { ok: false, reason: constraints.reason ?? 'That printer cannot run this item' }
    if (!constraints.idle) return { ok: false, reason: `${context.name} is busy` }
    return { ok: true, printerId: context.printerId, amsMapping: explicitAmsMapping }
  }

  if (explicitPrinterId) {
    const context = contexts.find((entry) => entry.printerId === explicitPrinterId)
    if (!context) return { ok: false, reason: 'That printer is not connected' }
    const evaluation = evaluateQueueItemForPrinter(placement, context, options)
    if (!evaluation.eligible) return { ok: false, reason: evaluation.reason ?? 'That printer cannot run this item' }
    if (!evaluation.idle) return { ok: false, reason: `${context.name} is busy` }
    return { ok: true, printerId: context.printerId, amsMapping: evaluation.amsMapping }
  }

  const summary = summarizeQueueItemEligibility(placement, contexts, options)
  if (!summary.recommendedPrinterId) {
    return { ok: false, reason: summary.blockedReason ?? 'No connected printer can run this item' }
  }
  const recommended = contexts.find((entry) => entry.printerId === summary.recommendedPrinterId)
  if (!recommended) return { ok: false, reason: 'No connected printer can run this item' }
  const evaluation = evaluateQueueItemForPrinter(placement, recommended, options)
  if (!evaluation.idle) {
    return { ok: false, reason: summary.waitingForFreePrinter ? 'All matching printers are busy' : 'No idle printer can run this item' }
  }
  return { ok: true, printerId: recommended.printerId, amsMapping: evaluation.amsMapping }
}
