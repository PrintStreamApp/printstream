import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { AuthBootstrap } from '@printstream/shared'
import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { apiFetch } from './apiClient'
import { readCurrentWorkspaceScopeKey } from './workspaceScope'

export const AUTH_BOOTSTRAP_STALE_TIME_MS = 60_000
export const platformAuthScopeKey = 'platform'

const authBootstrapQueryContext = createContext<UseQueryResult<AuthBootstrap> | null>(null)

export const authQueryKeys = {
  bootstrap: ['auth-bootstrap'] as const,
  bootstrapScoped: (authScopeKey: string) => ['auth-bootstrap', authScopeKey] as const,
  managementStatus: (authScopeKey: string) => ['auth-management-status', authScopeKey] as const,
  localStatus: (authScopeKey: string) => ['local-auth-status', authScopeKey] as const,
  oauthConfig: (authScopeKey: string) => ['auth-oauth-config', authScopeKey] as const,
  groups: (authScopeKey: string) => ['auth-groups', authScopeKey] as const,
  users: (authScopeKey: string) => ['auth-users', authScopeKey] as const,
  userSessions: (authScopeKey: string, userId: string | null) => ['auth-user-sessions', authScopeKey, userId] as const,
  serviceAccounts: (authScopeKey: string) => ['auth-service-accounts', authScopeKey] as const
}

export function resolveAuthScope(authBootstrap?: Pick<AuthBootstrap, 'tenant'> | null): {
  authTenantId: string | undefined
  authScopeKey: string
} {
  const authTenantId = authBootstrap?.tenant?.id
  return {
    authTenantId,
    authScopeKey: authTenantId ?? platformAuthScopeKey
  }
}

export function readCurrentAuthBootstrapScopeKey(): string {
  return readCurrentWorkspaceScopeKey()
}

export function buildAuthBootstrapQueryOptions(authScopeKey: string) {
  return {
    queryKey: authQueryKeys.bootstrapScoped(authScopeKey),
    queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch<AuthBootstrap>('/api/auth/bootstrap', { signal }),
    staleTime: AUTH_BOOTSTRAP_STALE_TIME_MS
  }
}

export function AuthBootstrapQueryProvider(
  { children, value }: { children: ReactNode; value: UseQueryResult<AuthBootstrap> }
) {
  return createElement(authBootstrapQueryContext.Provider, { value }, children)
}

export function useAuthBootstrapQuery(options: {
  enabled?: boolean
  suppressGlobalErrorToast?: boolean
} = {}) {
  const sharedQuery = useContext(authBootstrapQueryContext)
  const localQuery = useQuery({
    ...buildAuthBootstrapQueryOptions(readCurrentAuthBootstrapScopeKey()),
    enabled: !sharedQuery && (options.enabled ?? true),
    ...(options.suppressGlobalErrorToast ? { meta: { suppressGlobalErrorToast: true } } : {})
  })

  return sharedQuery ?? localQuery
}

export async function invalidateAuthQueries(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  ...queryKeys: Array<readonly unknown[]>
): Promise<void> {
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}