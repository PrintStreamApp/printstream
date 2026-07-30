/**
 * Where the toast stack sits above the bottom edge.
 *
 * Toasts render above the modal layer (`zIndex.tooltip`), so on a phone they must clear the mobile
 * tab bar — but that tab bar is covered whenever a dialog is open, and a toast still lifted clear of
 * it then floats in empty space over the dialog. Desktop has no bottom chrome, so its offset is
 * constant.
 *
 * Pure so the rule is testable without mounting the portal; `StatusToastStack` applies it.
 */

/** Height of the phone tab bar the stack lifts clear of. */
export const MOBILE_TAB_BAR_CLEARANCE = 84
/** Plain breathing room from the viewport edge. */
export const TOAST_EDGE_GAP = 12

export function resolveToastBottomGap(input: { dialogOpen: boolean }): number {
  return input.dialogOpen ? TOAST_EDGE_GAP : MOBILE_TAB_BAR_CLEARANCE
}
