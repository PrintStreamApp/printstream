import type { SlicingProfileSummary } from '@printstream/shared'

export type SlicingProfileSortValue = 'updatedAt' | 'name' | 'kind'
export type SlicingProfileKind = SlicingProfileSummary['kind']
export type SlicingProfileSortDirection = 'asc' | 'desc'

export const DEFAULT_SLICING_PROFILE_SORT_VALUE: SlicingProfileSortValue = 'name'
export const DEFAULT_SLICING_PROFILE_SORT_DIRECTION: SlicingProfileSortDirection = 'asc'

export function formatSlicingProfileKind(kind: SlicingProfileSummary['kind']): string {
  switch (kind) {
    case 'machine': return 'Printer'
    case 'process': return 'Quality'
    case 'filament': return 'Material'
  }
}

export function filterSlicingProfiles(
  profiles: SlicingProfileSummary[],
  search: string,
  kindFilters: ReadonlyArray<SlicingProfileKind>
): SlicingProfileSummary[] {
  const normalizedSearch = search.trim().toLowerCase()
  return profiles.filter((profile) => {
    if (kindFilters.length > 0 && !kindFilters.includes(profile.kind)) return false
    if (!normalizedSearch) return true
    const searchHaystack = `${profile.name} ${formatSlicingProfileKind(profile.kind)}`.toLowerCase()
    return searchHaystack.includes(normalizedSearch)
  })
}

export function sortSlicingProfiles(
  profiles: SlicingProfileSummary[],
  sortValue: SlicingProfileSortValue,
  sortDirection: SlicingProfileSortDirection
): SlicingProfileSummary[] {
  const directionMultiplier = sortDirection === 'asc' ? 1 : -1
  return [...profiles].sort((left, right) => {
    let comparison = 0
    switch (sortValue) {
      case 'name':
        comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
        break
      case 'kind':
        comparison = formatSlicingProfileKind(left.kind).localeCompare(formatSlicingProfileKind(right.kind), undefined, { sensitivity: 'base' })
        if (comparison === 0) comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
        break
      case 'updatedAt': {
        const leftUpdatedAt = left.updatedAt ? Date.parse(left.updatedAt) : 0
        const rightUpdatedAt = right.updatedAt ? Date.parse(right.updatedAt) : 0
        comparison = leftUpdatedAt - rightUpdatedAt
        if (comparison === 0) comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
        break
      }
    }
    return comparison * directionMultiplier
  })
}

export function toggleSlicingProfileSelection(currentIds: string[], profileId: string): string[] {
  return currentIds.includes(profileId)
    ? currentIds.filter((currentId) => currentId !== profileId)
    : [...currentIds, profileId]
}

export function setAllFilteredSlicingProfilesSelected(
  currentIds: string[],
  filteredProfiles: SlicingProfileSummary[],
  selected: boolean
): string[] {
  const filteredProfileIds = filteredProfiles.map((profile) => profile.id)
  const filteredProfileIdSet = new Set(filteredProfileIds)
  if (selected) return Array.from(new Set([...currentIds, ...filteredProfileIds]))
  return currentIds.filter((profileId) => !filteredProfileIdSet.has(profileId))
}