/**
 * Refill-aware remaining-filament state for print-dialog tray choices (the
 * insufficiency highlight and the auto-refill badge on `SlotOptionLabel`).
 *
 * The primitives — the percent→grams estimate, the low-filament headroom, and
 * the auto-refill pooling test — live in `@printstream/shared`'s
 * `slot-remaining.ts` so the shared print matcher's sufficiency-guarded
 * tie-break and this warning state can never disagree; this module only owns
 * the per-slot UI grading (which pool a slot belongs to, combined remaining).
 */
import {
  LOW_FILAMENT_HEADROOM_GRAMS,
  estimateRemainGrams,
  trayCanSatisfyRequirement,
  traysMatchForAutoRefill
} from '@printstream/shared'

export { estimateRemainGrams }

export interface SlotRemainingTray {
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
  const remainGrams = estimateRemainGrams(tray.remainPercent)
  if (requiredGrams == null || remainGrams == null) {
    return { remainGrams, insufficient: false, usesAutoRefill: false }
  }

  const minimumRequiredGrams = requiredGrams + LOW_FILAMENT_HEADROOM_GRAMS
  const matchingAmsTrays = autoRefillEnabled
    ? trays.filter((candidate) => trayCanUseAutoRefill(candidate, tray, requiredFilamentType, requiredNozzleId))
    : []
  const trayUsesAutoRefill =
    autoRefillEnabled === true
    && trayCanUseAutoRefill(tray, tray, requiredFilamentType, requiredNozzleId)
    && matchingAmsTrays.length > 1

  if (!trayUsesAutoRefill) {
    return {
      remainGrams,
      insufficient: remainGrams < minimumRequiredGrams,
      usesAutoRefill: false
    }
  }

  const combinedRemainGrams = matchingAmsTrays.reduce(
    (total, candidate) => total + (estimateRemainGrams(candidate.remainPercent) ?? 0),
    0
  )

  return {
    remainGrams,
    insufficient: combinedRemainGrams < minimumRequiredGrams,
    usesAutoRefill: true
  }
}

function trayCanUseAutoRefill(
  tray: SlotRemainingTray,
  anchor: SlotRemainingTray,
  requiredFilamentType: string | null | undefined,
  requiredNozzleId: number | null | undefined
): boolean {
  return tray.kind === 'ams'
    && trayHasLoadedFilament(tray)
    && traysMatchForAutoRefill(anchor, tray)
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
