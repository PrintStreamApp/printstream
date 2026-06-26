import React from 'react'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import FileUploadRoundedIcon from '@mui/icons-material/FileUploadRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import { Alert, Box, Button, Card, CardContent, Checkbox, Chip, FormControl, FormLabel, Select, Stack, Typography } from '@mui/joy'
import {
  extractErrorMessage,
  type SlicingProfileResponse,
  type SlicingProfilesResponse,
  type SlicingProfileSummary,
  type UploadSlicingProfile
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch } from '../../lib/apiClient'
import {
  DEFAULT_SLICING_PROFILE_SORT_DIRECTION,
  DEFAULT_SLICING_PROFILE_SORT_VALUE,
  filterSlicingProfiles,
  formatSlicingProfileKind,
  setAllFilteredSlicingProfilesSelected,
  sortSlicingProfiles,
  toggleSlicingProfileSelection,
  type SlicingProfileKind,
  type SlicingProfileSortValue
} from '../../lib/slicingProfileDirectory'
import { type DirectorySortDirection, type DirectorySortOption } from '../DirectoryControls'
import { DirectoryPrimaryToolbar } from '../DirectoryToolbar'
import { EmptyState } from '../EmptyState'
import { MultiSelectOption } from '../MultiSelectOption'
import { PaginatedSection } from '../PaginationFooter'
import { usePromptDialog } from '../PromptDialogProvider'
import { usePersistentState } from '../../hooks/usePersistentState'

const SLICING_PROFILE_PAGE_SIZE_OPTIONS = [10, 25, 50] as const
type SlicingProfilePageSize = (typeof SLICING_PROFILE_PAGE_SIZE_OPTIONS)[number]
const SLICING_PROFILE_SORT_OPTIONS: ReadonlyArray<DirectorySortOption<SlicingProfileSortValue>> = [
  { value: 'updatedAt', label: 'Updated' },
  { value: 'name', label: 'Name' },
  { value: 'kind', label: 'Type' }
]

// Persist the directory controls (sort, type filter, page size) across reloads;
// search text, page index, and selection state stay ephemeral.
const SLICING_PROFILE_SORT_KEY = 'printstream.slicingProfiles.sort'
const SLICING_PROFILE_SORT_DIR_KEY = 'printstream.slicingProfiles.sortDir'
const SLICING_PROFILE_TYPE_FILTER_KEY = 'printstream.slicingProfiles.typeFilter'
const SLICING_PROFILE_PAGE_SIZE_KEY = 'printstream.slicingProfiles.pageSize'

const SLICING_PROFILE_SORT_VALUES = new Set<string>(SLICING_PROFILE_SORT_OPTIONS.map((option) => option.value))
const SLICING_PROFILE_KINDS = new Set<string>(['machine', 'process', 'filament'])

// Coerce stored (or corrupt) preference blobs back into valid values, falling
// back per field to the same defaults the directory controls start with.
function sanitizeSlicingProfileSort(value: unknown): SlicingProfileSortValue {
  return SLICING_PROFILE_SORT_VALUES.has(value as string)
    ? (value as SlicingProfileSortValue)
    : DEFAULT_SLICING_PROFILE_SORT_VALUE
}

function sanitizeSlicingProfileSortDirection(value: unknown): DirectorySortDirection {
  return value === 'asc' || value === 'desc' ? value : DEFAULT_SLICING_PROFILE_SORT_DIRECTION
}

function sanitizeSlicingProfileKindFilters(value: unknown): SlicingProfileKind[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is SlicingProfileKind => SLICING_PROFILE_KINDS.has(entry as string))
}

function sanitizeSlicingProfilePageSize(value: unknown): SlicingProfilePageSize {
  return (SLICING_PROFILE_PAGE_SIZE_OPTIONS as readonly number[]).includes(value as number)
    ? (value as SlicingProfilePageSize)
    : SLICING_PROFILE_PAGE_SIZE_OPTIONS[0]
}

export function SlicingProfilesSettingsSection() {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')
  const [kindFilters, setKindFilters] = usePersistentState<SlicingProfileKind[]>(SLICING_PROFILE_TYPE_FILTER_KEY, [], sanitizeSlicingProfileKindFilters)
  const [sortValue, setSortValue] = usePersistentState<SlicingProfileSortValue>(SLICING_PROFILE_SORT_KEY, DEFAULT_SLICING_PROFILE_SORT_VALUE, sanitizeSlicingProfileSort)
  const [sortDirection, setSortDirection] = usePersistentState<DirectorySortDirection>(SLICING_PROFILE_SORT_DIR_KEY, DEFAULT_SLICING_PROFILE_SORT_DIRECTION, sanitizeSlicingProfileSortDirection)
  const [pageSize, setPageSize] = usePersistentState<SlicingProfilePageSize>(SLICING_PROFILE_PAGE_SIZE_KEY, SLICING_PROFILE_PAGE_SIZE_OPTIONS[0], sanitizeSlicingProfilePageSize)
  const [page, setPage] = React.useState(0)
  const [selectionMode, setSelectionMode] = React.useState(false)
  const [selectedProfileIds, setSelectedProfileIds] = React.useState<string[]>([])
  const profilesQuery = useQuery({
    queryKey: ['slicing-profiles'],
    queryFn: ({ signal }) => apiFetch<SlicingProfilesResponse>('/api/slicing/profiles', { signal })
  })
  const uploadProfile = useMutation({
    // Errors (incl. the 409 same-name conflict) are handled locally in handleUploadFile, so opt out
    // of the global mutation-error toast.
    meta: { suppressGlobalErrorToast: true },
    mutationFn: async ({ file, overwrite }: { file: File; overwrite?: boolean }) => {
      return await apiFetch<SlicingProfileResponse>('/api/slicing/profiles', {
        method: 'POST',
        body: await buildSlicingProfileUpload(file, overwrite)
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] })
    }
  })
  /**
   * Uploads a profile, asking the user to confirm before overwriting any existing same-name preset
   * (the server reports the collision as a 409 instead of replacing silently).
   */
  const handleUploadFile = async (file: File) => {
    setUploadError(null)
    try {
      await uploadProfile.mutateAsync({ file })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const conflicts = Array.isArray((error.payload as { conflicts?: unknown })?.conflicts)
          ? (error.payload as { conflicts: string[] }).conflicts
          : []
        const confirmed = await confirm({
          title: 'Replace existing presets?',
          description: conflicts.length > 0
            ? (
              <Stack spacing={0.75}>
                <Typography level="body-sm">
                  Uploading "{file.name}" will overwrite {conflicts.length > 1 ? 'these existing presets' : 'this existing preset'}:
                </Typography>
                <Stack spacing={0.25}>
                  {conflicts.map((name) => (
                    <Typography key={name} level="body-sm" sx={{ fontWeight: 'lg' }}>{name}</Typography>
                  ))}
                </Stack>
              </Stack>
            )
            : `Uploading "${file.name}" will overwrite an existing preset.`,
          confirmLabel: 'Replace',
          color: 'warning'
        })
        if (!confirmed) return
        try {
          await uploadProfile.mutateAsync({ file, overwrite: true })
        } catch (retryError) {
          setUploadError(extractErrorMessage(retryError))
        }
        return
      }
      setUploadError(extractErrorMessage(error))
    }
  }
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
  const customProfiles = (profilesQuery.data?.profiles ?? []).filter((profile) => profile.source === 'custom')
  const builtinCounts = countProfilesByKind((profilesQuery.data?.profiles ?? []).filter((profile) => profile.source === 'builtin'))
  const listError = profilesQuery.error ? extractErrorMessage(profilesQuery.error) : null
  const deleteError = deleteProfiles.error ? extractErrorMessage(deleteProfiles.error) : null
  const activeFilterCount = Number(kindFilters.length > 0)
  const selectedProfileIdSet = React.useMemo(() => new Set(selectedProfileIds), [selectedProfileIds])

  React.useEffect(() => {
    const customProfileIdSet = new Set(customProfiles.map((profile) => profile.id))
    setSelectedProfileIds((current) => {
      const next = current.filter((profileId) => customProfileIdSet.has(profileId))
      return next.length === current.length ? current : next
    })
    if (customProfiles.length === 0) {
      setSelectionMode(false)
    }
  }, [customProfiles])

  const filteredProfiles = React.useMemo(
    () => filterSlicingProfiles(customProfiles, search, kindFilters),
    [customProfiles, kindFilters, search]
  )

  const sortedProfiles = React.useMemo(
    () => sortSlicingProfiles(filteredProfiles, sortValue, sortDirection),
    [filteredProfiles, sortDirection, sortValue]
  )

  const pageCount = Math.max(1, Math.ceil(sortedProfiles.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleProfiles = React.useMemo(() => {
    const start = safePage * pageSize
    return sortedProfiles.slice(start, start + pageSize)
  }, [pageSize, safePage, sortedProfiles])
  const selectedProfiles = React.useMemo(
    () => customProfiles.filter((profile) => selectedProfileIdSet.has(profile.id)),
    [customProfiles, selectedProfileIdSet]
  )
  const selectedFilteredCount = filteredProfiles.filter((profile) => selectedProfileIdSet.has(profile.id)).length
  const allFilteredProfilesSelected = filteredProfiles.length > 0 && selectedFilteredCount === filteredProfiles.length
  const singleDeletingProfileId = deleteProfiles.isPending && deleteProfiles.variables?.length === 1
    ? deleteProfiles.variables[0] ?? null
    : null

  function clearFilters() {
    setPage(0)
    setKindFilters([])
  }

  function resetSearchAndFilters() {
    setPage(0)
    setSearch('')
    setKindFilters([])
  }

  function toggleProfileSelection(profileId: string) {
    setSelectedProfileIds((current) => toggleSlicingProfileSelection(current, profileId))
  }

  function setAllFilteredProfilesSelected(selected: boolean) {
    setSelectedProfileIds((current) => setAllFilteredSlicingProfilesSelected(current, filteredProfiles, selected))
  }

  function clearSelection() {
    setSelectionMode(false)
    setSelectedProfileIds([])
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

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography level="title-md">Slicing profiles</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Upload BambuStudio presets for printer settings, filament settings, and quality/process settings.
        </Typography>
      </Box>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.25}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
              <Stack spacing={0.5}>
                <Typography level="title-sm">Upload BambuStudio presets</Typography>
                <Typography level="body-sm" textColor="text.tertiary">
                  Upload `.json`, `.bbscfg`, `.bbsflmt`, or preset `.zip` exports. Profile kinds are auto-detected from the file using BambuStudio's own preset rules.
                </Typography>
              </Stack>
              <Button loading={uploadProfile.isPending} onClick={() => inputRef.current?.click()}>
                Upload presets
              </Button>
            </Stack>
            <Box
              component="input"
              type="file"
              accept="application/json,.json,.bbscfg,.bbsflmt,.zip"
              ref={inputRef}
              sx={{ display: 'none' }}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (!file) return
                void handleUploadFile(file)
              }}
            />
            {(uploadError || deleteError) && <Alert color="danger">{uploadError ?? deleteError}</Alert>}
          </Stack>
        </CardContent>
      </Card>

      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Chip size="sm" variant="soft">Built-in printer profiles: {builtinCounts.machine}</Chip>
        <Chip size="sm" variant="soft">Built-in quality profiles: {builtinCounts.process}</Chip>
        <Chip size="sm" variant="soft">Built-in material profiles: {builtinCounts.filament}</Chip>
      </Stack>

      {listError && <Alert color="danger">{listError}</Alert>}
      {!listError && customProfiles.length === 0 ? (
        <EmptyState
          compact
          icon={<FileUploadRoundedIcon />}
          title="No custom profiles yet"
          description="Upload BambuStudio presets above to keep printer, material, and quality profiles ready for server-side slicing."
        />
      ) : (
        <Stack spacing={1.25}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'center' }}
          >
            <Typography level="title-sm">Custom profiles</Typography>
            {filteredProfiles.length > 0 && !selectionMode && (
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}>
                <Button size="sm" variant="soft" onClick={() => setSelectionMode(true)}>
                  Select...
                </Button>
              </Stack>
            )}
            {selectionMode && (
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}>
                <Chip size="sm" variant="soft" color="neutral">
                  {selectedProfiles.length} selected
                </Chip>
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => setAllFilteredProfilesSelected(!allFilteredProfilesSelected)}
                  disabled={filteredProfiles.length === 0 || deleteProfiles.isPending}
                >
                  {allFilteredProfilesSelected ? 'Clear all results' : 'Select all results'}
                </Button>
                <Button size="sm" variant="plain" onClick={clearSelection} disabled={deleteProfiles.isPending}>
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
              </Stack>
            )}
          </Stack>

          <DirectoryPrimaryToolbar
            pinStorageKey="settings.slicingProfiles"
            searchValue={search}
            onSearchChange={(value) => {
              setPage(0)
              setSearch(value)
            }}
            searchPlaceholder="Search profile name or type"
            searchAriaLabel="Search slicing profiles"
            filters={{
              activeCount: activeFilterCount,
              onClear: clearFilters,
              clearDisabled: activeFilterCount === 0,
              children: (
                <FormControl>
                  <FormLabel>Profile type</FormLabel>
                  <Select
                    multiple
                    size="sm"
                    value={kindFilters}
                    onChange={(_event, value) => {
                      setPage(0)
                      setKindFilters(value ?? [])
                    }}
                    placeholder="All profile types"
                    renderValue={() => kindFilters.length === 0 ? null : kindFilters.map((kind) => formatSlicingProfileKind(kind)).join(', ')}
                    slotProps={{ listbox: { disablePortal: true } }}
                  >
                    <MultiSelectOption value="machine" selected={kindFilters.includes('machine')}>Printer</MultiSelectOption>
                    <MultiSelectOption value="process" selected={kindFilters.includes('process')}>Quality</MultiSelectOption>
                    <MultiSelectOption value="filament" selected={kindFilters.includes('filament')}>Material</MultiSelectOption>
                  </Select>
                </FormControl>
              )
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
          ) : (
            <PaginatedSection
              showingLabel={`Showing ${safePage * pageSize + 1}-${Math.min(sortedProfiles.length, (safePage + 1) * pageSize)} of ${sortedProfiles.length}`}
              previousDisabled={safePage === 0}
              nextDisabled={safePage >= pageCount - 1}
              onPrevious={() => setPage((current) => Math.max(0, current - 1))}
              onNext={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              spacing={1.25}
            >
              <Stack spacing={1}>
                {visibleProfiles.map((profile) => (
                  <SlicingProfileRow
                    key={profile.id}
                    profile={profile}
                    selectionMode={selectionMode}
                    selected={selectedProfileIdSet.has(profile.id)}
                    deleting={singleDeletingProfileId === profile.id}
                    onToggleSelected={() => toggleProfileSelection(profile.id)}
                    onDelete={() => void handleDeleteProfile(profile)}
                  />
                ))}
              </Stack>
            </PaginatedSection>
          )}
        </Stack>
      )}
    </Stack>
  )
}

function SlicingProfileRow({
  profile,
  selectionMode,
  selected,
  deleting,
  onToggleSelected,
  onDelete
}: {
  profile: SlicingProfileSummary
  selectionMode: boolean
  selected: boolean
  deleting: boolean
  onToggleSelected: () => void
  onDelete: () => void
}) {
  return (
    <Card variant="soft">
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
          <Stack direction="row" spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }} sx={{ minWidth: 0, flex: 1 }}>
            {selectionMode && (
              <Checkbox
                checked={selected}
                onChange={() => onToggleSelected()}
                slotProps={{ input: { 'aria-label': `Select ${profile.name}` } }}
              />
            )}
            <Stack spacing={0.35} sx={{ minWidth: 0, flex: 1 }}>
              <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Typography level="title-sm" sx={{ minWidth: 0 }}>{profile.name}</Typography>
                <Chip size="sm" variant="soft">{formatSlicingProfileKind(profile.kind)}</Chip>
              </Stack>
              {profile.updatedAt && (
                <Typography level="body-xs" textColor="text.tertiary">
                  Updated {new Date(profile.updatedAt).toLocaleString()}
                </Typography>
              )}
            </Stack>
          </Stack>
          {!selectionMode ? <Button size="sm" variant="plain" color="danger" loading={deleting} onClick={onDelete}>Delete</Button> : null}
        </Stack>
      </CardContent>
    </Card>
  )
}

function countProfilesByKind(profiles: SlicingProfileSummary[]): Record<SlicingProfileSummary['kind'], number> {
  return profiles.reduce<Record<SlicingProfileSummary['kind'], number>>((counts, profile) => {
    counts[profile.kind] += 1
    return counts
  }, { machine: 0, process: 0, filament: 0 })
}

async function buildSlicingProfileUpload(file: File, overwrite = false): Promise<UploadSlicingProfile> {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.json')) {
    return {
      fileName: file.name,
      encoding: 'utf8',
      content: await file.text(),
      overwrite
    }
  }

  return {
    fileName: file.name,
    encoding: 'base64',
    content: encodeFileBase64(new Uint8Array(await file.arrayBuffer())),
    overwrite
  }
}

function encodeFileBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}
