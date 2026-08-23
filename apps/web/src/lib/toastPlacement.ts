/**
 * Which viewport edge the toast stack anchors to.
 *
 * Phones anchor toasts to the TOP. The bottom of a phone screen is the busiest part of the app,
 * the fixed tab bar, a dialog's footer actions, the on-screen keyboard and the home indicator all
 * live there, so a toast in that corner lands on whatever the user is reaching for, and it needed
 * a dialog-aware lift just to stay out of the tab bar's way. No surface at any width puts fixed
 * chrome along the top edge, so one constant offset (clear of the notch / PWA title bar, which is
 * what `--app-top-inset` measures) is the whole rule.
 *
 * Desktop keeps the bottom-right corner, where there is nothing to collide with.
 *
 * Pure so the rule is testable without mounting the portal; `StatusToastStack` applies it.
 */

/** Breathing room between the stack and the viewport edge it anchors to. */
export const TOAST_EDGE_GAP = 12

/**
 * The stack's vertical anchors, as a responsive `sx` fragment.
 *
 * Both edges are named at both breakpoints on purpose: a responsive `sx` value cannot be undone by
 * a flat one, because MUI emits the `xs` entry as `@media (min-width:0px)`, which still matches on
 * a desktop. Leaving `top` unset at `sm` would therefore keep the phone's top anchor everywhere, so
 * each breakpoint has to state `auto` for the edge it does not use.
 */
export const TOAST_STACK_PLACEMENT = {
  top: { xs: `calc(var(--app-top-inset, 0px) + ${TOAST_EDGE_GAP}px)`, sm: 'auto' },
  bottom: { xs: 'auto', sm: `calc(var(--app-safe-bottom, 0px) + ${TOAST_EDGE_GAP}px)` }
} as const
