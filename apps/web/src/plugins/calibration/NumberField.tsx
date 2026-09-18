/**
 * A small labelled numeric input used by the calibration wizard and result
 * dialog. Wraps Joy's number `Input` with a label, optional helper text, and an
 * optional unit decorator, and reports parsed numbers.
 *
 * While focused it holds the raw text in a local draft so transient states
 * ("", "-", "0.") never round-trip through the numeric prop, a directly-bound
 * controlled number input would coerce an emptied field straight back to 0
 * ("backspace the 0" then becomes "010"). The draft is dropped on blur, snapping
 * the display back to the canonical value.
 */
import { useState } from 'react'
import { FormControl, FormHelperText, FormLabel, Input } from '@mui/joy'

export function NumberField({
  label,
  value,
  onChange,
  onClear,
  step,
  min,
  max,
  helperText,
  endDecorator
}: {
  label: string
  value: number | null
  onChange: (value: number) => void
  /** Opt into a genuinely empty value instead of restoring the last number on blur. */
  onClear?: () => void
  step?: number
  min?: number
  max?: number
  helperText?: string
  /** Unit shown at the end of the input (e.g. "mm"). */
  endDecorator?: string
}) {
  // Raw text while the user is editing; null = display the canonical value.
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <FormControl sx={{ flex: 1, minWidth: 0 }}>
      <FormLabel>{label}</FormLabel>
      <Input
        type="number"
        value={draft ?? (value != null && Number.isFinite(value) ? value : '')}
        endDecorator={endDecorator}
        slotProps={{ input: { step, min, max } }}
        onChange={(event) => {
          const text = event.target.value
          setDraft(text)
          if (text.trim() === '') {
            onClear?.()
            return // Empty is not zero; callers without onClear keep the last number.
          }
          const next = Number(text)
          if (Number.isFinite(next)) onChange(next)
        }}
        onBlur={() => setDraft(null)}
      />
      {helperText ? <FormHelperText>{helperText}</FormHelperText> : null}
    </FormControl>
  )
}
