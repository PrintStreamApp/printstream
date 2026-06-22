/**
 * Durable journal for the print dispatcher.
 *
 * The dispatcher executes in-process (the heap is the live executor), but every
 * lifecycle transition is written through to the `DispatchJob` table so that a
 * restart can reconcile dispatches that were in flight when the process died —
 * and so the per-printer dispatch guard can eventually become cluster-wide.
 *
 * Safety boundary (the dispatcher's "rob-1" restart contract): `startCommandAttemptedAt`
 * is set — and durably committed — immediately BEFORE the MQTT start command is
 * published. A row with it NULL therefore provably never started a print and is safe to
 * reconcile/clean up; a row with it set may correspond to a real running print and must
 * be left alone for the status recorder to resolve.
 *
 * All write-through helpers except {@link markDispatchStartAttempted} are best-effort:
 * a journal hiccup must never break a print, so they swallow and log errors. The start
 * marker is the exception — callers MUST await it and abort the dispatch if it rejects,
 * because the reconcile's safety depends on that marker being durable before publish.
 */
import { rootPrisma } from './prisma.js'

/** Journal lifecycle states. A superset of the public dispatch statuses plus `interrupted`. */
export type DispatchJournalStatus =
  | 'queued'
  | 'uploading'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Non-terminal states a dispatch can be left in if the process dies mid-flight. */
const RECONCILABLE_STATUSES: readonly DispatchJournalStatus[] = ['queued', 'uploading']

export interface DispatchJournalSeed {
  id: string
  tenantId: string
  printerId: string
  jobName: string
  fileName: string
  remoteName: string
}

/**
 * Whether an orphaned journal row is safe to reconcile (mark interrupted + clean up its
 * upload). Pure so the rob-1 rule is unit-testable: only pre-publish rows
 * (`startCommandAttemptedAt` NULL) in a non-terminal state qualify — anything that may
 * have published a start command is left for the status recorder.
 */
export function isReconcilableDispatch(
  status: string,
  startCommandAttemptedAt: Date | null
): boolean {
  if (startCommandAttemptedAt != null) return false
  return (RECONCILABLE_STATUSES as readonly string[]).includes(status)
}

/** Create the journal row when a dispatch is enqueued. Best-effort. */
export async function recordDispatchEnqueued(seed: DispatchJournalSeed): Promise<void> {
  try {
    await rootPrisma.dispatchJob.create({
      data: {
        id: seed.id,
        tenantId: seed.tenantId,
        printerId: seed.printerId,
        status: 'queued',
        jobName: seed.jobName,
        fileName: seed.fileName,
        remoteName: seed.remoteName
      }
    })
  } catch (error) {
    console.warn(`[dispatch-journal] failed to record enqueue for ${seed.id}`, (error as Error).message)
  }
}

/** Write a lifecycle transition. Best-effort. */
export async function recordDispatchStatus(
  id: string,
  status: DispatchJournalStatus,
  fields: { error?: string | null; finishedAt?: Date | null; clearStartAttempt?: boolean } = {}
): Promise<void> {
  try {
    await rootPrisma.dispatchJob.update({
      where: { id },
      data: {
        status,
        ...(fields.error !== undefined ? { error: fields.error } : {}),
        ...(fields.finishedAt !== undefined ? { finishedAt: fields.finishedAt } : {}),
        ...(fields.clearStartAttempt ? { startCommandAttemptedAt: null } : {})
      }
    })
  } catch (error) {
    console.warn(`[dispatch-journal] failed to record ${status} for ${id}`, (error as Error).message)
  }
}

/**
 * Durably mark that a start command is about to be published — the rob-1 boundary.
 * NOT best-effort: the caller MUST await this and abort the dispatch if it rejects, so
 * a later crash can never misclassify a started print as a safe-to-clean pre-publish row.
 */
export async function markDispatchStartAttempted(id: string): Promise<void> {
  await rootPrisma.dispatchJob.update({
    where: { id },
    data: { startCommandAttemptedAt: new Date() }
  })
}

/**
 * Boot reconcile: mark every pre-publish, non-terminal journal row as `interrupted`.
 * Platform-wide (all tenants) — a deliberate startup operation. Returns the count.
 * Mirrors {@link isReconcilableDispatch}; the two MUST stay in sync.
 */
export async function reconcileInterruptedDispatches(): Promise<number> {
  const result = await rootPrisma.dispatchJob.updateMany({
    where: {
      status: { in: [...RECONCILABLE_STATUSES] },
      startCommandAttemptedAt: null
    },
    data: {
      status: 'interrupted',
      finishedAt: new Date(),
      error: 'Interrupted: the server restarted before the print started'
    }
  })
  return result.count
}

/** Interrupted dispatches for a printer that may have left orphaned bytes on its SD. */
export async function listInterruptedDispatchUploads(
  printerId: string
): Promise<Array<{ id: string; remoteName: string }>> {
  return rootPrisma.dispatchJob.findMany({
    where: { printerId, status: 'interrupted' },
    select: { id: true, remoteName: true }
  })
}

/** Drop handled journal rows once their orphaned upload has been cleaned (or confirmed gone). */
export async function deleteDispatchJournalRows(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    await rootPrisma.dispatchJob.deleteMany({ where: { id: { in: [...ids] } } })
  } catch (error) {
    console.warn('[dispatch-journal] failed to delete handled rows', (error as Error).message)
  }
}
