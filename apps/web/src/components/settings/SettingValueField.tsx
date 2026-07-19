/**
 * One value control for a Bambu settings option (process OR filament) — the catalog-agnostic leaf
 * shared by ProcessSettingsDialog and FilamentSettingsDialog. Renders the right input for the
 * option type (bool Switch / enum Select / code Textarea / numeric or text Input) against a plain
 * serialized-string value, emitting the new scalar. It knows nothing about which catalog the option
 * came from, so both dialogs render identical controls.
 */
import { Box, Input, Option, Select, Stack, Switch, Textarea, Typography } from '@mui/joy'
import { FILAMENT_INDEX_PROCESS_KEYS, serializeProcessBool, type ProcessSettingOption } from '@printstream/shared'

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
  isCode?: boolean
  modified?: boolean
  /**
   * The project's materials, for filament-index settings (BambuStudio's `i_enum_open` int
   * options: support/raft base+interface, walls/infill filament). When provided those render
   * as a material picker — 0 is "Default" — instead of a bare number input.
   */
  filamentChoices?: SettingFilamentChoice[]
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

export function SettingValueField(props: SettingValueFieldProps): JSX.Element {
  const { settingKey, option, value: scalar, enabled = true, enumRestriction, showOwnLabel, isCode, modified, filamentChoices, onScalarChange } = props

  // Filament-index settings pick a project material by its 1-based index; render them as a
  // material select when the host supplied the material list. "0" is BambuStudio's "Default"
  // (use the object's own filament). Keyed off the explicit list, NOT the catalog's
  // `i_enum_open` gui type — BambuStudio shares that widget with numeric settings that ship
  // preset choices, so matching on it turned "Top interface layers" into a material picker.
  if (option.type === 'int' && FILAMENT_INDEX_PROCESS_KEYS.includes(settingKey) && filamentChoices && filamentChoices.length > 0) {
    const current = Number.parseInt(scalar, 10)
    const normalized = Number.isFinite(current) && current > 0 ? String(current) : '0'
    // A value pointing past the current material list (stale baked config) still needs a
    // visible row, or the select would render blank.
    const outOfRange = normalized !== '0' && !filamentChoices.some((choice) => String(choice.id) === normalized)
    return (
      <Select
        value={normalized}
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

  if (option.type === 'bool') {
    return (
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Switch
          checked={scalar === '1' || scalar === 'true'}
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
  const fixedNumericWidth = isNumeric && !option.vector

  return (
    <Input
      type={useNumberInput ? 'number' : 'text'}
      value={isPurePercent ? scalar.replace(/%/g, '').trim() : scalar}
      disabled={!enabled}
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
      sx={fixedNumericWidth
        ? { width: SCALAR_CONTROL_WIDTH }
        : { minWidth: 140, maxWidth: option.type === 'string' || option.type === 'point' ? 280 : 180 }}
    />
  )
}
