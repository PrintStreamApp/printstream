/**
 * Shared web-side plate-clearing state helpers.
 *
 * The plate-clearing plugin is optional, so callers must treat missing
 * or disabled plugin responses as "all printers are cleared" rather
 * than a hard failure that breaks core pages.
 */
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage, wsEventSchema } from '@printstream/shared'
import { buildApiUrl } from './apiUrl'
import { usePluginCatalogQuery } from './pluginCatalogQuery'
import { isPluginActiveByName } from './pluginSettings'
import { wsClient } from './wsClient'

export interface PlateClearingPrinterState {
  printerId: string
  cleared: boolean
}

export interface PlateClearingStateResponse {
  printers: PlateClearingPrinterState[]
}

export const PLATE_CLEARING_STATE_QUERY_KEY = ['plate-clearing', 'state'] as const
const PLATE_CLEARING_PLUGIN_NAME = 'plate-clearing'

export function mergePlateClearingState(
  existing: PlateClearingStateResponse | undefined,
  printerId: string,
  cleared: boolean
): PlateClearingStateResponse {
  const printers = existing?.printers ?? []
  const others = printers.filter((row) => row.printerId !== printerId)
  return { printers: [...others, { printerId, cleared }] }
}

export async function fetchPlateClearingStateFromUrl(requestUrl: string): Promise<PlateClearingStateResponse> {
  const response = await fetch(requestUrl, {
    headers: { Accept: 'application/json' }
  })

  if (response.status === 404) {
    return { printers: [] }
  }

  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json') ? await response.json() : await response.text()

  if (response.status === 503 && extractErrorMessage(payload) === 'Plugin disabled: plate-clearing') {
    return { printers: [] }
  }

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Request failed (${response.status})`))
  }

  return payload as PlateClearingStateResponse
}

async function fetchPlateClearingState(): Promise<PlateClearingStateResponse> {
  return fetchPlateClearingStateFromUrl(buildApiUrl('/api/plugins/plate-clearing/state'))
}

function usePlateClearingAvailability(): { active: boolean; loading: boolean } {
  const query = usePluginCatalogQuery({ suppressGlobalErrorToast: true })

  if (!query.data) {
    return { active: false, loading: query.isLoading }
  }

  const pluginsByName = new Map(query.data.plugins.map((plugin) => [plugin.name, plugin] as const))
  return {
    active: isPluginActiveByName(PLATE_CLEARING_PLUGIN_NAME, pluginsByName, true),
    loading: query.isLoading
  }
}

export function usePlateClearingSync(): void {
  const queryClient = useQueryClient()
  const availability = usePlateClearingAvailability()

  useEffect(() => {
    if (!availability.active) return

    wsClient.start()
    const off = wsClient.onJson((raw) => {
      const parsed = wsEventSchema.safeParse(raw)
      if (!parsed.success) return
      const event = parsed.data
      if (event.type !== 'plugin.event' || event.pluginName !== 'plate-clearing') return

      const inner = event.event as { kind?: string; printerId?: string; cleared?: boolean }
      if (inner.kind !== 'state' || typeof inner.printerId !== 'string' || typeof inner.cleared !== 'boolean') return

      queryClient.setQueryData<PlateClearingStateResponse>(
        PLATE_CLEARING_STATE_QUERY_KEY,
        (existing) => mergePlateClearingState(existing, inner.printerId!, inner.cleared!)
      )
    })

    return () => {
      off()
      wsClient.stop()
    }
  }, [availability.active, queryClient])
}

export function usePlateClearingState(printerId: string): { cleared: boolean; loading: boolean } {
  const availability = usePlateClearingAvailability()
  const query = useQuery<PlateClearingStateResponse>({
    queryKey: PLATE_CLEARING_STATE_QUERY_KEY,
    queryFn: fetchPlateClearingState,
    staleTime: 60_000,
    enabled: availability.active,
    retry: false
  })

  const entry = query.data?.printers.find((row) => row.printerId === printerId)
  return { cleared: entry ? entry.cleared : true, loading: availability.loading || (availability.active && query.isLoading) }
}

export function usePlateClearingStates(): {
  clearedByPrinterId: Record<string, boolean>
  loading: boolean
} {
  const availability = usePlateClearingAvailability()
  const query = useQuery<PlateClearingStateResponse>({
    queryKey: PLATE_CLEARING_STATE_QUERY_KEY,
    queryFn: fetchPlateClearingState,
    staleTime: 60_000,
    enabled: availability.active,
    retry: false
  })

  const clearedByPrinterId = Object.fromEntries(
    (query.data?.printers ?? []).map((row) => [row.printerId, row.cleared] as const)
  )

  return { clearedByPrinterId, loading: availability.loading || (availability.active && query.isLoading) }
}