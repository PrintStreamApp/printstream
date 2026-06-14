import type { SlicingTarget } from '@printstream/shared'

/**
 * Rebuild the print-dialog AMS mapping array from the slice job's saved
 * per-project filament tray selections.
 */
export function buildDefaultAmsMappingFromSlicingTarget(
  target: SlicingTarget | null | undefined
): number[] | null {
  if (!target) return null

  const mapping: number[] = []
  let hasMapping = false

  for (const filament of target.filamentMappings ?? []) {
    if (typeof filament.trayId !== 'number' || filament.trayId < 0) continue

    const slotIndex = filament.projectFilamentId - 1
    while (mapping.length <= slotIndex) mapping.push(-1)
    mapping[slotIndex] = filament.trayId
    hasMapping = true
  }

  return hasMapping ? mapping : null
}