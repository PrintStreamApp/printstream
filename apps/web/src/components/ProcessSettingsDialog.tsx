/**
 * Process (quality) settings editor dialog.
 *
 * Renders the Bambu-faithful process settings catalog (generated from
 * BambuStudio source) page-by-page, applying the same conditional
 * visibility/enable rules and value-coercion validation that BambuStudio's
 * Process tab uses. The user edits values against a resolved base config; the
 * dialog emits the sparse override map (changed keys) back to the slice dialog
 * and can optionally persist the result as a reusable custom process preset.
 *
 * The catalog's `develop`-tier options are hidden unless developer mode is on
 * (`useEffectiveSlicerDeveloperMode` — the workspace default from the Slicing
 * settings page, optionally overridden per device); see
 * `isProcessOptionVisibleInMode`.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, CircularProgress, DialogActions, Divider, FormControl, FormLabel,
  IconButton, Input, Option, Select, Stack, Tab, TabList, TabPanel, Tabs, Tooltip, Typography
} from '@mui/joy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import {
  applyProcessConfigDefaults,
  computeProcessFieldStates,
  createProcessConfigAccessor,
  defaultProcessVisibilityContext,
  diffProcessConfig,
  getProcessFieldState,
  isProcessOptionVisibleInMode,
  processConfigValuesEqual,
  processSettingsCatalog,
  validateProcessConfig,
  type ProcessConfig,
  type ProcessSettingOption,
  type ProcessSettingOverrides,
  type ProcessVisibilityContext
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { useEffectiveSlicerDeveloperMode } from '../lib/slicerDeveloperMode'
import { BackAwareModal } from './BackAwareModal'
import { DialogSection } from './DialogSection'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { usePromptDialog } from './PromptDialogProvider'
import { SettingValueField } from './settings/SettingValueField'

export interface ProcessSettingsDialogProps {
  open: boolean
  onClose: () => void
  slicerTargetId: string
  processProfileId: string
  processProfileName: string
  /** Source library file id; required to resolve project-embedded (`project:`) profiles. */
  sourceFileId?: string | null
  initialOverrides: ProcessSettingOverrides
  /** Machine context affecting conditional visibility (printer model, flavor). */
  visibilityContext?: Partial<ProcessVisibilityContext>
  /** Selectable process profiles for switching within the dialog (Bambu carry-over). */
  profileOptions?: Array<{ id: string; name: string }>
  /** Switch the active profile, carrying the current modifications (relative to the preset). */
  onProfileChange?: (profileId: string, carryOverrides: ProcessSettingOverrides) => void
  /** Restrict the editable catalog to these keys (per-object overrides expose a subset). */
  allowedKeys?: readonly string[]
  /**
   * Global effective overrides to overlay onto the resolved base. For per-object editing this is
   * the global process overrides, so the object's baseline/reset target is the inherited global
   * config rather than the bare preset.
   */
  baseOverlay?: ProcessSettingOverrides
  /** Title prefix; defaults to "Process settings" (per-object uses "Object settings"). */
  titlePrefix?: string
  /**
   * What the Apply button commits to: a `project` (the 3D editor, where the override is saved
   * with the project) or a one-off `slice` (the print/slice dialog, where it applies to just that
   * slice). Only changes the button wording. Defaults to `slice`.
   */
  applyScope?: 'project' | 'slice'
  onApply: (overrides: ProcessSettingOverrides) => void
}

type ResolveResponse = {
  config: Record<string, string | string[]>
  baseConfig?: Record<string, string | string[]>
  overriddenKeys?: string[]
}

export default function ProcessSettingsDialog(props: ProcessSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, processProfileId, processProfileName, sourceFileId, initialOverrides, profileOptions, onProfileChange, allowedKeys, baseOverlay, titlePrefix, applyScope = 'slice', onApply } = props
  const allowedKeySet = useMemo(() => (allowedKeys ? new Set(allowedKeys) : null), [allowedKeys])
  const isKeyAllowed = (key: string): boolean => allowedKeySet === null || allowedKeySet.has(key)
  // Reveal BambuStudio's develop-tier options only when developer mode is on (workspace
  // default, optionally overridden per device — see useEffectiveSlicerDeveloperMode).
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
  const isOptionVisibleInMode = (option: ProcessSettingOption): boolean =>
    isProcessOptionVisibleInMode(option, showDeveloperOptions)
  // `baseConfig` is the preset baseline (reset target); `sliceBase` is the effective config the
  // slicer merges overrides onto (equal to baseConfig for installed presets, but the 3MF's
  // already-overridden config for a project profile). `bakedKeys` marks 3MF overrides whose
  // baseline value could not be resolved, so they still read as modified.
  const [baseConfig, setBaseConfig] = useState<ProcessConfig | null>(null)
  const [sliceBase, setSliceBase] = useState<ProcessConfig>({})
  const [bakedKeys, setBakedKeys] = useState<Set<string>>(new Set())
  const [config, setConfig] = useState<ProcessConfig>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [corrections, setCorrections] = useState<string[]>([])
  const [activePage, setActivePage] = useState(0)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [showChangedOnly, setShowChangedOnly] = useState(false)
  const normalizedQuery = query.trim().toLowerCase()
  const { promptText } = usePromptDialog()

  // Callers pass `visibilityContext` as a fresh object literal each render (e.g. the editor:
  // `visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}`), so identity-
  // keying this memo would recompute it — and the expensive `computeProcessFieldStates` below — on
  // every parent render while the dialog is open. Content-key it instead (mirrors `baseOverlayKey`).
  const visibilityContextKey = JSON.stringify(props.visibilityContext ?? null)
  const context: ProcessVisibilityContext = useMemo(
    () => ({ ...defaultProcessVisibilityContext, ...props.visibilityContext }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed; read live value inside.
    [visibilityContextKey]
  )

  // Callers pass `baseOverlay`/`initialOverrides` as fresh object literals each render (e.g.
  // the per-part dialog: `baseOverlay={{ ...globalOverrides, ...objectOverrides }}`). Keying
  // the load effect on their identity would re-resolve the process config on every parent
  // re-render — flashing "Loading…" and resetting the form mid-edit. Depend on a stable
  // content hash instead so it reloads only when the values actually change.
  const baseOverlayKey = JSON.stringify(baseOverlay ?? null)
  const initialOverridesKey = JSON.stringify(initialOverrides ?? null)

  useEffect(() => {
    if (!open || !processProfileId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setBaseConfig(null)
    apiFetch<ResolveResponse>('/api/slicing/profiles/resolve-process', {
      method: 'POST',
      body: { processProfileId, targetId: slicerTargetId || null, sourceFileId: sourceFileId || null }
    })
      .then((response) => {
        if (cancelled) return
        const effective = applyProcessConfigDefaults(response.config as ProcessConfig)
        if (baseOverlay) {
          // Per-object: the object inherits the global effective config (profile + global
          // overrides); that is both the slice base and the reset target.
          const globalEffective = applyProcessConfigDefaults({ ...effective, ...baseOverlay })
          setSliceBase(globalEffective)
          setBaseConfig(globalEffective)
          setBakedKeys(new Set())
          setConfig({ ...globalEffective, ...initialOverrides })
        } else {
          const baseline = applyProcessConfigDefaults((response.baseConfig ?? response.config) as ProcessConfig)
          setSliceBase(effective)
          setBaseConfig(baseline)
          setBakedKeys(new Set(response.overriddenKeys ?? []))
          setConfig({ ...effective, ...initialOverrides })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load process settings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
    // baseOverlay/initialOverrides are read inside but keyed by their JSON content above so
    // an unstable object identity from the caller doesn't re-fire this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, processProfileId, slicerTargetId, sourceFileId, initialOverridesKey, baseOverlayKey])

  const fieldStates = useMemo(() => computeProcessFieldStates(config, context), [config, context])
  const accessor = useMemo(() => createProcessConfigAccessor(config), [config])

  /**
   * True when a key differs from its preset baseline — either a resettable value diff, or a
   * 3MF-baked override whose baseline value couldn't be resolved (`bakedKeys`, still untouched
   * relative to the effective config). Surfaces both in-session edits and sealed-in overrides.
   * Declared here (before `pageHasContent`) so the tab-visibility and "changed only" filter can use it.
   */
  const isModified = (key: string): boolean => {
    if (baseConfig === null) return false
    if (!processConfigValuesEqual(baseConfig[key], config[key])) return true
    return bakedKeys.has(key) && processConfigValuesEqual(config[key], sliceBase[key])
  }

  /** Number of visible settings matching the search query on each page (0 when not searching). */
  const pageMatchCounts = useMemo(() => processSettingsCatalog.pages.map((page) => {
    if (!normalizedQuery) return 0
    let count = 0
    for (const group of page.groups) {
      for (const line of group.lines) {
        for (const key of line.keys) {
          const option = processSettingsCatalog.options[key]
          if (!option || !isOptionVisibleInMode(option) || !isKeyAllowed(key)) continue
          if (!getProcessFieldState(fieldStates.states, key).visible) continue
          if (processKeyMatchesQuery(key, normalizedQuery)) count += 1
        }
      }
    }
    return count
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [normalizedQuery, fieldStates, allowedKeySet])

  /** Whether each page has any visible, allowed setting — pages with none are hidden entirely
   * (e.g. Speed when editing the restricted per-object subset). Independent of the search query. */
  const pageHasContent = useMemo(() => processSettingsCatalog.pages.map((page) =>
    page.groups.some((group) => group.lines.some((line) => line.keys.some((key) => {
      const option = processSettingsCatalog.options[key]
      if (!option || !isOptionVisibleInMode(option) || !isKeyAllowed(key) || !getProcessFieldState(fieldStates.states, key).visible) return false
      return !showChangedOnly || isModified(key)
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [fieldStates, allowedKeySet, showChangedOnly, config, baseConfig, bakedKeys, sliceBase])

  // Keep the active tab on a page that still has content.
  useEffect(() => {
    if (pageHasContent[activePage]) return
    const firstVisible = pageHasContent.findIndex(Boolean)
    if (firstVisible >= 0 && firstVisible !== activePage) setActivePage(firstVisible)
  }, [pageHasContent, activePage])

  const commit = (next: ProcessConfig) => {
    // Apply BambuStudio's deterministic value clamps after each edit.
    const issues = validateProcessConfig(next)
    if (issues.length > 0) {
      const fixed = { ...next }
      for (const issue of issues) {
        for (const [key, value] of Object.entries(issue.fix)) fixed[key] = value
      }
      setConfig(fixed)
      setCorrections(issues.map((issue) => issue.message))
    } else {
      setConfig(next)
      setCorrections([])
    }
  }

  const setValue = (key: string, value: string | string[]) => {
    commit({ ...config, [key]: value })
  }

  const setScalar = (key: string, scalar: string) => {
    const current = config[key]
    if (Array.isArray(current)) {
      const next = [...current]
      next[0] = scalar
      setValue(key, next)
    } else {
      setValue(key, scalar)
    }
  }

  /** Reverts a key to its resolved system value (BambuStudio "back to system value"). */
  const resetKey = (key: string) => {
    if (!baseConfig) return
    const next = { ...config }
    if (baseConfig[key] === undefined) delete next[key]
    else next[key] = baseConfig[key]
    commit(next)
  }

  /** True when a key can be reset — i.e. a distinct baseline value exists to revert to. */
  const canReset = (key: string): boolean =>
    baseConfig !== null && !processConfigValuesEqual(baseConfig[key], config[key])

  const modifiedKeyCount = useMemo(() => {
    if (!baseConfig) return 0
    return Object.keys(processSettingsCatalog.options).filter((key) => isKeyAllowed(key) && isModified(key)).length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConfig, config, bakedKeys, sliceBase, allowedKeySet])

  const modifiedPages = useMemo(() => {
    if (!baseConfig) return new Set<number>()
    const result = new Set<number>()
    processSettingsCatalog.pages.forEach((page, index) => {
      const anyModified = page.groups.some((group) =>
        group.lines.some((line) =>
          line.keys.some((key) => {
            const option = processSettingsCatalog.options[key]
            if (!option || !isOptionVisibleInMode(option) || !isKeyAllowed(key)) return false
            return isModified(key)
          })
        )
      )
      if (anyModified) result.add(index)
    })
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConfig, config, bakedKeys, sliceBase, allowedKeySet])

  const handleApply = () => {
    if (!baseConfig) return
    // Emit overrides relative to the effective slice base so baked-but-untouched keys aren't
    // re-sent, while a reset of a baked key becomes an explicit override back to the preset value.
    onApply(diffProcessConfig(sliceBase, config))
    onClose()
  }

  /** Reverts every setting to the preset baseline (BambuStudio "reset to default"). */
  const handleResetAll = () => {
    if (!baseConfig) return
    setConfig({ ...baseConfig })
    setCorrections([])
  }

  const handleSaveAsPreset = async () => {
    if (!baseConfig) return
    const name = await promptText({
      title: 'Save as custom process preset',
      label: 'Preset name',
      initialValue: `${processProfileName} (custom)`,
      confirmLabel: 'Save preset'
    })
    if (!name || !name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const presetConfig: Record<string, string | string[]> = { ...config, name: name.trim(), type: 'process' }
      await apiFetch('/api/slicing/profiles', {
        method: 'POST',
        body: {
          kind: 'process',
          fileName: `${name.trim()}.json`,
          encoding: 'utf8',
          content: JSON.stringify(presetConfig, null, 2)
        }
      })
      onApply(diffProcessConfig(sliceBase, config))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preset')
    } finally {
      setSaving(false)
    }
  }

  const pages = processSettingsCatalog.pages

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 720, width: '100%' }}>
        <Typography level="h4">{titlePrefix ?? 'Process settings'} — {modifiedKeyCount > 0 ? '*' : ''}{processProfileName}</Typography>
        {profileOptions && profileOptions.length > 1 && onProfileChange && (
          <FormControl size="sm" sx={{ mt: 1 }}>
            <FormLabel>Profile</FormLabel>
            <Select
              value={processProfileId}
              onChange={(_event, value) => {
                if (typeof value === 'string' && value !== processProfileId && baseConfig) {
                  // Carry modifications (vs the current preset baseline) onto the new profile.
                  onProfileChange(value, diffProcessConfig(baseConfig, config))
                }
              }}
            >
              {profileOptions.map((option) => (
                <Option key={option.id} value={option.id}>{option.name}</Option>
              ))}
            </Select>
          </FormControl>
        )}
        {loading && (
          <ScrollableDialogBody sx={{ mt: 1, px: 0 }}>
            <Stack alignItems="center" justifyContent="center" sx={{ py: 6 }} spacing={1}>
              <CircularProgress />
              <Typography level="body-sm">Loading process settings…</Typography>
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
            <TabList
              sx={{
                overflowX: 'auto',
                flexWrap: 'nowrap',
                flexShrink: 0
              }}
            >
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
              {corrections.length > 0 && (
                <Alert color="warning" size="sm" sx={{ m: 1 }}>
                  <Stack spacing={0.25}>
                    {corrections.map((message) => <Typography key={message} level="body-xs">{message}</Typography>)}
                  </Stack>
                </Alert>
              )}
              {pages.map((page, index) => (
                <TabPanel key={page.id} value={index} sx={{ p: 2 }}>
                  <Stack spacing={2}>
                    {page.groups.map((group) => {
                      const visibleLines = group.lines.filter((line) =>
                        line.keys.some((key) => {
                          const option = processSettingsCatalog.options[key]
                          if (!option || !isOptionVisibleInMode(option) || !isKeyAllowed(key)) return false
                          if (!getProcessFieldState(fieldStates.states, key).visible) return false
                          if (normalizedQuery && !processKeyMatchesQuery(key, normalizedQuery)) return false
                          return !showChangedOnly || isModified(key)
                        })
                      )
                      if (visibleLines.length === 0) return null
                      return (
                        <DialogSection key={group.title} title={group.title}>
                          <Stack spacing={1.25}>
                            {visibleLines.map((line, lineIndex) => (
                              <ProcessSettingLineRow
                                key={`${group.title}-${lineIndex}`}
                                lineLabel={line.label}
                                keys={line.keys.filter(isKeyAllowed)}
                                showDeveloperOptions={showDeveloperOptions}
                                code={line.code}
                                fieldStates={fieldStates}
                                accessor={accessor}
                                config={config}
                                isModified={isModified}
                                canReset={canReset}
                                onReset={resetKey}
                                onScalarChange={setScalar}
                                onValueChange={setValue}
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
          <Stack direction="row" spacing={1}>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="outlined" onClick={handleSaveAsPreset} disabled={loading || !baseConfig || saving} loading={saving}>
              Save as preset
            </Button>
            <Button variant="solid" onClick={handleApply} disabled={loading || !baseConfig || saving}>
              {applyScope === 'project' ? 'Apply to this project' : 'Apply to this slice'}
            </Button>
          </Stack>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

/** Case-insensitive match of a setting against the search query (label, key, or tooltip). */
function processKeyMatchesQuery(key: string, normalizedQuery: string): boolean {
  const option = processSettingsCatalog.options[key]
  if (!option) return false
  return option.label.toLowerCase().includes(normalizedQuery)
    || key.toLowerCase().includes(normalizedQuery)
    || (option.tooltip?.toLowerCase().includes(normalizedQuery) ?? false)
}

interface ProcessSettingLineRowProps {
  lineLabel?: string
  keys: string[]
  /** Whether BambuStudio develop-tier options are revealed (developer-mode preference). */
  showDeveloperOptions: boolean
  code?: boolean
  fieldStates: ReturnType<typeof computeProcessFieldStates>
  accessor: ReturnType<typeof createProcessConfigAccessor>
  config: ProcessConfig
  isModified: (key: string) => boolean
  canReset: (key: string) => boolean
  onReset: (key: string) => void
  onScalarChange: (key: string, value: string) => void
  onValueChange: (key: string, value: string | string[]) => void
}

function ProcessSettingLineRow(props: ProcessSettingLineRowProps): JSX.Element | null {
  const { keys, lineLabel, showDeveloperOptions, code, fieldStates, accessor, isModified, canReset, onReset, onScalarChange } = props
  const visibleKeys = keys.filter((key) => {
    const option = processSettingsCatalog.options[key]
    return option && isProcessOptionVisibleInMode(option, showDeveloperOptions) && getProcessFieldState(fieldStates.states, key).visible
  })
  if (visibleKeys.length === 0) return null

  const firstKey = visibleKeys[0] ?? keys[0] ?? ''
  const firstOption = processSettingsCatalog.options[firstKey]
  const label = lineLabel ?? firstOption?.label ?? firstKey
  // BambuStudio paints the line label orange when any value on the line differs
  // from the resolved system preset.
  const lineModified = visibleKeys.some((key) => isModified(key))

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
            const option = processSettingsCatalog.options[key]
            if (!option) return null
            const enabled = getProcessFieldState(fieldStates.states, key).enabled
            const enumRestriction = fieldStates.enumRestrictions.get(key)
            const modified = isModified(key)
            return (
              <Stack key={key} direction="row" spacing={0.25} alignItems="center">
                <SettingValueField
                  settingKey={key}
                  option={option}
                  value={accessor.str(key)}
                  enabled={enabled}
                  enumRestriction={enumRestriction}
                  showOwnLabel={visibleKeys.length > 1}
                  modified={modified}
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

