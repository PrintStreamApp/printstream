/** Shared local licence query and feature-specific cloud eligibility feedback. */
import { canUseSuggestions, hasInAppSupport, inAppSupportUnavailabilityReason, type LicenseStatusResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'

/** Both features use one cached local licence status, with separate entitlement rules. */
function useCloudLicenseStatus() {
  const query = useQuery({
    queryKey: ['license'],
    queryFn: ({ signal }) => apiFetch<LicenseStatusResponse>('/api/license', { signal }),
    staleTime: 5 * 60_000,
    meta: { suppressGlobalErrorToast: true }
  })
  return query
}

/** Help requires a current support window; include the reason for its email fallback. */
export function useCloudSupportEligibility(): { eligible: boolean; reason: string | null } | undefined {
  const query = useCloudLicenseStatus()
  if (query.isError) {
    return { eligible: false, reason: `Could not check the installed licence: ${query.error.message}` }
  }
  const status = query.data?.status
  if (!status) return undefined
  return { eligible: hasInAppSupport(status), reason: inAppSupportUnavailabilityReason(status) }
}

/** Suggestions is available to any valid licensed install. */
export function useCloudSuggestionEligibility(): { eligible: boolean; reason: string | null } | undefined {
  const query = useCloudLicenseStatus()
  if (query.isError) {
    return { eligible: false, reason: `Could not check the installed licence: ${query.error.message}` }
  }
  const status = query.data?.status
  if (!status) return undefined
  return {
    eligible: canUseSuggestions(status),
    reason: canUseSuggestions(status) ? null : 'Suggestions require a valid installed licence.'
  }
}
