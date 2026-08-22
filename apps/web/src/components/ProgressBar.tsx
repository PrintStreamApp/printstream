/**
 * The app's linear progress indicator — the ONE way a surface shows "this is
 * running" and, when it can, how far along it is.
 *
 * Owns three things every caller used to hand-roll, two of which they got wrong:
 *
 * 1. **Determinacy.** A caller supplies `value` or it does not; there is no
 *    `determinate` prop to disagree with it. Joy sizes the moving segment of an
 *    indeterminate bar from `--LinearProgress-percent`, which it reads off the
 *    `value` prop (its default of `25` is a quarter-width segment, not a
 *    position). So the widespread `determinate={x != null} value={x ?? 0}` pair
 *    animated a ZERO-WIDTH segment across the track: the bar looked dead exactly
 *    when it needed to look busy. Passing `value` through only when it is a real
 *    number makes that combination unrepresentable.
 * 2. **Tweening.** Reported values arrive in discrete hops (a WS status frame, an
 *    upload chunk). The fill transitions between them so progress reads as motion.
 * 3. **`prefers-reduced-motion`.** The determinate tween is dropped outright. The
 *    indeterminate cycle is gentled, not removed: it is the only thing telling the
 *    user the work is alive, so removing it reproduces the dead-bar symptom above.
 *    WCAG 2.2.2 exempts loading indicators from pause/stop/hide for this reason.
 *
 * Counterpart for busy states with no room for a bar: `ProgressSpinner`.
 */
import { LinearProgress } from '@mui/joy'
import type { LinearProgressProps } from '@mui/joy'
import { resolveProgressPercent } from '../lib/progressValue'

/**
 * Tween applied to the determinate fill. Long enough to read as movement between
 * two status frames, short enough that a fast upload's bar is not lagging behind
 * the percentage rendered beside it.
 */
const DETERMINATE_TWEEN_MS = 320

/**
 * Slower and linear rather than Joy's 2.5s ease-in-out, which reads as a swoosh.
 * Motion is kept under reduced-motion (see the module header) but loses its
 * acceleration, so it registers as "alive" without drawing the eye.
 */
const REDUCED_MOTION_CIRCULATION = '4s linear 0s infinite normal none running'

export interface ProgressBarProps extends Omit<LinearProgressProps, 'determinate' | 'value'> {
  /**
   * Percentage 0-100, or `null`/`undefined` when the work is running but its
   * extent is unknown — which renders the indeterminate cycle. Never coerce an
   * unknown value to `0`: that is a claim the work has not started, and it is
   * what made these bars render empty.
   */
  value?: number | null
}

export function ProgressBar({ value, sx, ...props }: ProgressBarProps) {
  const percent = resolveProgressPercent(value)
  const determinate = percent != null

  return (
    <LinearProgress
      determinate={determinate}
      // Omitted entirely when indeterminate so Joy applies its own segment width.
      {...(determinate ? { value: percent } : {})}
      sx={[
        determinate
          ? {
              '&::before': {
                transition: `inline-size ${DETERMINATE_TWEEN_MS}ms ease-out`,
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
              }
            }
          : {
              '@media (prefers-reduced-motion: reduce)': {
                '--LinearProgress-circulation': REDUCED_MOTION_CIRCULATION
              }
            },
        ...(Array.isArray(sx) ? sx : [sx])
      ]}
      {...props}
    />
  )
}
