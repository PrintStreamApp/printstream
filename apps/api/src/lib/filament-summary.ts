/**
 * Converts persisted filament rollups into the shared stats response shape.
 */
const FEET_PER_METER = 3.28084

function toFeet(meters: number): number {
  return Number((meters * FEET_PER_METER).toFixed(6))
}

export type FilamentRollup = {
  trackedFilamentPrints: number
  filamentUsedGrams: number
  successfulFilamentUsedGrams: number
  failedFilamentUsedGrams: number
  cancelledFilamentUsedGrams: number
  filamentUsedMeters: number
  successfulFilamentUsedMeters: number
  failedFilamentUsedMeters: number
  cancelledFilamentUsedMeters: number
}

type FilamentSummary = {
  filamentKilogramsPrinted: number | null
  successfulFilamentKilogramsPrinted: number | null
  failedFilamentKilogramsPrinted: number | null
  cancelledFilamentKilogramsPrinted: number | null
  wastedFilamentKilogramsPrinted: number | null
  filamentMetersPrinted: number | null
  successfulFilamentMetersPrinted: number | null
  failedFilamentMetersPrinted: number | null
  cancelledFilamentMetersPrinted: number | null
  wastedFilamentMetersPrinted: number | null
  filamentFeetPrinted: number | null
  successfulFilamentFeetPrinted: number | null
  failedFilamentFeetPrinted: number | null
  cancelledFilamentFeetPrinted: number | null
  wastedFilamentFeetPrinted: number | null
}

export function buildFilamentSummary(rollup: FilamentRollup): FilamentSummary {
  if (rollup.trackedFilamentPrints <= 0) {
    return {
      filamentKilogramsPrinted: null,
      successfulFilamentKilogramsPrinted: null,
      failedFilamentKilogramsPrinted: null,
      cancelledFilamentKilogramsPrinted: null,
      wastedFilamentKilogramsPrinted: null,
      filamentMetersPrinted: null,
      successfulFilamentMetersPrinted: null,
      failedFilamentMetersPrinted: null,
      cancelledFilamentMetersPrinted: null,
      wastedFilamentMetersPrinted: null,
      filamentFeetPrinted: null,
      successfulFilamentFeetPrinted: null,
      failedFilamentFeetPrinted: null,
      cancelledFilamentFeetPrinted: null,
      wastedFilamentFeetPrinted: null
    }
  }

  const wastedFilamentUsedGrams = rollup.failedFilamentUsedGrams + rollup.cancelledFilamentUsedGrams
  const wastedFilamentUsedMeters = rollup.failedFilamentUsedMeters + rollup.cancelledFilamentUsedMeters

  return {
    filamentKilogramsPrinted: rollup.filamentUsedGrams / 1000,
    successfulFilamentKilogramsPrinted: rollup.successfulFilamentUsedGrams / 1000,
    failedFilamentKilogramsPrinted: rollup.failedFilamentUsedGrams / 1000,
    cancelledFilamentKilogramsPrinted: rollup.cancelledFilamentUsedGrams / 1000,
    wastedFilamentKilogramsPrinted: wastedFilamentUsedGrams / 1000,
    filamentMetersPrinted: rollup.filamentUsedMeters,
    successfulFilamentMetersPrinted: rollup.successfulFilamentUsedMeters,
    failedFilamentMetersPrinted: rollup.failedFilamentUsedMeters,
    cancelledFilamentMetersPrinted: rollup.cancelledFilamentUsedMeters,
    wastedFilamentMetersPrinted: wastedFilamentUsedMeters,
    filamentFeetPrinted: toFeet(rollup.filamentUsedMeters),
    successfulFilamentFeetPrinted: toFeet(rollup.successfulFilamentUsedMeters),
    failedFilamentFeetPrinted: toFeet(rollup.failedFilamentUsedMeters),
    cancelledFilamentFeetPrinted: toFeet(rollup.cancelledFilamentUsedMeters),
    wastedFilamentFeetPrinted: toFeet(wastedFilamentUsedMeters)
  }
}