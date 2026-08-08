/**
 * Published "how many dialogs are open" state, for fixed-position chrome OUTSIDE
 * any dialog that has to react to being covered — the toast stack lifts itself
 * clear of the mobile tab bar, and a dialog hides that tab bar, so the lift has
 * to drop while one is open.
 *
 * Module-level rather than a context because every dialog in the app mounts
 * through `BackAwareModal`, and a context would only see part of the tree.
 *
 * Split out of `BackAwareModal.tsx` so that file exports only its component:
 * mixing component and non-component exports breaks React Fast Refresh for the
 * whole module, which for the app's dialog host means losing hot reload in every
 * dialog. The modal still owns the dialog STACK; this owns only the published
 * count, which the modal pushes whenever the stack changes.
 */
const listeners = new Set<() => void>()
let openDialogCount = 0

/** Subscribe to open/close transitions. Returns the unsubscribe. */
export function subscribeToOpenDialogs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Snapshot for `useSyncExternalStore`; must be a stable read, never a fresh object. */
export function getOpenDialogCount(): number {
  return openDialogCount
}

/**
 * Publish the current open-dialog count. Called by `BackAwareModal` on every
 * stack change; no-ops when the count is unchanged so subscribers are not woken
 * by a re-render that did not alter what they read.
 */
export function setOpenDialogCount(count: number): void {
  if (count === openDialogCount) return
  openDialogCount = count
  for (const listener of listeners) listener()
}
