/**
 * Machine (printer) settings editor dialog.
 *
 * The third caller of `SettingsCatalogDialog`, and the simplest in one respect and the fussiest in
 * another.
 *
 * SIMPLER: there is no project branch. A 3MF embeds its filament and process settings but only
 * NAMES its printer, so a machine preset is always an installed one, no `sourceFileId`, no baked
 * overrides, no "the file changed this" bookkeeping. The resolved preset IS the baseline, and the
 * only diff that matters is against the preset's parent. There is likewise nothing to apply to, so
 * the dialog runs at `applyScope: 'preset'`: Save as preset / Update preset / Cancel, no Apply.
 *
 * FUSSIER: over half the machine catalog's options are vectors, and their elements are indexed by
 * different things per page: extruders on the Extruder page, Normal/Silent mode on Motion ability,
 * and nothing at all elsewhere. Editing element 0 (what the process dialog's scalar accessor does)
 * would silently change extruder 1 of an H2D and leave extruder 2 unreachable, so this dialog asks
 * `machineColumnsForPage` and renders one control per column. See `@printstream/shared`'s
 * `machine-settings.ts` for the rule and its BambuStudio sources.
 *
 * A save writes the FULL resolved config, not just the catalog's 77 keys, so the printer's
 * bespoke non-catalog values, `printable_area`, `bed_shape`, `printer_model`, survive an edit
 * untouched. BambuStudio edits those through widgets this dialog does not have; dropping them would
 * silently rebuild the preset around a different bed.
 *
 * Counterpart: the API `POST /api/slicing/profiles/resolve-machine` route.
 */
import { useEffect, useState } from 'react'
import {
  applyProcessConfigDefaults,
  buildMachinePresetConfig,
  machineColumnsForPage,
  machineColumnValue,
  machineSettingsCatalog,
  processConfigValuesEqual,
  setMachineColumnValue,
  type ProcessConfig
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { useEffectiveSlicerDeveloperMode } from '../../lib/slicerDeveloperMode'
import { usePromptDialog } from '../PromptDialogProvider'
import { SettingsCatalogDialog } from './SettingsCatalogDialog'
import type { SettingsCatalogAdapter, SettingsFieldColumn } from './settingsCatalogAdapter'

export interface MachineSettingsDialogProps {
  open: boolean
  onClose: () => void
  slicerTargetId: string
  /** Slicing preset id of the printer (`builtin:machine:…` or a custom id). */
  machineProfileId: string
  machineProfileName: string
  /**
   * The preset being edited is the user's own, so it can be updated IN PLACE. False/absent for a
   * built-in, which mirrors BambuStudio: a system preset is editable but can only be saved as a new
   * user preset. Matches the same prop on the process and filament dialogs.
   */
  canEditOriginal?: boolean
}

/** What `/profiles/resolve-machine` returns; `baseConfig` is the parent preset when one is declared. */
interface ResolveMachineResponse {
  config: Record<string, string | string[]>
  baseConfig?: Record<string, string | string[]>
}

/** Which catalog page a key belongs to: the column rule is page-driven. */
const PAGE_ID_BY_KEY: ReadonlyMap<string, string> = new Map(
  machineSettingsCatalog.pages.flatMap((page) =>
    page.groups.flatMap((group) => group.lines.flatMap((line) => line.keys.map((key) => [key, page.id] as const))))
)

export default function MachineSettingsDialog(props: MachineSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, machineProfileId, machineProfileName, canEditOriginal } = props
  // The shell applies the develop-tier gate itself; this only tells it which mode it is in.
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
  const { promptText } = usePromptDialog()

  /**
   * The preset's own values, and its PARENT's for the emphasis-only "this preset overrides that"
   * state. Unlike the process and filament dialogs there is no third config: nothing sits between
   * the preset and the editor, so `baseConfig` is both the reset target and the diff source.
   */
  const [baseConfig, setBaseConfig] = useState<ProcessConfig | null>(null)
  const [parentBaseline, setParentBaseline] = useState<ProcessConfig | null>(null)
  /**
   * The resolved config as it arrived, INCLUDING the keys the catalog knows nothing about. Kept
   * whole so a save can write the preset back intact; the editor only ever replaces catalog keys.
   */
  const [resolvedConfig, setResolvedConfig] = useState<ProcessConfig>({})
  const [config, setConfig] = useState<ProcessConfig>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !machineProfileId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setBaseConfig(null)
    apiFetch<ResolveMachineResponse>('/api/slicing/profiles/resolve-machine', {
      method: 'POST',
      body: { machineProfileId, targetId: slicerTargetId || null }
    })
      .then((response) => {
        if (cancelled) return
        const effective = applyProcessConfigDefaults(response.config as ProcessConfig, machineSettingsCatalog)
        setResolvedConfig(response.config as ProcessConfig)
        setBaseConfig(effective)
        // The route returns the parent only when the preset declares `inherits`; without one there
        // is no "inherited value" to contrast against, so the emphasis state simply never fires.
        setParentBaseline(response.baseConfig
          ? applyProcessConfigDefaults(response.baseConfig as ProcessConfig, machineSettingsCatalog)
          : null)
        setConfig(effective)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load printer settings')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, machineProfileId, slicerTargetId])

  /**
   * How many columns each key has, and what they are called.
   *
   * Derived from the EDITED config, not the resolved one: adding an extruder or turning silent mode
   * on has to grow the row it controls, which is exactly what BambuStudio's `build_unregular_pages`
   * does when `nozzle_diameter`'s length changes.
   */
  const columnsFor = (key: string): SettingsFieldColumn[] => {
    const pageId = PAGE_ID_BY_KEY.get(key)
    if (pageId === undefined) return []
    return machineColumnsForPage(key, pageId, config).map((column) => ({
      id: `${key}#${column.index}`,
      settingKey: key,
      label: column.label,
      value: machineColumnValue(config[key], column.index),
      onChange: (value) => setConfig((prev) => ({
        ...prev,
        [key]: setMachineColumnValue(prev[key], column.index, value)
      }))
    }))
  }

  /** A value differing from the preset as saved: the only kind of change this dialog can have. */
  const isChanged = (key: string): boolean =>
    baseConfig !== null
    && !processConfigValuesEqual(baseConfig[key], config[key], machineSettingsCatalog.options[key])

  /**
   * An override the PRESET itself carries relative to its parent: emphasis only, never counted.
   * BambuStudio keeps this as a separate question from "modified"
   * (`current_different_from_parent_options` vs `current_dirty_options`).
   */
  const isPresetOverride = (key: string): boolean =>
    parentBaseline !== null && baseConfig !== null
    && !processConfigValuesEqual(parentBaseline[key], baseConfig[key], machineSettingsCatalog.options[key])

  /** What a changed value replaced, naming which baseline it is showing. */
  const originalOf = (key: string): { value: string; label: string } | null => {
    const asText = (value: string | string[] | undefined): string | null => {
      if (Array.isArray(value)) {
        const parts = value.map((entry) => String(entry ?? ''))
        // Every column, not just the first: on a multi-extruder row the hover would otherwise
        // repeat the number already on screen and say nothing about the others.
        const text = parts.every((entry) => entry === parts[0]) ? (parts[0] ?? '') : parts.join(' / ')
        return text === '' ? null : text
      }
      return value === undefined || value === '' ? null : String(value)
    }
    if (isChanged(key)) {
      const value = asText(baseConfig?.[key])
      return value === null ? null : { value, label: 'Preset value' }
    }
    if (isPresetOverride(key)) {
      const value = asText(parentBaseline?.[key])
      return value === null ? null : { value, label: 'Inherited value' }
    }
    return null
  }

  // Built fresh each render like its process and filament siblings: the shell reads the adapter
  // during render rather than keying an effect on it, so memoizing would only risk showing values
  // from a render that has already been superseded.
  const adapter: SettingsCatalogAdapter = {
    columnsFor,
    // One question here, not two: there is nothing between the preset and the editor, so what the
    // dialog counts, colours and can reset are all the same set.
    isModified: isChanged,
    isUnsaved: isChanged,
    isPresetOverride,
    canReset: isChanged,
    onReset: (key) => setConfig((prev) => {
      if (!baseConfig) return prev
      const next = { ...prev }
      if (baseConfig[key] === undefined) delete next[key]
      else next[key] = baseConfig[key]
      return next
    }),
    originalOf
  }

  const handleResetAll = () => {
    if (!baseConfig) return
    setConfig({ ...baseConfig })
  }

  /**
   * Save the edited printer as a preset. `overwrite` updates the original custom preset in place.
   *
   * Written over the RESOLVED config rather than the editor's own, so every key BambuStudio's
   * printer tab edits through a widget we do not have, the printable area, the bed shape and
   * exclusion zones, the model and variant identity, is carried through exactly as it arrived.
   * Only the catalog keys the user could actually see are replaced.
   */
  const savePreset = async (name: string, overwrite: boolean) => {
    if (!baseConfig) return
    setSaving(true)
    setError(null)
    try {
      const presetConfig = buildMachinePresetConfig({
        resolved: resolvedConfig,
        baseline: baseConfig,
        edited: config,
        name
      })
      await apiFetch('/api/slicing/profiles', {
        method: 'POST',
        body: {
          kind: 'machine',
          fileName: `${name}.json`,
          encoding: 'utf8',
          overwrite,
          content: JSON.stringify(presetConfig, null, 2)
        }
      })
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
      title: 'Save as custom printer preset',
      label: 'Preset name',
      initialValue: `${machineProfileName} (custom)`,
      confirmLabel: 'Save preset'
    })
    if (!name || !name.trim()) return
    await savePreset(name.trim(), false)
  }

  return (
    <SettingsCatalogDialog
      open={open}
      onClose={onClose}
      catalog={machineSettingsCatalog}
      titlePrefix="Printer settings"
      presetName={machineProfileName}
      loading={loading}
      loadingLabel="Loading printer settings…"
      error={error}
      ready={baseConfig !== null}
      showDeveloperOptions={showDeveloperOptions}
      adapter={adapter}
      actions={{
        onResetAll: handleResetAll,
        onCancel: onClose,
        saving,
        onUpdatePreset: canEditOriginal ? () => void savePreset(machineProfileName, true) : undefined,
        onSaveAsPreset: () => void handleSaveAsPreset()
        // No `apply`: there is no slice or project to apply a printer preset to.
      }}
    />
  )
}
