/** Local entitlement check used to keep inactive support surfaces quiet. */
import type { LicenseStatusResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'

/** Return true only while the installed commercial licence includes support. */
export function useCloudSupportEligibility(): boolean | undefined {
  const query = useQuery({
    queryKey: ['license'],
    queryFn: ({ signal }) => apiFetch<LicenseStatusResponse>('/api/license', { signal }),
    staleTime: 5 * 60_000,
    meta: { suppressGlobalErrorToast: true }
  })
  if (!query.data) return undefined

  return query.data.status.valid
    && query.data.status.edition === 'commercial'
    && !query.data.status.updatesExpired
}
