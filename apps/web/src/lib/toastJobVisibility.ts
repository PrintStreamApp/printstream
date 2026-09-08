/**
 * How long a job stays in a toast stack, for all three stacks.
 *
 * ONE definition because the stacks share a corner of the screen and a user cannot tell which
 * produced a given toast: a difference between them reads as one of them being broken, not as a
 * policy. They had already drifted in the telling, with a comment in `SlicingToasts` claiming a
 * failure never auto-dismisses while an untouched recency filter removed it after ninety seconds
 * anyway.
 *
 * Callers own everything about their own DOMAIN (which statuses count as active or failed,
 * ownership, dismissal, toast suppression); what lives here is only the question all three ask in
 * the same words. Both verdicts arrive as booleans rather than being read off `job.status`, so a
 * domain that renames a state gets a compile error at its own call site instead of a rule that
 * silently stops matching.
 */
import { useEffect, useRef } from 'react'

/**
 * How long a FINISHED job stays in the stack.
 *
 * It bounds the fresh-load case rather than the live one: `jobs` comes from the server on mount, so
 * with no window every recently-finished job would pop a toast for work whose result the user has
 * already seen.
 */
export const TOAST_RECENT_MS = 90_000

export interface ToastJobVerdict {
  isActive: boolean
  isFailed: boolean
  /**
   * Whether THIS stack watched the job running. See {@link jobBelongsInToastStack} for why a
   * failure's exemption hangs on it.
   */
  watchedRunning: boolean
}

/**
 * Whether a job still belongs in the toast stack.
 *
 * A failure the stack WATCHED RUN is exempt from the window, the same exemption it already has from
 * the five-second auto-dismiss and for the same reason: it is the one outcome carrying an action
 * (Retry) and a reason the user has to read, and a slice or an upload routinely runs longer than
 * ninety seconds, so the toast expired exactly for the user who stepped away. It leaves when they
 * dismiss it.
 *
 * The `watchedRunning` half is what keeps that bounded, and it is not a detail. A failure the stack
 * never saw running arrived already-failed from the server on mount, which means the user is not
 * waiting on it, and pinning those turns a page load into a pile of history: the dispatch list is
 * capped at a HUNDRED finished jobs with no time bound at all (`printDispatcher.pruneOldJobs`), and
 * `dismissed` is component state that a reload clears, so week-old failures would re-toast on every
 * load, forever. Slicing's list happens to be time-capped (`slicingJobs.listActive`, five minutes)
 * and its stack caps items at eight, but relying on either would make one stack's rule depend on a
 * server detail the other does not share, which is the drift this module exists to prevent.
 */
export function jobBelongsInToastStack(
  job: { updatedAt: string },
  verdict: ToastJobVerdict,
  now: number
): boolean {
  if (verdict.isActive) return true
  if (verdict.isFailed && verdict.watchedRunning) return true
  return now - Date.parse(job.updatedAt) <= TOAST_RECENT_MS
}

/**
 * The ids this stack has seen RUNNING since it mounted, which is what earns a failure its exemption.
 *
 * A ref rather than state on purpose: it is read during the same render that recomputes the visible
 * list, and storing it in state would schedule an extra render per poll for a value no one paints.
 * Recording happens in an effect so the render stays pure. That costs one frame the very first time
 * a job appears already-failed-and-previously-active, which no arrangement of polling can produce:
 * a job is observed running at least once before it fails.
 */
export function useWatchedRunningJobIds<T extends { id: string }>(
  jobs: readonly T[],
  isActive: (job: T) => boolean
): ReadonlySet<string> {
  const watched = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const job of jobs) {
      if (isActive(job)) watched.current.add(job.id)
    }
    // Deliberately never pruned: an id costs a few bytes and the set dies with the mount, whereas
    // forgetting one would un-pin a failure the user is still looking at.
  }, [jobs, isActive])
  return watched.current
}
