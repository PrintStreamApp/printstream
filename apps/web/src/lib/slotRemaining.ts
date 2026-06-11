/**
 * Refill-aware remaining-filament helpers for print-dialog tray choices.
 *
 * The printer only reports tray remaining as a percentage, so the UI uses
 * Bambu Studio's rough 1kg spool convention (`percent * 10`) to estimate
 * grams. When AMS auto-refill is enabled, compatible AMS trays are treated
 * as a shared pool for the low-filament warning state.
 */
import { trayCanSatisfyRequirement } from '@printstream/shared'

const LOW_FILAMENT_HEADROOM_GRAMS = 25

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

function traysMatchForAutoRefill(anchor: SlotRemainingTray, candidate: SlotRemainingTray): boolean {
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

function samePalette(left: SlotRemainingTray, right: SlotRemainingTray): boolean {
  const leftPalette = normalizePalette(left)
  const rightPalette = normalizePalette(right)
  if (leftPalette.length === 0 || rightPalette.length === 0) return false
  if (leftPalette.length !== rightPalette.length) return false
  return leftPalette.every((color, index) => color === rightPalette[index])
}

function normalizePalette(tray: Pick<SlotRemainingTray, 'colors' | 'color'>): string[] {
  const colors = tray.colors
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

function estimateRemainGrams(remainPercent: number | null): number | null {
  return remainPercent != null ? Math.round(remainPercent * 10) : null
}
