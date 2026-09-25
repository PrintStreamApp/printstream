/**
 * The shared chrome for every Bambu settings editor: title, search, "Changed only", the page tabs
 * with their modified emphasis and per-page counts, the scrolling body of grouped lines, and the
 * footer's Reset all / Cancel / Update preset / Save as preset / Apply.
 *
 * It owns LAYOUT and FILTERING only. Everything about where a value comes from, what counts as
 * changed, and what a save writes lives in the caller's {@link SettingsCatalogAdapter}, which is
 * what lets one shell serve three genuinely different dialogs (process, filament, machine).
 *
 * This exists because the process and filament dialogs were near-copies that had already drifted:
 * one wrapped its footer buttons and one did not (four buttons overflowed a 375px phone), one
 * counted tab matches under "Changed only" and one only under the search box, their body padding
 * disagreed, and their reset tooltips called the same thing a preset and a profile. Each divergence
 * was small; together they made one product look like three. Adding the machine editor as a third
 * copy would have tripled them, so the shape moved here instead.
 *
 * Counterparts: `ProcessSettingsDialog.tsx`, `library/FilamentSettingsDialog.tsx`,
 * `MachineSettingsDialog.tsx`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  DialogActions,
  Divider,
  IconButton,
  Input,
  ModalClose,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Typography
} from '@mui/joy'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import type { ProcessSettingsCatalog } from '@printstream/shared'
import { BackAwareModal } from '../BackAwareModal'
import { DialogSection } from '../DialogSection'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import {
  catalogFiltersActive, countModified, countShownPerPage, isKeyShown, pagesWithContent,
  pagesWithModified, type CatalogFilterContext
} from './catalogDialogFilter'
import { SettingsCatalogLineRow } from './SettingsCatalogLineRow'
import type { SettingFilamentChoice } from './SettingValueField'
import type { SettingsCatalogAdapter } from './settingsCatalogAdapter'

/**
 * The dialog's actions, in the order the footer renders them.
 *
 * Structured rather than a `ReactNode` slot so the documented button order (destructive-left,
 * primary-rightmost, Cancel innermost) is enforced in one place instead of being retyped per
 * dialog, which is how one of these footers ended up unable to wrap on a phone.
 */
export interface SettingsCatalogDialogActions {
  onResetAll: () => void
  onCancel: () => void
  saving: boolean
  /** "Update preset": omit when the preset is not the user's own (BambuStudio's system-preset rule). */
  onUpdatePreset?: () => void
  /** "Save as preset": omit where there is no preset destination (per-object editing). */
  onSaveAsPreset?: () => void
  /** The primary action; omit for a dialog editing a stored preset, which has nothing to apply to. */
  apply?: { label: string; onApply: () => void }
}

export interface SettingsCatalogDialogProps {
  open: boolean
  onClose: () => void
  catalog: ProcessSettingsCatalog
  /** What kind of settings these are ("Process settings", "Printer settings"). */
  titlePrefix: string
  /** The preset being edited; the shell marks it with "*" while anything is modified. */
  presetName: string
  /** Secondary line under the title (the filament dialog's full preset name). */
  subtitle?: ReactNode
  /**
   * Rendered between the title and the tabs: the process dialog's preset switcher, and either
   * dialog's baseline caveat ({@link SettingsBaselineNote}).
   */
  header?: ReactNode
  loading: boolean
  /** Body text while loading ("Loading process settings…"). */
  loadingLabel: string
  error: string | null
  /** Whether the config has resolved; false keeps the body empty without showing an error. */
  ready: boolean
  /** Whether BambuStudio's develop-tier options are revealed. */
  showDeveloperOptions: boolean
  /** Conditional visibility (the process dialog's field-state engine); defaults to always visible. */
  isKeyVisible?: (key: string) => boolean
  adapter: SettingsCatalogAdapter
  /** Value clamps applied after an edit, surfaced as a warning above the settings. */
  corrections?: string[]
  filamentChoices?: SettingFilamentChoice[]
  /**
   * Search text to open with, used by the cross-catalog settings search to land the user on the
   * setting they picked. It SEEDS the box rather than controlling it, so the user can clear or
   * retype freely; a later change does not reach an already-open dialog, which is correct because
   * every host mounts these lazily and unmounts them on close.
   */
  initialQuery?: string
  /** Modified values rendered outside the generated catalog, such as machine bed geometry. */
  additionalModifiedCount?: number
  actions: SettingsCatalogDialogActions
}

export function SettingsCatalogDialog(props: SettingsCatalogDialogProps): JSX.Element {
  const {
    open, onClose, catalog, titlePrefix, presetName, subtitle, header, loading, loadingLabel, error,
    ready, showDeveloperOptions, isKeyVisible, adapter, corrections, filamentChoices, initialQuery,
    additionalModifiedCount = 0, actions
  } = props
  const [activePage, setActivePage] = useState(0)
  const [query, setQuery] = useState(initialQuery ?? '')
  const [showChangedOnly, setShowChangedOnly] = useState(false)
  const normalizedQuery = query.trim().toLowerCase()

  const filter: CatalogFilterContext = {
    catalog,
    showDeveloperOptions,
    normalizedQuery,
    showChangedOnly,
    isKeyVisible,
    isModified: adapter.isModified
  }
  // Deliberately not memoized: this walks the catalog's keys once per render doing string and
  // equality checks, which is orders of magnitude cheaper than the rows it decides. The dialogs
  // that used to memoize it needed hand-maintained dependency lists with an eslint escape hatch,
  // and a missing entry there is a stale tab count nobody would notice.
  const filtersActive = catalogFiltersActive(filter)
  const pageShownCounts = countShownPerPage(filter)
  const pageHasContent = pagesWithContent(filter)
  const modifiedPages = pagesWithModified(filter)
  // Catalog changes drive the tabs and "Changed only" because those controls can reveal only
  // catalog rows. A caller may add a focused setting outside that catalog; it still marks the title
  // and enables Reset all, while its always-visible header owns its own changed indicator.
  // Visibility still gates catalog changes: a modified setting the user cannot see must not mark
  // the dialog or offer a reset with no corresponding row.
  const catalogModifiedCount = countModified(filter)
  const modifiedCount = catalogModifiedCount + additionalModifiedCount

  // Keep the active tab on a page that still has content.
  const pageHasContentKey = pageHasContent.map((has) => (has ? '1' : '0')).join('')
  useEffect(() => {
    if (pageHasContent[activePage]) return
    const firstVisible = pageHasContent.findIndex(Boolean)
    if (firstVisible >= 0 && firstVisible !== activePage) setActivePage(firstVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed; read live value inside.
  }, [pageHasContentKey, activePage])


  return (
    <BackAwareModal open={open} onClose={() => { if (!actions.saving) onClose() }}>
      <ScrollableModalDialog sx={{ maxWidth: 720, width: '100%' }}>
        <ModalClose disabled={actions.saving} />
        <Typography level="h4">{titlePrefix}: {modifiedCount > 0 ? '*' : ''}{presetName}</Typography>
        {subtitle}
        {header}
        {loading && (
          <ScrollableDialogBody sx={{ mt: 1, px: 0 }}>
            <Stack alignItems="center" justifyContent="center" sx={{ py: 6 }} spacing={1}>
              <CircularProgress />
              <Typography level="body-sm">{loadingLabel}</Typography>
            </Stack>
          </ScrollableDialogBody>
        )}
        {!loading && error && (
          <ScrollableDialogBody sx={{ mt: 1, px: 0 }}>
            <Alert color="danger" sx={{ m: 2 }}>{error}</Alert>
          </ScrollableDialogBody>
        )}
        {!loading && !error && ready && (
          <Tabs
            value={activePage}
            onChange={(_event, value) => setActivePage(typeof value === 'number' ? value : 0)}
            orientation="horizontal"
            sx={{ mt: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', bgcolor: 'transparent' }}
          >
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0, mb: 1, flexWrap: 'wrap' }}>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings…"
                size="sm"
                startDecorator={<Box component="span" sx={{ display: 'inline-flex', fontSize: 18, opacity: 0.6 }}><SearchRoundedIcon fontSize="inherit" /></Box>}
                endDecorator={query ? (
                  <IconButton size="sm" variant="plain" color="neutral" onClick={() => setQuery('')} aria-label="Clear search">
                    <Box component="span" sx={{ display: 'inline-flex', fontSize: 16 }}><CloseRoundedIcon fontSize="inherit" /></Box>
                  </IconButton>
                ) : undefined}
                sx={{ flex: 1, minWidth: 160 }}
              />
              <Checkbox
                size="sm"
                label="Changed only"
                checked={showChangedOnly}
                onChange={(event) => setShowChangedOnly(event.target.checked)}
                disabled={catalogModifiedCount === 0 && !showChangedOnly}
              />
            </Stack>
            <TabList
              sx={{
                overflowX: 'auto',
                flexWrap: 'nowrap',
                flexShrink: 0,
                // The list scrolls rather than wraps (overflowX/nowrap above), but a Tab defaults to
                // `white-space: normal` and is shrinkable, so instead of scrolling, tabs squeezed
                // below their text and wrapped onto two lines while the row still had slack. Pinning
                // each tab to its own width is what makes the scroll actually engage.
                '& > *': { flexShrink: 0, whiteSpace: 'nowrap' }
              }}
            >
              {catalog.pages.map((page, index) => pageHasContent[index] ? (
                <Tab
                  key={page.id}
                  value={index}
                  sx={modifiedPages.has(index) ? { color: 'warning.plainColor', fontWeight: 700 } : undefined}
                >
                  {page.title}{filtersActive ? ` (${pageShownCounts[index] ?? 0})` : ''}
                </Tab>
              ) : null)}
            </TabList>
            <ScrollableDialogBody sx={{ mt: 0, px: 0 }}>
              {showChangedOnly && catalogModifiedCount === 0 && additionalModifiedCount === 0 && (
                <Typography level="body-sm" textColor="text.tertiary" sx={{ p: 2 }}>No changed settings.</Typography>
              )}
              {corrections && corrections.length > 0 && (
                <Alert color="warning" size="sm" sx={{ m: 1 }}>
                  <Stack spacing={0.25}>
                    {corrections.map((message) => <Typography key={message} level="body-xs">{message}</Typography>)}
                  </Stack>
                </Alert>
              )}
              {catalog.pages.map((page, index) => (
                // No horizontal padding: the group cards must line up with the tabs/search/header
                // above, which sit at the dialog's own inner edge. `p: 2` here pushed them in 16px
                // on each side. Vertical padding stays for breathing room from the tabs and footer.
                <TabPanel key={page.id} value={index} sx={{ px: 0, py: 2 }}>
                  <Stack spacing={2}>
                    {page.groups.map((group) => {
                      const visibleLines = group.lines
                        .map((line) => ({ line, keys: line.keys.filter((key) => isKeyShown(key, filter)) }))
                        .filter((entry) => entry.keys.length > 0)
                      if (visibleLines.length === 0) return null
                      return (
                        <DialogSection key={group.title} title={group.title}>
                          <Stack spacing={1.25}>
                            {visibleLines.map((entry, lineIndex) => (
                              <SettingsCatalogLineRow
                                key={`${group.title}-${lineIndex}`}
                                catalog={catalog}
                                lineLabel={entry.line.label}
                                keys={entry.keys}
                                code={entry.line.code}
                                fullWidth={entry.line.fullWidth}
                                adapter={adapter}
                                filamentChoices={filamentChoices}
                              />
                            ))}
                          </Stack>
                        </DialogSection>
                      )
                    })}
                  </Stack>
                </TabPanel>
              ))}
            </ScrollableDialogBody>
          </Tabs>
        )}
        <Divider />
        <DialogActions sx={{ justifyContent: 'space-between' }}>
          <Button
            variant="plain"
            color="warning"
            onClick={actions.onResetAll}
            disabled={loading || !ready || actions.saving || modifiedCount === 0}
            startDecorator={<Box component="span" sx={{ display: 'inline-flex', fontSize: 16 }}><RestartAltRoundedIcon fontSize="inherit" /></Box>}
          >
            Reset all
          </Button>
          {/* Wraps: with Update preset, Save as preset and Apply all present this row is four
              buttons wide, which does not fit a 375px phone on one line. */}
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button variant="plain" color="neutral" onClick={actions.onCancel} disabled={actions.saving}>Cancel</Button>
            {actions.onUpdatePreset && (
              <Button variant="outlined" onClick={actions.onUpdatePreset} disabled={loading || !ready || actions.saving} loading={actions.saving}>
                Update preset
              </Button>
            )}
            {actions.onSaveAsPreset && (
              <Button variant="outlined" onClick={actions.onSaveAsPreset} disabled={loading || !ready || actions.saving} loading={actions.saving}>
                Save as preset
              </Button>
            )}
            {actions.apply && (
              <Button variant="solid" onClick={actions.apply.onApply} disabled={loading || !ready || actions.saving}>
                {actions.apply.label}
              </Button>
            )}
          </Stack>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
