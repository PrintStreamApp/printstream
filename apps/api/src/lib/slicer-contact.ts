/**
 * Watchdog over the slicer's live-progress channel: decides when a running slice has actually been
 * LOST, so the job fails with a real reason instead of reassuring the user for half an hour.
 *
 * OWNS the "is this slice still alive?" judgement. Pure — the polling, the CLI output, and the job
 * state machine stay in `slicing-jobs.ts`; this module only folds poll outcomes into a verdict.
 *
 * WHY. The slice itself is one long-lived POST to the slicer service, bounded only by
 * `SLICING_REQUEST_TIMEOUT_MS` (30 minutes). When the service dies mid-slice that POST usually
 * fails fast — but not always: a SIGKILLed process inside a container, or a proxy between the API
 * and the service, routinely leaves the socket HALF-OPEN, and the API then waits out the full
 * ceiling. Meanwhile the progress poller was swallowing every error and the job kept appending
 * its healthy "Slicing... 8m elapsed" heartbeat, which is not merely unhelpful — it is a confident
 * claim that work is happening, emitted while the slicer has no idea the job exists.
 *
 * The progress channel is an INDEPENDENT signal that answers within a second, so it is the right
 * watchdog: a bound instance replying 404 has restarted and dropped its job table, and no amount of
 * waiting brings that slice back.
 *
 * Two different graces on purpose (see the constants): an instance that is up and disowns the job
 * is conclusive, while an unreachable one may just be restarting, and killing a 20-minute slice
 * over a 3-second blip would be its own bug.
 */
import type { SlicerProgressResult } from './slicer-client.js'

/**
 * How long the bound instance may keep disowning the job before we call it lost. Short because the
 * answer is conclusive; the only reason to wait at all is the narrow race where the slice has just
 * finished and the instance dropped its record before the poller was aborted.
 */
export const UNKNOWN_JOB_GRACE_MS = 15_000

/**
 * How long the instance may be unreachable before we call it lost. Generous because a service
 * restart (or a redeploy rolling one of several sidecars) is a normal transient, and a slice that
 * survives it is worth more than a fast failure.
 */
export const UNREACHABLE_GRACE_MS = 60_000

/** Accumulated contact state across polls. Treat as immutable; fold with {@link nextSlicerContact}. */
export interface SlicerContactState {
  /** When contact was first lost, or null while the slicer is answering for this job. */
  readonly lostSince: number | null
  /** Which kind of loss started the current streak; null when in contact. */
  readonly kind: 'unknown' | 'unreachable' | null
  /** The transport reason for an `unreachable` streak, for the operator-facing log. */
  readonly reason: string | null
}

export const INITIAL_SLICER_CONTACT: SlicerContactState = { lostSince: null, kind: null, reason: null }

/**
 * Fold one poll outcome into the contact state.
 *
 * `unclaimed` is deliberately NEUTRAL rather than a loss: a queued job has no instance yet, and a
 * job whose instance was just released is finishing normally. It neither proves health nor
 * disproves it, so it leaves an existing streak running without starting one.
 *
 * A change of KIND restarts the clock, so a brief unreachable patch that resolves into a settled
 * 404 is judged on the (short) unknown grace from the moment the instance came back, not on
 * whichever grace happened to start first.
 */
export function nextSlicerContact(
  state: SlicerContactState,
  poll: SlicerProgressResult,
  nowMs: number
): SlicerContactState {
  if (poll.kind === 'output') return INITIAL_SLICER_CONTACT
  if (poll.kind === 'unclaimed') return state
  const reason = poll.kind === 'unreachable' ? poll.reason : null
  if (state.kind !== poll.kind) return { lostSince: nowMs, kind: poll.kind, reason }
  return { ...state, reason: reason ?? state.reason }
}

/** How long contact has been lost, or 0 while in contact. */
export function slicerContactLostForMs(state: SlicerContactState, nowMs: number): number {
  return state.lostSince === null ? 0 : Math.max(0, nowMs - state.lostSince)
}

/**
 * The user-facing failure message once the grace for the current streak has elapsed, else null.
 *
 * Both messages name a next action, because both are recoverable by re-slicing — the point of
 * failing early is that the user gets to make that call in seconds rather than half an hour.
 */
export function slicerContactGiveUpMessage(
  state: SlicerContactState,
  nowMs: number,
  grace?: { unknownMs?: number; unreachableMs?: number }
): string | null {
  const unknownMs = grace?.unknownMs ?? UNKNOWN_JOB_GRACE_MS
  const unreachableMs = grace?.unreachableMs ?? UNREACHABLE_GRACE_MS
  const lostForMs = slicerContactLostForMs(state, nowMs)
  if (state.kind === 'unknown' && lostForMs >= unknownMs) {
    return 'The slicer service restarted while this slice was running, so the slice was lost. Slice again to retry.'
  }
  if (state.kind === 'unreachable' && lostForMs >= unreachableMs) {
    return `Lost contact with the slicer service for ${Math.round(lostForMs / 1000)}s, so this slice was abandoned. Check the slicer service, then slice again.`
  }
  return null
}

/**
 * The periodic status line for a job, shown to the USER (the web renders the newest system line
 * verbatim). While in contact it reassures with the elapsed time; once contact is lost it must NOT
 * claim progress — it reports the silence instead, so the status tells the truth from the first
 * missed poll rather than only at the give-up point.
 *
 * `elapsedLabel` is the caller's already-formatted total elapsed time (e.g. "8m 20s").
 */
export function slicerContactHeartbeat(
  state: SlicerContactState,
  nowMs: number,
  elapsedLabel: string
): string {
  // The healthy case is the one users see, so it reads as progress, not as an overrun: "still
  // processing" said something was wrong eight seconds in.
  if (state.kind === null) return `Slicing... ${elapsedLabel} elapsed`
  const lostSeconds = Math.round(slicerContactLostForMs(state, nowMs) / 1000)
  return state.kind === 'unknown'
    ? `The slicer service is no longer tracking this job (${lostSeconds}s); it may have restarted. ${elapsedLabel} elapsed`
    : `Lost contact with the slicer service (${lostSeconds}s). ${elapsedLabel} elapsed`
}
