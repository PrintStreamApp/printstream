/**
 * Stable-width value readout for the G-code layer and move scrubbers.
 *
 * The hidden reference occupies the same grid cell as the live value, so the chip reserves the
 * widest value the scrubber can show without exposing duplicate text to assistive technology.
 */
import React from 'react'
import { Box, Chip } from '@mui/joy'

export interface GcodeScrubberValueChipProps {
  value: string
  widthReference: string
  /** Turn the readout sideways so a vertical scrubber can keep a narrow rail. */
  sideways?: boolean
}

export function GcodeScrubberValueChip({ value, widthReference, sideways = false }: GcodeScrubberValueChipProps) {
  return (
    <Chip
      size="sm"
      variant="soft"
      color="neutral"
      sx={{
        minHeight: 18,
        px: 0.5,
        // Sideways text uses its inline axis vertically, so it needs physical block padding too.
        py: sideways ? 0.5 : 0,
        fontSize: '0.625rem',
        lineHeight: 1.2
      }}
    >
      <Box
        component="span"
        sx={{
          display: 'grid',
          fontVariantNumeric: 'tabular-nums',
          ...(sideways
            ? { writingMode: 'vertical-rl', textOrientation: 'sideways', transform: 'rotate(180deg)' }
            : null)
        }}
      >
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
