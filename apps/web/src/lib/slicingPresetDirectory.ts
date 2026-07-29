import type { SlicingPresetSummary } from '@printstream/shared'

export type SlicingPresetSortValue = 'updatedAt' | 'name' | 'kind'
export type SlicingPresetKind = SlicingPresetSummary['kind']
export type SlicingPresetSortDirection = 'asc' | 'desc'

export const DEFAULT_SLICING_PRESET_SORT_VALUE: SlicingPresetSortValue = 'name'
export const DEFAULT_SLICING_PRESET_SORT_DIRECTION: SlicingPresetSortDirection = 'asc'

export function formatSlicingPresetKind(kind: SlicingPresetSummary['kind']): string {
  switch (kind) {
    case 'machine': return 'Printer'
    case 'process': return 'Process'
    case 'filament': return 'Material'
  }
}

export function filterSlicingPresets(
  profiles: SlicingPresetSummary[],
  search: string,
  kindFilters: ReadonlyArray<SlicingPresetKind>
): SlicingPresetSummary[] {
  const normalizedSearch = search.trim().toLowerCase()
  return profiles.filter((profile) => {
    if (kindFilters.length > 0 && !kindFilters.includes(profile.kind)) return false
    if (!normalizedSearch) return true
    const searchHaystack = `${profile.name} ${formatSlicingPresetKind(profile.kind)}`.toLowerCase()
    return searchHaystack.includes(normalizedSearch)
  })
}

export function sortSlicingPresets(
  profiles: SlicingPresetSummary[],
  sortValue: SlicingPresetSortValue,
  sortDirection: SlicingPresetSortDirection
): SlicingPresetSummary[] {
  const directionMultiplier = sortDirection === 'asc' ? 1 : -1
  return [...profiles].sort((left, right) => {
    let comparison = 0
    switch (sortValue) {
      case 'name':
        comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
        break
      case 'kind':
        comparison = formatSlicingPresetKind(left.kind).localeCompare(formatSlicingPresetKind(right.kind), undefined, { sensitivity: 'base' })
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

export function toggleSlicingPresetSelection(currentIds: string[], profileId: string): string[] {
  return currentIds.includes(profileId)
    ? currentIds.filter((currentId) => currentId !== profileId)
    : [...currentIds, profileId]
}

export function setAllFilteredSlicingPresetsSelected(
  currentIds: string[],
  filteredProfiles: SlicingPresetSummary[],
  selected: boolean
): string[] {
  const filteredProfileIds = filteredProfiles.map((profile) => profile.id)
  const filteredProfileIdSet = new Set(filteredProfileIds)
  if (selected) return Array.from(new Set([...currentIds, ...filteredProfileIds]))
  return currentIds.filter((profileId) => !filteredProfileIdSet.has(profileId))
}