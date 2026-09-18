/**
 * Replaces physical recipe inputs when a project material is deleted. Shares are merged when
 * two inputs become the same material; a one-input mix becomes that physical material. Nested
 * replacement recipes are expanded with cycle protection so they never retain a deleted id.
 */
import type { SessionFilamentSlot } from './useMaterialSlots'

export function replaceMaterialRecipe(
  slot: SessionFilamentSlot,
  slots: readonly SessionFilamentSlot[],
  removedId: number,
  replacementId: number
): SessionFilamentSlot {
  const recipe = slot.mixedFilament
  if (!recipe?.componentIds.includes(removedId)) return slot
  const byId = new Map(slots.map((entry) => [entry.projectFilamentId, entry]))
  const shares = new Map<number, number>()

  /** Expand only the replacement, retaining physical inputs and omitting circular branches. */
  const add = (id: number, ratio: number, visiting: Set<number>) => {
    const targetId = id === removedId ? replacementId : id
    if (visiting.has(targetId)) return
    const target = byId.get(targetId)
    if (!target) return
    if (!target.mixedFilament) {
      shares.set(targetId, (shares.get(targetId) ?? 0) + ratio)
      return
    }
    const path = new Set([...visiting, targetId])
    target.mixedFilament.componentIds.forEach((componentId, index) => {
      add(componentId, ratio * (target.mixedFilament!.ratios[index] ?? 0), path)
    })
  }
  recipe.componentIds.forEach((id, index) => add(id, recipe.ratios[index] ?? 0, new Set()))
  const componentIds = [...shares.keys()]
  const total = [...shares.values()].reduce((sum, ratio) => sum + ratio, 0)
  if (componentIds.length === 1) {
    const physical = byId.get(componentIds[0]!)!
    return {
      ...physical,
      projectFilamentId: slot.projectFilamentId,
      replacedSourceIndices: slot.replacedSourceIndices,
      mixedFilament: null,
      profileEdited: true
    }
  }
  const issues = recipe.issues.filter((issue) => !['component-count', 'component-reference', 'component-is-mixed', 'component-type-mismatch'].includes(issue))
  if (componentIds.length < 2 || componentIds.length > 3) issues.push('component-count')
  if (new Set(componentIds.map((id) => byId.get(id)?.label)).size > 1) issues.push('component-type-mismatch')
  return {
    ...slot,
    mixedFilament: {
      ...recipe,
      componentIds,
      ratios: componentIds.map((id) => total > 0 ? shares.get(id)! / total : 0),
      gradient: recipe.gradient && componentIds.length === 2,
      issues
    }
  }
}
