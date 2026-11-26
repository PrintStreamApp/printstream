/**
 * Owns transactional fault transitions and job/idle references. Every mutation locks
 * the owning printer and supplies its workspace, including nested relation reads.
 * Assumes one API recorder per printer; the queue preserves observation arrival order.
 * Revisit ingestion leadership if multiple API nodes consume the same bridge stream.
 */
import { isPrintCancellationError, isPrinterActiveJobStage, type PrinterStatus } from '@printstream/shared'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { FaultSourceObservation } from './printer-fault-observation.js'

type FaultTransaction = Prisma.TransactionClient

/** Serialize all fault writes for a printer, independently of unrelated fleet activity. */
async function lockPrinter(tx: FaultTransaction, workspaceId: string, printerId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Printer" WHERE "workspaceId" = ${workspaceId} AND "id" = ${printerId} FOR UPDATE
  `)
  return rows.length > 0
}

/** Links temporal overlaps, including faults cleared while external-job activation awaited I/O. */
async function linkJob(tx: FaultTransaction, job: {
  id: string; workspaceId: string; printerId: string; startedAt: Date; finishedAt: Date | null
}): Promise<boolean> {
  const faults = await tx.printerFault.findMany({ where: {
    workspaceId: job.workspaceId,
    printerId: job.printerId,
    ...(job.finishedAt ? { firstObservedAt: { lte: job.finishedAt } } : {}),
    OR: [{ observedClearedAt: null }, { observedClearedAt: { gte: job.startedAt } }]
  } })
  // Late terminal reconciliation removes provisional links outside the observed job interval.
  const removed = await tx.printJobFault.deleteMany({ where: {
    workspaceId: job.workspaceId, jobId: job.id, faultId: { notIn: faults.map((fault) => fault.id) }
  } })
  await tx.printerFaultJobSpan.deleteMany({ where: { workspaceId: job.workspaceId, jobKey: job.id, faultId: { notIn: faults.map((fault) => fault.id) } } })
  for (const fault of faults) {
    await tx.printerFaultJobSpan.upsert({
      where: { faultId_jobKey: { faultId: fault.id, jobKey: job.id } },
      create: { workspaceId: job.workspaceId, faultId: fault.id, jobKey: job.id, startedAt: job.startedAt, endedAt: job.finishedAt },
      update: { startedAt: job.startedAt, endedAt: job.finishedAt }
    })
  }
  const result = await tx.printJobFault.createMany({ skipDuplicates: true, data: faults.map((fault) => ({
    workspaceId: job.workspaceId,
    jobId: job.id,
    faultId: fault.id,
    alreadyPresent: fault.firstObservedAt < job.startedAt
  })) })
  return result.count > 0 || removed.count > 0
}

/** Reconcile job coverage once a row is durable. Failure is isolated by the caller. */
export async function linkRecordedJobFaults(db: PrismaClient, workspaceId: string, printerId: string, jobId: string): Promise<boolean> {
  return await db.$transaction(async (tx) => {
    if (!await lockPrinter(tx, workspaceId, printerId)) return false
    const job = await tx.printJob.findFirst({ where: { workspaceId, printerId, id: jobId } })
    if (!job) return false
    return await linkJob(tx, job)
  })
}

/** Open source-specific uncertainty without altering occurrence or idle-period identity. */
export async function openFaultObservationGap(db: PrismaClient, input: {
  workspaceId: string; printerId: string; observedAt: Date; reason: 'disconnect' | 'restart'
}): Promise<boolean> {
  return await db.$transaction(async (tx) => {
    if (!await lockPrinter(tx, input.workspaceId, input.printerId)) return false
    const faults = await tx.printerFault.findMany({ where: {
      workspaceId: input.workspaceId, printerId: input.printerId, observedClearedAt: null,
      gaps: { none: { endedAt: null } }
    } })
    await tx.printerFaultGap.createMany({ data: faults.map((fault) => ({
      workspaceId: input.workspaceId, faultId: fault.id,
      // On restart we know only the last confirmed observation, not when the server stopped.
      startedAt: input.reason === 'restart' ? fault.lastObservedAt : input.observedAt,
      reason: input.reason
    })) })
    return faults.length > 0
  })
}

/**
 * Apply only fresh sources. Repeated codes dedupe until an observed clear; each
 * source closes only its own gaps. Idle boundaries never manufacture recurrences.
 */
export async function persistFaultObservation(db: PrismaClient, input: {
  workspaceId: string; status: PrinterStatus; sources: FaultSourceObservation; preparingJobId?: string
}): Promise<boolean> {
  const { workspaceId, status, sources } = input
  const at = new Date(status.observedAt)
  return await db.$transaction(async (tx) => {
    if (!await lockPrinter(tx, workspaceId, status.printerId)) return false
    let changed = false
    for (const source of ['hms', 'device_error'] as const) {
      const reported = sources[source]
      if (!reported) continue
      const byCode = new Map<string, (typeof reported)[number]>()
      for (const fault of reported) {
        if (source === 'device_error' && isPrintCancellationError(fault)) continue
        byCode.set(fault.code, fault)
      }
      const faults = [...byCode.values()]
      const codes = new Set(faults.map((fault) => fault.code))
      const open = await tx.printerFault.findMany({ where: {
        workspaceId, printerId: status.printerId, source, observedClearedAt: null
      }, include: { gaps: { where: { workspaceId, endedAt: null } } } })

      for (const fault of open) {
        if (fault.gaps.length) {
          await tx.printerFaultGap.updateMany({ where: { workspaceId, faultId: fault.id, endedAt: null }, data: { endedAt: at } })
          changed = true
        }
        if (codes.has(fault.code)) {
          await tx.printerFault.update({ where: { id: fault.id, workspaceId }, data: { lastObservedAt: at } })
        } else {
          await tx.printerFault.update({ where: { id: fault.id, workspaceId }, data: { observedClearedAt: at } })
          await tx.printerFaultIdlePeriod.updateMany({ where: { workspaceId, faultId: fault.id, endedAt: null }, data: { endedAt: at } })
          changed = true
        }
      }
      for (const fault of faults) {
        if (open.some((previous) => previous.code === fault.code)) continue
        // Keep the live parser's meaningful-HMS policy. Raw unknown codes above
        // still prevent a recorded occurrence from clearing during a dictionary outage.
        if (source === 'hms' && !fault.message) continue
        await tx.printerFault.create({ data: {
          workspaceId, printerId: status.printerId, source, code: fault.code, message: fault.message,
          firstObservedAt: at, lastObservedAt: at
        } })
        changed = true
      }
    }

    const active = isPrinterActiveJobStage(status.stage) || Boolean(input.preparingJobId)
    const unresolved = await tx.printerFault.findMany({ where: { workspaceId, printerId: status.printerId, observedClearedAt: null } })
    if (active) {
      const closed = await tx.printerFaultIdlePeriod.updateMany({ where: {
        workspaceId, faultId: { in: unresolved.map((fault) => fault.id) }, endedAt: null
      }, data: { endedAt: at } })
      changed = closed.count > 0 || changed
    } else if (status.stage !== 'unknown') {
      for (const fault of unresolved) {
        const existing = await tx.printerFaultIdlePeriod.findFirst({ where: { workspaceId, faultId: fault.id, endedAt: null } })
        if (!existing) {
          await tx.printerFaultIdlePeriod.create({ data: { workspaceId, faultId: fault.id, startedAt: at } })
          changed = true
        }
      }
    }

    // Reserved jobs count as preparation even before MQTT confirms a task. Job
    // creation also calls linkRecordedJobFaults, closing the async activation race.
    const jobs = active ? await tx.printJob.findMany({ where: {
      workspaceId, printerId: status.printerId, finishedAt: null,
      OR: [{ taskId: status.taskId ?? '__no_task__' }, ...(input.preparingJobId ? [{ id: input.preparingJobId }] : [])]
    } }) : []
    for (const job of jobs) changed = await linkJob(tx, job) || changed
    return changed
  })
}
