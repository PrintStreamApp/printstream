/**
 * Stable-width value readout for the G-code layer and move scrubbers.
 *
 * The hidden reference occupies the same grid cell as the live value, so the chip reserves the
 * widest value the scrubber can show without exposing duplicate text to assistive technology.
 */
import { Box, Chip } from '@mui/joy'

export interface GcodeScrubberValueChipProps {
  value: string
  widthReference: string
}

export function GcodeScrubberValueChip({ value, widthReference }: GcodeScrubberValueChipProps) {
  return (
    <Chip size="sm" variant="soft" color="neutral">
      <Box component="span" sx={{ display: 'grid', fontVariantNumeric: 'tabular-nums' }}>
        <Box component="span" sx={{ gridArea: '1 / 1', textAlign: 'center' }}>{value}</Box>
        <Box
          component="span"
          aria-hidden="true"
          sx={{ gridArea: '1 / 1', visibility: 'hidden', pointerEvents: 'none' }}
        >
          {widthReference}
        </Box>
      </Box>
    </Chip>
  )
}
