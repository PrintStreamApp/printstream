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
  diffFilamentVariantConfig,
  filamentSettingsCatalog,
  filamentVariantValuesEqual,
  isProcessOptionVisibleInMode,
  prepareResolvedFilamentState,
  scalarizeFilamentConfig,
  type FilamentConfig,
  type FilamentSettingOption,
  type FilamentSettingOverrides,
  type ResolveFilamentConfigResponse,
  type ResolvedFilamentState,
  isNilSettingValue
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
  /**
   * The preset's LITERAL name, including the `@<printer>` suffix ("Bambu PLA Basic @BBL A1").
   * Display only, and deliberately separate from `filamentProfileName`: that one is the alias shown
   * in the title AND the name written when saving a preset, so it must stay the alias. This tells
   * the user which machine variant they are actually tuning, which the alias hides.
   */
  filamentPresetFullName?: string | null
  /** Source 3MF id + slot, required to resolve a `project:filament:` material's embedded base. */
  sourceFileId?: string | null
  projectFilamentId?: number | null
  initialOverrides: FilamentSettingOverrides
  /** Whether the current material is a workspace custom preset (so "Update preset" is offered). */
  canEditOriginal?: boolean
  /**
   * What the Apply button commits to: a `project` (the 3D editor, where the override persists with
   * the next project save) or a one-off `slice` (the print/slice dialog). Only changes the button
   * wording — mirrors {@link ProcessSettingsDialogProps.applyScope} so the two dialogs read alike.
   */
  /**
   * What the dialog is editing FOR.
   *
   * 'slice' / 'project' edit a slice's config and emit an override map through `onApply`.
   * 'preset' edits the stored preset ITSELF — opened from the slicer-profiles settings, where
   * there is no slice to apply to: the Apply button is hidden and `onApply` is never called, so
   * the only ways out are Save as preset, Update preset (custom presets only, via
   * `canEditOriginal`) and Cancel. That mirrors BambuStudio, where editing a SYSTEM preset can
   * only ever produce a new user preset.
   */
  applyScope?: 'project' | 'slice' | 'preset'
  /**
   * How the dialog resolves a preset's base config. Defaults to the TENANT route
   * (`/api/slicing/profiles/resolve-filament`). The public 3MF editor passes an anonymous resolver
   * (built-in presets via `/api/public/slicing/...`; project filaments from the in-tab 3MF slot), so
   * it can run with no workspace. Additive — omitting it preserves the exact library behaviour.
   */
  resolveConfig?: FilamentConfigResolver
  /** Emits the sparse override map for THIS material back to the slice dialog (per-material). */
  /** Omitted for `applyScope: 'preset'`, which has nothing to apply to. */
  onApply?: (overrides: FilamentSettingOverrides) => void
}

/** Resolves a filament preset's base config for the dialog. See {@link FilamentSettingsDialogProps.resolveConfig}. */
export type FilamentConfigResolver = (request: {
  filamentProfileId: string
  targetId: string | null
  sourceFileId: string | null
  projectFilamentId: number | null
}) => Promise<ResolveFilamentConfigResponse>


export default function FilamentSettingsDialog(props: FilamentSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, filamentProfileId, filamentProfileName, filamentPresetFullName, sourceFileId, projectFilamentId, initialOverrides, canEditOriginal, applyScope = 'slice', resolveConfig, onApply } = props
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
  const isOptionVisibleInMode = (option: FilamentSettingOption): boolean =>
    isProcessOptionVisibleInMode(option, showDeveloperOptions)
  const { promptText } = usePromptDialog()

  // `baseConfig` is the preset baseline (reset target + "modified" diff source) in element-0 scalar
  // space, which is what the fields edit. `bakedKeys` marks 3MF changes whose baseline could not be
  // resolved, so they still read as modified. Mirrors ProcessSettingsDialog.
  const [baseConfig, setBaseConfig] = useState<FilamentConfig | null>(null)
  // The preset's own parent, for the emphasis-only state above. Null until resolved.
  const [parentBaseline, setParentBaseline] = useState<FilamentConfig | null>(null)
  // The same three configs before the element-0 collapse, plus the edited config in that space. The
  // FIELDS edit element 0 (as BambuStudio's filament tab does), but a value can differ on a later
  // extruder variant only, so every "is this changed" question and the emitted overrides work here.
  const [raw, setRaw] = useState<ResolvedFilamentState['raw'] | null>(null)
  const [rawConfig, setRawConfig] = useState<FilamentConfig>({})
  const [bakedKeys, setBakedKeys] = useState<Set<string>>(new Set())
  /** See the twin in ProcessSettingsDialog: declared record present => `bakedKeys` is the whole truth. */
  const [declaresOverrides, setDeclaresOverrides] = useState(false)
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
    const resolve = resolveConfig
      ? resolveConfig({ filamentProfileId, targetId: slicerTargetId || null, sourceFileId: sourceFileId || null, projectFilamentId: projectFilamentId ?? null })
      : apiFetch<ResolveFilamentConfigResponse>('/api/slicing/profiles/resolve-filament', {
          method: 'POST',
          body: { filamentProfileId, targetId: slicerTargetId || null, sourceFileId: sourceFileId || null, projectFilamentId: projectFilamentId ?? null }
        })
    resolve
      .then((response) => {
        if (cancelled) return
        // "Modified" = the value differs from the preset OUTSIDE the project (value-diff vs the
        // resolved parent), same as the process dialog — this is what surfaces real embedded
        // deviations a project-preset slice would print with. The shared prepare helper is also
        // what drives the slice dialog's pre-open "changed values" badge, so the two agree.
        const state = prepareResolvedFilamentState(response)
        baseShapesRef.current = state.shapes
        setBaseConfig(state.baseline)
        setParentBaseline(state.parentBaseline)
        setBakedKeys(new Set(state.bakedKeys))
        setDeclaresOverrides(response.declaresOverrides === true)
        setConfig({ ...state.effective, ...scalarizeFilamentConfig(initialOverrides) })
        setRaw(state.raw)
        setRawConfig({ ...state.raw.effective, ...initialOverrides })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load filament settings')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // initialOverrides is read inside but content-keyed above so an unstable identity doesn't refire.
    // `resolveConfig` (public editor) must be a stable identity or this refires every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filamentProfileId, slicerTargetId, sourceFileId, projectFilamentId, initialOverridesKey, resolveConfig])

  /** Broadcast a scalar to the key's original variant count (a shorter value slices under-length). */
  const broadcast = (key: string, scalar: string): FilamentConfig[string] => {
    const length = baseShapesRef.current[key] ?? 1
    return length > 1 ? Array.from({ length }, () => scalar) : scalar
  }

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
    // An edit applies to every variant: the field shows one number, so leaving the others at their
    // old values would silently keep printing a value the user just replaced.
    setRawConfig((prev) => ({ ...prev, [key]: broadcast(key, scalar) }))
  }

  const resetKey = (key: string) => {
    if (!baseConfig) return
    setConfig((prev) => {
      const next = { ...prev }
      if (baseConfig[key] === undefined) delete next[key]
      else next[key] = baseConfig[key]
      return next
    })
    setRawConfig((prev) => {
      const next = { ...prev }
      const presetValue = raw?.baseline[key]
      if (presetValue === undefined) delete next[key]
      else next[key] = presetValue
      return next
    })
  }

  const canReset = (key: string): boolean =>
    raw !== null && !filamentVariantValuesEqual(raw.baseline[key], rawConfig[key], filamentSettingsCatalog.options[key])

  /**
   * True when a key differs from its preset baseline — either a resettable value diff, or a
   * 3MF-baked change whose baseline value couldn't be resolved (`bakedKeys`, still untouched
   * relative to the effective config). Mirrors ProcessSettingsDialog.
   */
  const isProjectChange = (key: string): boolean => {
    if (raw === null) return false
    const option = filamentSettingsCatalog.options[key]
    // Declared record present: the file's list plus this session's edits, and nothing else. An
    // undeclared difference from the preset is drift BambuStudio normalizes away — reporting it as
    // this project's change is what showed stock materials as edited.
    if (declaresOverrides) {
      return bakedKeys.has(key) || !filamentVariantValuesEqual(raw.effective[key], rawConfig[key], option)
    }
    if (!filamentVariantValuesEqual(raw.baseline[key], rawConfig[key], option)) return true
    return bakedKeys.has(key) && filamentVariantValuesEqual(rawConfig[key], raw.effective[key], option)
  }

  /**
   * The keys BambuStudio renders with an enable checkbox — its filament "Setting Overrides" page.
   * Unchecked means the value is nil ("not overridden"); checked restores a real value. Derived
   * from the catalog page rather than a second hand-kept list, so the two cannot drift.
   */
  const overrideKeys = useMemo(() => new Set(
    (filamentSettingsCatalog.pages.find((page) => page.id === 'setting-overrides')?.groups ?? [])
      .flatMap((group) => group.lines.flatMap((line) => line.keys))
  ), [])

  /**
   * An override the PRESET itself carries relative to its parent — emphasis only, never a badge and
   * never caught by "changed only". BambuStudio keeps this as a separate question from "modified"
   * (`current_different_from_parent_options` vs `current_dirty_options`), and only the latter drives
   * its modified marker. Counting these made a user preset's own saved settings look like edits the
   * project had made, complete with a reset button that would have discarded them.
   */
  const isPresetOverride = (key: string): boolean =>
    parentBaseline !== null && raw !== null
    && !filamentVariantValuesEqual(raw.parentBaseline[key], raw.baseline[key], filamentSettingsCatalog.options[key])

  /**
   * What a changed value replaced. A project change is measured against the preset; an override the
   * preset carries is measured against its parent — so the tooltip names which baseline it is
   * showing rather than leaving "original" ambiguous between the two.
   */
  const originalOf = (key: string): { value: string; label: string } | null => {
    // A per-variant value renders every variant ("25 / 40"), because the field only shows the first:
    // collapsed to element 0 the hover would repeat the number already on screen.
    const asText = (value: FilamentConfig[string] | undefined): string | null => {
      if (Array.isArray(value)) {
        const parts = value.map((entry) => String(entry ?? ''))
        const text = parts.every((entry) => entry === parts[0]) ? (parts[0] ?? '') : parts.join(' / ')
        return text === '' ? null : text
      }
      return value === undefined || value === '' ? null : String(value)
    }
    if (isProjectChange(key)) {
      const value = asText(raw?.baseline[key])
      return value === null ? null : { value, label: 'Preset value' }
    }
    if (isPresetOverride(key)) {
      const value = asText(raw?.parentBaseline[key])
      return value === null ? null : { value, label: 'Inherited value' }
    }
    return null
  }

  const modifiedKeyCount = useMemo(() => {
    if (!baseConfig) return 0
    return Object.keys(filamentSettingsCatalog.options).filter(isProjectChange).length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConfig, rawConfig, raw, bakedKeys])

  const modifiedPages = useMemo(() => {
    const result = new Set<number>()
    if (!baseConfig) return result
    filamentSettingsCatalog.pages.forEach((page, index) => {
      const anyModified = page.groups.some((group) =>
        group.lines.some((line) => line.keys.some((key) => {
          const option = filamentSettingsCatalog.options[key]
          return Boolean(option) && isOptionVisibleInMode(option!) && isProjectChange(key)
        }))
      )
      if (anyModified) result.add(index)
    })
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConfig, rawConfig, raw, bakedKeys, declaresOverrides, showDeveloperOptions])

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
      if (showChangedOnly && !isProjectChange(key)) return false
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

  /**
   * The overrides this session should ride the slice with: every key whose per-variant value differs
   * from the effective slice base, each broadcast back to the key's original vector length (a
   * scalar written where a multi-variant machine expects N values would slice under-length).
   *
   * Measured against the effective base, not the preset, so baked-but-untouched values aren't
   * re-sent while a RESET of a baked deviation becomes an explicit override back to the preset
   * value — which is what actually heals a drifted project filament at slice time.
   */
  const changedOverrides = (): FilamentSettingOverrides => {
    if (!raw) return {}
    const diff = diffFilamentVariantConfig(raw.effective, rawConfig)
    const expanded: FilamentSettingOverrides = {}
    for (const [key, value] of Object.entries(diff)) {
      expanded[key] = Array.isArray(value) ? value : broadcast(key, value)
    }
    return expanded
  }

  const handleApply = () => {
    if (!baseConfig) return
    onApply?.(changedOverrides())
    onClose()
  }

  const handleResetAll = () => {
    if (!baseConfig || !raw) return
    setConfig({ ...baseConfig })
    setRawConfig({ ...raw.baseline })
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
      onApply?.(changedOverrides())
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
        {filamentPresetFullName && filamentPresetFullName !== filamentProfileName && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: -0.5 }}>{filamentPresetFullName}</Typography>
        )}
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
            <TabList sx={{
              overflowX: 'auto',
              flexWrap: 'nowrap',
              flexShrink: 0,
                // The list scrolls rather than wraps (overflowX/nowrap above), but a Tab defaults to
                // `white-space: normal` and is shrinkable — so instead of scrolling, tabs squeezed
                // below their text and wrapped onto two lines while the row still had slack. Pinning
                // each tab to its own width is what makes the scroll actually engage.
                '& > *': { flexShrink: 0, whiteSpace: 'nowrap' }
            }}>
              {pages.map((page, index) => pageHasContent[index] ? (
                <Tab
                  key={page.id}
                  value={index}
                  sx={modifiedPages.has(index) ? { color: 'warning.plainColor', fontWeight: 700 } : undefined}
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
                                fullWidth={line.fullWidth}
                                config={config}
                                isProjectChange={isProjectChange}
                                isPresetOverride={isPresetOverride}
                                originalOf={originalOf}
                                overrideKeys={overrideKeys}
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
            {applyScope !== 'preset' && (
              <Button variant="solid" onClick={handleApply} disabled={loading || !baseConfig || saving}>
                {applyScope === 'project' ? 'Apply to this project' : 'Apply to this slice'}
              </Button>
            )}
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
  /** The line spans the row (BambuStudio's full-width lines: Notes and the G-code editors). */
  fullWidth?: boolean
  config: FilamentConfig
  /** Changed by THIS project/session versus the preset in use — coloured, badged, filterable. */
  isProjectChange: (key: string) => boolean
  /** An override the preset itself carries versus its parent — emphasis only. */
  isPresetOverride: (key: string) => boolean
  /** The baseline a changed value replaced, for the hover. */
  originalOf: (key: string) => { value: string; label: string } | null
  overrideKeys: ReadonlySet<string>
  canReset: (key: string) => boolean
  onReset: (key: string) => void
  onScalarChange: (key: string, value: string) => void
}

/** Renders one settings line (label + one or more value controls) with per-control reset. */
function FilamentSettingLineRow(props: FilamentSettingLineRowProps): JSX.Element | null {
  const { keys, lineLabel, showDeveloperOptions, code, fullWidth, config, isProjectChange, isPresetOverride, originalOf, overrideKeys, canReset, onReset, onScalarChange } = props
  const visibleKeys = keys.filter((key) => {
    const option = filamentSettingsCatalog.options[key]
    return option && isProcessOptionVisibleInMode(option, showDeveloperOptions)
  })
  if (visibleKeys.length === 0) return null

  const firstKey = visibleKeys[0] ?? keys[0] ?? ''
  const firstOption = filamentSettingsCatalog.options[firstKey]
  const label = lineLabel ?? firstOption?.label ?? firstKey
  const lineProjectChange = visibleKeys.some((key) => isProjectChange(key))
  const linePresetOverride = visibleKeys.some((key) => isPresetOverride(key))
  // Full-width lines take the label above and the whole row: the G-code editors and Notes.
  const spansRow = Boolean(code || fullWidth)

  const scalarOf = (key: string): string => {
    const value = config[key]
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
    return typeof value === 'string' ? value : ''
  }

  // See the note at its use: one control -> FormControl (so the label is really associated);
  // several -> a plain Box, because each control carries its own label.
  // Cast: both accept children and no required props, but a union of two component types is not
  // callable as a JSX tag.
  const RowRoot = (visibleKeys.length === 1 ? FormControl : Box) as typeof Box
  return (
    // A Joy FormControl may contain exactly ONE control, and it labels that control. A row with
    // several visible keys is one setting per extruder variant — several controls, each labelling
    // itself via `showOwnLabel` — so wrapping those in a FormControl is both a Joy error (logged on
    // every render) and a false label association. Use it only when there really is one control.
    <RowRoot>
      {/* A G-code field is a multi-line editor, not a value in a column: it takes the label ABOVE
          and the full row width, the way BambuStudio lays its G-code groups out. Beside a 220px
          label column it was stuck at its 280px minimum in a 720px dialog. */}
      <Stack direction={spansRow ? 'column' : { xs: 'column', sm: 'row' }} spacing={1} alignItems={spansRow ? 'stretch' : { sm: 'center' }}>
        <Box sx={{ minWidth: spansRow ? undefined : { sm: 220 }, flexShrink: 0 }}>
          <FormLabel sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: lineProjectChange ? 'warning.plainColor' : undefined, fontWeight: linePresetOverride || lineProjectChange ? 700 : undefined, fontStyle: linePresetOverride && !lineProjectChange ? 'italic' : undefined }}>
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
        <Stack direction="row" spacing={1} sx={{ flex: 1, flexWrap: 'wrap', justifyContent: spansRow ? 'stretch' : { sm: 'flex-end' }, width: spansRow ? '100%' : undefined }}>
          {visibleKeys.map((key) => {
            const option = filamentSettingsCatalog.options[key]
            if (!option) return null
            const isOverride = overrideKeys.has(key)
            const overridden = isOverride && !isNilSettingValue(config[key])
            return (
              <Stack key={key} direction="row" spacing={0.25} alignItems="center" sx={spansRow ? { flex: 1, minWidth: 0 } : undefined}>
                {isOverride && (
                  <Tooltip title={overridden ? 'Overriding the printer setting — uncheck to use the printer value' : 'Not overridden — check to set a filament-specific value'} variant="soft">
                    <Checkbox
                      size="sm"
                      checked={overridden}
                      slotProps={{ input: { 'aria-label': `Override ${option.label}` } }}
                      // Mirrors BambuStudio's Field::set_na_value / set_last_meaningful_value:
                      // unchecking stores nil, checking restores a real value (the catalog default,
                      // which is what the printer would have used anyway).
                      onChange={(event) => onScalarChange(key, event.target.checked ? (option.default ?? '0') : 'nil')}
                    />
                  </Tooltip>
                )}
                <SettingValueField
                  settingKey={key}
                  option={option}
                  value={scalarOf(key)}
                  enabled={!isOverride || overridden}
                  showOwnLabel={visibleKeys.length > 1}
                  modified={isPresetOverride(key)}
                  unsaved={isProjectChange(key)}
                  original={originalOf(key)}
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
    </RowRoot>
  )
}
