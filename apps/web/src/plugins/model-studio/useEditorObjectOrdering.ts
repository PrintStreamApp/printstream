/**
 * Owns whole-project object and part ordering from sidebar drags. The model
 * helpers decide the new order; this hook records exactly one history frame
 * only when a drag changes state. Ordering moves no geometry, so it does not
 * request a scene rebuild.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { moveObjectBefore, movePartBefore, type EditorState } from './lib/editorModel'

interface EditorObjectOrderingOptions {
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  recordHistory: () => void
}

/** Return the object and part row reorder handlers for the sidebar. */
export function useEditorObjectOrdering({ stateRef, setState, recordHistory }: EditorObjectOrderingOptions) {
  const commitReorder = useCallback((reorder: (current: EditorState) => EditorState) => {
    const current = stateRef.current
    if (!current) return
    const next = reorder(current)
    if (next === current) return
    recordHistory()
    setState(next)
  }, [stateRef, recordHistory, setState])

  // The file has one object order across all plates. Address by host id because the sidebar
  // lists only instances whose geometry has rendered, so a row position can name the wrong model.
  const handleReorderObject = useCallback((hostId: number, beforeHostId: number | null) => {
    commitReorder((current) => moveObjectBefore(current, hostId, beforeHostId))
  }, [commitReorder])

  // Part order is geometry-level and applies to every linked copy of the owning object.
  const handleReorderPart = useCallback((hostId: number, partIndex: number, beforePartIndex: number | null) => {
    commitReorder((current) => movePartBefore(current, hostId, partIndex, beforePartIndex))
  }, [commitReorder])

  return { handleReorderObject, handleReorderPart }
}
