/**
 * BambuStudio's project-level purge-mode contract.
 *
 * The engine stores this as `prime_volume_mode`. Its UI offers Standard plus exactly one
 * machine-supported alternative: Fast when `support_fast_purge_mode` is enabled, otherwise Prime
 * Saving on a multi-nozzle machine. Keeping that choice rule shared prevents a client from writing
 * a mode the selected machine immediately resets to Standard.
 */
import { z } from 'zod'

export const primeVolumeModeSchema = z.enum(['Default', 'Saving', 'Fast'])
export type PrimeVolumeMode = z.infer<typeof primeVolumeModeSchema>

/** Parse the string or enum index Bambu project settings may carry, defaulting like the engine. */
export function parsePrimeVolumeMode(value: unknown): PrimeVolumeMode {
  const scalar = Array.isArray(value) ? value[0] : value

  if (scalar === 1 || scalar === '1' || scalar === 'Saving') {
    return 'Saving'
  }

  if (scalar === 2 || scalar === '2' || scalar === 'Fast') {
    return 'Fast'
  }

  return 'Default'
}

/** Modes BambuStudio exposes for this machine, in its display order. */
export function availablePrimeVolumeModes(input: {
  supportsFastPurge: boolean
  supportsPrimeSaving: boolean
}): PrimeVolumeMode[] {
  if (input.supportsFastPurge) {
    return ['Default', 'Fast']
  }

  if (input.supportsPrimeSaving) {
    return ['Default', 'Saving']
  }

  return ['Default']
}
