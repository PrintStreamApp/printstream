/**
 * The list of custom presets for ONE profile kind: search, that kind's filter facets, sorting,
 * selection, paging and delete.
 *
 * One panel is mounted per tab, and Joy unmounts the inactive ones — which is what keeps a
 * selection, a page index or a filter from a printer tab leaking into the material tab. Sort
 * order and page size are the deliberate exception: they persist and are shared across kinds,
 * because they are a display preference rather than a property of the list being shown.
 */
import React, { lazy, Suspense } from 'react'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import { Alert, Button, Chip, FormControl, FormLabel, Select, Stack, Typography } from '@mui/joy'
import { extractErrorMessage, type SlicingCapabilities, type SlicingPresetSummary } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../../lib/apiClient'
import {
  DEFAULT_SLICING_PRESET_SORT_DIRECTION,
  DEFAULT_SLICING_PRESET_SORT_VALUE,
  setAllFilteredSlicingPresetsSelected,
  sortSlicingPresets,
  toggleSlicingPresetSelection,
  type SlicingPresetKind,
  type SlicingPresetSortValue
} from '../../../lib/slicingPresetDirectory'
import {
  SLICING_PRESET_FACETS,
  collectSlicingPresetFacetOptions,
  countActiveSlicingPresetFacets,
  filterSlicingPresetsForKind,
  findSlicingPresetFacet,
  groupSlicingPresetsByFacet,
  type SlicingPresetFacetSelections
} from '../../../lib/slicingPresetFacets'
import { type DirectorySortDirection, type DirectorySortOption } from '../../DirectoryControls'
import { DirectoryPrimaryToolbar, type ModalSafeStickyTop } from '../../DirectoryToolbar'
import { EmptyState } from '../../EmptyState'
import { LazyDialogFallback } from '../../LazyDialogFallback'

// Code-split like every other host of these dialogs: they pull in the whole settings catalog.
const ProcessSettingsDialog = lazy(() => import('../../ProcessSettingsDialog'))
const FilamentSettingsDialog = lazy(() => import('../../library/FilamentSettingsDialog'))
import { MultiSelectOption } from '../../MultiSelectOption'
import { PaginatedSection } from '../../PaginationFooter'
import { usePromptDialog } from '../../PromptDialogProvider'
import { usePersistentState } from '../../../hooks/usePersistentState'
import { SlicingPresetRow } from './SlicingPresetRow'

const SLICING_PRESET_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
type SlicingPresetPageSize = (typeof SLICING_PRESET_PAGE_SIZE_OPTIONS)[number]

// 'kind' is gone from the sort options: every row in a panel is the same kind now.
const SLICING_PRESET_SORT_OPTIONS: ReadonlyArray<DirectorySortOption<SlicingPresetSortValue>> = [
  { value: 'updatedAt', label: 'Updated' },
  { value: 'name', label: 'Name' }
]

// Legacy `slicingProfiles` spelling reserved: these are persisted per-device display prefs, and
// renaming them would silently reset every user's sort and page size. See the localSlicingPresets note.
const SLICING_PRESET_SORT_KEY = 'printstream.slicingProfiles.sort'
const SLICING_PRESET_SORT_DIR_KEY = 'printstream.slicingProfiles.sortDir'
const SLICING_PRESET_PAGE_SIZE_KEY = 'printstream.slicingProfiles.pageSize'

const SLICING_PRESET_SORT_VALUES = new Set<string>(SLICING_PRESET_SORT_OPTIONS.map((option) => option.value))

/** Sentinel for the grouping control's "off" state; every other value is a facet id. */
const NO_GROUPING = 'none'

// Coerce stored (or corrupt) preference blobs back into valid values.
function sanitizeSlicingPresetSort(value: unknown): SlicingPresetSortValue {
  return SLICING_PRESET_SORT_VALUES.has(value as string)
    ? (value as SlicingPresetSortValue)
    : DEFAULT_SLICING_PRESET_SORT_VALUE
}

function sanitizeSlicingPresetSortDirection(value: unknown): DirectorySortDirection {
  return value === 'asc' || value === 'desc' ? value : DEFAULT_SLICING_PRESET_SORT_DIRECTION
}

function sanitizeSlicingPresetPageSize(value: unknown): SlicingPresetPageSize {
  return (SLICING_PRESET_PAGE_SIZE_OPTIONS as readonly number[]).includes(value as number)
    ? (value as SlicingPresetPageSize)
    : SLICING_PRESET_PAGE_SIZE_OPTIONS[0]
}

export function SlicingPresetKindPanel({ kind, profiles, emptyDescription, stickyTop, stickySurface }: {
  kind: SlicingPresetKind
  /** Every custom profile of this kind, unfiltered. */
  profiles: SlicingPresetSummary[]
  /** Shown when this kind has no custom presets at all (as opposed to none matching). */
  emptyDescription: string
  stickyTop?: ModalSafeStickyTop
  stickySurface?: string
}): JSX.Element {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const [search, setSearch] = React.useState('')
  const [facetSelections, setFacetSelections] = React.useState<SlicingPresetFacetSelections>({})
  // Built-ins outnumber a workspace's own presets by orders of magnitude (thousands of filament
  // profiles), so the manager opens on YOUR presets and browsing the built-ins is one filter away.
  // Kept as a filter rather than a tab or section so the toolbar's search/sort/grouping/paging
  // serves both without being duplicated.
  const [sources, setSources] = React.useState<Array<'custom' | 'builtin'>>(['custom'])
  const [openProfile, setOpenProfile] = React.useState<SlicingPresetSummary | null>(null)
  // A preset's values are resolved against a slicer engine, so the editor needs a target. The
  // manager has no project to take one from, so it uses the capabilities' default.
  const capabilitiesQuery = useQuery({
    queryKey: ['slicing-capabilities'],
    queryFn: ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal }),
    staleTime: 60_000
  })
  const slicerTargetId = capabilitiesQuery.data?.defaultTargetId ?? capabilitiesQuery.data?.targets[0]?.id ?? ''
  // Facet id to group by, or 'none'. Per-kind like the filters (the options differ per kind), so
  // it resets with the panel rather than persisting across tabs.
  const [groupFacetId, setGroupFacetId] = React.useState<string>(NO_GROUPING)
  const [sortValue, setSortValue] = usePersistentState<SlicingPresetSortValue>(SLICING_PRESET_SORT_KEY, DEFAULT_SLICING_PRESET_SORT_VALUE, sanitizeSlicingPresetSort)
  const [sortDirection, setSortDirection] = usePersistentState<DirectorySortDirection>(SLICING_PRESET_SORT_DIR_KEY, DEFAULT_SLICING_PRESET_SORT_DIRECTION, sanitizeSlicingPresetSortDirection)
  const [pageSize, setPageSize] = usePersistentState<SlicingPresetPageSize>(SLICING_PRESET_PAGE_SIZE_KEY, SLICING_PRESET_PAGE_SIZE_OPTIONS[0], sanitizeSlicingPresetPageSize)
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

  const facets = SLICING_PRESET_FACETS[kind]
  // Options come from the unfiltered list so picking one filter never empties the other's menu.
  const facetOptions = React.useMemo(() => collectSlicingPresetFacetOptions(profiles, facets), [facets, profiles])
  // The source filter counts as active whenever it is not showing everything.
  const activeFilterCount = countActiveSlicingPresetFacets(facetSelections) + (sources.length === 2 || sources.length === 0 ? 0 : 1)
  const selectedProfileIdSet = React.useMemo(() => new Set(selectedProfileIds), [selectedProfileIds])

  const filteredProfiles = React.useMemo(
    () => filterSlicingPresetsForKind(
      sources.length === 0 ? profiles : profiles.filter((profile) => sources.includes(profile.source === 'builtin' ? 'builtin' : 'custom')),
      kind, search, facetSelections
    ),
    [facetSelections, kind, profiles, search, sources]
  )
  const sortedProfiles = React.useMemo(
    () => sortSlicingPresets(filteredProfiles, sortValue, sortDirection),
    [filteredProfiles, sortDirection, sortValue]
  )

  const groupFacet = findSlicingPresetFacet(kind, groupFacetId)
  // Grouped mode shows every match under its group heading and drops paging, matching the spool
  // library (`plugins/filament-manager/SpoolResults.tsx`) — paging a grouped list would cut
  // groups in half.
  const groups = React.useMemo(
    () => groupFacet ? groupSlicingPresetsByFacet(sortedProfiles, groupFacet) : null,
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
    // Back to the default view (your own presets), not to "everything" — clearing should return
    // the manager to what it opens as.
    setSources(['custom'])
  }

  function resetSearchAndFilters() {
    setSearch('')
    clearFilters()
  }

  async function handleDeleteProfile(profile: SlicingPresetSummary) {
    const confirmed = await confirm({
      title: 'Delete preset?',
      description: `Delete ${profile.name}?`,
      confirmLabel: 'Delete preset',
      color: 'danger'
    })
    if (!confirmed) return
    deleteProfiles.mutate([profile.id])
  }

  async function handleDeleteSelectedProfiles() {
    if (selectedProfiles.length === 0) return
    const confirmed = await confirm({
      title: 'Delete selected presets?',
      description: selectedProfiles.length === 1
        ? `Delete ${selectedProfiles[0]?.name ?? 'this preset'}?`
        : `Delete ${selectedProfiles.length} selected presets?`,
      confirmLabel: 'Delete selected',
      color: 'danger'
    })
    if (!confirmed) return
    await deleteProfiles.mutateAsync(selectedProfiles.map((profile) => profile.id))
    setSelectionMode(false)
  }

  // Shared by both result modes. In grouped mode a profile can render in several groups; keying
  // on the id stays valid because a facet's values are deduped, so it appears once per group.
  function renderProfileRow(profile: SlicingPresetSummary) {
    return (
      <SlicingPresetRow
        key={profile.id}
        profile={profile}
        selectionMode={selectionMode}
        selected={selectedProfileIdSet.has(profile.id)}
        deleting={singleDeletingProfileId === profile.id}
        onToggleSelected={() => setSelectedProfileIds((current) => toggleSlicingPresetSelection(current, profile.id))}
        onDelete={() => void handleDeleteProfile(profile)}
        // Machine presets have no editor yet, so their rows carry no open action.
        onOpen={profile.kind === 'machine' || !slicerTargetId ? undefined : () => setOpenProfile(profile)}
      />
    )
  }

  const editor = openProfile && (
    <Suspense fallback={<LazyDialogFallback label="Opening preset…" />}>
      {openProfile.kind === 'filament' ? (
      <FilamentSettingsDialog
        open
        onClose={() => setOpenProfile(null)}
        slicerTargetId={slicerTargetId}
        filamentProfileId={openProfile.id}
        filamentProfileName={openProfile.name}
        sourceFileId={null}
        // Null, not 0: there is no project slot here, and the request schema requires a POSITIVE
        // slot index — 0 failed validation and the dialog opened empty with "Number must be
        // greater than 0".
        projectFilamentId={null}
        initialOverrides={{}}
        applyScope="preset"
        // A built-in is editable but can only be saved as a NEW user preset, the way BambuStudio
        // treats a system preset; the workspace's own can be updated in place.
        canEditOriginal={openProfile.source === 'custom'}
      />
      ) : openProfile.kind === 'process' ? (
      <ProcessSettingsDialog
        open
        onClose={() => setOpenProfile(null)}
        slicerTargetId={slicerTargetId}
        processProfileId={openProfile.id}
        processProfileName={openProfile.name}
        sourceFileId={null}
        initialOverrides={{}}
        applyScope="preset"
        canEditOriginal={openProfile.source === 'custom'}
      />
      ) : null}
    </Suspense>
  )

  // The kind has no presets at all — not even built-ins, so the slicer has nothing installed.
  if (profiles.length === 0) {
    return <EmptyState compact icon={<SearchRoundedIcon />} title="No presets yet" description={emptyDescription} />
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
              onClick={() => setSelectedProfileIds((current) => setAllFilteredSlicingPresetsSelected(current, filteredProfiles, !allFilteredProfilesSelected))}
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
        pinStorageKey={`settings.slicingPresets.${kind}`}
        searchValue={search}
        onSearchChange={(value) => {
          setPage(0)
          setSearch(value)
        }}
        searchPlaceholder="Search preset name"
        searchAriaLabel="Search slicing presets"
        filters={{
          activeCount: activeFilterCount,
          onClear: clearFilters,
          clearDisabled: activeFilterCount === 0,
          children: [
            <FormControl key="__source">
              <FormLabel>Source</FormLabel>
              <Select
                multiple
                size="sm"
                value={sources}
                onChange={(_event, value) => { setPage(0); setSources((value ?? []) as Array<'custom' | 'builtin'>) }}
                placeholder="All sources"
                renderValue={() => sources.length === 0 ? null : sources.map((source) => source === 'custom' ? 'User presets' : 'Built-in presets').join(', ')}
                slotProps={{ listbox: { disablePortal: true } }}
              >
                <MultiSelectOption value="custom" selected={sources.includes('custom')}>User presets</MultiSelectOption>
                <MultiSelectOption value="builtin" selected={sources.includes('builtin')}>Built-in presets</MultiSelectOption>
              </Select>
            </FormControl>,
            ...facets.map((facet) => {
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
          ]
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
        pageSizeOptions={SLICING_PRESET_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} per page` }))}
        onPageSizeChange={(value) => {
          setPage(0)
          setPageSize(value as SlicingPresetPageSize)
        }}
        pageSizeAriaLabel="Presets per page"
        pageSizeRenderValue={(value) => `${value} per page`}
        sortValue={sortValue}
        sortOptions={SLICING_PRESET_SORT_OPTIONS}
        onSortValueChange={(value) => {
          setPage(0)
          setSortValue(value as SlicingPresetSortValue)
        }}
        sortDirection={sortDirection}
        onSortDirectionChange={(direction) => {
          setPage(0)
          setSortDirection(direction)
        }}
        sortAriaLabel="Sort slicing presets by"
      />

      {filteredProfiles.length === 0 ? (
        <EmptyState
          compact
          icon={<SearchRoundedIcon />}
          title="No presets match"
          description="No custom slicing presets match the current search or filters."
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
              <Stack spacing={0}>{group.profiles.map(renderProfileRow)}</Stack>
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
          <Stack spacing={0}>{visibleProfiles.map(renderProfileRow)}</Stack>
        </PaginatedSection>
      )}
      {editor}
    </Stack>
  )
}
