/**
 * Real filament **brands** (vendors) for the queue's custom-material picker — derived from the slicer's
 * filament profiles (`/api/slicing/profiles`, `kind: 'filament'`). Used as suggestions for the freeSolo
 * Brand field: a convenient starting point (e.g. "Bambu Lab"), with the user free to type any brand and
 * pick the type separately. Deduped to unique vendors (a self-made copy of a system preset keeps its
 * vendor, so it adds no noise; a custom preset with a genuinely new vendor still shows up).
 */
import { useQuery } from '@tanstack/react-query'
import type { SlicingProfileSummary, SlicingProfilesResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { isVisibleFilamentProfile } from '../../lib/sliceProfileMatching'

/** Unique, sorted filament vendors from the visible filament profiles. Pure for testing. */
export function buildFilamentBrands(profiles: SlicingProfileSummary[]): string[] {
  const brands = new Set<string>()
  for (const profile of profiles) {
    if (profile.kind !== 'filament' || !isVisibleFilamentProfile(profile)) continue
    const vendor = profile.filamentVendor?.trim()
    if (vendor) brands.add(vendor)
  }
  return [...brands].sort((left, right) => left.localeCompare(right))
}

const FILAMENT_BRANDS_QUERY_KEY = ['slicing', 'profiles', 'filament-brands'] as const

/**
 * Filament brand suggestions for the custom-material picker. Returns `[]` when the slicer isn't
 * configured or the profiles can't be read (no retry, no surfaced error) — manual entry works without them.
 */
export function useFilamentBrands(enabled = true): string[] {
  const query = useQuery({
    queryKey: FILAMENT_BRANDS_QUERY_KEY,
    queryFn: async ({ signal }) =>
      buildFilamentBrands((await apiFetch<SlicingProfilesResponse>('/api/slicing/profiles', { signal })).profiles),
    enabled,
    retry: false,
    staleTime: 5 * 60_000
  })
  return query.data ?? []
}
