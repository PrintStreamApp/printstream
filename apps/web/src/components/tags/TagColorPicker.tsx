/** Tag color control using the same preset swatches as filament setup, plus distinct suggestions. */
import { useMemo, useRef } from 'react'
import { Box, FormControl, FormLabel, Input, Stack } from '@mui/joy'
import { COMMON_FILAMENT_COLOR_SWATCHES, commonFilamentColorName } from '@printstream/shared'
import { ColorSwatchPicker } from '../ColorSwatchPicker'
import { suggestTagColor } from '../../lib/tagColors'

export function TagColorPicker({ color, existingColors, onChange }: {
  color: string
  existingColors: readonly string[]
  onChange: (color: string) => void
}) {
  const customInput = useRef<HTMLInputElement>(null)
  const suggestions = useMemo(() => {
    const used = [...existingColors]
    return Array.from({ length: 8 }, () => {
      const hex = suggestTagColor(used)
      used.push(hex)
      return { hex, name: commonFilamentColorName(hex) ?? 'Suggested color' }
    })
  }, [existingColors])
  const validColor = /^#[0-9a-f]{6}$/i.test(color)
  return (
    <Stack spacing={1}>
      <FormControl>
        <FormLabel>Color</FormLabel>
        <Input value={color} onChange={(event) => onChange(event.target.value)} placeholder="#RRGGBB"
          slotProps={{ input: { maxLength: 7, 'aria-label': 'Tag color hex' } }}
          startDecorator={<Box sx={{ width: 20, height: 20, borderRadius: 'sm', bgcolor: validColor ? color : 'transparent', border: '1px solid', borderColor: 'divider' }} />} />
      </FormControl>
      <ColorSwatchPicker title="Suggested colors" swatches={suggestions} selectedHex={color.toUpperCase()} onPick={onChange} />
      <ColorSwatchPicker title="Preset colors" swatches={COMMON_FILAMENT_COLOR_SWATCHES} selectedHex={color.toUpperCase()}
        onPick={onChange} onCustomPick={() => customInput.current?.click()} />
      <input ref={customInput} type="color" value={validColor ? color : '#000000'} onChange={(event) => onChange(event.target.value)}
        aria-hidden="true" tabIndex={-1} style={{ display: 'none' }} />
    </Stack>
  )
}
