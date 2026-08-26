/**
 * Whether this tab is in the middle of something a reload would destroy.
 *
 * Exists for one caller: `appStaleness.ts`, which reloads the tab onto a new build and
 * must not do that mid-flight. The sources are the places where a reload loses work the
 * user cannot get back by repeating a click, not merely places that are "doing
 * something": an unsaved 3MF project, an upload the queue is streaming, a slice this tab
 * owns, and any in-flight mutation.
 *
 * That distinction matters because the browser cannot ask. A scripted `location.reload()`
 * does not fire the `beforeunload` confirmation that guards the editor
 * (`plugins/model-studio/useEditorHistory.ts`), and mobile Safari ignores that dialog
 * regardless, so nothing downstream will catch a badly-timed reload. This registry is
 * the only thing standing between a deploy and someone's unsaved work.
 *
 * The source list is a closed union deliberately: a new kind of losable work should have
 * to name itself here rather than being silently uncovered.
 */

export type AppBusySource =
  /** Library uploads queued or streaming (`libraryUploadQueue.ts`). */
  | 'library-uploads'
  /** A slice this tab started and is tracking (`components/SlicingToasts.tsx`). */
  | 'slicing'
  /**
   * An open 3MF project with unsaved edits (`plugins/model-studio/useEditorHistory.ts`).
   *
   * Currently implied by `dialog-open`, since `EditorView` renders inside a
   * `BackAwareModal` on both hosts. Kept anyway: that is incidental, and if the editor
   * ever becomes a route the unsaved-work protection would vanish with no test failing.
   */
  | 'editor-edits'
  /** Any React Query mutation in flight (`lib/appBusyMutations.ts`). */
  | 'mutations'
  /**
   * Any dialog is open (`components/BackAwareModal.tsx`). A dialog is nearly always a
   * half-filled form or a decision in progress, so it counts as work even when nothing
   * has been submitted yet.
   */
  | 'dialog-open'

const busySources = new Set<AppBusySource>()
const listeners = new Set<() => void>()

/**
 * Mark a source busy or idle. Idempotent, so a caller can push its current state on
 * every render without churn.
 */
export function setAppBusy(source: AppBusySource, busy: boolean): void {
  const wasBusy = busySources.has(source)
  if (wasBusy === busy) return
  if (busy) busySources.add(source)
  else busySources.delete(source)
  for (const listener of listeners) listener()
}

/** True when any source holds work a reload would lose. */
export function isAppBusy(): boolean {
  return busySources.size > 0
}

/** Subscribe to busy/idle transitions. Returns an unsubscribe function. */
export function subscribeAppBusy(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam: drop all registered busy state. */
export function resetAppBusyForTests(): void {
  busySources.clear()
  listeners.clear()
}
