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
  onPick,
  onCustomPick
}: {
  title: string
  swatches: FilamentColorSwatchOption[]
  selectedHex: string
  onPick: (hex: string) => void
  /** When provided, a leading "custom color" tile opens a free-form picker. */
  onCustomPick?: () => void
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
        {onCustomPick ? (
          <Box
            component="button"
            type="button"
            onClick={onCustomPick}
            title="Custom color"
            aria-label="Custom color"
            sx={{
              appearance: 'none',
              p: 0,
              width: '100%',
              aspectRatio: '1 / 1',
              borderRadius: '50%',
              cursor: 'pointer',
              background: (theme) => `repeating-conic-gradient(${theme.vars.palette.background.level2} 0% 25%, transparent 0% 50%) 50% / 8px 8px`,
              border: (theme) => `1px solid ${theme.vars.palette.divider}`,
              color: 'text.primary',
              display: 'grid',
              placeItems: 'center',
              transition: 'transform 80ms ease',
              '&:hover': { transform: 'scale(1.08)' },
              '&:focus-visible': {
                outline: (theme) => `2px solid ${theme.vars.palette.focusVisible}`,
                outlineOffset: 2
              }
            }}
          >
            <Box
              aria-hidden="true"
              sx={{
                position: 'relative',
                width: 14,
                height: 14,
                filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.6))',
                '&::before': {
                  content: '""',
                  position: 'absolute',
                  left: 5,
                  top: 1,
                  width: 4,
                  height: 12,
                  borderRadius: 1,
                  backgroundColor: 'currentColor',
                  transform: 'rotate(45deg)'
                },
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  right: 0,
                  bottom: 1,
                  width: 4,
                  height: 4,
                  borderRight: '2px solid currentColor',
                  borderBottom: '2px solid currentColor',
                  transform: 'rotate(45deg)'
                }
              }}
            />
          </Box>
        ) : null}
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
