/**
 * The list of custom presets for ONE profile kind: search, that kind's filter facets, sorting,
 * selection, paging and delete.
 *
 * One panel is mounted per tab, and Joy unmounts the inactive ones — which is what keeps a
 * selection, a page index or a filter from a printer tab leaking into the material tab. Sort
 * order and page size are the deliberate exception: they persist and are shared across kinds,
 * because they are a display preference rather than a property of the list being shown.
 */
import React from 'react'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import { Alert, Button, Chip, FormControl, FormLabel, Select, Stack, Typography } from '@mui/joy'
import { extractErrorMessage, type SlicingProfileSummary } from '@printstream/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../../lib/apiClient'
import {
  DEFAULT_SLICING_PROFILE_SORT_DIRECTION,
  DEFAULT_SLICING_PROFILE_SORT_VALUE,
  setAllFilteredSlicingProfilesSelected,
  sortSlicingProfiles,
  toggleSlicingProfileSelection,
  type SlicingProfileKind,
  type SlicingProfileSortValue
} from '../../../lib/slicingProfileDirectory'
import {
  SLICING_PROFILE_FACETS,
  collectSlicingProfileFacetOptions,
  countActiveSlicingProfileFacets,
  filterSlicingProfilesForKind,
  findSlicingProfileFacet,
  groupSlicingProfilesByFacet,
  type SlicingProfileFacetSelections
} from '../../../lib/slicingProfileFacets'
import { type DirectorySortDirection, type DirectorySortOption } from '../../DirectoryControls'
import { DirectoryPrimaryToolbar, type ModalSafeStickyTop } from '../../DirectoryToolbar'
import { EmptyState } from '../../EmptyState'
import { MultiSelectOption } from '../../MultiSelectOption'
import { PaginatedSection } from '../../PaginationFooter'
import { usePromptDialog } from '../../PromptDialogProvider'
import { usePersistentState } from '../../../hooks/usePersistentState'
import { SlicingProfileRow } from './SlicingProfileRow'

const SLICING_PROFILE_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
type SlicingProfilePageSize = (typeof SLICING_PROFILE_PAGE_SIZE_OPTIONS)[number]

// 'kind' is gone from the sort options: every row in a panel is the same kind now.
const SLICING_PROFILE_SORT_OPTIONS: ReadonlyArray<DirectorySortOption<SlicingProfileSortValue>> = [
  { value: 'updatedAt', label: 'Updated' },
  { value: 'name', label: 'Name' }
]

const SLICING_PROFILE_SORT_KEY = 'printstream.slicingProfiles.sort'
const SLICING_PROFILE_SORT_DIR_KEY = 'printstream.slicingProfiles.sortDir'
const SLICING_PROFILE_PAGE_SIZE_KEY = 'printstream.slicingProfiles.pageSize'

const SLICING_PROFILE_SORT_VALUES = new Set<string>(SLICING_PROFILE_SORT_OPTIONS.map((option) => option.value))

/** Sentinel for the grouping control's "off" state; every other value is a facet id. */
const NO_GROUPING = 'none'

// Coerce stored (or corrupt) preference blobs back into valid values.
function sanitizeSlicingProfileSort(value: unknown): SlicingProfileSortValue {
  return SLICING_PROFILE_SORT_VALUES.has(value as string)
    ? (value as SlicingProfileSortValue)
    : DEFAULT_SLICING_PROFILE_SORT_VALUE
}

function sanitizeSlicingProfileSortDirection(value: unknown): DirectorySortDirection {
  return value === 'asc' || value === 'desc' ? value : DEFAULT_SLICING_PROFILE_SORT_DIRECTION
}

function sanitizeSlicingProfilePageSize(value: unknown): SlicingProfilePageSize {
  return (SLICING_PROFILE_PAGE_SIZE_OPTIONS as readonly number[]).includes(value as number)
    ? (value as SlicingProfilePageSize)
    : SLICING_PROFILE_PAGE_SIZE_OPTIONS[0]
}

export function SlicingProfileKindPanel({ kind, profiles, emptyDescription, stickyTop, stickySurface }: {
  kind: SlicingProfileKind
  /** Every custom profile of this kind, unfiltered. */
  profiles: SlicingProfileSummary[]
  /** Shown when this kind has no custom presets at all (as opposed to none matching). */
  emptyDescription: string
  stickyTop?: ModalSafeStickyTop
  stickySurface?: string
}): JSX.Element {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const [search, setSearch] = React.useState('')
  const [facetSelections, setFacetSelections] = React.useState<SlicingProfileFacetSelections>({})
  // Facet id to group by, or 'none'. Per-kind like the filters (the options differ per kind), so
  // it resets with the panel rather than persisting across tabs.
  const [groupFacetId, setGroupFacetId] = React.useState<string>(NO_GROUPING)
  const [sortValue, setSortValue] = usePersistentState<SlicingProfileSortValue>(SLICING_PROFILE_SORT_KEY, DEFAULT_SLICING_PROFILE_SORT_VALUE, sanitizeSlicingProfileSort)
  const [sortDirection, setSortDirection] = usePersistentState<DirectorySortDirection>(SLICING_PROFILE_SORT_DIR_KEY, DEFAULT_SLICING_PROFILE_SORT_DIRECTION, sanitizeSlicingProfileSortDirection)
  const [pageSize, setPageSize] = usePersistentState<SlicingProfilePageSize>(SLICING_PROFILE_PAGE_SIZE_KEY, SLICING_PROFILE_PAGE_SIZE_OPTIONS[0], sanitizeSlicingProfilePageSize)
  const [page, setPage] = React.useState(0)
  const [selectionMode, setSelectionMode] = React.useState(false)
  const [selectedProfileIds, setSelectedProfileIds] = React.useState<string[]>([])

  const deleteProfiles = useMutation({
    mutationFn: async (profileIds: string[]) => {
      for (const profileId of profileIds) {
        await apiFetch<void>(`/api/slicing/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' })
      }
    },
    onSuccess: async (_data, deletedProfileIds) => {
      setSelectedProfileIds((current) => current.filter((profileId) => !deletedProfileIds.includes(profileId)))
      await queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
    }
  })
  const deleteError = deleteProfiles.error ? extractErrorMessage(deleteProfiles.error) : null

  const facets = SLICING_PROFILE_FACETS[kind]
  // Options come from the unfiltered list so picking one filter never empties the other's menu.
  const facetOptions = React.useMemo(() => collectSlicingProfileFacetOptions(profiles, facets), [facets, profiles])
  const activeFilterCount = countActiveSlicingProfileFacets(facetSelections)
  const selectedProfileIdSet = React.useMemo(() => new Set(selectedProfileIds), [selectedProfileIds])

  const filteredProfiles = React.useMemo(
    () => filterSlicingProfilesForKind(profiles, kind, search, facetSelections),
    [facetSelections, kind, profiles, search]
  )
  const sortedProfiles = React.useMemo(
    () => sortSlicingProfiles(filteredProfiles, sortValue, sortDirection),
    [filteredProfiles, sortDirection, sortValue]
  )

  const groupFacet = findSlicingProfileFacet(kind, groupFacetId)
  // Grouped mode shows every match under its group heading and drops paging, matching the spool
  // library (`plugins/filament-manager/SpoolResults.tsx`) — paging a grouped list would cut
  // groups in half.
  const groups = React.useMemo(
    () => groupFacet ? groupSlicingProfilesByFacet(sortedProfiles, groupFacet) : null,
    [groupFacet, sortedProfiles]
  )

  const pageCount = Math.max(1, Math.ceil(sortedProfiles.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleProfiles = React.useMemo(() => {
    const start = safePage * pageSize
    return sortedProfiles.slice(start, start + pageSize)
  }, [pageSize, safePage, sortedProfiles])

  const selectedProfiles = React.useMemo(
    () => profiles.filter((profile) => selectedProfileIdSet.has(profile.id)),
    [profiles, selectedProfileIdSet]
  )
  const selectedFilteredCount = filteredProfiles.filter((profile) => selectedProfileIdSet.has(profile.id)).length
  const allFilteredProfilesSelected = filteredProfiles.length > 0 && selectedFilteredCount === filteredProfiles.length
  const singleDeletingProfileId = deleteProfiles.isPending && deleteProfiles.variables?.length === 1
    ? deleteProfiles.variables[0] ?? null
    : null

  // A deleted profile must not linger in the selection, and an emptied list must not stay in
  // selection mode with no way out.
  React.useEffect(() => {
    const profileIdSet = new Set(profiles.map((profile) => profile.id))
    setSelectedProfileIds((current) => {
      const next = current.filter((profileId) => profileIdSet.has(profileId))
      return next.length === current.length ? current : next
    })
    if (profiles.length === 0) setSelectionMode(false)
  }, [profiles])

  function setFacetValues(facetId: string, values: string[]) {
    setPage(0)
    setFacetSelections((current) => ({ ...current, [facetId]: values }))
  }

  function clearFilters() {
    setPage(0)
    setFacetSelections({})
  }

  function resetSearchAndFilters() {
    setSearch('')
    clearFilters()
  }

  async function handleDeleteProfile(profile: SlicingProfileSummary) {
    const confirmed = await confirm({
      title: 'Delete profile?',
      description: `Delete ${profile.name}?`,
      confirmLabel: 'Delete profile',
      color: 'danger'
    })
    if (!confirmed) return
    deleteProfiles.mutate([profile.id])
  }

  async function handleDeleteSelectedProfiles() {
    if (selectedProfiles.length === 0) return
    const confirmed = await confirm({
      title: 'Delete selected profiles?',
      description: selectedProfiles.length === 1
        ? `Delete ${selectedProfiles[0]?.name ?? 'this profile'}?`
        : `Delete ${selectedProfiles.length} selected profiles?`,
      confirmLabel: 'Delete selected',
      color: 'danger'
    })
    if (!confirmed) return
    await deleteProfiles.mutateAsync(selectedProfiles.map((profile) => profile.id))
    setSelectionMode(false)
  }

  // Shared by both result modes. In grouped mode a profile can render in several groups; keying
  // on the id stays valid because a facet's values are deduped, so it appears once per group.
  function renderProfileRow(profile: SlicingProfileSummary) {
    return (
      <SlicingProfileRow
        key={profile.id}
        profile={profile}
        selectionMode={selectionMode}
        selected={selectedProfileIdSet.has(profile.id)}
        deleting={singleDeletingProfileId === profile.id}
        onToggleSelected={() => setSelectedProfileIds((current) => toggleSlicingProfileSelection(current, profile.id))}
        onDelete={() => void handleDeleteProfile(profile)}
      />
    )
  }

  if (profiles.length === 0) {
    return <EmptyState compact icon={<SearchRoundedIcon />} title="No custom profiles yet" description={emptyDescription} />
  }

  return (
    <Stack spacing={1.25}>
      {deleteError && <Alert color="danger">{deleteError}</Alert>}

      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {!selectionMode && filteredProfiles.length > 0 && (
          <Button size="sm" variant="soft" onClick={() => setSelectionMode(true)}>Select...</Button>
        )}
        {selectionMode && (
          <>
            <Chip size="sm" variant="soft" color="neutral">{selectedProfiles.length} selected</Chip>
            <Button
              size="sm"
              variant="soft"
              onClick={() => setSelectedProfileIds((current) => setAllFilteredSlicingProfilesSelected(current, filteredProfiles, !allFilteredProfilesSelected))}
              disabled={filteredProfiles.length === 0 || deleteProfiles.isPending}
            >
              {allFilteredProfilesSelected ? 'Clear all results' : 'Select all results'}
            </Button>
            <Button size="sm" variant="plain" onClick={() => { setSelectionMode(false); setSelectedProfileIds([]) }} disabled={deleteProfiles.isPending}>
              Cancel
            </Button>
            <Button
              size="sm"
              color="danger"
              startDecorator={<DeleteRoundedIcon />}
              disabled={selectedProfiles.length === 0}
              loading={deleteProfiles.isPending && (deleteProfiles.variables?.length ?? 0) > 1}
              onClick={() => void handleDeleteSelectedProfiles()}
            >
              Delete selected{selectedProfiles.length > 0 ? ` (${selectedProfiles.length})` : ''}
            </Button>
          </>
        )}
      </Stack>

      <DirectoryPrimaryToolbar
        stickyTop={stickyTop}
        stickySurface={stickySurface}
        pinStorageKey={`settings.slicingProfiles.${kind}`}
        searchValue={search}
        onSearchChange={(value) => {
          setPage(0)
          setSearch(value)
        }}
        searchPlaceholder="Search profile name"
        searchAriaLabel="Search slicing profiles"
        filters={{
          activeCount: activeFilterCount,
          onClear: clearFilters,
          clearDisabled: activeFilterCount === 0,
          children: facets.map((facet) => {
            const options = facetOptions[facet.id] ?? []
            const selected = facetSelections[facet.id] ?? []
            return (
              <FormControl key={facet.id}>
                <FormLabel>{facet.label}</FormLabel>
                <Select
                  multiple
                  size="sm"
                  value={selected}
                  onChange={(_event, value) => setFacetValues(facet.id, value ?? [])}
                  placeholder={facet.placeholder}
                  disabled={options.length === 0}
                  renderValue={() => selected.length === 0 ? null : selected.join(', ')}
                  slotProps={{ listbox: { disablePortal: true } }}
                >
                  {options.map((option) => (
                    <MultiSelectOption key={option} value={option} selected={selected.includes(option)}>
                      {option}
                    </MultiSelectOption>
                  ))}
                </Select>
              </FormControl>
            )
          })
        }}
        // The same facets serve as group-by options, so each tab groups by exactly what it filters by.
        grouping={{
          value: groupFacetId,
          options: [
            { value: NO_GROUPING, label: 'No grouping' },
            ...facets.map((facet) => ({ value: facet.id, label: facet.label }))
          ],
          onChange: (value) => {
            setPage(0)
            setGroupFacetId(value)
          }
        }}
        pageSizeValue={pageSize}
        pageSizeOptions={SLICING_PROFILE_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} per page` }))}
        onPageSizeChange={(value) => {
          setPage(0)
          setPageSize(value as SlicingProfilePageSize)
        }}
        pageSizeAriaLabel="Profiles per page"
        pageSizeRenderValue={(value) => `${value} per page`}
        sortValue={sortValue}
        sortOptions={SLICING_PROFILE_SORT_OPTIONS}
        onSortValueChange={(value) => {
          setPage(0)
          setSortValue(value as SlicingProfileSortValue)
        }}
        sortDirection={sortDirection}
        onSortDirectionChange={(direction) => {
          setPage(0)
          setSortDirection(direction)
        }}
        sortAriaLabel="Sort slicing profiles by"
      />

      {filteredProfiles.length === 0 ? (
        <EmptyState
          compact
          icon={<SearchRoundedIcon />}
          title="No profiles match"
          description="No custom slicing profiles match the current search or filters."
          action={(search.trim().length > 0 || activeFilterCount > 0) ? (
            <Button size="sm" variant="plain" color="neutral" onClick={resetSearchAndFilters}>
              Clear search and filters
            </Button>
          ) : undefined}
        />
      ) : groups ? (
        <Stack spacing={1.5}>
          {groups.map((group) => (
            <Stack key={group.key} spacing={0.75}>
              <Typography level="title-sm" textColor="text.tertiary">{group.label} · {group.profiles.length}</Typography>
              <Stack spacing={1}>{group.profiles.map(renderProfileRow)}</Stack>
            </Stack>
          ))}
        </Stack>
      ) : (
        <PaginatedSection
          showingLabel={`Showing ${safePage * pageSize + 1}-${Math.min(sortedProfiles.length, (safePage + 1) * pageSize)} of ${sortedProfiles.length}`}
          previousDisabled={safePage === 0}
          nextDisabled={safePage >= pageCount - 1}
          onPrevious={() => setPage((current) => Math.max(0, current - 1))}
          onNext={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          spacing={1.25}
        >
          <Stack spacing={1}>{visibleProfiles.map(renderProfileRow)}</Stack>
        </PaginatedSection>
      )}
    </Stack>
  )
}
