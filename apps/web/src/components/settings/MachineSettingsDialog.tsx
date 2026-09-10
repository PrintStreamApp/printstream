/**
 * Machine (printer) settings editor dialog.
 *
 * The third caller of `SettingsCatalogDialog`, and the simplest in one respect and the fussiest in
 * another.
 *
 * SIMPLER: the resolved preset IS the baseline. Unlike the process dialog there is no third config
 * between the preset and the editor, so the only diffs that matter are against the preset (changed)
 * and against the preset's parent (emphasis only).
 *
 * It DOES have a project branch, though. This header used to claim a 3MF "only NAMES its printer",
 * which is false and is why Apply did not exist here for so long: `project_settings.config` carries
 * the full machine block that `retargetProjectSettingsToMachine` writes (bed, nozzle, extruder
 * topology, machine gcode, limits). So a printer modified for ONE project, without minting a global
 * preset, is representable exactly as a modified process is. At `applyScope: 'project'` the footer
 * gains "Apply to this project" and `onApply` emits the diff against the preset; at `'preset'`
 * (the settings-page host, which edits a stored preset and has no project) it does not.
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
 * Counterpart: `components/workspaceMachineResolver.ts`, the one module that fetches that route.
 */
import { useEffect, useState } from 'react'
import {
  applyProcessConfigDefaults,
  buildMachinePresetConfig,
  diffProcessConfig,
  machineColumnsForPage,
  machineColumnValue,
  machineSettingsCatalog,
  processConfigValuesEqual,
  setMachineColumnValue,
  type ProcessConfig
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { resolveWorkspaceMachineConfig } from '../workspaceMachineResolver'
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
  /** Search text to open the catalog with, from the cross-catalog settings search. */
  initialQuery?: string
  /**
   * Where an edit lands, mirroring the process dialog. `'preset'` (default) is the stored-preset
   * editor: no Apply button, and {@link onApply} is never called. `'project'` (the 3MF editor) and
   * `'slice'` (the prepare-print dialog) both emit the override map instead of writing a preset;
   * they differ only in the promise the button makes, because only the editor's save persists it.
   */
  applyScope?: 'preset' | 'project' | 'slice'
  /** The project's existing machine overrides, laid over the resolved preset when the dialog opens. */
  initialOverrides?: Record<string, string | string[]>
  /** The diff against the resolved preset: what the project should carry on top of it. */
  onApply?: (overrides: Record<string, string | string[]>) => void
}

/** Which catalog page a key belongs to: the column rule is page-driven. */
const PAGE_ID_BY_KEY: ReadonlyMap<string, string> = new Map(
  machineSettingsCatalog.pages.flatMap((page) =>
    page.groups.flatMap((group) => group.lines.flatMap((line) => line.keys.map((key) => [key, page.id] as const))))
)

export default function MachineSettingsDialog(props: MachineSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, machineProfileId, machineProfileName, canEditOriginal, applyScope = 'preset', initialOverrides, initialQuery, onApply } = props
  // Content-keyed, not identity-keyed: hosts build this map inline, so keying the load effect on
  // the object itself would refetch and reset the form on every parent render (see apps/web/the development notes).
  const initialOverridesKey = JSON.stringify(initialOverrides ?? null)
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
    resolveWorkspaceMachineConfig({ machineProfileId, targetId: slicerTargetId || null })
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
        // The project's own values sit ON TOP of the preset, which is what makes them read as
        // "changed" against it and what `handleApply` diffs back out.
        setConfig(initialOverrides ? { ...effective, ...initialOverrides } : effective)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load printer settings')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialOverrides is content-keyed above
  }, [open, machineProfileId, slicerTargetId, initialOverridesKey])

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

  /**
   * The project's machine settings as a diff against the RESOLVED PRESET, which is the baseline the
   * server re-resolves and lays these back over. Emitting the whole config instead would freeze
   * every machine value into the project and make a later preset fix invisible to it.
   */
  const handleApply = (): void => {
    if (!baseConfig) return
    onApply?.(diffProcessConfig(baseConfig, config, machineSettingsCatalog))
    onClose()
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
      initialQuery={initialQuery}
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
        onSaveAsPreset: () => void handleSaveAsPreset(),
        // Omitted at 'preset' scope (the settings page edits a stored preset and has nothing to
        // apply to); present in a project, where it saves the edit INTO the project instead.
        apply: applyScope === 'preset'
          ? undefined
          : { label: applyScope === 'project' ? 'Apply to this project' : 'Apply to this slice', onApply: handleApply }
      }}
    />
  )
}
