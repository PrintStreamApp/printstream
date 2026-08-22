/**
 * The contract a settings dialog implements so {@link SettingsCatalogDialog} can render it.
 *
 * The shell owns the chrome (tabs, search, "Changed only", footer) and knows nothing about where a
 * value comes from; the adapter owns the value space and the change semantics. That split is what
 * lets one shell serve three dialogs whose insides are genuinely different: the process dialog runs
 * a conditional field-state engine and a per-object override mode, the filament dialog edits element
 * 0 of per-variant vectors and broadcasts back, and the machine dialog edits a vector column per
 * extruder.
 *
 * Counterparts: `ProcessSettingsDialog.tsx`, `library/FilamentSettingsDialog.tsx`,
 * `MachineSettingsDialog.tsx`.
 */
import type { ReactNode } from 'react'

/**
 * One editable control on a settings line.
 *
 * Most keys produce exactly one; a machine vector produces one per extruder (or per Normal/Silent
 * motion mode). `label` is set only when the line really carries more than one, because a single
 * control is already named by the line's own label.
 */
export interface SettingsFieldColumn {
  /** Unique within the line — the key, or `${key}#${index}` for a vector column. */
  id: string
  /** The catalog key this column edits. */
  settingKey: string
  /** Column name ("Extruder 2", "Silent"); omitted when the line has one control. */
  label?: string
  /** Current serialized scalar value. */
  value: string
  /** False renders the control read-only (BambuStudio's `toggle_field`). Defaults to true. */
  enabled?: boolean
  /** Enum values allowed in the current context; defaults to the option's full list. */
  enumRestriction?: string[]
  /** Bulk editing: the selection disagrees on this value, so no single one is true. */
  mixed?: boolean
  /** Rendered immediately before the control — the filament dialog's override checkbox. */
  prefix?: ReactNode
  onChange: (value: string) => void
}

/** Per-key state and behaviour the shell needs to render and style a line. */
export interface SettingsCatalogAdapter {
  /** The controls for one key. Never empty; a scalar returns a single unlabelled column. */
  columnsFor: (key: string) => SettingsFieldColumn[]
  /**
   * Counts toward the title's "*", the tab emphasis and the "Changed only" filter. Broader than
   * {@link isUnsaved}: the process dialog's per-object mode also counts a key that is explicitly
   * SET while matching the value it inherits, because that pin is still an override.
   */
  isModified: (key: string) => boolean
  /** An edit made in this session — colours the LINE label amber. */
  isUnsaved: (key: string) => boolean
  /**
   * Colours the FIELD amber. Defaults to {@link isUnsaved}. The process dialog separates the two:
   * its field marks any value differing from the preset baseline, while its line marks only what
   * this session changed relative to the effective slice base, and a 3MF's baked overrides sit
   * between the two.
   */
  isFieldChanged?: (key: string) => boolean
  /** An override the PRESET carries over its parent — bold + italic, never counted. */
  isPresetOverride: (key: string) => boolean
  canReset: (key: string) => boolean
  onReset: (key: string) => void
  /** The baseline a changed value replaced, for the hover. */
  originalOf: (key: string) => { value: string; label: string } | null
  /**
   * A leading dot on the line label, for a state that emphasis alone cannot express — the process
   * dialog's per-object "set, but matching the inherited value" case, which is resettable despite
   * showing no value difference. Return null for no marker.
   */
  lineMarker?: (keys: string[]) => { tooltip: string } | null
}

/** Resolves the field-level amber, honouring the adapter's optional override. */
export function isFieldChanged(adapter: SettingsCatalogAdapter, key: string): boolean {
  return (adapter.isFieldChanged ?? adapter.isUnsaved)(key)
}
