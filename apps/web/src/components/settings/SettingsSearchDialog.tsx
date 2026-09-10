/**
 * "Search every setting": one box over the process, filament and printer catalogs.
 *
 * OWNS the finder UI only. Picking a result hands `(kind, key)` back to the host, which opens that
 * kind's own settings dialog seeded with the key; this never renders or writes a value itself. See
 * `settingsSearch.ts` for why that split is deliberate rather than unfinished.
 *
 * Each row leads with the setting's own name, then its catalog and breadcrumb, then BambuStudio's
 * description, because the question behind the search is usually "which of these is the one I
 * mean", which the name alone does not answer and the description usually does.
 */
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import {
  Box,
  Chip,
  DialogContent,
  DialogTitle,
  Input,
  List,
  ListItemButton,
  ModalClose,
  ModalDialog,
  Stack,
  Typography
} from '@mui/joy'
import { useMemo, useState } from 'react'
import { BackAwareModal } from '../BackAwareModal'
import { EmptyState } from '../EmptyState'
import {
  SETTINGS_CATALOG_KIND_LABELS,
  searchAllSettings,
  type SettingsCatalogKind
} from './settingsSearch'

export function SettingsSearchDialog({
  showDeveloperOptions,
  unavailableKinds,
  onSelect,
  onClose
}: {
  showDeveloperOptions: boolean
  /**
   * Why a kind cannot be opened right now, keyed by kind; absent means it can.
   *
   * Every target is conditional (each dialog renders behind its own selected preset, and a project
   * may carry no materials), and a result whose dialog cannot mount is otherwise a dead click: the
   * row absorbs the press and nothing happens, with no reason given. Disabled-with-a-reason is the
   * honest form, and it is the caller that knows the reason.
   */
  unavailableKinds: Partial<Record<SettingsCatalogKind, string>>
  /** Open this setting: the host opens `kind`'s dialog with `key` as its search text. */
  onSelect: (kind: SettingsCatalogKind, key: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const results = useMemo(
    () => searchAllSettings(query, { showDeveloperOptions }),
    [query, showDeveloperOptions]
  )
  const trimmed = query.trim()

  return (
    <BackAwareModal open onClose={onClose}>
      <ModalDialog variant="outlined" sx={{ width: 'min(720px, 100%)' }}>
        <ModalClose />
        <DialogTitle>Search settings</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Input
              autoFocus
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search process, filament and printer settings…"
              startDecorator={<SearchRoundedIcon fontSize="small" />}
            />
            {!trimmed ? (
              <Typography level="body-sm" textColor="text.tertiary">
                Search by name, by setting key, or by anything in a setting's description.
              </Typography>
            ) : results.length === 0 ? (
              <EmptyState
                compact
                icon={<SearchRoundedIcon />}
                title="No matching settings"
                description={`Nothing in the process, filament or printer catalogs matches “${trimmed}”.`}
              />
            ) : (
              <List size="sm" sx={{ '--ListItem-paddingY': '0.5rem' }}>
                {results.map((result) => {
                  const unavailable = unavailableKinds[result.kind]
                  return (
                  <ListItemButton
                    key={`${result.kind}:${result.key}`}
                    disabled={Boolean(unavailable)}
                    onClick={() => { if (!unavailable) onSelect(result.kind, result.key) }}
                  >
                    <Box sx={{ minWidth: 0, width: '100%' }}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                        <Typography level="title-sm" noWrap sx={{ minWidth: 0 }}>{result.label}</Typography>
                        <Chip size="sm" variant="soft" color="neutral">
                          {SETTINGS_CATALOG_KIND_LABELS[result.kind]}
                        </Chip>
                      </Stack>
                      <Typography level="body-xs" textColor="text.tertiary" noWrap>
                        {unavailable ?? `${result.page} › ${result.group} · ${result.key}`}
                      </Typography>
                      {result.tooltip ? (
                        <Typography
                          level="body-xs"
                          textColor="text.tertiary"
                          // Two lines: enough to tell near-identical settings apart, not so much
                          // that a long BambuStudio description pushes the next result off screen.
                          sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                        >
                          {result.tooltip}
                        </Typography>
                      ) : null}
                    </Box>
                  </ListItemButton>
                  )
                })}
              </List>
            )}
          </Stack>
        </DialogContent>
      </ModalDialog>
    </BackAwareModal>
  )
}

export default SettingsSearchDialog
