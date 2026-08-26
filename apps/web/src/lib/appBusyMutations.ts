/**
 * Bridges React Query's in-flight mutations into the app-busy registry.
 *
 * The blunt catch-all among the `appBusy.ts` sources: the named ones (uploads, slices,
 * unsaved editor edits) each know exactly what they would lose, while this one simply
 * refuses to let the app reload out from under any write that is still in the air. It
 * costs nothing when idle and it means a new source of losable work is covered by
 * default, rather than being discovered the first time a user's action vanishes.
 *
 * Mounted once from `main.tsx`, against the same client the app renders with.
 */
import type { QueryClient } from '@tanstack/react-query'
import { setAppBusy } from './appBusy'

/** Start mirroring mutation activity into `appBusy`. Returns an unsubscribe function. */
export function trackMutationsAsAppBusy(queryClient: QueryClient): () => void {
  const sync = (): void => {
    setAppBusy('mutations', queryClient.isMutating() > 0)
  }
  sync()
  return queryClient.getMutationCache().subscribe(sync)
}
