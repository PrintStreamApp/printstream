import type { SlicingTarget } from '@printstream/shared'

/**
 * What to do with a slicing job when the user leaves a slice-then-print/queue flow
 * (Cancel, Back, or an unmount) so the throwaway hidden output is never orphaned:
 *
 * - `cancel`  — the slice is still running; stop it.
 * - `discard` — it finished but the output was never used; drop the hidden file.
 * - `keep`    — nothing to do: either not sliced yet, or already dispatched to a
 *               printer (`printed`), in which case the output must survive.
 *
 * Centralised so the "don't discard an output we just printed" invariant lives in
 * one tested place rather than being re-derived at each leave path.
 */
export function resolveSlicingLeaveAction(input: {
  status: string | null | undefined
  outputFileId: string | null | undefined
  printed: boolean
}): 'cancel' | 'discard' | 'keep' {
  const { status, outputFileId, printed } = input
  if (status != null && status !== 'ready' && status !== 'failed' && status !== 'cancelled') {
    return 'cancel'
  }
  if (!printed && status === 'ready' && outputFileId) return 'discard'
  return 'keep'
}

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