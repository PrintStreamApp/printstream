/**
 * The slicing-preset manager: upload BambuStudio presets and manage the custom ones.
 *
 * Presets are split onto a tab per kind (printer / process / material) because the three carry
 * different metadata and so need different filters — a nozzle diameter means nothing to a
 * material preset. Each tab owns its own search, filters, selection and paging
 * (`SlicingPresetKindPanel`); this shell owns only the query, the upload card and the tabs.
 *
 * Rendered inside `components/library/SlicingPresetsDialog.tsx`, which titles the surface and is a
 * scroll container of its own — hence no heading here, and the sticky props passed to the toolbar.
 */
import React from 'react'
import { Alert, Chip, Stack, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy'
import { extractErrorMessage, type SlicingPresetsResponse, type SlicingPresetSummary } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../../lib/apiClient'
import { formatSlicingPresetKind, type SlicingPresetKind } from '../../../lib/slicingPresetDirectory'
import { type ModalSafeStickyTop } from '../../DirectoryToolbar'
import { usePersistentState } from '../../../hooks/usePersistentState'
import { SlicingPresetKindPanel } from './SlicingPresetKindPanel'
import { SlicingPresetUploadCard } from './SlicingPresetUploadCard'

const SLICING_PRESET_KIND_TAB_KEY = 'printstream.slicingPresets.kindTab'

const PROFILE_KINDS: ReadonlyArray<{ kind: SlicingPresetKind; emptyDescription: string }> = [
  { kind: 'machine', emptyDescription: 'Upload a BambuStudio printer preset to slice with your own machine settings.' },
  { kind: 'process', emptyDescription: 'Upload a BambuStudio process preset to slice with your own layer and speed settings.' },
  { kind: 'filament', emptyDescription: 'Upload a BambuStudio filament preset to slice with your own material settings.' }
]

function sanitizeSlicingPresetKindTab(value: unknown): SlicingPresetKind {
  return PROFILE_KINDS.some((entry) => entry.kind === value) ? (value as SlicingPresetKind) : 'machine'
}

export function SlicingPresetsSettingsSection({ stickyTop, stickySurface }: {
  /** Passed through to each tab's toolbar pinned offset; see DirectoryPrimaryToolbar. */
  stickyTop?: ModalSafeStickyTop
  /** Passed through to the pinned toolbar's background; see DirectoryPrimaryToolbar. */
  stickySurface?: string
} = {}): JSX.Element {
  const [activeKind, setActiveKind] = usePersistentState<SlicingPresetKind>(SLICING_PRESET_KIND_TAB_KEY, 'machine', sanitizeSlicingPresetKindTab)
  const profilesQuery = useQuery({
    queryKey: ['slicing-profiles'],
    queryFn: ({ signal }) => apiFetch<SlicingPresetsResponse>('/api/slicing/profiles', { signal })
  })

  const allProfiles = React.useMemo(() => profilesQuery.data?.profiles ?? [], [profilesQuery.data])
  const customByKind = React.useMemo(() => groupProfilesByKind(allProfiles.filter((profile) => profile.source === 'custom')), [allProfiles])
  // Every preset of the kind, built-in included: the panel's Source filter decides what shows, and
  // it defaults to the workspace's own. The tab COUNT stays the custom count — it answers "how many
  // have I made?", which a built-in total would drown.
  const byKind = React.useMemo(() => groupProfilesByKind(allProfiles), [allProfiles])
  const listError = profilesQuery.error ? extractErrorMessage(profilesQuery.error) : null

  return (
    <Stack spacing={1.5}>
      <Typography level="body-sm" textColor="text.tertiary">
        Upload BambuStudio presets for printer settings, material settings, and process settings.
      </Typography>

      <SlicingPresetUploadCard />

      {listError && <Alert color="danger">{listError}</Alert>}
      {!listError && (
        <Tabs
          value={activeKind}
          onChange={(_event, value) => setActiveKind(sanitizeSlicingPresetKindTab(value))}
          sx={{ bgcolor: 'transparent' }}
        >
          <TabList size="sm" variant="soft" sx={{ borderRadius: 'sm' }}>
            {PROFILE_KINDS.map(({ kind }) => (
              <Tab key={kind} value={kind}>
                {formatSlicingPresetKind(kind)}
                <Chip size="sm" variant="soft" sx={{ ml: 0.75 }}>{customByKind[kind].length}</Chip>
              </Tab>
            ))}
          </TabList>
          {PROFILE_KINDS.map(({ kind, emptyDescription }) => (
            // Inactive panels unmount, which is what resets a tab's filters/selection/page.
            <TabPanel key={kind} value={kind} sx={{ px: 0, pb: 0 }}>
              <Stack spacing={1.25}>
                <SlicingPresetKindPanel
                  kind={kind}
                  profiles={byKind[kind]}
                  emptyDescription={emptyDescription}
                  stickyTop={stickyTop}
                  stickySurface={stickySurface}
                />

              </Stack>
            </TabPanel>
          ))}
        </Tabs>
      )}
    </Stack>
  )
}

function groupProfilesByKind(profiles: SlicingPresetSummary[]): Record<SlicingPresetKind, SlicingPresetSummary[]> {
  const grouped: Record<SlicingPresetKind, SlicingPresetSummary[]> = { machine: [], process: [], filament: [] }
  for (const profile of profiles) grouped[profile.kind].push(profile)
  return grouped
}
