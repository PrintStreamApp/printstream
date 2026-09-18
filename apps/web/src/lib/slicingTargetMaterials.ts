/** Translates editor session material identities into the ordered slots written into a prepared 3MF. */

/**
 * Freeze a target in saved-slot space before BOTH preparing its bytes and submitting its request.
 * Session ids survive deletion/reordering; file ids are always list positions 1..N. Preset,
 * nozzle, colour and overrides travel together. Reject a stale mapping instead of slicing it
 * against another material. Call only at the editor-to-slicer boundary, once per target.
 */
export function slicingTargetWithSavedMaterials<T extends { filamentMappings?: Array<{ projectFilamentId: number }> }>(target: T, sessionIds: readonly number[]): T {
  if (!target.filamentMappings) return target
  const savedIds = new Map(sessionIds.map((id, index) => [id, index + 1]))
  return {
    ...target,
    filamentMappings: target.filamentMappings.map((mapping) => {
      const projectFilamentId = savedIds.get(mapping.projectFilamentId)
      if (projectFilamentId === undefined) {
        throw new Error('A selected slicing material is no longer in the project. Choose its replacement and try again.')
      }
      return { ...mapping, projectFilamentId }
    })
  }
}
