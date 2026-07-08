/**
 * Tiny module store bridging the AMS-slot launch points (the slot context-menu item and the
 * "Calibrate…" button in the pressure-advance dialog) to the always-mounted calibration host.
 * The context-menu item unmounts when the menu closes, so it can't host the wizard itself;
 * instead it records the requested slot here and the `shell.overlays` host renders the wizard.
 * No core changes, no cross-plugin imports.
 */
import { useSyncExternalStore } from 'react'
import type { CalibrationLockedTarget } from './NewCalibrationDialog'

let current: CalibrationLockedTarget | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Open the pressure-advance calibration wizard for a specific AMS slot's filament. */
export function openSlotCalibration(target: CalibrationLockedTarget): void {
  current = target
  emit()
}

export function closeSlotCalibration(): void {
  current = null
  emit()
}

export function useSlotCalibrationTarget(): CalibrationLockedTarget | null {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    () => current,
    () => current
  )
}
