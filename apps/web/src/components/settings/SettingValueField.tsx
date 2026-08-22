/**
 * One value control for a Bambu settings option (process OR filament) — the catalog-agnostic leaf
 * shared by ProcessSettingsDialog and FilamentSettingsDialog. Renders the right input for the
 * option type (bool Switch / enum Select / code Textarea / numeric or text Input) against a plain
 * serialized-string value, emitting the new scalar. It knows nothing about which catalog the option
 * came from, so both dialogs render identical controls.
 */
import type React from 'react'
import { Box, Input, Option, Select, Stack, Switch, Textarea, Tooltip, Typography } from '@mui/joy'
import { FILAMENT_INDEX_PROCESS_KEYS, serializeProcessBool, type ProcessSettingOption, isNilSettingValue } from '@printstream/shared'

/**
 * One fixed width for every scalar value control (numeric inputs, percent fields, and enum
 * selects) so the value column lines up — content-sized controls otherwise vary (a bare number
 * shrinks; a `%`/`°` decorator or a long enum label grows).
 */
export const SCALAR_CONTROL_WIDTH = 200

/** A project material offered by filament-index settings ("Support/raft base" etc.). */
export interface SettingFilamentChoice {
  /** 1-based filament index as the config stores it (position in the project's material list). */
  id: number
  label: string
  color: string | null
  /**
   * Material character, used only to classify a newly-chosen support interface material for the
   * recommendation prompt (`recommendSupportSettingsForInterfaceFilament`) — never for rendering.
   * Optional so hosts that only need the picker can omit them; `isSupport`/`isSoluble` are null
   * when the project carried no `filament_is_support`/`filament_soluble` flag for the slot.
   */
  filamentType?: string | null
  isSupport?: boolean | null
  isSoluble?: boolean | null
  /**
   * The material's FULL preset name ("Bambu Support For PLA/PETG @BBL X1C"), for the
   * recommendation table's name-matched entries — `label` may be vendor-stripped for picker
   * grouping. Classification-only, like `filamentType`; falls back to `label` when absent.
   */
  materialName?: string | null
  /**
   * Whether the target plate's MODEL OBJECTS print with this material (the combination table's
   * model-material side). Dedicated support materials are false. Leave undefined when the host
   * has no plate context — the table lookup is then skipped entirely.
   */
  usedByPlateModels?: boolean | null
}

export interface SettingValueFieldProps {
  settingKey: string
  option: ProcessSettingOption
  /** The current serialized scalar value (vectors are edited through their first element upstream). */
  value: string
  enabled?: boolean
  /** Enum values allowed in the current context (process conditional engine); defaults to all. */
  enumRestriction?: string[]
  /** Whether to render the option's own label beside a bool switch (multi-control lines). */
  showOwnLabel: boolean
  /**
   * What that own label says, when the option's name is not the answer. A line carrying one control
   * per extruder repeats a single option, so naming each control after the option would print the
   * same word three times — the column ("Extruder 2", "Silent") is what tells them apart. Defaults
   * to `option.label`.
   */
  ownLabel?: string
  isCode?: boolean
  /** Differs from the preset's PARENT — i.e. an override this preset carries. Bold, plain colour. */
  modified?: boolean
  /**
   * Differs from what is currently SAVED — an edit made in this session. Takes precedence over
   * `modified` and colours the label, mirroring BambuStudio: it paints a value that differs from
   * the last saved one with `m_modified_label_clr` and leaves a saved override in the default text
   * colour (Tab.cpp `update_changed_ui`).
   */
  unsaved?: boolean
  /**
   * Bulk (multi-target) editing: the selection's members hold DIFFERENT values for this key, so
   * no single value is true. Renders an explicit "Mixed" state — an empty control with a "Mixed"
   * placeholder (bools show a hint beside the switch) — instead of any one member's value. Any
   * interaction sets one value for the whole selection, which clears this flag upstream.
   */
  mixed?: boolean
  /**
   * The project's materials, for filament-index settings (BambuStudio's `i_enum_open` int
   * options: support/raft base+interface, walls/infill filament). When provided those render
   * as a material picker — 0 is "Default" — instead of a bare number input.
   */
  filamentChoices?: SettingFilamentChoice[]
  /**
   * The value this one replaced, shown on hover — the preset's value for a project change, the
   * parent preset's for an override the preset carries. Without it a bold row says something
   * changed but not what it changed FROM, which is the question it prompts.
   */
  original?: { value: string; label: string } | null
  onScalarChange: (key: string, value: string) => void
}

/** Small colour swatch for material options in filament-index selects. */
function FilamentSwatch({ color }: { color: string | null }) {
  return (
    <Box
      component="span"
      sx={{
        width: 14,
        height: 14,
        borderRadius: '3px',
        flexShrink: 0,
        bgcolor: color || 'neutral.softBg',
        border: '1px solid rgba(255,255,255,0.18)'
      }}
    />
  )
}

function SettingControl(props: SettingValueFieldProps): JSX.Element {
  const { settingKey, option, value: scalar, enabled = true, enumRestriction, showOwnLabel, ownLabel, isCode, modified, unsaved, mixed, filamentChoices, onScalarChange } = props
  // A nil is BambuStudio's "not overridden", not a value: show an empty field, never the word.
  // A mixed key likewise has no single value to show — empty control, "Mixed" placeholder.
  const value = mixed ? '' : isNilSettingValue(scalar) ? '' : scalar
  // Two channels per state, because weight alone at this size was unreadable. Colour is reserved
  // for the PROJECT change — the one the user acted on and can reset. A preset's own override gets
  // italic+bold instead: noticeable, but it does not read as an alert about something wrong, which
  // a second colour did (nothing on screen explains why it would be highlighted).
  const changeSx = unsaved
    ? { color: 'warning.plainColor', fontWeight: 700 }
    : modified ? { fontWeight: 700, fontStyle: 'italic' as const } : undefined

  // Filament-index settings pick a project material by its 1-based index; render them as a
  // material select when the host supplied the material list. "0" is BambuStudio's "Default"
  // (use the object's own filament). Keyed off the explicit list, NOT the catalog's
  // `i_enum_open` gui type — BambuStudio shares that widget with numeric settings that ship
  // preset choices, so matching on it turned "Top interface layers" into a material picker.
  if (option.type === 'int' && FILAMENT_INDEX_PROCESS_KEYS.includes(settingKey) && filamentChoices && filamentChoices.length > 0) {
    const current = Number.parseInt(value, 10)
    const normalized = Number.isFinite(current) && current > 0 ? String(current) : '0'
    // A value pointing past the current material list (stale baked config) still needs a
    // visible row, or the select would render blank.
    const outOfRange = !mixed && normalized !== '0' && !filamentChoices.some((choice) => String(choice.id) === normalized)
    return (
      <Select
        value={mixed ? null : normalized}
        placeholder={mixed ? 'Mixed' : undefined}
        disabled={!enabled}
        onChange={(_event, value) => { if (typeof value === 'string') onScalarChange(settingKey, value) }}
        sx={{ width: SCALAR_CONTROL_WIDTH }}
      >
        <Option value="0">Default</Option>
        {filamentChoices.map((choice) => (
          <Option key={choice.id} value={String(choice.id)}>
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
              <FilamentSwatch color={choice.color} />
              <Typography level="body-sm" noWrap>{choice.id} — {choice.label}</Typography>
            </Stack>
          </Option>
        ))}
        {outOfRange && <Option value={normalized}>Material {normalized} (missing)</Option>}
      </Select>
    )
  }

  // BambuStudio renders this one as a colour button (`ConfigOptionDef::GUIType::color`), and the
  // generator already captured that — we were just dropping it on the floor and rendering the hex
  // as an anonymous text box. Empty is a real value here (the default is ""), meaning "no default
  // colour", so the swatch falls back to black for the native control while the text stays the
  // source of truth and can still be cleared.
  if (option.guiType === 'color') {
    return (
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: SCALAR_CONTROL_WIDTH }}>
        <Box
          component="input"
          type="color"
          aria-label={`${option.label} swatch`}
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
          disabled={!enabled}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onScalarChange(settingKey, event.target.value)}
          sx={{
            width: 34, height: 30, p: 0, flexShrink: 0, cursor: enabled ? 'pointer' : 'default',
            bgcolor: 'transparent', border: '1px solid', borderColor: 'neutral.outlinedBorder',
            borderRadius: 'sm'
          }}
        />
        <Input
          value={value}
          disabled={!enabled}
          placeholder={mixed ? 'Mixed' : 'Not set'}
          onChange={(event) => onScalarChange(settingKey, event.target.value)}
          sx={{ flex: 1, minWidth: 0 }}
        />
      </Stack>
    )
  }

  if (option.type === 'bool') {
    return (
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Switch
          checked={value === '1' || value === 'true'}
          disabled={!enabled}
          onChange={(event) => onScalarChange(settingKey, serializeProcessBool(event.target.checked))}
        />
        {showOwnLabel && (
          <Typography level="body-sm" sx={changeSx}>
            {ownLabel ?? option.label}
          </Typography>
        )}
        {/* A switch has no empty state, so the mixed hint must be text: the off position would
            otherwise silently claim every member is off. Toggling sets one value for all. */}
        {mixed && (
          <Typography level="body-xs" textColor="text.tertiary">
            Mixed
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
        value={mixed ? null : value}
        placeholder={mixed ? 'Mixed' : undefined}
        disabled={!enabled}
        onChange={(_event, value) => { if (typeof value === 'string') onScalarChange(settingKey, value) }}
        sx={{ width: SCALAR_CONTROL_WIDTH }}
      >
        {values.map((value) => {
          const labelIndex = labels.indexOf(value)
          const display = labelIndex >= 0 && option.enumLabels ? option.enumLabels[labelIndex] ?? value : value
          return <Option key={value} value={value}>{display}</Option>
        })}
      </Select>
    )
  }

  // MULTILINE and MONOSPACE are different things. BambuStudio's Notes fields are full-width
  // multiline editors (`fullWidth` + a group `height` in the catalog) but ordinary prose, while
  // G-code fields are both. Keying the textarea off `isCode` alone left Notes as a 200px
  // single-line input with a 25-row height it never used.
  const monospace = Boolean(isCode || option.isCode)
  if (option.type === 'string' && (monospace || option.fullWidth || option.height != null)) {
    return (
      <Textarea
        // BambuStudio sizes each G-code box per group (its `new_optgroup(..., height)`), which the
        // catalog carries as `height`. Clamped: the source asks for 25 rows on some, which would
        // push the rest of the page out of reach inside a dialog.
        minRows={Math.min(Math.max(option.height ?? 3, 3), 12)}
        value={value}
        disabled={!enabled}
        placeholder={mixed ? 'Mixed' : undefined}
        onChange={(event) => onScalarChange(settingKey, event.target.value)}
        sx={{ flex: 1, fontFamily: monospace ? 'code' : undefined, minWidth: 280 }}
      />
    )
  }

  const isInteger = option.type === 'int'
  const isFloat = option.type === 'float'
  // A pure percent value is serialized with a `%` suffix ("15%"), but since it is ALWAYS a
  // percentage the suffix is redundant with the `%` sidetext decorator — show just the number
  // in a native number input and re-append the suffix on change. floatOrPercent stays text:
  // there the typed `%` is meaningful (it distinguishes "40%" from "0.4" mm).
  const isPurePercent = option.type === 'percent' && !option.vector
  const isPercentish = option.type === 'percent' || option.type === 'floatOrPercent'
  const isNumeric = isInteger || isFloat || isPercentish
  // A vector setting packs several values into one string (e.g. "0.4,0.4"); keep it free-text.
  const useNumberInput = (isInteger || isFloat || isPurePercent) && !option.vector


  return (
    <Input
      type={useNumberInput ? 'number' : 'text'}
      value={isPurePercent ? value.replace(/%/g, '').trim() : value}
      disabled={!enabled}
      placeholder={mixed ? 'Mixed' : undefined}
      onChange={(event) => {
        const raw = event.target.value
        if (isPurePercent) {
          onScalarChange(settingKey, raw === '' ? '' : `${raw}%`)
        } else {
          onScalarChange(settingKey, isPercentish && !option.vector ? raw.replace(/[^\d.%-]/g, '') : raw)
        }
      }}
      endDecorator={option.sidetext ? <Typography level="body-xs">{option.sidetext}</Typography> : undefined}
      slotProps={isNumeric ? {
        input: {
          inputMode: isInteger ? 'numeric' : 'decimal',
          ...(useNumberInput ? { step: isInteger ? 1 : 'any' } : {}),
          ...(option.min != null ? { min: option.min } : {}),
          ...(option.max != null ? { max: option.max } : {})
        }
      } : undefined}
      // ONE width for every single-line control, which is what SCALAR_CONTROL_WIDTH is for: text
      // and point fields used to stretch to 280 and vectors were capped at 180, so a row's controls
      // were three different lengths depending on the option's type. A row with several controls
      // (per-extruder variants) wraps rather than shrinking them out of alignment.
      sx={{ width: SCALAR_CONTROL_WIDTH }}
    />
  )
}

/**
 * A line carrying more than one setting needs to say which value is which — BambuStudio labels each
 * field with the option's own name beside the line's ("Nozzle" -> "Initial layer" / "Other layers",
 * "Ramming volumetric speed" -> "Extruder change" / "Hotend change"; see `TabFilament::build()`,
 * where each `line.append_option` carries a `ConfigOptionDef::label`). We passed `showOwnLabel`
 * down but only bool switches honoured it, so every multi-value row rendered as two unexplained
 * boxes.
 *
 * Single-setting lines are unchanged: the line's own label already names the value, and repeating
 * it beside the field would be noise.
 */
export function SettingValueField(props: SettingValueFieldProps): JSX.Element {
  const control = <SettingControl {...props} />
  const ownLabel = props.ownLabel ?? props.option.label
  // A bool renders its own label inline with the switch, so it is already handled.
  if (!props.showOwnLabel || !ownLabel || props.option.type === 'bool') return control
  // The state is per KEY, so the per-field label is where it belongs: on a two-value line the row
  // label alone cannot say WHICH value changed.
  const changed = props.unsaved
    ? { color: 'warning.plainColor', fontWeight: 700 }
    : props.modified ? { fontWeight: 700, fontStyle: 'italic' as const } : undefined
  const label = (
    <Typography
      level="body-xs"
      textColor={changed ? undefined : 'text.tertiary'}
      noWrap
      sx={{ flexShrink: 0, textAlign: 'right', minWidth: 88, ...changed }}
    >
      {ownLabel}
    </Typography>
  )
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
      {props.original
        ? <Tooltip title={`${props.original.label}: ${props.original.value}`} variant="soft" disableInteractive>{label}</Tooltip>
        : label}
      {control}
    </Stack>
  )
}
