/**
 * React Query definitions for the ANONYMOUS slicer catalogue (`/api/public/slicing/*`), used by the
 * public 3MF editor. The workspace editor uses `lib/slicingPresetsQuery.ts`; this is the same shape
 * against the no-workspace surface, so nothing here ever needs an account.
 *
 * The profiles body is the largest JSON the app loads (multi-MB) and is served with a long public
 * cache, so this mirrors the workspace query's stall guard: a transport that wedges mid-body (the Vite
 * dev proxy's large-body stall; a dropped connection) is turned into a retryable error instead of a
 * forever-pending fetch. See the note in `lib/slicingPresetsQuery.ts`.
 */
import type { SlicerFamily, SlicingCapabilities, SlicingPresetSummary } from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'

/** The catalogue is effectively static per slicer image; keep it fresh for a few minutes. */
const CATALOGUE_STALE_TIME_MS = 5 * 60_000
const CATALOGUE_STALL_TIMEOUT_MS = 25_000

interface PublicTargetsResponse {
  configured: boolean
  defaultTargetId: string | null
  targets: Array<{
    id: string
    label: string
    family: SlicerFamily
    version: string
    isDefault: boolean
    prerelease: boolean
  }>
}

export interface PublicSlicerTargets {
  configured: boolean
  defaultTargetId: string | null
  /** Mapped to the full descriptor shape the settings panel/controller expect. */
  targets: SlicingCapabilities['targets']
}

/** Run a fetch under the shared stall timeout, composing the query's own cancel signal. */
async function fetchWithStallGuard<T>(path: string, signal: AbortSignal | undefined, stallMessage: string): Promise<T> {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  let stalled = false
  const stallTimer = setTimeout(() => { stalled = true; controller.abort() }, CATALOGUE_STALL_TIMEOUT_MS)
  try {
    return await apiFetch<T>(path, { signal: controller.signal })
  } catch (error) {
    if (stalled && !signal?.aborted) throw new Error(stallMessage)
    throw error
  } finally {
    clearTimeout(stallTimer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

export function publicSlicerTargetsQueryOptions() {
  return {
    queryKey: ['public-slicer-targets'] as const,
    queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<PublicSlicerTargets> => {
      const body = await fetchWithStallGuard<PublicTargetsResponse>(
        '/api/public/slicing/targets', signal, 'Loading slicer versions stalled: retrying.'
      )
      return {
        configured: body.configured,
        defaultTargetId: body.defaultTargetId,
        // The public endpoint omits deployment-only fields; fill the descriptor so the value still
        // satisfies the shared type. `slicerName` is display-only here and the estimate-mode switch
        // is a real-printer optimization the browser never performs.
        targets: body.targets.map((target) => ({
          ...target,
          slicerName: target.label,
          supportsEstimateModeMachineSwitch: false
        }))
      }
    },
    staleTime: CATALOGUE_STALE_TIME_MS,
    retry: 5,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000)
  }
}

export function publicSlicingPresetsQueryOptions(targetId: string) {
  return {
    queryKey: ['public-slicing-profiles', targetId] as const,
    enabled: targetId.length > 0,
    queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<SlicingPresetSummary[]> => {
      const params = new URLSearchParams({ targetId })
      const body = await fetchWithStallGuard<{ profiles: SlicingPresetSummary[] }>(
        `/api/public/slicing/profiles?${params.toString()}`, signal, 'Loading slicing presets stalled: retrying.'
      )
      return body.profiles
    },
    staleTime: CATALOGUE_STALE_TIME_MS,
    retry: 5,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000)
  }
}
