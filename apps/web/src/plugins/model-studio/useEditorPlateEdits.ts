/**
 * Owns the editor's history and scene-invalidation boundary for plate edits.
 * Callers choose the cheapest truthful edit kind; only structure changes may
 * alter geometry or instance identities. The editor retains React state and
 * scene tokens, while this hook keeps their update policy in one place.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react'
import {
  normalizePlateObjectOrder,
  type EditorFilamentChange,
  type EditorPause,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'

/** A plate edit's effect on the active scene. Use structure when uncertain. */
export type PlateEditKind = 'structure' | 'transform' | 'material' | 'visibility' | 'inert'

interface EditorPlateEditsOptions {
  activePlateIndex: number
  recordHistory: () => void
  setState: Dispatch<SetStateAction<EditorState | null>>
  setRebuildToken: Dispatch<SetStateAction<number>>
  setTransformSyncToken: Dispatch<SetStateAction<number>>
  setMaterialSyncToken: Dispatch<SetStateAction<number>>
}

/** Return the shared plate writer and active-plate layer G-code writers. */
export function useEditorPlateEdits({
  activePlateIndex,
  recordHistory,
  setState,
  setRebuildToken,
  setTransformSyncToken,
  setMaterialSyncToken
}: EditorPlateEditsOptions) {
  /**
   * Record one history frame and invalidate only the scene work the edit needs.
   * `recordHistory: false` is for a caller that already captured a combined
   * scene/config frame. Visibility and inert edits update state without a scene
   * token; effects keyed on state handle their presentation.
   */
  const updatePlates = useCallback((
    updater: (plates: EditorPlate[]) => EditorPlate[],
    kind: PlateEditKind = 'structure',
    options: { recordHistory?: boolean } = {}
  ) => {
    if (options.recordHistory !== false) recordHistory()
    setState((current) => {
      if (!current) return current
      const plates = updater(current.plates)
      // Session-only paint, ears, and added-volume fields survive because this spreads the whole
      // state. Structure edits group copies by object to match the saved file's build order.
      return { ...current, plates: kind === 'structure' ? normalizePlateObjectOrder(plates) : plates }
    })

    if (kind === 'structure') setRebuildToken((token) => token + 1)
    else if (kind === 'transform') setTransformSyncToken((token) => token + 1)
    else if (kind === 'material') setMaterialSyncToken((token) => token + 1)
  }, [recordHistory, setState, setRebuildToken, setTransformSyncToken, setMaterialSyncToken])

  // Layer G-code updates the band's shader uniforms through state. The continuous render loop
  // shows the new colour without rebuilding geometry or recolouring each part material.
  const setActivePlateFilamentChanges = useCallback((changes: EditorFilamentChange[]) => {
    updatePlates((plates) => plates.map((plate) => (
      plate.index === activePlateIndex ? { ...plate, filamentChangesOverride: changes } : plate
    )), 'inert')
  }, [activePlateIndex, updatePlates])

  const setActivePlatePauses = useCallback((pauses: EditorPause[]) => {
    updatePlates((plates) => plates.map((plate) => (
      plate.index === activePlateIndex ? { ...plate, pausesOverride: pauses } : plate
    )), 'inert')
  }, [activePlateIndex, updatePlates])

  return { updatePlates, setActivePlateFilamentChanges, setActivePlatePauses }
}
