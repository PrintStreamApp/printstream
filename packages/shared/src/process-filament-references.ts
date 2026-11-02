/**
 * Final process material-reference validation. The editor remaps loaded preset references in the
 * same transaction as material removal/reordering. A later writer must not resurrect a dangling
 * preset index or silently substitute a different material before native changed-key serialization.
 */
import { FILAMENT_INDEX_PROCESS_KEYS } from './process-settings.js'

/** Reject dangling references after authoring. Zero means Default; absent material topology skips validation. */
export function assertValidProcessFilamentReferences(
  config: Record<string, unknown>,
  filamentCount: number
): void {
  if (!Number.isInteger(filamentCount) || filamentCount < 1) return
  for (const key of FILAMENT_INDEX_PROCESS_KEYS) {
    const value = config[key]
    if (typeof value !== 'string') continue
    const index = Number(value)
    if (!Number.isInteger(index) || (index >= 0 && index <= filamentCount)) continue
    throw new Error(`The process setting ${key} refers to material ${value}, which is unavailable. Choose a current material or Default before saving or slicing.`)
  }
}
