/**
 * The slicing-profile manager: upload BambuStudio presets and manage the custom ones.
 *
 * Presets are split onto a tab per kind (printer / quality / material) because the three carry
 * different metadata and so need different filters — a nozzle diameter means nothing to a
 * material preset. Each tab owns its own search, filters, selection and paging
 * (`SlicingProfileKindPanel`); this shell owns only the query, the upload card and the tabs.
 *
 * Rendered inside the editor settings dialog (`components/library/EditorSettingsDialog.tsx`),
 * which is a scroll container of its own — hence the sticky props passed through to the toolbar.
 */
import React from 'react'
import FileUploadRoundedIcon from '@mui/icons-material/FileUploadRounded'
import { Alert, Box, Chip, Stack, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy'
import { extractErrorMessage, type SlicingProfilesResponse, type SlicingProfileSummary } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../../lib/apiClient'
import { formatSlicingProfileKind, type SlicingProfileKind } from '../../../lib/slicingProfileDirectory'
import { type ModalSafeStickyTop } from '../../DirectoryToolbar'
import { EmptyState } from '../../EmptyState'
import { usePersistentState } from '../../../hooks/usePersistentState'
import { SlicingProfileKindPanel } from './SlicingProfileKindPanel'
import { SlicingProfileUploadCard } from './SlicingProfileUploadCard'

const SLICING_PROFILE_KIND_TAB_KEY = 'printstream.slicingProfiles.kindTab'

const PROFILE_KINDS: ReadonlyArray<{ kind: SlicingProfileKind; emptyDescription: string }> = [
  { kind: 'machine', emptyDescription: 'Upload a BambuStudio printer preset to slice with your own machine settings.' },
  { kind: 'process', emptyDescription: 'Upload a BambuStudio quality preset to slice with your own layer and speed settings.' },
  { kind: 'filament', emptyDescription: 'Upload a BambuStudio filament preset to slice with your own material settings.' }
]

function sanitizeSlicingProfileKindTab(value: unknown): SlicingProfileKind {
  return PROFILE_KINDS.some((entry) => entry.kind === value) ? (value as SlicingProfileKind) : 'machine'
}

export function SlicingProfilesSettingsSection({ stickyTop, stickySurface }: {
  /** Passed through to each tab's toolbar pinned offset; see DirectoryPrimaryToolbar. */
  stickyTop?: ModalSafeStickyTop
  /** Passed through to the pinned toolbar's background; see DirectoryPrimaryToolbar. */
  stickySurface?: string
} = {}): JSX.Element {
  const [activeKind, setActiveKind] = usePersistentState<SlicingProfileKind>(SLICING_PROFILE_KIND_TAB_KEY, 'machine', sanitizeSlicingProfileKindTab)
  const profilesQuery = useQuery({
    queryKey: ['slicing-profiles'],
    queryFn: ({ signal }) => apiFetch<SlicingProfilesResponse>('/api/slicing/profiles', { signal })
  })

  const allProfiles = React.useMemo(() => profilesQuery.data?.profiles ?? [], [profilesQuery.data])
  const customByKind = React.useMemo(() => groupProfilesByKind(allProfiles.filter((profile) => profile.source === 'custom')), [allProfiles])
  const builtinByKind = React.useMemo(() => groupProfilesByKind(allProfiles.filter((profile) => profile.source === 'builtin')), [allProfiles])
  const listError = profilesQuery.error ? extractErrorMessage(profilesQuery.error) : null
  const hasCustomProfiles = PROFILE_KINDS.some((entry) => customByKind[entry.kind].length > 0)

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography level="title-md">Slicing profiles</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Upload BambuStudio presets for printer settings, filament settings, and quality/process settings.
        </Typography>
      </Box>

      <SlicingProfileUploadCard />

      {listError && <Alert color="danger">{listError}</Alert>}
      {!listError && !hasCustomProfiles ? (
        <EmptyState
          compact
          icon={<FileUploadRoundedIcon />}
          title="No custom profiles yet"
          description="Upload BambuStudio presets above to keep printer, material, and quality profiles ready for server-side slicing."
        />
      ) : !listError && (
        <Tabs
          value={activeKind}
          onChange={(_event, value) => setActiveKind(sanitizeSlicingProfileKindTab(value))}
          sx={{ bgcolor: 'transparent' }}
        >
          <TabList size="sm" variant="soft" sx={{ borderRadius: 'sm' }}>
            {PROFILE_KINDS.map(({ kind }) => (
              <Tab key={kind} value={kind}>
                {formatSlicingProfileKind(kind)}
                <Chip size="sm" variant="soft" sx={{ ml: 0.75 }}>{customByKind[kind].length}</Chip>
              </Tab>
            ))}
          </TabList>
          {PROFILE_KINDS.map(({ kind, emptyDescription }) => (
            // Inactive panels unmount, which is what resets a tab's filters/selection/page.
            <TabPanel key={kind} value={kind} sx={{ px: 0, pb: 0 }}>
              <Stack spacing={1.25}>
                <SlicingProfileKindPanel
                  kind={kind}
                  profiles={customByKind[kind]}
                  emptyDescription={emptyDescription}
                  stickyTop={stickyTop}
                  stickySurface={stickySurface}
                />
                <Typography level="body-xs" textColor="text.tertiary">
                  {builtinByKind[kind].length} built-in {formatSlicingProfileKind(kind).toLowerCase()} profiles are also available for slicing.
                </Typography>
              </Stack>
            </TabPanel>
          ))}
        </Tabs>
      )}
    </Stack>
  )
}

function groupProfilesByKind(profiles: SlicingProfileSummary[]): Record<SlicingProfileKind, SlicingProfileSummary[]> {
  const grouped: Record<SlicingProfileKind, SlicingProfileSummary[]> = { machine: [], process: [], filament: [] }
  for (const profile of profiles) grouped[profile.kind].push(profile)
  return grouped
}
