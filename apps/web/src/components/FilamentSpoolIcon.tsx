/**
 * Custom "spool of filament" icon (face-on spool: flange ring, wound-filament coil, centre hub, and a
 * loose strand). Drawn with `currentColor` strokes so it inherits surrounding colour and sizing. Shared
 * across the app — the Filament tab/nav, and the print-queue start dialog's material indicator — so the
 * "material" glyph is consistent everywhere (and reusable without one plugin importing another).
 */
import { SvgIcon } from '@mui/joy'
import type { ComponentProps } from 'react'

export function FilamentSpoolIcon(props: ComponentProps<typeof SvgIcon>) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <g fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5.7" />
        <circle cx="12" cy="12" r="2.4" />
        <path d="M20.7 12.5c1.5.4 1.8 1.9 1.2 3.2" />
      </g>
    </SvgIcon>
  )
}
