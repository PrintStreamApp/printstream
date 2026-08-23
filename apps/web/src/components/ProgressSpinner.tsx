/**
 * The circular sibling of `ProgressBar`, for busy states with no room for a bar
 * (chip and toast decorators, button adornments, overlay centres).
 *
 * Exists for the same reason: Joy draws an indeterminate `CircularProgress` arc
 * from `--CircularProgress-percent`, taken from the `value` prop, so
 * `determinate={x != null} value={x ?? 0}` spins a zero-length arc, a bare track
 * ring with nothing moving on it. Determinacy is derived from `value` here too,
 * so that pair cannot be written.
 *
 * Joy's 0.8s linear rotation is already the gentlest form of the motion, so
 * unlike the bar there is nothing to soften under `prefers-reduced-motion`; the
 * spin stays, being the only signal the work is alive (see `ProgressBar`).
 */
import { CircularProgress, circularProgressClasses } from '@mui/joy'
import type { CircularProgressProps } from '@mui/joy'
import { resolveProgressPercent } from '../lib/progressValue'

const DETERMINATE_TWEEN_MS = 320

export interface ProgressSpinnerProps extends Omit<CircularProgressProps, 'determinate' | 'value'> {
  /**
   * Percentage 0-100, or `null`/`undefined` while the extent is unknown. Never
   * coerce an unknown value to `0`: see `ProgressBar`.
   */
  value?: number | null
}

export function ProgressSpinner({ value, sx, ...props }: ProgressSpinnerProps) {
  const percent = resolveProgressPercent(value)
  const determinate = percent != null

  return (
    <CircularProgress
      determinate={determinate}
      {...(determinate ? { value: percent } : {})}
      sx={[
        determinate
          ? {
              // The arc is the second <circle> in Joy's svg; the first is the track.
              [`& .${circularProgressClasses.progress}`]: {
                transition: `stroke-dashoffset ${DETERMINATE_TWEEN_MS}ms ease-out`,
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
              }
            }
          : {},
        ...(Array.isArray(sx) ? sx : [sx])
      ]}
      {...props}
    />
  )
}
