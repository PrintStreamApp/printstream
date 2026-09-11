/**
 * Filament (material) settings editor dialog: the material "tune" dialog opened from the settings
 * icon next to a material's trashbin in the slice dialog. It owns the FILAMENT value space and lets
 * the user persist the result three ways, like Bambu Studio: save within this slice/3MF (the
 * per-material override that rides the slice), save as a new workspace preset, or update the
 * original (custom presets only: builtin Bambu presets are read-only, so that button is hidden).
 *
 * The chrome (tabs, search, "Changed only", footer) comes from
 * `settings/SettingsCatalogDialog.tsx`, shared with the process and machine editors; this dialog
 * reaches it through a {@link SettingsCatalogAdapter}. Its own two specialities are the "Setting
 * Overrides" checkboxes and the per-variant broadcast: the fields edit element 0, but a value can
 * differ on a later extruder variant, so every "is this changed" question and the emitted overrides
 * work in the un-collapsed `raw` space.
 *
 * The filament tab has essentially no conditional show/enable rules (unlike the process tab), so
 * this dialog passes no `isKeyVisible` and every catalog option renders, subject only to the
 * shell's developer-mode tiering. Counterpart: the API `/api/slicing/profiles/resolve-filament` route.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, Tooltip, Typography } from '@mui/joy'
import {
  diffFilamentVariantConfig,
  filamentSettingsCatalog,
  filamentVariantValuesEqual,
  prepareResolvedFilamentState,
  scalarizeFilamentConfig,
  type FilamentConfig,
  type FilamentSettingOverrides,
  type ResolveFilamentConfigResponse,
  type ResolvedFilamentState,
  type SettingsBaselineOrigin,
  describeSettingsBaseline,
  isNilSettingValue
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { resolveWorkspaceFilamentConfig } from './workspaceFilamentResolver'
import { useEffectiveSlicerDeveloperMode } from '../../lib/slicerDeveloperMode'
import { usePromptDialog } from '../PromptDialogProvider'
import { SettingsCatalogDialog } from '../settings/SettingsCatalogDialog'
import { SettingsBaselineNote } from '../settings/SettingsBaselineNote'
import type { SettingsCatalogAdapter } from '../settings/settingsCatalogAdapter'

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
  /** Search text to open the catalog with, from the cross-catalog settings search. */
  initialQuery?: string
  /** Source 3MF id + slot, required to resolve a `project:filament:` material's embedded base. */
  sourceFileId?: string | null
  projectFilamentId?: number | null
  initialOverrides: FilamentSettingOverrides
  /** Whether the current material is a workspace custom preset (so "Update preset" is offered). */
  canEditOriginal?: boolean
  /**
   * What the Apply button commits to: a `project` (the 3D editor, where the override persists with
   * the next project save) or a one-off `slice` (the print/slice dialog). Only changes the button
   * wording: mirrors {@link ProcessSettingsDialogProps.applyScope} so the two dialogs read alike.
   */
  /**
   * What the dialog is editing FOR.
   *
   * 'slice' / 'project' edit a slice's config and emit an override map through `onApply`.
   * 'preset' edits the stored preset ITSELF: opened from the slicer-profiles settings, where
   * there is no slice to apply to: the Apply button is hidden and `onApply` is never called, so
   * the only ways out are Save as preset, Update preset (custom presets only, via
   * `canEditOriginal`) and Cancel. That mirrors BambuStudio, where editing a SYSTEM preset can
   * only ever produce a new user preset.
   */
  applyScope?: 'project' | 'slice' | 'preset'
  /**
   * How the dialog resolves a preset's base config. Defaults to the WORKSPACE route
   * (`/api/slicing/profiles/resolve-filament`). The public 3MF editor passes an anonymous resolver
   * (built-in presets via `/api/public/slicing/...`; project filaments from the in-tab 3MF slot), so
   * it can run with no workspace. Additive: omitting it preserves the exact library behaviour.
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
}, options?: { signal?: AbortSignal }) => Promise<ResolveFilamentConfigResponse>


export default function FilamentSettingsDialog(props: FilamentSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, filamentProfileId, filamentProfileName, filamentPresetFullName, sourceFileId, projectFilamentId, initialOverrides, canEditOriginal, applyScope = 'slice', initialQuery, resolveConfig, onApply } = props
  // The shell applies the develop-tier gate itself; this only tells it which mode it is in.
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
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
  /** See the twin in ProcessSettingsDialog: a declared record narrows what counts as this project's. */
  const [declaresOverrides, setDeclaresOverrides] = useState(false)
  /** False when no preset resolved to diff against: see {@link ResolvedFilamentState.baselineResolved}. */
  const [baselineResolved, setBaselineResolved] = useState(true)
  /**
   * What the change markers ended up being measured against, straight from the resolver: see
   * {@link SettingsBaselineOrigin}. Not a prop: a host computing it separately answered per PRESET
   * while the resolver answers per SLOT, and knew nothing of browser-stored presets.
   */
  const [baselineOrigin, setBaselineOrigin] = useState<SettingsBaselineOrigin | undefined>(undefined)
  const [config, setConfig] = useState<FilamentConfig>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Each key's original per-filament vector length (before scalarizing), so an emitted override can
  // be broadcast back to that shape at slice time, a scalar written where a multi-variant machine
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
    const resolve = (resolveConfig ?? resolveWorkspaceFilamentConfig)({
      filamentProfileId,
      targetId: slicerTargetId || null,
      sourceFileId: sourceFileId || null,
      projectFilamentId: projectFilamentId ?? null
    })
    resolve
      .then((response) => {
        if (cancelled) return
        // "Modified" = the value differs from the preset OUTSIDE the project (value-diff vs the
        // resolved parent), same as the process dialog, this is what surfaces real embedded
        // deviations a project-preset slice would print with. The shared prepare helper is also
        // what drives the slice dialog's pre-open "changed values" badge, so the two agree.
        const state = prepareResolvedFilamentState(response)
        baseShapesRef.current = state.shapes
        setBaseConfig(state.baseline)
        setParentBaseline(state.parentBaseline)
        setBakedKeys(new Set(state.bakedKeys))
        setDeclaresOverrides(state.declaresOverrides)
        setBaselineResolved(state.baselineResolved)
        setBaselineOrigin(state.baselineOrigin)
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
   * True when this project/session changed the key relative to the preset in use.
   *
   * Two conditions, both required, and the first is what keeps the surface honest: the value must
   * actually DIFFER from the preset, the same test {@link canReset} uses, so anything marked
   * changed can always be reset, and "Reset all" always clears the marks. BambuStudio agrees: its
   * modified marker is `PresetCollection::dirty_options`, a value diff against the selected preset.
   * The declared record (`different_settings_to_system`) decides which of the file's values SURVIVE
   * loading (`update_non_diff_values_to_base_config`), not what counts as changed; treating it as
   * the marker put three permanently-un-resettable "changes" on every material of a stock project.
   *
   * The exception is a preset that did not resolve (`baselineResolved` false): there is nothing to
   * diff against, so the record is the only evidence a setting was changed and is taken at its word,
   * an honest "changed, and we cannot say from what". Mirrors ProcessSettingsDialog.
   */
  const isProjectChange = (key: string): boolean => {
    if (raw === null) return false
    const option = filamentSettingsCatalog.options[key]
    if (!baselineResolved) return bakedKeys.has(key)
    if (filamentVariantValuesEqual(raw.baseline[key], rawConfig[key], option)) return false
    // With a record present, an undeclared difference is drift BambuStudio normalizes away, not
    // this project's change; a key edited in this session always counts.
    if (declaresOverrides
      && !bakedKeys.has(key)
      && filamentVariantValuesEqual(raw.effective[key], rawConfig[key], option)) return false
    return true
  }

  /**
   * The keys BambuStudio renders with an enable checkbox, its filament "Setting Overrides" page.
   * Unchecked means the value is nil ("not overridden"); checked restores a real value. Derived
   * from the catalog page rather than a second hand-kept list, so the two cannot drift.
   */
  const overrideKeys = useMemo(() => new Set(
    (filamentSettingsCatalog.pages.find((page) => page.id === 'setting-overrides')?.groups ?? [])
      .flatMap((group) => group.lines.flatMap((line) => line.keys))
  ), [])

  /**
   * An override the PRESET itself carries relative to its parent: emphasis only, never a badge and
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
   * preset carries is measured against its parent, so the tooltip names which baseline it is
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


  /**
   * The overrides this session should ride the slice with: every key whose per-variant value differs
   * from the effective slice base, each broadcast back to the key's original vector length (a
   * scalar written where a multi-variant machine expects N values would slice under-length).
   *
   * Measured against the effective base, not the preset, so baked-but-untouched values aren't
   * re-sent while a RESET of a baked deviation becomes an explicit override back to the preset
   * value, which is what actually heals a drifted project filament at slice time.
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

  /** The current element-0 scalar the fields edit; see the `raw`/`config` split above. */
  const scalarOf = (key: string): string => {
    const value = config[key]
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
    return typeof value === 'string' ? value : ''
  }

  /**
   * Everything the shared shell needs that only this dialog can answer.
   *
   * One column per key: the filament tab edits element 0 and broadcasts, because a material's
   * per-variant values describe the same spool on different extruders rather than separate things
   * to set. (The machine dialog is the opposite case: see `machineColumnsForPage`.)
   */
  // Suppressed while loading or errored: the caveat describes a config that is not on screen yet.
  const baselineNoteText = loading || error ? null : describeSettingsBaseline(baselineOrigin, 'filament')

  const adapter: SettingsCatalogAdapter = {
    columnsFor: (key) => {
      const option = filamentSettingsCatalog.options[key]
      if (!option) return []
      const isOverride = overrideKeys.has(key)
      const overridden = isOverride && !isNilSettingValue(config[key])
      return [{
        id: key,
        settingKey: key,
        value: scalarOf(key),
        enabled: !isOverride || overridden,
        prefix: isOverride ? (
          <Tooltip
            title={overridden
              ? 'Overriding the printer setting: uncheck to use the printer value'
              : 'Not overridden: check to set a filament-specific value'}
            variant="soft"
          >
            <Checkbox
              size="sm"
              checked={overridden}
              slotProps={{ input: { 'aria-label': `Override ${option.label}` } }}
              // Mirrors BambuStudio's Field::set_na_value / set_last_meaningful_value:
              // unchecking stores nil, checking restores a real value (the catalog default,
              // which is what the printer would have used anyway).
              onChange={(event) => setScalar(key, event.target.checked ? (option.default ?? '0') : 'nil')}
            />
          </Tooltip>
        ) : undefined,
        onChange: (value) => setScalar(key, value)
      }]
    },
    // One question here, not two: a filament change is measured against the preset in use, so what
    // the dialog counts and what it colours are the same set.
    isModified: isProjectChange,
    isUnsaved: isProjectChange,
    isPresetOverride,
    canReset,
    onReset: resetKey,
    originalOf
  }

  return (
    <SettingsCatalogDialog
      open={open}
      onClose={onClose}
      catalog={filamentSettingsCatalog}
      initialQuery={initialQuery}
      titlePrefix="Filament settings"
      presetName={filamentProfileName}
      subtitle={filamentPresetFullName && filamentPresetFullName !== filamentProfileName ? (
        <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: -0.5 }}>{filamentPresetFullName}</Typography>
      ) : undefined}
      header={baselineNoteText ? <SettingsBaselineNote note={baselineNoteText} /> : undefined}
      loading={loading}
      loadingLabel="Loading filament settings…"
      error={error}
      ready={baseConfig !== null}
      showDeveloperOptions={showDeveloperOptions}
      adapter={adapter}
      actions={{
        onResetAll: handleResetAll,
        onCancel: onClose,
        saving,
        // A built-in is editable but can only be saved as a NEW user preset, the way BambuStudio
        // treats a system preset; the workspace's own can be updated in place.
        onUpdatePreset: canEditOriginal ? () => void handleUpdateOriginal() : undefined,
        onSaveAsPreset: () => void handleSaveAsPreset(),
        apply: applyScope === 'preset' ? undefined : {
          label: applyScope === 'project' ? 'Apply to this project' : 'Apply to this slice',
          onApply: handleApply
        }
      }}
    />
  )
}
