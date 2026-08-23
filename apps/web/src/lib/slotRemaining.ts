/**
 * Refill-aware remaining-filament state for print-dialog tray choices (the
 * insufficiency highlight and the auto-refill badge on `SlotOptionLabel`).
 *
 * The rule itself, which of a slot's remaining signals may be believed, the
 * low-filament headroom, auto-refill pooling and the grade that falls out of
 * them, lives in `@printstream/shared`'s `slot-remaining.ts`, so the shared
 * print matcher's tie-break, the dialog-level low-filament confirmation and this
 * badge can never disagree. This module only owns the adaptation: which of THIS
 * printer's trays the print could chain into, in the web's tray shape.
 */
import {
  gradeSlotSufficiency,
  estimateRemainGrams,
  knownRemainGrams,
  trayCanSatisfyRequirement,
  type RemainingFilamentTray
} from '@printstream/shared'

export { estimateRemainGrams }

export interface SlotRemainingTray extends RemainingFilamentTray {
  kind: 'ams' | 'external'
  filamentType: string | null
  color: string | null
  colors: readonly string[]
  trayName?: string | null
  trayInfoIdx?: string | null
  remainPercent: number | null
  nozzleId: number | null
}

export interface SlotRemainingState {
  /**
   * What this slot alone holds: the figure the label prints, so it is the BELIEVABLE
   * one (`knownRemainGrams`: the tracked spool first, then the RFID-only percent
   * estimate) and never the refill pool's total, which would contradict the number
   * printed beside it. Null when nothing about the slot is measurable, which is the
   * signal to print no figure at all rather than a guess.
   */
  remainGrams: number | null
  insufficient: boolean
  usesAutoRefill: boolean
}

interface SlotRemainingInput {
  tray: SlotRemainingTray
  trays: readonly SlotRemainingTray[]
  requiredFilamentType?: string | null
  requiredNozzleId?: number | null
  requiredGrams?: number | null
  autoRefillEnabled?: boolean | null
}

export function getSlotRemainingState({
  tray,
  trays,
  requiredFilamentType,
  requiredNozzleId,
  requiredGrams,
  autoRefillEnabled
}: SlotRemainingInput): SlotRemainingState {
  const trayIsRefillable = trayCanUseAutoRefill(tray, requiredFilamentType, requiredNozzleId)
  const grade = gradeSlotSufficiency({
    tray,
    trayIsRefillable,
    refillCandidates: trays.filter((candidate) =>
      trayCanUseAutoRefill(candidate, requiredFilamentType, requiredNozzleId)),
    requiredGrams: requiredGrams ?? null,
    autoRefillEnabled
  })
  return {
    remainGrams: knownRemainGrams(tray),
    insufficient: grade.sufficiency === 'short',
    usesAutoRefill: grade.pooled
  }
}

/**
 * Whether the printer's auto-refill could chain this tray for the print: a loaded
 * physical AMS slot that satisfies the requirement. Deliberately says nothing
 * about RFID: the printer chains a manually-set pair exactly as it chains two
 * tagged spools, and gating this on `trayUuid` is what made the refill badge look
 * like a Bambu-only feature.
 */
function trayCanUseAutoRefill(
  tray: SlotRemainingTray,
  requiredFilamentType: string | null | undefined,
  requiredNozzleId: number | null | undefined
): boolean {
  return tray.kind === 'ams'
    && trayHasLoadedFilament(tray)
    && trayCanSatisfyRequirement(
      {
        filamentId: 1,
        filamentType: requiredFilamentType ?? null,
        filamentName: null,
        nozzleId: requiredNozzleId ?? null
      },
      {
        filamentType: tray.filamentType,
        nozzleId: tray.nozzleId
      }
    )
}

function trayHasLoadedFilament(tray: Pick<SlotRemainingTray, 'filamentType' | 'color' | 'colors'>): boolean {
  return tray.filamentType != null || tray.color != null || tray.colors.length > 0
}
