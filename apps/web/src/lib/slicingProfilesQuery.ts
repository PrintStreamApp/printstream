/**
 * Shared React Query definition for the slicer profile catalogue.
 *
 * Used by the slice dialog's live query AND by views that PREFETCH the catalogue as soon
 * as the slicer is known healthy — so the "Loading slicer data…" wait happens in the
 * background before the dialog opens, not while the user watches. One definition keeps
 * the query key, usability check, and retry/staleness behavior identical everywhere: a
 * prefetch with different options would either duplicate the cache entry or poison it
 * with an unusable (builtin-less) response.
 */
import type { QueryClient } from '@tanstack/react-query'
import type { SlicingCapabilities, SlicingProfilesResponse } from '@printstream/shared'
import { apiFetch } from './apiClient'
import { slicingProfilesResponseIsUsable } from './sliceProfileMatching'

/** The catalogue is effectively static per slicer image; keep it fresh for a few minutes. */
export const SLICING_PROFILES_STALE_TIME_MS = 5 * 60_000

/**
 * Abort a catalogue fetch that produces nothing for this long. The response is the largest JSON
 * body the app loads (multi-MB), and a transport that wedges mid-body (the Vite dev proxy's
 * intermittent large-body stall; a dropped LB connection in prod) otherwise hangs the fetch
 * FOREVER — no error, so no retry, and the slice dialog sits on "Loading slicer data…" until
 * closed (unmount aborts the fetch) and reopened (a fresh fetch succeeds). Timing out turns the
 * stall into an error React Query retries (×5 with backoff), so the dialog self-heals. Generous:
 * a healthy load takes a couple of seconds even on slow dev.
 */
const SLICING_PROFILES_STALL_TIMEOUT_MS = 25_000

export function slicingProfilesQueryOptions(targetId: string) {
  return {
    queryKey: ['slicing-profiles', targetId] as const,
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      const params = new URLSearchParams()
      params.set('targetId', targetId)
      // Compose the query's cancel signal with the stall timeout (manual composition —
      // AbortSignal.any is still too new to rely on across the supported browsers).
      const controller = new AbortController()
      const onOuterAbort = () => controller.abort()
      signal?.addEventListener('abort', onOuterAbort, { once: true })
      let stalled = false
      const stallTimer = setTimeout(() => {
        stalled = true
        controller.abort()
      }, SLICING_PROFILES_STALL_TIMEOUT_MS)
      let result: SlicingProfilesResponse
      try {
        result = await apiFetch<SlicingProfilesResponse>(`/api/slicing/profiles?${params.toString()}`, { signal: controller.signal })
      } catch (error) {
        // A stall-triggered abort must surface as a plain Error: React Query treats caller
        // aborts as cancellation (no retry), but a stalled transport should retry.
        if (stalled && !signal?.aborted) {
          throw new Error('Loading slicer profiles stalled — retrying.')
        }
        throw error
      } finally {
        clearTimeout(stallTimer)
        signal?.removeEventListener('abort', onOuterAbort)
      }
      // A response with no builtin presets means the slicer answered before its bundled
      // `*_full/` preset dirs were indexed (restart / still initializing) and only the
      // workspace's custom profiles came back. Caching that strands the editor on a
      // custom-only catalogue (Slice disabled; loaded materials mislabelled). Throw so
      // React Query retries with backoff instead of poisoning the cache.
      if (!slicingProfilesResponseIsUsable(result.profiles)) {
        throw new Error('Couldn’t load slicer profiles — the slicer may be restarting. Reopen the editor to try again.')
      }
      return result
    },
    staleTime: SLICING_PROFILES_STALE_TIME_MS,
    retry: 5,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000)
  }
}

/**
 * Fire-and-forget catalogue prefetch for the capabilities' default target. Call from any
 * view that already loads `/api/slicing/capabilities` and can later open a slice dialog.
 * Respects `staleTime` (a fresh cache entry is not refetched) and dedupes with an
 * in-flight dialog query on the same key.
 */
export function prefetchSlicingProfiles(queryClient: QueryClient, capabilities: SlicingCapabilities | null | undefined): void {
  if (!capabilities?.configured || !capabilities.healthy) return
  const targetId = capabilities.defaultTargetId ?? capabilities.targets[0]?.id
  if (!targetId) return
  void queryClient.prefetchQuery(slicingProfilesQueryOptions(targetId))
}
