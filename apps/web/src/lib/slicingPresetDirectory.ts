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
/** Whether a preset belongs to the workspace or ships with the slicer. */
export type SlicingPresetSource = 'custom' | 'builtin'

/**
 * What the preset manager opens a kind's list on: the workspace's own presets. Built-ins outnumber
 * them by orders of magnitude (2000+ materials), so showing everything by default would bury the
 * presets someone came here to manage.
 */
export const DEFAULT_SLICING_PRESET_SOURCES: ReadonlyArray<SlicingPresetSource> = ['custom']

/**
 * ...unless the workspace has never made one of this kind, in which case that default hides
 * everything and the empty state has nothing to offer — "No presets match" with a disabled Clear,
 * over a catalogue of built-ins one un-obvious filter away.
 *
 * A stock install hits this on the Printer tab every time, because printer presets are the one kind
 * most workspaces never customise: the tab read as "there are no printer presets" rather than "you
 * have not customised one yet", and the printer editor behind it was unreachable.
 */
export function defaultSlicingPresetSources(
  profiles: ReadonlyArray<SlicingPresetSummary>
): SlicingPresetSource[] {
  return profiles.some((profile) => profile.source !== 'builtin')
    ? [...DEFAULT_SLICING_PRESET_SOURCES]
    : ['custom', 'builtin']
}

/**
 * Whether the source filter is untouched — order-insensitive, since the Select returns its own.
 * Compared against the RESOLVED default so the "Filters (N)" badge does not count the view the
 * panel opened as.
 */
export function slicingPresetSourcesAreDefault(
  sources: ReadonlyArray<SlicingPresetSource>,
  defaultSources: ReadonlyArray<SlicingPresetSource>
): boolean {
  return sources.length === defaultSources.length && defaultSources.every((source) => sources.includes(source))
}
