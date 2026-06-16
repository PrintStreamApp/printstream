/**
 * Process (quality) settings editor dialog.
 *
 * Renders the Bambu-faithful process settings catalog (generated from
 * BambuStudio source) page-by-page, applying the same conditional
 * visibility/enable rules and value-coercion validation that BambuStudio's
 * Process tab uses. The user edits values against a resolved base config; the
 * dialog emits the sparse override map (changed keys) back to the slice dialog
 * and can optionally persist the result as a reusable custom process preset.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, CircularProgress, DialogActions, Divider, FormControl, FormLabel,
  IconButton, Input, Option, Select, Stack, Switch, Tab, TabList, TabPanel, Tabs, Textarea, Tooltip, Typography
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
  isAdvancedModeOption,
  processConfigValuesEqual,
  processSettingsCatalog,
  serializeProcessBool,
  validateProcessConfig,
  type ProcessConfig,
  type ProcessSettingOption,
  type ProcessSettingOverrides,
  type ProcessVisibilityContext
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { BackAwareModal } from './BackAwareModal'
import { DialogSection } from './DialogSection'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { usePromptDialog } from './PromptDialogProvider'

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
  onApply: (overrides: ProcessSettingOverrides) => void
}

type ResolveResponse = {
  config: Record<string, string | string[]>
  baseConfig?: Record<string, string | string[]>
  overriddenKeys?: string[]
}

export default function ProcessSettingsDialog(props: ProcessSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, processProfileId, processProfileName, sourceFileId, initialOverrides, profileOptions, onProfileChange, allowedKeys, baseOverlay, titlePrefix, onApply } = props
  const allowedKeySet = useMemo(() => (allowedKeys ? new Set(allowedKeys) : null), [allowedKeys])
  const isKeyAllowed = (key: string): boolean => allowedKeySet === null || allowedKeySet.has(key)
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
  const normalizedQuery = query.trim().toLowerCase()
  const { promptText } = usePromptDialog()

  const context: ProcessVisibilityContext = useMemo(
    () => ({ ...defaultProcessVisibilityContext, ...props.visibilityContext }),
    [props.visibilityContext]
  )

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
  }, [open, processProfileId, slicerTargetId, sourceFileId, initialOverrides, baseOverlay])

  const fieldStates = useMemo(() => computeProcessFieldStates(config, context), [config, context])
  const accessor = useMemo(() => createProcessConfigAccessor(config), [config])

  /** Number of visible settings matching the search query on each page (0 when not searching). */
  const pageMatchCounts = useMemo(() => processSettingsCatalog.pages.map((page) => {
    if (!normalizedQuery) return 0
    let count = 0
    for (const group of page.groups) {
      for (const line of group.lines) {
        for (const key of line.keys) {
          const option = processSettingsCatalog.options[key]
          if (!option || !isAdvancedModeOption(option) || !isKeyAllowed(key)) continue
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
      return Boolean(option) && isAdvancedModeOption(option!) && isKeyAllowed(key) && getProcessFieldState(fieldStates.states, key).visible
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [fieldStates, allowedKeySet])

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

  /**
   * True when a key differs from its preset baseline — either a resettable value diff, or a
   * 3MF-baked override whose baseline value couldn't be resolved (`bakedKeys`, still untouched
   * relative to the effective config). Surfaces both in-session edits and sealed-in overrides.
   */
  const isModified = (key: string): boolean => {
    if (baseConfig === null) return false
    if (!processConfigValuesEqual(baseConfig[key], config[key])) return true
    return bakedKeys.has(key) && processConfigValuesEqual(config[key], sliceBase[key])
  }

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
            if (!option || !isAdvancedModeOption(option) || !isKeyAllowed(key)) return false
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
              sx={{ flexShrink: 0, mb: 1 }}
            />
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
                          if (!option || !isAdvancedModeOption(option) || !isKeyAllowed(key)) return false
                          if (!getProcessFieldState(fieldStates.states, key).visible) return false
                          return !normalizedQuery || processKeyMatchesQuery(key, normalizedQuery)
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
            <Button variant="solid" onClick={handleApply} disabled={loading || !baseConfig || saving}>Apply to this slice</Button>
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
  const { keys, lineLabel, code, fieldStates, accessor, isModified, canReset, onReset, onScalarChange } = props
  const visibleKeys = keys.filter((key) => {
    const option = processSettingsCatalog.options[key]
    return option && isAdvancedModeOption(option) && getProcessFieldState(fieldStates.states, key).visible
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
                <ProcessSettingField
                  settingKey={key}
                  option={option}
                  enabled={enabled}
                  enumRestriction={enumRestriction}
                  showOwnLabel={visibleKeys.length > 1}
                  modified={modified}
                  accessor={accessor}
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

interface ProcessSettingFieldProps {
  settingKey: string
  option: ProcessSettingOption
  enabled: boolean
  enumRestriction?: string[]
  showOwnLabel: boolean
  isCode?: boolean
  modified?: boolean
  accessor: ReturnType<typeof createProcessConfigAccessor>
  onScalarChange: (key: string, value: string) => void
}

function ProcessSettingField(props: ProcessSettingFieldProps): JSX.Element {
  const { settingKey, option, enabled, enumRestriction, showOwnLabel, isCode, modified, accessor, onScalarChange } = props
  const scalar = accessor.str(settingKey)

  if (option.type === 'bool') {
    return (
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Switch
          checked={accessor.bool(settingKey)}
          disabled={!enabled}
          onChange={(event) => onScalarChange(settingKey, serializeProcessBool(event.target.checked))}
        />
        {showOwnLabel && (
          <Typography level="body-sm" sx={modified ? { color: 'warning.plainColor', fontWeight: 'lg' } : undefined}>
            {option.label}
          </Typography>
        )}
      </Stack>
    )
  }

  if (option.type === 'enum') {
    const values = enumRestriction ?? option.enumValues ?? []
    const labels = option.enumValues ?? []
    return (
      <Select
        value={scalar}
        disabled={!enabled}
        onChange={(_event, value) => { if (typeof value === 'string') onScalarChange(settingKey, value) }}
        sx={{ minWidth: 180 }}
      >
        {values.map((value) => {
          const labelIndex = labels.indexOf(value)
          const display = labelIndex >= 0 && option.enumLabels ? option.enumLabels[labelIndex] ?? value : value
          return <Option key={value} value={value}>{display}</Option>
        })}
      </Select>
    )
  }

  if (option.type === 'string' && (isCode || option.isCode)) {
    return (
      <Textarea
        minRows={3}
        value={scalar}
        disabled={!enabled}
        onChange={(event) => onScalarChange(settingKey, event.target.value)}
        sx={{ flex: 1, fontFamily: 'code', minWidth: 280 }}
      />
    )
  }

  const isNumeric = option.type === 'int' || option.type === 'float' || option.type === 'percent' || option.type === 'floatOrPercent'

  return (
    <Input
      value={scalar}
      disabled={!enabled}
      onChange={(event) => onScalarChange(settingKey, event.target.value)}
      endDecorator={option.sidetext ? <Typography level="body-xs">{option.sidetext}</Typography> : undefined}
      slotProps={isNumeric ? { input: { inputMode: 'decimal' } } : undefined}
      sx={{ minWidth: 140, maxWidth: option.type === 'string' || option.type === 'point' ? 280 : 180 }}
    />
  )
}
