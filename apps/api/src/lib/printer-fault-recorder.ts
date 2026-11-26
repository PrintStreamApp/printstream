/**
 * Event-driven durable fault recorder, counterpart to printer-fault-store and Jobs.
 * Source observations queue before asynchronous job activation. Persistence failures
 * are logged and retried without rejecting print dispatch or the main job recorder.
 * Startup reconciliation records uncertainty before accepting fresh observations.
 */
import { isPrinterActiveJobStage } from '@printstream/shared'
import type { PrismaClient } from '@prisma/client'
import { printerEvents, type PrinterEvents } from './printer-events.js'
import { peekPendingPrintJobSource } from './pending-print-job-source.js'
import { rootPrisma } from './prisma.js'
import { broadcastJobsChanged } from './ws-resource-events.js'
import { linkRecordedJobFaults, openFaultObservationGap, persistFaultObservation } from './printer-fault-store.js'

/** Instance seam lets isolated fixtures exercise restart recovery and ordered ingestion. */
export class PrinterFaultRecorder {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly activity = new Map<string, string>()
  private readonly endedReservations = new Map<string, string>()
  private recovery: Promise<void> | null = null

  constructor(private readonly db: PrismaClient, private readonly changed: (workspaceId: string) => void) {}

  /** Recover uncleared occurrences, retaining pre-existing open gaps. Safe to retry after failure. */
  async recover(): Promise<void> {
    if (!this.recovery) {
      this.recovery = this.recoverUnresolved().catch((error) => {
        this.recovery = null
        throw error
      })
    }
    await this.recovery
  }

  private async recoverUnresolved(): Promise<void> {
    const rows = await this.db.printerFault.findMany({ where: { observedClearedAt: null }, select: { workspaceId: true, printerId: true }, distinct: ['printerId'] })
    for (const row of rows) {
      if (await openFaultObservationGap(this.db, { ...row, observedAt: new Date(), reason: 'restart' })) this.changed(row.workspaceId)
    }
  }

  /** Ordered best-effort writes; retries preserve the original observation timestamp. */
  private async enqueue(workspaceId: string, printerId: string, operation: () => Promise<boolean>): Promise<void> {
    const previous = this.queues.get(printerId) ?? Promise.resolve()
    const pending = previous.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.recover()
          if (await operation()) this.changed(workspaceId)
          return
        } catch (error) {
          console.error(`[printer-fault-recorder] persistence failed for printer ${printerId} (attempt ${attempt + 1})`, error)
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
    })
    this.queues.set(printerId, pending)
    await pending
    if (this.queues.get(printerId) === pending) this.queues.delete(printerId)
  }

  /** Accept a fresh report in arrival order, retaining pending-job identity at ingestion. */
  async observe(event: Parameters<PrinterEvents['fault.observed']>[0]): Promise<void> {
    // A just-observed terminal transition outranks pending metadata whose async
    // activation has not yet caught up. A stale terminal snapshot before a new
    // reservation, by contrast, still belongs to the new job's preparation.
    const pendingJobId = peekPendingPrintJobSource(event.status.printerId)?.jobId ?? undefined
    if (event.jobEnded && pendingJobId) this.endedReservations.set(event.status.printerId, pendingJobId)
    if (!pendingJobId) this.endedReservations.delete(event.status.printerId)
    const preparingJobId = pendingJobId && this.endedReservations.get(event.status.printerId) !== pendingJobId ? pendingJobId : undefined
    const signature = `${isPrinterActiveJobStage(event.status.stage)}:${event.status.taskId ?? ''}:${preparingJobId ?? ''}`
    const previous = this.activity.get(event.status.printerId)
    this.activity.set(event.status.printerId, signature)
    if (previous === signature && Object.keys(event.sources).length === 0) return
    await this.enqueue(event.workspaceId, event.status.printerId, () => persistFaultObservation(this.db, { ...event, preparingJobId }))
  }

  /** A new reservation supersedes any terminal observation from an earlier use of that job key. */
  reservationStarted(printerId: string): void { this.endedReservations.delete(printerId) }

  /** A disconnect creates uncertainty even before the fleet view marks a printer offline. */
  async gap(event: Parameters<PrinterEvents['fault.gap']>[0]): Promise<void> {
    await this.enqueue(event.workspaceId, event.printerId, () => openFaultObservationGap(this.db, {
      ...event, observedAt: new Date(event.observedAt), reason: 'disconnect'
    }))
  }

  /** Awaited after job persistence; never throws back into dispatch/job lifecycle callers. */
  async linkJob(workspaceId: string, printerId: string, jobId: string): Promise<void> {
    await this.enqueue(workspaceId, printerId, () => linkRecordedJobFaults(this.db, workspaceId, printerId, jobId))
  }

  /** Await writes accepted before shutdown; no new observations should be admitted afterward. */
  async drain(): Promise<void> { await Promise.all(this.queues.values()) }
}

export const printerFaultRecorder = new PrinterFaultRecorder(rootPrisma, broadcastJobsChanged)
const onObservation: PrinterEvents['fault.observed'] = (event) => { void printerFaultRecorder.observe(event) }
const onReservation: PrinterEvents['print.job.starting'] = (event) => { printerFaultRecorder.reservationStarted(event.printerId) }
const onGap: PrinterEvents['fault.gap'] = (event) => { void printerFaultRecorder.gap(event) }
let started = false

/** Subscribe before printer-manager starts; initialization never prevents printer connectivity. */
export async function startPrinterFaultRecorder(): Promise<void> {
  if (started) return
  started = true
  printerEvents.on('fault.observed', onObservation)
  printerEvents.on('fault.gap', onGap)
  printerEvents.on('print.job.starting', onReservation)
  try { await printerFaultRecorder.recover() } catch (error) {
    console.error('[printer-fault-recorder] startup recovery failed; retrying on the next observation', error)
  }
}

/** Stop accepting observations and flush the writes already accepted. */
export async function stopPrinterFaultRecorder(): Promise<void> {
  started = false
  printerEvents.off('fault.observed', onObservation)
  printerEvents.off('fault.gap', onGap)
  printerEvents.off('print.job.starting', onReservation)
  await printerFaultRecorder.drain()
}

/** Production job seam is inactive until subscribed, so isolated job users need no fault store. */
export async function linkPrintJobFaults(workspaceId: string, printerId: string, jobId: string): Promise<void> {
  if (started) await printerFaultRecorder.linkJob(workspaceId, printerId, jobId)
}
