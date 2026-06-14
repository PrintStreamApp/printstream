import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { PluginCatalogResponse } from '@printstream/shared'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiFetch } from './apiClient'

export const PLUGIN_CATALOG_QUERY_KEY = ['plugin-catalog'] as const
export const PLUGIN_CATALOG_STALE_TIME_MS = 60_000

const pluginCatalogQueryContext = createContext<UseQueryResult<PluginCatalogResponse> | null>(null)

export function buildPluginCatalogQueryOptions() {
  return {
    queryKey: PLUGIN_CATALOG_QUERY_KEY,
    queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch<PluginCatalogResponse>('/api/plugin-catalog', { signal }),
    staleTime: PLUGIN_CATALOG_STALE_TIME_MS
  }
}

export function PluginCatalogQueryProvider(
  { children, value }: { children: ReactNode; value: UseQueryResult<PluginCatalogResponse> }
) {
  return createElement(pluginCatalogQueryContext.Provider, { value }, children)
}

export function usePluginCatalogQuery(options: {
  enabled?: boolean
  suppressGlobalErrorToast?: boolean
} = {}) {
  const sharedQuery = useContext(pluginCatalogQueryContext)
  const localQuery = useQuery({
    ...buildPluginCatalogQueryOptions(),
    enabled: !sharedQuery && (options.enabled ?? true),
    ...(options.suppressGlobalErrorToast ? { meta: { suppressGlobalErrorToast: true } } : {})
  })

  return sharedQuery ?? localQuery
}