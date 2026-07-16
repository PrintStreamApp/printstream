/**
 * One value control for a Bambu settings option (process OR filament) — the catalog-agnostic leaf
 * shared by ProcessSettingsDialog and FilamentSettingsDialog. Renders the right input for the
 * option type (bool Switch / enum Select / code Textarea / numeric or text Input) against a plain
 * serialized-string value, emitting the new scalar. It knows nothing about which catalog the option
 * came from, so both dialogs render identical controls.
 */
import { Input, Option, Select, Stack, Switch, Textarea, Typography } from '@mui/joy'
import { serializeProcessBool, type ProcessSettingOption } from '@printstream/shared'

/**
 * One fixed width for every scalar value control (numeric inputs, percent fields, and enum
 * selects) so the value column lines up — content-sized controls otherwise vary (a bare number
 * shrinks; a `%`/`°` decorator or a long enum label grows).
 */
export const SCALAR_CONTROL_WIDTH = 200

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
  onScalarChange: (key: string, value: string) => void
}

export function SettingValueField(props: SettingValueFieldProps): JSX.Element {
  const { settingKey, option, value: scalar, enabled = true, enumRestriction, showOwnLabel, isCode, modified, onScalarChange } = props

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
