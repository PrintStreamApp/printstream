/**
 * Data access for the maintenance plugin: the per-printer customization rows and
 * the completion log.
 *
 * Owns the rule that a `PrinterMaintenanceTask` row exists ONLY when the user has
 * changed something — {@link upsertTaskOverride} writes one on demand, and every
 * read tolerates its absence. That is what lets a catalog interval change reach
 * existing installs instead of being frozen at whatever was copied in at setup.
 *
 * Everything here is keyed by `printerSerial` (see the model docs): maintenance
 * belongs to the physical machine, so removing and re-adding a printer keeps its
 * history. Callers resolve `printerId -> serial` once, at the route boundary.
 */
import { CUSTOM_MAINTENANCE_TASK_PREFIX, type MaintenanceCustomTaskRequest, type MaintenanceTaskPatchRequest } from '@printstream/shared'
import { randomUUID } from 'node:crypto'
import type { WorkspaceScopedPrismaClient } from '../../lib/prisma.js'

export type MaintenanceTaskRow = {
  id: string
  printerSerial: string
  taskKey: string
  customTitle: string | null
  customLubricant: string | null
  intervalDays: number | null
  intervalPrintHours: number | null
  intervalFilamentKilograms: unknown
  intervalsCleared: string[]
  disabledAt: Date | null
}

export type MaintenanceLogRow = {
  id: string
  printerSerial: string
  taskKey: string
  completedAt: Date
  printHours: unknown
  filamentKilograms: unknown
  note: string | null
  performedByUserId: string | null
}

const TASK_SELECT = {
  id: true,
  printerSerial: true,
  taskKey: true,
  customTitle: true,
  customLubricant: true,
  intervalDays: true,
  intervalPrintHours: true,
  intervalFilamentKilograms: true,
  intervalsCleared: true,
  disabledAt: true
} as const

const LOG_SELECT = {
  id: true,
  printerSerial: true,
  taskKey: true,
  completedAt: true,
  printHours: true,
  filamentKilograms: true,
  note: true,
  performedByUserId: true
} as const

export async function listTaskRows(
  prisma: WorkspaceScopedPrismaClient,
  printerSerials: string[]
): Promise<MaintenanceTaskRow[]> {
  if (printerSerials.length === 0) return []
  return prisma.printerMaintenanceTask.findMany({
    where: { printerSerial: { in: printerSerials } },
    select: TASK_SELECT
  })
}

/**
 * The newest completion per (serial, taskKey). Postgres has no portable
 * "latest per group" through Prisma, so this orders by completion time and keeps
 * the first row seen per key — correct as long as the ordering stays descending.
 */
export async function listLatestCompletions(
  prisma: WorkspaceScopedPrismaClient,
  printerSerials: string[]
): Promise<Map<string, MaintenanceLogRow>> {
  const latest = new Map<string, MaintenanceLogRow>()
  if (printerSerials.length === 0) return latest

  const rows = await prisma.printerMaintenanceLog.findMany({
    where: { printerSerial: { in: printerSerials } },
    select: LOG_SELECT,
    orderBy: { completedAt: 'desc' }
  })
  for (const row of rows) {
    // Serials never contain a space, so this composite key cannot collide.
    const key = `${row.printerSerial} ${row.taskKey}`
    if (!latest.has(key)) latest.set(key, row)
  }
  return latest
}

/**
 * Narrow the multi-printer completion map down to one printer, re-keyed by task
 * key alone — the shape `resolvePrinterTasks` expects.
 */
export function completionsForPrinter(
  latest: Map<string, MaintenanceLogRow>,
  printerSerial: string
): Map<string, MaintenanceLogRow> {
  const scoped = new Map<string, MaintenanceLogRow>()
  for (const row of latest.values()) {
    if (row.printerSerial === printerSerial) scoped.set(row.taskKey, row)
  }
  return scoped
}

export async function listTaskHistory(
  prisma: WorkspaceScopedPrismaClient,
  printerSerial: string,
  taskKey: string,
  limit: number
): Promise<MaintenanceLogRow[]> {
  return prisma.printerMaintenanceLog.findMany({
    where: { printerSerial, taskKey },
    select: LOG_SELECT,
    orderBy: { completedAt: 'desc' },
    take: limit
  })
}

export async function recordCompletion(
  prisma: WorkspaceScopedPrismaClient,
  input: {
    workspaceId: string
    printerSerial: string
    taskKey: string
    completedAt: Date
    printHours: number | null
    filamentKilograms: number | null
    performedByUserId: string | null
    note: string | null
  }
): Promise<MaintenanceLogRow> {
  return prisma.printerMaintenanceLog.create({
    data: {
      workspaceId: input.workspaceId,
      printerSerial: input.printerSerial,
      taskKey: input.taskKey,
      completedAt: input.completedAt,
      printHours: input.printHours,
      filamentKilograms: input.filamentKilograms,
      performedByUserId: input.performedByUserId,
      note: input.note
    },
    select: LOG_SELECT
  })
}

/** Interval kinds a patch can clear, in the wire names `intervalsCleared` stores. */
const INTERVAL_KINDS = ['days', 'printHours', 'filamentKilograms'] as const

/**
 * The `intervalsCleared` list after applying a patch.
 *
 * Exported for its own tests because this is the one place the three-state wire
 * contract is decoded: absent leaves the list alone, `null` adds the kind (the
 * user switched that measure off), and a number removes it (a value replaces a
 * clear). Getting it wrong silently re-inherits a catalog interval the user
 * turned off, which surfaces as a task that will not stop coming due.
 */
export function nextClearedIntervals(
  existing: readonly string[],
  patch: Pick<MaintenanceTaskPatchRequest, 'intervalDays' | 'intervalPrintHours' | 'intervalFilamentKilograms'>
): string[] {
  const cleared = new Set(existing)
  const patched: Record<string, number | null | undefined> = {
    days: patch.intervalDays,
    printHours: patch.intervalPrintHours,
    filamentKilograms: patch.intervalFilamentKilograms
  }
  for (const kind of INTERVAL_KINDS) {
    const value = patched[kind]
    if (value === undefined) continue
    if (value === null) cleared.add(kind)
    else cleared.delete(kind)
  }
  return [...cleared]
}

/**
 * Apply a patch to a task, creating the customization row if this is the first
 * change. An interval sent as `null` is recorded in `intervalsCleared` rather
 * than merely nulled, because a null column alone cannot distinguish "the user
 * turned this off" from "inherit the catalog value".
 */
export async function upsertTaskOverride(
  prisma: WorkspaceScopedPrismaClient,
  input: {
    workspaceId: string
    printerSerial: string
    taskKey: string
    patch: MaintenanceTaskPatchRequest
  }
): Promise<MaintenanceTaskRow> {
  const { patch } = input
  const existing = await prisma.printerMaintenanceTask.findUnique({
    where: {
      workspaceId_printerSerial_taskKey: {
        workspaceId: input.workspaceId,
        printerSerial: input.printerSerial,
        taskKey: input.taskKey
      }
    },
    select: TASK_SELECT
  })

  const cleared = nextClearedIntervals(existing?.intervalsCleared ?? [], patch)

  const data = {
    ...(patch.intervalDays !== undefined ? { intervalDays: patch.intervalDays } : {}),
    ...(patch.intervalPrintHours !== undefined ? { intervalPrintHours: patch.intervalPrintHours } : {}),
    ...(patch.intervalFilamentKilograms !== undefined ? { intervalFilamentKilograms: patch.intervalFilamentKilograms } : {}),
    ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? new Date() : null } : {}),
    ...(patch.title !== undefined ? { customTitle: patch.title } : {}),
    ...(patch.lubricant !== undefined ? { customLubricant: patch.lubricant } : {}),
    intervalsCleared: [...cleared]
  }

  return prisma.printerMaintenanceTask.upsert({
    where: {
      workspaceId_printerSerial_taskKey: {
        workspaceId: input.workspaceId,
        printerSerial: input.printerSerial,
        taskKey: input.taskKey
      }
    },
    create: {
      workspaceId: input.workspaceId,
      printerSerial: input.printerSerial,
      taskKey: input.taskKey,
      ...data
    },
    update: data,
    select: TASK_SELECT
  })
}

/**
 * Create a user-defined task. The row IS the task — there is no catalog entry
 * behind it — so its title is required and deleting the row deletes the task.
 */
export async function createCustomTask(
  prisma: WorkspaceScopedPrismaClient,
  input: {
    workspaceId: string
    printerSerial: string
    request: MaintenanceCustomTaskRequest
  }
): Promise<MaintenanceTaskRow> {
  const { request } = input
  const cleared = INTERVAL_KINDS.filter((kind) => {
    if (kind === 'days') return request.intervalDays === null
    if (kind === 'printHours') return request.intervalPrintHours === null
    return request.intervalFilamentKilograms === null
  })

  return prisma.printerMaintenanceTask.create({
    data: {
      workspaceId: input.workspaceId,
      printerSerial: input.printerSerial,
      taskKey: `${CUSTOM_MAINTENANCE_TASK_PREFIX}${randomUUID()}`,
      customTitle: request.title,
      customLubricant: request.lubricant,
      intervalDays: request.intervalDays ?? null,
      intervalPrintHours: request.intervalPrintHours ?? null,
      intervalFilamentKilograms: request.intervalFilamentKilograms ?? null,
      intervalsCleared: cleared
    },
    select: TASK_SELECT
  })
}

/**
 * Delete a custom task and its history. Catalog tasks are never deleted — the
 * catalog would just re-supply them on the next read — so callers reject that
 * case before getting here.
 */
export async function deleteCustomTask(
  prisma: WorkspaceScopedPrismaClient,
  input: { printerSerial: string; taskKey: string }
): Promise<void> {
  await prisma.printerMaintenanceTask.deleteMany({
    where: { printerSerial: input.printerSerial, taskKey: input.taskKey }
  })
  await prisma.printerMaintenanceLog.deleteMany({
    where: { printerSerial: input.printerSerial, taskKey: input.taskKey }
  })
}

/** Drop a catalog task's customization, returning it to the catalog defaults. */
export async function resetTaskOverride(
  prisma: WorkspaceScopedPrismaClient,
  input: { printerSerial: string; taskKey: string }
): Promise<void> {
  await prisma.printerMaintenanceTask.deleteMany({
    where: { printerSerial: input.printerSerial, taskKey: input.taskKey }
  })
}
