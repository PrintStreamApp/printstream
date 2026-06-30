/**
 * Grade a material's remaining quantity against a print's required grams for the queue material
 * pickers' right-aligned badge. Three states so the user sees whether a material actually covers the
 * print, not just "low or not": **enough** (comfortable headroom), **low** (enough but within a thin
 * margin), **short** (less than required). Without a known requirement it just states the remaining
 * amount. The matching slot picker in the print dialog uses the same 25g headroom
 * (see `slotRemaining.ts`).
 */

/** Headroom over the required grams below which an otherwise-sufficient material reads as "low". */
export const LOW_FILAMENT_HEADROOM_GRAMS = 25

export type FilamentRemainingTone = 'text.tertiary' | 'warning.plainColor' | 'danger.plainColor'

export interface FilamentRemainingStatus {
  text: string
  tone: FilamentRemainingTone
}

/**
 * The one shared remaining-badge text, e.g. `67% (~670g)`. The weight is always an estimate — printer
 * trays report only a percent (grams are roughly percent * 10) and tracked spool weights drift — so it
 * carries a leading `~` and, when a percent is known, sits in brackets after the percent. Every surface routes
 * through here — the print dialogs' AMS slot pickers (`SlotOptionLabel` in `PrinterMapping` /
 * `StoragePrintModal` / `SliceFileModal`) and the library/queue material pickers
 * ({@link filamentRemainingStatus} → `FilamentOptionLabel`) — so the estimate marker, brackets, and
 * placement stay identical instead of drifting.
 */
export function formatFilamentRemaining(
  remainingGrams: number,
  remainPercent?: number | null,
  /** True when the grams sum across several spools — adds a "total" suffix so that's clear. */
  aggregated = false
): string {
  const weight = `~${remainingGrams}g${aggregated ? ' total' : ''}`
  return remainPercent != null ? `${Math.round(remainPercent)}% (${weight})` : weight
}

export function filamentRemainingStatus(
  remainingGrams: number | null | undefined,
  requiredGrams: number | null | undefined,
  remainPercent?: number | null,
  /** True when the grams sum across several spools — adds a "total" suffix so that's clear. */
  aggregated = false
): FilamentRemainingStatus | null {
  if (remainingGrams == null) return null
  const lead = formatFilamentRemaining(remainingGrams, remainPercent, aggregated)
  if (requiredGrams != null && remainingGrams < requiredGrams) {
    const short = Math.max(1, Math.round(requiredGrams - remainingGrams))
    return { text: `${lead} · ${short}g short`, tone: 'danger.plainColor' }
  }
  if (requiredGrams != null && remainingGrams < requiredGrams + LOW_FILAMENT_HEADROOM_GRAMS) {
    return { text: `${lead} · low`, tone: 'warning.plainColor' }
  }
  // The "left" word only reads well for a single spool; an aggregate uses the "total" suffix instead.
  return { text: remainPercent != null || aggregated ? lead : `~${remainingGrams}g left`, tone: 'text.tertiary' }
}
