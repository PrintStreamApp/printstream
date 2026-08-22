/**
 * The shared rule for reading a progress indicator's `value`, used by both
 * `components/ProgressBar` and `components/ProgressSpinner`.
 *
 * It exists so determinacy is DERIVED in exactly one place. Joy's progress
 * components take the size of an indeterminate indicator's moving segment from
 * the same `value` prop a determinate one uses for its position, so a value of
 * `0` alongside `determinate={false}` renders a zero-width segment -- an
 * indicator that animates nothing. Callers therefore never state determinacy;
 * they hand over a number or nothing, and this decides.
 */

/**
 * Returns the percentage to render, or `null` when the work is running with no
 * usable extent (absent, or a non-finite number from a bad division) and the
 * indicator should be indeterminate.
 *
 * Clamps to 0-100 because Joy renders the value straight into a CSS width: a
 * stale total or a server rounding to `100.4` would otherwise overflow the track.
 */
export function resolveProgressPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}
