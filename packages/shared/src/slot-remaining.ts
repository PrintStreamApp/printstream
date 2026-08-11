/**
 * Remaining-filament primitives shared by every surface that grades a printer
 * slot against a print's material needs: the gram estimate for percent-only
 * trays, the low-filament headroom, and the AMS auto-refill pooling test.
 *
 * Owned here (not in the web) because the shared print-queue matcher's
 * lowest-remaining tie-break and the web's low-filament warning state
 * (`apps/web/src/lib/slotRemaining.ts`, the module's web counterpart) must
 * agree on all three — a slot the warning calls sufficient must never be one
 * the matcher skipped as insufficient.
 */

/**
 * Grams of slack required beyond a plate's stated usage before a slot counts
 * as "enough". Covers purge/prime waste and the roughness of the percent-based
 * estimate below.
 */
export const LOW_FILAMENT_HEADROOM_GRAMS = 25

/**
 * Estimate grams remaining from the printer's percent-only reading using Bambu
 * Studio's rough 1kg-spool convention (`percent * 10`). Callers that only have a
 * percentage (e.g. the loaded-material pickers) reuse this so every surface
 * shows the same estimate. Note the percent itself is only trustworthy for
 * RFID (Bambu-tagged) spools; callers gate on `trayUuid` before believing it.
 */
export function estimateRemainGrams(remainPercent: number | null): number | null {
  return remainPercent != null ? Math.round(remainPercent * 10) : null
}

/** What the auto-refill pooling test needs to know about a tray. */
export interface AutoRefillTrayIdentity {
  filamentType: string | null
  color: string | null
  colors?: readonly string[] | null
  trayName?: string | null
  trayInfoIdx?: string | null
}

/**
 * Whether two AMS trays hold interchangeable filament for the printer's own
 * auto-refill (backup) chaining: same filament type, same colour palette, and
 * the same declared identity — Bambu preset id (`trayInfoIdx`) when either tray
 * has one, else tray name. Two trays with no declared identity at all never
 * pool, because "same type and colour" alone is how a third-party spool gets
 * silently continued with a different material.
 *
 * Callers still own the surrounding conditions (auto-refill enabled, both trays
 * are physical AMS slots, both satisfy the print's requirement).
 */
export function traysMatchForAutoRefill(anchor: AutoRefillTrayIdentity, candidate: AutoRefillTrayIdentity): boolean {
  if (!sameExactText(anchor.filamentType, candidate.filamentType)) return false
  if (!samePalette(anchor, candidate)) return false

  const anchorTrayInfoIdx = normalizeText(anchor.trayInfoIdx)
  const candidateTrayInfoIdx = normalizeText(candidate.trayInfoIdx)
  if (anchorTrayInfoIdx || candidateTrayInfoIdx) {
    return anchorTrayInfoIdx !== '' && anchorTrayInfoIdx === candidateTrayInfoIdx
  }

  const anchorTrayName = normalizeText(anchor.trayName)
  const candidateTrayName = normalizeText(candidate.trayName)
  if (anchorTrayName || candidateTrayName) {
    return anchorTrayName !== '' && anchorTrayName === candidateTrayName
  }

  return false
}

function samePalette(left: AutoRefillTrayIdentity, right: AutoRefillTrayIdentity): boolean {
  const leftPalette = normalizePalette(left)
  const rightPalette = normalizePalette(right)
  if (leftPalette.length === 0 || rightPalette.length === 0) return false
  if (leftPalette.length !== rightPalette.length) return false
  return leftPalette.every((color, index) => color === rightPalette[index])
}

function normalizePalette(tray: AutoRefillTrayIdentity): string[] {
  const colors = (tray.colors ?? [])
    .map((color) => normalizeText(color))
    .filter((color) => color !== '')
  if (colors.length > 0) return colors

  const fallback = normalizeText(tray.color)
  return fallback ? [fallback] : []
}

function sameExactText(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeText(left)
  const normalizedRight = normalizeText(right)
  return normalizedLeft !== '' && normalizedLeft === normalizedRight
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? ''
}
