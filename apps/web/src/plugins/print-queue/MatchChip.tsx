/**
 * Small status chip for one match aspect (model / nozzle / material / plate type) on the queue card and
 * in the start dialog. Colour + icon encode the {@link AspectState}: a satisfied aspect reads green with
 * a check, an unsatisfied one amber with a cross, an undeterminable one neutral with a question mark. A
 * `na` aspect (no such constraint) renders nothing. Pass `state="info"` for a plain informational chip
 * (e.g. the plate type, which can't be matched against a printer).
 */
import { Chip } from '@mui/joy'
import CheckRounded from '@mui/icons-material/CheckRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded'
import type { ReactNode } from 'react'
import type { AspectState } from './printerAspectMatch'

// NB: never pass `sx` to a @mui/icons-material icon in this Joy-only app — it reaches for the Material
// theme's breakpoints and crashes (`createEmptyBreakpointObject` → reading 'length'). As a Joy Chip
// `startDecorator` (no `sx`) the icon is sized by Joy's `--Icon-fontSize`, so it's safe.
export function MatchChip({ label, state, icon }: { label: ReactNode; state: AspectState | 'info'; icon?: ReactNode }) {
  if (state === 'na') return null
  const color = state === 'match' ? 'success' : state === 'mismatch' ? 'warning' : 'neutral'
  // A caller-supplied icon (e.g. the spool glyph on the material chip) names the aspect; otherwise the
  // check/cross/question already reads as the match state. Either way colour still encodes the state.
  const decorator = icon ?? (state === 'match'
    ? <CheckRounded />
    : state === 'mismatch'
      ? <CloseRounded />
      : state === 'unknown'
        ? <HelpOutlineRounded />
        : undefined)
  return (
    <Chip size="sm" variant="soft" color={color} startDecorator={decorator}>
      {label}
    </Chip>
  )
}
