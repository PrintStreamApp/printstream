/**
 * Resolves deferred selection clicks after orbit or object dragging has had a chance to move.
 *
 * Empty space clears selection only on a click. A multi-selection member collapses to one
 * member only if the gesture stayed still; a real body drag keeps the set even if it returns
 * to its press point. Baked-part drill-down follows the same release threshold.
 */
import type { PartRef } from './selectionModel'
import { isEditorPointerClick } from './editorPointerClick'

export interface EditorSelectionClicksOptions {
  selectExclusive: (key: string | null) => void
  selectBakedPart: (part: PartRef) => void
}

/** Return per-mount click state for the viewport's pointer handlers. */
export function createEditorSelectionClicks(options: EditorSelectionClicksOptions) {
  const { selectExclusive, selectBakedPart } = options
  let empty: { x: number; y: number } | null = null
  let collapse: { key: string; x: number; y: number } | null = null
  let bakedPart: { part: PartRef; x: number; y: number } | null = null

  return {
    beginEmpty(event: PointerEvent) {
      empty = { x: event.clientX, y: event.clientY }
    },
    beginCollapse(key: string, event: PointerEvent) {
      collapse = { key, x: event.clientX, y: event.clientY }
    },
    beginBakedPart(part: PartRef, event: PointerEvent) {
      bakedPart = { part, x: event.clientX, y: event.clientY }
    },
    /** A real body drag keeps the multi-selection even if the pointer returns to its start. */
    onBodyDragMove(event: PointerEvent) {
      if (collapse && !isEditorPointerClick(collapse, event)) collapse = null
    },
    /** Resolve and clear all pending selection decisions on pointer release. */
    finish(event: PointerEvent) {
      const releasedEmpty = empty
      const releasedCollapse = collapse
      const releasedPart = bakedPart
      empty = null
      collapse = null
      bakedPart = null
      if (releasedEmpty && isEditorPointerClick(releasedEmpty, event)) selectExclusive(null)
      if (releasedCollapse && isEditorPointerClick(releasedCollapse, event)) selectExclusive(releasedCollapse.key)
      if (releasedPart && isEditorPointerClick(releasedPart, event)) selectBakedPart(releasedPart.part)
    }
  }
}
