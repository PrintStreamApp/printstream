/**
 * Small inline SVG glyphs used across the printer dashboard cards and menus.
 *
 * `MoreVertIcon` is the "more vertical" three-dot glyph used by the row-level
 * Actions menus; `LightbulbIcon` is the chamber-light toggle glyph (filled and
 * yellow-tinted when on, outline when off). Both are pure, props-only.
 */
import { Box } from '@mui/joy'

/**
 * Material "more vertical" three-dot glyph used by the row-level Actions
 * menus across the dashboard.
 */
export function MoreVertIcon() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: '1.1em', height: '1.1em', fill: 'currentColor' }}
    >
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </Box>
  )
}

/**
 * Material "lightbulb" glyph used by the chamber-light toggle. Filled when
 * `on` is true and tinted yellow via `currentColor`, outline when off.
 */
export function LightbulbIcon({ on }: { on: boolean }) {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{
        width: 18,
        height: 18,
        color: on ? '#fbc02d' : 'currentColor',
        fill: 'currentColor'
      }}
    >
      {on ? (
        <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z" />
      ) : (
        <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1l-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z" />
      )}
    </Box>
  )
}
