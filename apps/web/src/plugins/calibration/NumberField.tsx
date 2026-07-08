/**
 * A small labelled numeric input used by the calibration wizard and result
 * dialog. Wraps Joy's number `Input` with a label and optional helper text and
 * reports parsed numbers (ignoring transient empty/invalid states).
 */
import { FormControl, FormHelperText, FormLabel, Input } from '@mui/joy'

export function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  helperText
}: {
  label: string
  value: number
  onChange: (value: number) => void
  step?: number
  min?: number
  max?: number
  helperText?: string
}) {
  return (
    <FormControl sx={{ flex: 1, minWidth: 0 }}>
      <FormLabel>{label}</FormLabel>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        slotProps={{ input: { step, min, max } }}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
      {helperText ? <FormHelperText>{helperText}</FormHelperText> : null}
    </FormControl>
  )
}
