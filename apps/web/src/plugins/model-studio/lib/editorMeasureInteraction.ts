/**
 * Coordinates measure-tool hover and press/release without owning the scene highlight.
 * A camera orbit does not place a point; the full resolved feature and source travel
 * together to the panel and highlight.
 */
import type { MeasurePick } from './editorMeasurePicking'
import { isEditorPointerClick } from './editorPointerClick'

interface MeasureClickOptions {
  pick: (event: PointerEvent) => MeasurePick | null
  add: (pick: MeasurePick) => void
  setHover: (pick: MeasurePick | null, pointMode: boolean) => void
  hasHover: () => boolean
  clearHover: () => void
}

/** Return hover and press/release handlers; release reports whether Measure owned the gesture. */
export function createEditorMeasureInteraction({
  pick,
  add,
  setHover,
  hasHover,
  clearHover
}: MeasureClickOptions) {
  let start: { x: number; y: number } | null = null

  return {
    updateHover: (event: PointerEvent, active: boolean) => {
      if (active) setHover(pick(event), event.shiftKey)
      else if (hasHover()) clearHover()
    },
    begin: (event: PointerEvent) => {
      start = { x: event.clientX, y: event.clientY }
    },
    finish: (event: PointerEvent): boolean => {
      if (!start) return false
      const press = start
      start = null
      if (isEditorPointerClick(press, event)) {
        const resolved = pick(event)
        if (resolved) add(resolved)
      }
      return true
    },
    reset: () => { start = null }
  }
}
