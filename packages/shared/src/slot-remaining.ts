/**
 * Remaining-filament primitives shared by every surface that grades a printer
 * slot against a print's material needs: the gram estimate for percent-only
 * trays, which of a slot's remaining signals may be believed, the low-filament
 * headroom, the AMS auto-refill pooling test, and the one grading rule built on
 * all of them.
 *
 * Owned here (not in the web) because four callers must agree: the print
 * matcher's sufficiency-guarded tie-break (`print-queue.ts`), the web's per-slot
 * warning state (`apps/web/src/lib/slotRemaining.ts`, this module's web
 * counterpart), the dialog-level confirmation and its API guard
 * (`print-filament-sufficiency.ts`). A slot one of them calls sufficient must
 * never be one another skipped as insufficient, they used to re-derive the pool
 * sum separately and already disagreed about it.
 */
import { hasBambuRfidTag } from './filament-identity.js'

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
 * RFID (Bambu-tagged) spools; `knownRemainGrams` applies that gate.
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
 * the same declared identity: Bambu preset id (`trayInfoIdx`) when either tray
 * has one, else tray name. Two trays with no declared identity at all never
 * pool, because "same type and colour" alone is how a third-party spool gets
 * silently continued with a different material.
 *
 * Deliberately blind to RFID: a spool the user set by hand declares its identity
 * through `trayInfoIdx`/`trayName` just as an RFID one does, and the printer
 * chains the two the same way. Nothing here may gate on `trayUuid`.
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

/** A tray as the sufficiency grader sees it: its pooling identity plus every remaining-filament signal. */
export interface RemainingFilamentTray extends AutoRefillTrayIdentity {
  /** The tracked spool's own figure (filament-manager), which is the only signal a non-RFID spool has. */
  remainingGrams?: number | null
  remainPercent: number | null
  /** RFID/Bambu tag. Null for third-party spools, whose reported percent means nothing. */
  trayUuid?: string | null
}

/**
 * Grams known to remain in a slot: the tracked spool's own figure first
 * (filament-manager covers non-RFID custom spools); otherwise the percent
 * estimate, trusted only for RFID (Bambu-tagged) trays.
 *
 * Untracked third-party filament returns null: **ungradeable, not zero**. The
 * distinction is the whole point: firmware reports `remain: -1` for a spool it
 * cannot measure, and treating that as an empty spool marks every manually-set
 * slot as insufficient.
 */
export function knownRemainGrams(tray: RemainingFilamentTray): number | null {
  if (tray.remainingGrams != null) return tray.remainingGrams
  if (hasBambuRfidTag(tray.trayUuid)) return estimateRemainGrams(tray.remainPercent)
  return null
}

/** `enough` holds the print with headroom, `short` demonstrably does not, `unknown` cannot be graded at all. */
export type SlotSufficiency = 'enough' | 'unknown' | 'short'

export interface SlotSufficiencyGrade {
  /** Remaining grams for this slot, or across its refill pool when pooled. Null = nothing gradeable. */
  remainGrams: number | null
  /** The printer's own auto-refill chains this slot to at least one other, so it is not alone. */
  pooled: boolean
  sufficiency: SlotSufficiency
}

export interface SlotSufficiencyInput {
  tray: RemainingFilamentTray
  /**
   * Whether `tray` is itself a slot the printer's auto-refill could chain FROM: a
   * loaded physical AMS slot this print can reach. False for an external spool, an
   * empty slot, or one behind the wrong nozzle: the printer refills from none of them.
   */
  trayIsRefillable: boolean
  /**
   * Every refillable slot for this requirement, the anchor included, that is why a
   * real pool is `length > 1`. Callers own the reachability filter because only they
   * know their own tray shape; this module owns only the identity test between them.
   */
  refillCandidates: readonly RemainingFilamentTray[]
  /** The plate's stated usage for the filament this slot would feed. Null = unknown, so ungradeable. */
  requiredGrams: number | null
  /** The printer's own setting, never a caller preference. */
  autoRefillEnabled: boolean | null | undefined
}

/**
 * Grade one slot against what the print needs of it.
 *
 * Pooling is decided from identity alone, never from whether the remaining
 * quantity happens to be readable: the printer chains a manually-set pair
 * exactly as it chains two RFID spools, so a slot backed by a mate is `pooled`
 * even when every figure involved is unknown.
 */
export function gradeSlotSufficiency({
  tray,
  trayIsRefillable,
  refillCandidates,
  requiredGrams,
  autoRefillEnabled
}: SlotSufficiencyInput): SlotSufficiencyGrade {
  const poolmates = autoRefillEnabled === true && trayIsRefillable
    ? refillCandidates.filter((candidate) => traysMatchForAutoRefill(tray, candidate))
    : []
  const pooled = poolmates.length > 1
  const remainGrams = pooled ? sumKnownRemainGrams(poolmates) : knownRemainGrams(tray)
  const sufficiency: SlotSufficiency = requiredGrams == null || remainGrams == null
    ? 'unknown'
    : remainGrams >= requiredGrams + LOW_FILAMENT_HEADROOM_GRAMS ? 'enough' : 'short'
  return { remainGrams, pooled, sufficiency }
}

/**
 * Total across a refill pool, or null when not one mate can be graded.
 *
 * An ungradeable mate contributes nothing rather than voiding the total: a pool
 * of one measured 800g spool and one unreadable spool holds *at least* 800g, and
 * understating it can only ever warn where it need not have.
 */
function sumKnownRemainGrams(poolmates: readonly RemainingFilamentTray[]): number | null {
  let total: number | null = null
  for (const mate of poolmates) {
    const grams = knownRemainGrams(mate)
    if (grams == null) continue
    total = (total ?? 0) + grams
  }
  return total
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
