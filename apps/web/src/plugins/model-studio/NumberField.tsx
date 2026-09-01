/**
 * A clamped numeric field, shared by the editor's tool panels.
 *
 * Clamps on COMMIT rather than on every keystroke: clamping as you type makes an empty field jump to
 * the minimum and a "10" typed toward "100" impossible to enter.
 *
 * The displayed text is LOCAL state rather than a `key` remount, because a remount only happens when
 * the committed value changes -- so any entry that clamps back to the current value (typing 1 into a
 * field already at its 3mm minimum, or typing letters) left the invalid text on screen disagreeing
 * with the geometry, with no way to resync short of entering a different number.
 *
 * Extracted from the text tool because the SVG panel re-solved the same problem the naive way and
 * got it wrong: a controlled `type="number"` whose handler REJECTS anything not already valid never
 * moves its state, so React restores the DOM value and the keystroke vanishes. Any value that has to
 * be typed THROUGH an invalid one is then unreachable -- 0.6 must pass through "0", and the field
 * cannot even be cleared to start again. Use this for every numeric input in a tool panel.
 */
import { useState } from 'react'
import { FormControl, FormLabel, Input } from '@mui/joy'

export function NumberField({ label, value, limits, step = 0.1, onChange }: {
  label: string
  value: number
  limits: { min: number; max: number }
  /** The spinner's increment. Sizes in whole millimetres want 1; thicknesses want the default. */
  step?: number
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(`${value}`)
  // Follows the committed value while the user is not typing: the panel can change it from
  // elsewhere, notably reopening the tool on saved text.
  const [lastValue, setLastValue] = useState(value)
  if (lastValue !== value) {
    setLastValue(value)
    setDraft(`${value}`)
  }

  return (
    <FormControl size="sm">
      <FormLabel>{label}</FormLabel>
      <Input
        size="sm"
        type="number"
        value={draft}
        slotProps={{ input: { min: limits.min, max: limits.max, step, 'aria-label': label } }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const parsed = Number.parseFloat(draft)
          const next = Number.isFinite(parsed)
            ? Math.min(Math.max(parsed, limits.min), limits.max)
            : value
          setDraft(`${next}`)
          if (next !== value) onChange(next)
        }}
      />
    </FormControl>
  )
}
