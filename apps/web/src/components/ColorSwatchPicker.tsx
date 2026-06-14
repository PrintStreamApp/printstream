/**
 * Round colour-swatch grid used by spool setup surfaces (AMS slot / external spool
 * editors and the print-flow spool-setup dialog) to pick a filament colour.
 */
import { Box, Typography } from '@mui/joy'
import type { FilamentColorSwatchOption } from '../lib/filamentColor'

export function ColorSwatchPicker({
  title,
  swatches,
  selectedHex,
  onPick
}: {
  title: string
  swatches: FilamentColorSwatchOption[]
  selectedHex: string
  onPick: (hex: string) => void
}) {
  return (
    <Box>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(28px, 1fr))',
          gap: 0.75
        }}
      >
        {swatches.map((swatch) => {
          const isSelected = swatch.hex.toUpperCase() === selectedHex
          return (
            <Box
              key={`${swatch.name}-${swatch.hex}`}
              component="button"
              type="button"
              onClick={() => onPick(swatch.hex)}
              title={`${swatch.name} (${swatch.hex})`}
              aria-label={`${swatch.name} ${swatch.hex}`}
              sx={{
                appearance: 'none',
                p: 0,
                width: '100%',
                aspectRatio: '1 / 1',
                borderRadius: '50%',
                cursor: 'pointer',
                background: swatch.hex,
                border: (theme) =>
                  isSelected
                    ? `2px solid ${theme.vars.palette.primary.solidBg}`
                    : `1px solid ${theme.vars.palette.divider}`,
                boxShadow: isSelected
                  ? '0 0 0 2px rgba(255,255,255,0.15) inset'
                  : 'none',
                transition: 'transform 80ms ease',
                '&:hover': { transform: 'scale(1.08)' },
                '&:focus-visible': {
                  outline: (theme) => `2px solid ${theme.vars.palette.focusVisible}`,
                  outlineOffset: 2
                }
              }}
            />
          )
        })}
      </Box>
    </Box>
  )
}
