/**
 * Rendering a filament cost, and the one place the currency assumption lives.
 *
 * Neither source of a cost carries a currency. BambuStudio's `filament_cost` is labelled
 * "money/kg" and stores no unit; our slicer's `money_cost` passes that straight through. So the
 * `$` here is OUR assumption, not the file's, and it is deliberately in one module rather than
 * retyped per surface: the three callers (the slice estimates panel, the slicing-job status line,
 * and the preview's all-plates statistics) would otherwise be free to drift apart, and a real
 * currency setting would have to be chased through all of them.
 *
 * Revisit if a workspace currency preference is ever added; this is the seam it lands on.
 */

/** A cost as a display string. Two decimals, prefixed with the assumed currency symbol. */
export function formatFilamentCost(cost: number): string {
  return `$${cost.toFixed(2)}`
}
