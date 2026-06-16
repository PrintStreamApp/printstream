/**
 * Global registry of jobs whose progress is currently shown in a modal dialog.
 *
 * Some long-running jobs (slicing today, potentially dispatch later) surface
 * their progress both in a focused modal and in a global status toast. While a
 * dialog already shows a job's progress, its toast is redundant, so dialogs
 * register the job id here and the matching toast list filters it out. The
 * toast is reserved for when no dialog is on screen.
 *
 * Registration is keyed per channel so a slicing dialog never suppresses a
 * dispatch toast (or vice versa), even though both share this store.
 */
import { useSyncExternalStore } from 'react'

export type ToastSuppressionChannel = 'slicing' | 'dispatch'

const active: Record<ToastSuppressionChannel, Set<string>> = {
  slicing: new Set(),
  dispatch: new Set()
}

// useSyncExternalStore requires a stable snapshot reference between renders, so
// we recompute the immutable snapshot only when the underlying set mutates.
const snapshots: Record<ToastSuppressionChannel, ReadonlySet<string>> = {
  slicing: new Set(),
  dispatch: new Set()
}

const listeners = new Set<() => void>()

function publish(channel: ToastSuppressionChannel): void {
  snapshots[channel] = new Set(active[channel])
  for (const listener of listeners) listener()
}

/**
 * Mark `jobId` as shown in a dialog for the given channel. Returns a cleanup
 * function that clears it; call it when the dialog unmounts.
 */
export function suppressJobToast(channel: ToastSuppressionChannel, jobId: string): () => void {
  active[channel].add(jobId)
  publish(channel)
  return () => {
    if (active[channel].delete(jobId)) publish(channel)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactively read the set of job ids currently suppressed for `channel`. */
export function useSuppressedJobToastIds(channel: ToastSuppressionChannel): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => snapshots[channel],
    () => snapshots[channel]
  )
}
