/**
 * "Will the slots this print mapped actually last?" — the plate-level low-filament
 * rule, shared by the print dialogs' confirmation and the API's dispatch guard.
 *
 * Owns: which mapped slots are short, and the sentence describing one. It owns
 * neither the grading rule (`slot-remaining.ts`'s `gradeSlotSufficiency`, which
 * every per-slot surface also uses, so the dialog's red remaining figure and this
 * check can never disagree) nor slot labelling (each caller has its own).
 *
 * Contract: only slots that can be measured are ever reported. A spool with no
 * RFID tag and no tracked figure is UNGRADEABLE, never "empty" — see
 * `knownRemainGrams`. A slot the printer's auto-refill chains to a mate is judged
 * on the pool's combined total, so a backed-up slot is reported only when the
 * whole pool falls short. That is what "too little, and no backup" means here.
 *
 * Why it never hard-blocks more than the browser warned about: the API cannot see
 * filament-manager's tracked grams (core must not import a plugin), so it grades
 * on the RFID percent alone and reads every manually-set spool as ungradeable.
 * It can therefore only ever report a SUBSET of what the dialog showed — the
 * direction that matters, since a refusal the dialog never displayed would be a
 * print the user cannot get out of.
 */
import { refillCandidateSlots, type QueueLoadedSlot, type QueueRequiredFilament } from './print-queue.js'
import { gradeSlotSufficiency } from './slot-remaining.js'

/** A mapped slot that cannot finish what the plate asks of it. */
export interface LowFilamentSlot {
  filamentId: number
  filamentType: string | null
  /** Bambu global tray index the print mapped this filament to (see `amsTrayIndex`). */
  trayIndex: number
  /** What the plate states it will consume. */
  requiredGrams: number
  /** What the slot holds — or its whole refill pool, when `pooled`. */
  remainGrams: number
  /**
   * The slot is chained to at least one auto-refill mate and the pool is STILL
   * short. A slot whose pool covers the plate never reaches this list at all.
   */
  pooled: boolean
}

export interface LowFilamentInput {
  /** The plate's filaments, carrying `usedGrams`; a filament with none is ungradeable. */
  required: readonly QueueRequiredFilament[]
  /** The printer's loaded slots (`loadedSlotsFromStatus`), ideally enriched with tracked grams. */
  slots: readonly QueueLoadedSlot[]
  /** The mapping about to be dispatched, indexed by `filament.id - 1`; `-1` = unmapped. */
  amsMapping: readonly number[] | undefined
  /** The printer's own auto-refill setting, never a caller preference. */
  autoRefillEnabled: boolean | null | undefined
}

/**
 * Every mapped slot that will run out, worst shortfall first.
 *
 * Empty when nothing is mapped, nothing states its usage, or no slot can be
 * measured — an empty result means "nothing to warn about", never "checked and
 * fine", because most of these signals are simply absent for third-party spools.
 */
export function findLowFilamentSlots({
  required,
  slots,
  amsMapping,
  autoRefillEnabled
}: LowFilamentInput): LowFilamentSlot[] {
  if (!amsMapping || amsMapping.length === 0) return []
  const issues: LowFilamentSlot[] = []
  for (const filament of required) {
    const trayIndex = amsMapping[filament.id - 1]
    if (typeof trayIndex !== 'number' || !Number.isInteger(trayIndex) || trayIndex < 0) continue
    const slot = slots.find((candidate) => candidate.trayIndex === trayIndex)
    if (!slot) continue
    // Zero usage means the plate does not consume this filament, not "it needs
    // nothing, so any slot under the headroom is short". `?? null` let 0 through
    // and `0 == null` is false, so a listed-but-unused material graded against the
    // bare 25g margin and rendered as "barely over the 0g this plate needs".
    const requiredGrams = filament.usedGrams != null && filament.usedGrams > 0 ? filament.usedGrams : null
    const refillCandidates = refillCandidateSlots(filament, slots)
    const grade = gradeSlotSufficiency({
      tray: slot,
      trayIsRefillable: refillCandidates.some((candidate) => candidate.trayIndex === trayIndex),
      refillCandidates,
      requiredGrams,
      autoRefillEnabled
    })
    if (grade.sufficiency !== 'short' || requiredGrams == null || grade.remainGrams == null) continue
    issues.push({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      trayIndex,
      requiredGrams,
      remainGrams: grade.remainGrams,
      pooled: grade.pooled
    })
  }
  return issues.sort((left, right) =>
    (right.requiredGrams - right.remainGrams) - (left.requiredGrams - left.remainGrams))
}

/**
 * The one sentence describing a shortfall. The print dialog's warning and the
 * API's refusal both render it, so a print can never be refused by a check whose
 * wording the user was never shown.
 *
 * Two shapes, because the threshold is "usage plus a safety margin": a slot can
 * be reported while still holding *more* grams than the plate names, and saying
 * "has 210g left and needs 200g" in that case reads as a bug rather than a
 * warning. `slotLabel` comes from the caller because only it knows how that
 * surface names a slot ("AMS A · 2", "External spool").
 */
export function lowFilamentIssueSentence(issue: LowFilamentSlot, slotLabel: string): string {
  const material = issue.filamentType ? `${issue.filamentType} ` : ''
  const backup = issue.pooled ? ' (with its auto-refill backup)' : ''
  const remaining = Math.round(issue.remainGrams)
  const needed = Math.round(issue.requiredGrams)
  return remaining < needed
    ? `${slotLabel}${backup} has about ${remaining}g of ${material}left, and this plate needs ${needed}g.`
    : `${slotLabel}${backup} has about ${remaining}g of ${material}left — barely over the ${needed}g`
      + ' this plate needs, with nothing spare for purging.'
}
