/**
 * A small labelled numeric input used by the calibration wizard and result
 * dialog. Wraps Joy's number `Input` with a label, optional helper text, and an
 * optional unit decorator, and reports parsed numbers.
 *
 * While focused it holds the raw text in a local draft so transient states
 * ("", "-", "0.") never round-trip through the numeric prop — a directly-bound
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
  step,
  min,
  max,
  helperText,
  endDecorator
}: {
  label: string
  value: number
  onChange: (value: number) => void
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
        value={draft ?? (Number.isFinite(value) ? value : '')}
        endDecorator={endDecorator}
        slotProps={{ input: { step, min, max } }}
        onChange={(event) => {
          const text = event.target.value
          setDraft(text)
          if (text.trim() === '') return // transient empty, not a 0
          const next = Number(text)
          if (Number.isFinite(next)) onChange(next)
        }}
        onBlur={() => setDraft(null)}
      />
      {helperText ? <FormHelperText>{helperText}</FormHelperText> : null}
    </FormControl>
  )
}
