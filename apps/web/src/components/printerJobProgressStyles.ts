/**
 * The chunky, pill-shaped progress bar used by printer job surfaces (printer
 * cards, the jobs list, dispatch toasts).
 *
 * Exported as a FUNCTION of determinacy because the fill geometry it sets --
 * `left` and `inlineSize` on the `::before` -- is determinate-only: those are the
 * two properties Joy's indeterminate keyframes animate, so declaring them
 * statically fights the animation. Applying the whole block unconditionally is
 * what pinned the indeterminate variant of these bars in place.
 */
export function printerJobProgressSx({
  value,
  fillColor,
  trackColor
}: {
  /** The same value handed to `ProgressBar`, so the geometry cannot disagree with the bar's mode. */
  value: number | null | undefined
  fillColor?: string
  trackColor?: string
}) {
  const determinate = value != null
  return {
    '--LinearProgress-thickness': '8px',
    flex: 'none',
    borderRadius: '999px',
    backgroundColor: trackColor ?? 'var(--joy-palette-neutral-800)',
    '&::before': {
      borderRadius: '999px',
      transform: 'scaleY(0.75)',
      transformOrigin: 'left center',
      ...(fillColor ? { backgroundColor: fillColor } : {}),
      // Left to the keyframes when indeterminate; see the module header.
      ...(determinate
        ? { left: '1px', inlineSize: 'max(calc(var(--LinearProgress-percent) * 1% - 2px), 0px)' }
        : {})
    }
  } as const
}
