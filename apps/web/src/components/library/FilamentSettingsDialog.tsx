/**
 * Filament (material) settings editor dialog — the material "tune" dialog opened from the settings
 * icon next to a material's trashbin in the slice dialog. Mirrors ProcessSettingsDialog (tabs +
 * search + per-key reset + reset-all) but over the FILAMENT catalog, and lets the user persist the
 * result three ways, like Bambu Studio: save within this slice/3MF (the per-material override that
 * rides the slice), save as a new workspace preset, or update the original (custom presets only —
 * builtin Bambu presets are read-only, so that button is hidden for them).
 *
 * The filament tab has essentially no conditional show/enable rules (unlike the process tab), so
 * this dialog renders every catalog option (respecting only developer-mode tiering) without a field
 * -state engine. Counterpart: the API `/api/slicing/profiles/resolve-filament` route.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, CircularProgress, DialogActions, Divider, FormControl, FormLabel,
  IconButton, Input, Stack, Tab, TabList, TabPanel, Tabs, Tooltip, Typography
} from '@mui/joy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import {
  applyFilamentConfigDefaults,
  diffFilamentConfig,
  filamentConfigValuesEqual,
  filamentSettingsCatalog,
  isProcessOptionVisibleInMode,
  scalarizeFilamentConfig,
  type FilamentConfig,
  type FilamentSettingOption,
  type FilamentSettingOverrides
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { useEffectiveSlicerDeveloperMode } from '../../lib/slicerDeveloperMode'
import { BackAwareModal } from '../BackAwareModal'
import { DialogSection } from '../DialogSection'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { usePromptDialog } from '../PromptDialogProvider'
import { SettingValueField } from '../settings/SettingValueField'

export interface FilamentSettingsDialogProps {
  open: boolean
  onClose: () => void
  slicerTargetId: string
  /** Slicing profile id of the material (`builtin:filament:…`, a custom id, or `project:filament:…`). */
  filamentProfileId: string
  filamentProfileName: string
  /** Source 3MF id + slot, required to resolve a `project:filament:` material's embedded base. */
  sourceFileId?: string | null
  projectFilamentId?: number | null
  initialOverrides: FilamentSettingOverrides
  /** Whether the current material is a workspace custom preset (so "Update preset" is offered). */
  canEditOriginal?: boolean
  /** Emits the sparse override map for THIS material back to the slice dialog (per-material). */
  onApply: (overrides: FilamentSettingOverrides) => void
}

type ResolveResponse = {
  config: Record<string, string | string[]>
  baseConfig?: Record<string, string | string[]>
  overriddenKeys?: string[]
}

export default function FilamentSettingsDialog(props: FilamentSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, filamentProfileId, filamentProfileName, sourceFileId, projectFilamentId, initialOverrides, canEditOriginal, onApply } = props
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
  const isOptionVisibleInMode = (option: FilamentSettingOption): boolean =>
    isProcessOptionVisibleInMode(option, showDeveloperOptions)
  const { promptText } = usePromptDialog()

  // `baseConfig` is the preset baseline (reset target + "modified" diff source); `sliceBase` is the
  // effective config the slicer merges overrides onto (the 3MF's embedded values for a project
  // filament — equal to baseConfig for installed presets). `bakedKeys` marks 3MF changes whose
  // baseline could not be resolved, so they still read as modified. Mirrors ProcessSettingsDialog.
  const [baseConfig, setBaseConfig] = useState<FilamentConfig | null>(null)
  const [sliceBase, setSliceBase] = useState<FilamentConfig>({})
  const [bakedKeys, setBakedKeys] = useState<Set<string>>(new Set())
  const [config, setConfig] = useState<FilamentConfig>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activePage, setActivePage] = useState(0)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [showChangedOnly, setShowChangedOnly] = useState(false)
  const normalizedQuery = query.trim().toLowerCase()
  // Each key's original per-filament vector length (before scalarizing), so an emitted override can
  // be broadcast back to that shape at slice time — a scalar written where a multi-variant machine
  // expects N values would slice under-length.
  const baseShapesRef = useRef<Record<string, number>>({})

  // Keyed by content, not identity, so an unstable `initialOverrides` object literal from the
  // caller doesn't re-fire the load effect on every parent render (see the web development notes).
  const initialOverridesKey = JSON.stringify(initialOverrides ?? null)

  useEffect(() => {
    if (!open || !filamentProfileId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setBaseConfig(null)
    apiFetch<ResolveResponse>('/api/slicing/profiles/resolve-filament', {
      method: 'POST',
      body: { filamentProfileId, targetId: slicerTargetId || null, sourceFileId: sourceFileId || null, projectFilamentId: projectFilamentId ?? null }
    })
      .then((response) => {
        if (cancelled) return
        const rawBase = applyFilamentConfigDefaults((response.baseConfig ?? response.config) as FilamentConfig)
        // Broadcast shape per key: prefer the baseline's per-variant vector length, falling back to
        // the project value's for keys the baseline omits.
        const shapeEntries: Array<[string, number]> = [
          ...Object.entries(response.config as FilamentConfig).map(([key, value]) => [key, Array.isArray(value) ? value.length : 1] as [string, number]),
          ...Object.entries(rawBase).map(([key, value]) => [key, Array.isArray(value) ? value.length : 1] as [string, number])
        ]
        baseShapesRef.current = Object.fromEntries(shapeEntries)
        const parent = scalarizeFilamentConfig(rawBase)
        const projectValues = scalarizeFilamentConfig(response.config as FilamentConfig)
        // The values shown/sliced: the profile's own config, with parent/catalog values filling
        // only the keys it doesn't define.
        const effective = { ...parent, ...projectValues }
        // "Modified" = the value differs from the preset OUTSIDE the project (value-diff vs the
        // resolved parent), same as the process dialog — this is what surfaces real embedded
        // deviations a project-preset slice would print with (e.g. legacy files carrying another
        // material's physics under this preset's name). Keys the parent doesn't define fall back to
        // the project's own value as baseline so a blank never reads as changed-against-nothing.
        setSliceBase(effective)
        setBaseConfig({ ...effective, ...parent })
        setBakedKeys(new Set(response.overriddenKeys ?? []))
        setConfig({ ...effective, ...scalarizeFilamentConfig(initialOverrides) })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load filament settings')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // initialOverrides is read inside but content-keyed above so an unstable identity doesn't refire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filamentProfileId, slicerTargetId, sourceFileId, projectFilamentId, initialOverridesKey])

  const setScalar = (key: string, scalar: string) => {
    setConfig((prev) => {
      const current = prev[key]
      if (Array.isArray(current)) {
        const next = [...current]
        next[0] = scalar
        return { ...prev, [key]: next }
      }
      return { ...prev, [key]: scalar }
    })
  }

  const resetKey = (key: string) => {
    if (!baseConfig) return
    setConfig((prev) => {
      const next = { ...prev }
      if (baseConfig[key] === undefined) delete next[key]
      else next[key] = baseConfig[key]
      return next
    })
  }

  const canReset = (key: string): boolean =>
    baseConfig !== null && !filamentConfigValuesEqual(baseConfig[key], config[key])

  /**
   * True when a key differs from its preset baseline — either a resettable value diff, or a
   * 3MF-baked change whose baseline value couldn't be resolved (`bakedKeys`, still untouched
   * relative to the effective config). Mirrors ProcessSettingsDialog.
   */
  const isModified = (key: string): boolean => {
    if (baseConfig === null) return false
    if (!filamentConfigValuesEqual(baseConfig[key], config[key])) return true
    return bakedKeys.has(key) && filamentConfigValuesEqual(config[key], sliceBase[key])
  }

  const modifiedKeyCount = useMemo(() => {
    if (!baseConfig) return 0
    return Object.keys(filamentSettingsCatalog.options).filter(isModified).length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConfig, config, bakedKeys])

  const modifiedPages = useMemo(() => {
    const result = new Set<number>()
    if (!baseConfig) return result
    filamentSettingsCatalog.pages.forEach((page, index) => {
      const anyModified = page.groups.some((group) =>
        group.lines.some((line) => line.keys.some((key) => {
          const option = filamentSettingsCatalog.options[key]
          return Boolean(option) && isOptionVisibleInMode(option!) && isModified(key)
        }))
      )
      if (anyModified) result.add(index)
    })
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConfig, config, bakedKeys, showDeveloperOptions])

  const pageMatchCounts = useMemo(() => filamentSettingsCatalog.pages.map((page) => {
    if (!normalizedQuery) return 0
    let count = 0
    for (const group of page.groups) {
      for (const line of group.lines) {
        for (const key of line.keys) {
          const option = filamentSettingsCatalog.options[key]
          if (option && isOptionVisibleInMode(option) && filamentKeyMatchesQuery(key, normalizedQuery)) count += 1
        }
      }
    }
    return count
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [normalizedQuery, showDeveloperOptions])

  // Whether a settings line is currently shown, honoring dev-mode visibility, the search query, and
  // the "changed only" filter. Shared by the tab-visibility check and the per-tab line list.
  const lineVisible = (line: { keys: string[] }): boolean =>
    line.keys.some((key) => {
      const option = filamentSettingsCatalog.options[key]
      if (!option || !isOptionVisibleInMode(option)) return false
      if (normalizedQuery && !filamentKeyMatchesQuery(key, normalizedQuery)) return false
      if (showChangedOnly && !isModified(key)) return false
      return true
    })

  // Hide a tab entirely when it has no visible line (e.g. "changed only" with no changes on it).
  const pageHasContent = filamentSettingsCatalog.pages.map((page) =>
    page.groups.some((group) => group.lines.some(lineVisible))
  )
  const pageHasContentKey = pageHasContent.map((has) => (has ? '1' : '0')).join('')

  // Keep the active tab on a page that still has content when the filter/search hides the current one.
  useEffect(() => {
    if (pageHasContent[activePage]) return
    const first = pageHasContent.findIndex(Boolean)
    if (first >= 0 && first !== activePage) setActivePage(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHasContentKey, activePage])

  /** Broadcast each changed element-0 scalar back to the key's original vector length for the slice. */
  const expandOverrides = (diff: FilamentSettingOverrides): FilamentSettingOverrides => {
    const expanded: FilamentSettingOverrides = {}
    for (const [key, value] of Object.entries(diff)) {
      const scalar = Array.isArray(value) ? (value[0] ?? '') : value
      const length = baseShapesRef.current[key] ?? 1
      expanded[key] = length > 1 ? Array.from({ length }, () => scalar) : scalar
    }
    return expanded
  }

  const handleApply = () => {
    if (!baseConfig) return
    // Emit overrides relative to the effective slice base so baked-but-untouched values aren't
    // re-sent, while a RESET of a baked deviation becomes an explicit override back to the preset
    // value — which is what actually heals a drifted project filament at slice time.
    onApply(expandOverrides(diffFilamentConfig(sliceBase, config)))
    onClose()
  }

  const handleResetAll = () => {
    if (!baseConfig) return
    setConfig({ ...baseConfig })
  }

  /** Save the edited material as a preset. `overwrite` updates the original custom preset in place. */
  const savePreset = async (name: string, overwrite: boolean) => {
    setSaving(true)
    setError(null)
    try {
      const presetConfig: Record<string, string | string[]> = { ...config, name, type: 'filament' }
      await apiFetch('/api/slicing/profiles', {
        method: 'POST',
        body: { kind: 'filament', fileName: `${name}.json`, encoding: 'utf8', overwrite, content: JSON.stringify(presetConfig, null, 2) }
      })
      onApply(expandOverrides(diffFilamentConfig(sliceBase, config)))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preset')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAsPreset = async () => {
    if (!baseConfig) return
    const name = await promptText({
      title: 'Save as custom filament preset',
      label: 'Preset name',
      initialValue: `${filamentProfileName} (custom)`,
      confirmLabel: 'Save preset'
    })
    if (!name || !name.trim()) return
    await savePreset(name.trim(), false)
  }

  const handleUpdateOriginal = async () => {
    if (!baseConfig) return
    await savePreset(filamentProfileName, true)
  }

  const pages = filamentSettingsCatalog.pages

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 720, width: '100%' }}>
        <Typography level="h4">Filament settings — {modifiedKeyCount > 0 ? '*' : ''}{filamentProfileName}</Typography>
        {loading && (
          <ScrollableDialogBody sx={{ mt: 1, px: 0 }}>
            <Stack alignItems="center" justifyContent="center" sx={{ py: 6 }} spacing={1}>
              <CircularProgress />
              <Typography level="body-sm">Loading filament settings…</Typography>
            </Stack>
          </ScrollableDialogBody>
        )}
        {!loading && error && (
          <ScrollableDialogBody sx={{ mt: 1, px: 0 }}>
            <Alert color="danger" sx={{ m: 2 }}>{error}</Alert>
          </ScrollableDialogBody>
        )}
        {!loading && !error && baseConfig && (
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
                disabled={modifiedKeyCount === 0 && !showChangedOnly}
              />
            </Stack>
            <TabList sx={{ overflowX: 'auto', flexWrap: 'nowrap', flexShrink: 0 }}>
              {pages.map((page, index) => pageHasContent[index] ? (
                <Tab
                  key={page.id}
                  value={index}
                  sx={modifiedPages.has(index) ? { color: 'warning.plainColor', fontWeight: 'lg' } : undefined}
                >
                  {page.title}{normalizedQuery ? ` (${pageMatchCounts[index] ?? 0})` : ''}
                </Tab>
              ) : null)}
            </TabList>
            <ScrollableDialogBody sx={{ mt: 0, px: 0 }}>
              {showChangedOnly && modifiedKeyCount === 0 && (
                <Typography level="body-sm" textColor="text.tertiary" sx={{ p: 2 }}>No changed settings.</Typography>
              )}
              {pages.map((page, index) => (
                <TabPanel key={page.id} value={index} sx={{ p: 2 }}>
                  <Stack spacing={2}>
                    {page.groups.map((group) => {
                      const visibleLines = group.lines.filter(lineVisible)
                      if (visibleLines.length === 0) return null
                      return (
                        <DialogSection key={group.title} title={group.title}>
                          <Stack spacing={1.25}>
                            {visibleLines.map((line, lineIndex) => (
                              <FilamentSettingLineRow
                                key={`${group.title}-${lineIndex}`}
                                lineLabel={line.label}
                                keys={line.keys}
                                showDeveloperOptions={showDeveloperOptions}
                                code={line.code}
                                config={config}
                                isModified={isModified}
                                canReset={canReset}
                                onReset={resetKey}
                                onScalarChange={setScalar}
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
            onClick={handleResetAll}
            disabled={loading || !baseConfig || saving || modifiedKeyCount === 0}
            startDecorator={<Box component="span" sx={{ display: 'inline-flex', fontSize: 16 }}><RestartAltRoundedIcon fontSize="inherit" /></Box>}
          >
            Reset all
          </Button>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>Cancel</Button>
            {canEditOriginal && (
              <Button variant="outlined" onClick={handleUpdateOriginal} disabled={loading || !baseConfig || saving} loading={saving}>
                Update preset
              </Button>
            )}
            <Button variant="outlined" onClick={handleSaveAsPreset} disabled={loading || !baseConfig || saving} loading={saving}>
              Save as preset
            </Button>
            <Button variant="solid" onClick={handleApply} disabled={loading || !baseConfig || saving}>
              Save in this 3MF
            </Button>
          </Stack>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

/** Case-insensitive match of a filament setting against the search query (label, key, or tooltip). */
function filamentKeyMatchesQuery(key: string, normalizedQuery: string): boolean {
  const option = filamentSettingsCatalog.options[key]
  if (!option) return false
  return option.label.toLowerCase().includes(normalizedQuery)
    || key.toLowerCase().includes(normalizedQuery)
    || (option.tooltip?.toLowerCase().includes(normalizedQuery) ?? false)
}

interface FilamentSettingLineRowProps {
  lineLabel?: string
  keys: string[]
  showDeveloperOptions: boolean
  code?: boolean
  config: FilamentConfig
  isModified: (key: string) => boolean
  canReset: (key: string) => boolean
  onReset: (key: string) => void
  onScalarChange: (key: string, value: string) => void
}

/** Renders one settings line (label + one or more value controls) with per-control reset. */
function FilamentSettingLineRow(props: FilamentSettingLineRowProps): JSX.Element | null {
  const { keys, lineLabel, showDeveloperOptions, code, config, isModified, canReset, onReset, onScalarChange } = props
  const visibleKeys = keys.filter((key) => {
    const option = filamentSettingsCatalog.options[key]
    return option && isProcessOptionVisibleInMode(option, showDeveloperOptions)
  })
  if (visibleKeys.length === 0) return null

  const firstKey = visibleKeys[0] ?? keys[0] ?? ''
  const firstOption = filamentSettingsCatalog.options[firstKey]
  const label = lineLabel ?? firstOption?.label ?? firstKey
  const lineModified = visibleKeys.some((key) => isModified(key))

  const scalarOf = (key: string): string => {
    const value = config[key]
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
    return typeof value === 'string' ? value : ''
  }

  return (
    <FormControl>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
        <Box sx={{ minWidth: { sm: 220 }, flexShrink: 0 }}>
          <FormLabel sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: lineModified ? 'warning.plainColor' : undefined, fontWeight: lineModified ? 'lg' : undefined }}>
            {label}
            {firstOption?.tooltip && (
              <Tooltip title={firstOption.tooltip} variant="soft" sx={{ maxWidth: 320 }}>
                <Box component="span" sx={{ display: 'inline-flex', fontSize: 16, opacity: 0.6 }}>
                  <InfoOutlinedIcon fontSize="inherit" />
                </Box>
              </Tooltip>
            )}
          </FormLabel>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flex: 1, flexWrap: 'wrap', justifyContent: { sm: 'flex-end' } }}>
          {visibleKeys.map((key) => {
            const option = filamentSettingsCatalog.options[key]
            if (!option) return null
            return (
              <Stack key={key} direction="row" spacing={0.25} alignItems="center">
                <SettingValueField
                  settingKey={key}
                  option={option}
                  value={scalarOf(key)}
                  showOwnLabel={visibleKeys.length > 1}
                  modified={isModified(key)}
                  onScalarChange={onScalarChange}
                  isCode={code}
                />
                {canReset(key) && (
                  <Tooltip title="Reset to profile default" variant="soft">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="warning"
                      aria-label={`Reset ${option.label} to default`}
                      onClick={() => onReset(key)}
                      sx={{ '--IconButton-size': '1.75rem' }}
                    >
                      <Box component="span" sx={{ display: 'inline-flex', fontSize: 16 }}>
                        <RestartAltRoundedIcon fontSize="inherit" />
                      </Box>
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            )
          })}
        </Stack>
      </Stack>
    </FormControl>
  )
}
