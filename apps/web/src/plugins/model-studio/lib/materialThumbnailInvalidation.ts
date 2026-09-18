/** Owns material-driven thumbnail invalidation without eagerly building unopened plates on load. */
export interface MaterialThumbnailInputs {
  colors: Record<number, string>
  baseIds: Record<number, number> | undefined
}

/** First population and newly added swatches are seeds; recolours, removals and replacements stale cached images. */
export function materialThumbnailsChanged(previous: MaterialThumbnailInputs | null, next: MaterialThumbnailInputs): boolean {
  if (!previous) return false
  if (Object.entries(previous.colors).some(([id, color]) => next.colors[Number(id)] !== color)) return true

  // Missing mappings mean identity. This also detects undo to a state before the first deletion,
  // without treating identity mappings introduced by an unchanged save as visual edits.
  const ids = new Set([...Object.keys(previous.baseIds ?? {}), ...Object.keys(next.baseIds ?? {})])
  return [...ids].some((key) => {
    const id = Number(key)
    return (previous.baseIds?.[id] ?? id) !== (next.baseIds?.[id] ?? id)
  })
}
