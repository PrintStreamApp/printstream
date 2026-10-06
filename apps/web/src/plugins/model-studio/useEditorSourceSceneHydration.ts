/**
 * Seeds an editor from its source index and merges late plate scenes into live state.
 * Pending plates use session-stable plate IDs. Every merge applies to the latest
 * state so a concurrent settings or scene update cannot erase another write.
 */
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { LibraryThreeMfScene } from '@printstream/shared'
import { bedsEqual } from './editorGeometry'
import {
  fillPlateFromScene,
  movePlateContentsToBed,
  seedEditorState,
  seedEmptyEditorState,
  seededActivePlateIndex,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'

interface SourceSceneHydrationOptions {
  hasNoBaseFile: boolean
  sourceIndex: Parameters<typeof seedEditorState>[0] | undefined
  initialSceneSettled: boolean
  scenesByPlate: Map<number, LibraryThreeMfScene>
  preferredSourceIndex: number | null
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  setActivePlateIndex: Dispatch<SetStateAction<number>>
  setRebuildToken: Dispatch<SetStateAction<number>>
}

/** Return the pending plate IDs so readiness and viewport build use the same source state. */
export function useEditorSourceSceneHydration(options: SourceSceneHydrationOptions) {
  const {
    hasNoBaseFile,
    sourceIndex,
    initialSceneSettled,
    scenesByPlate,
    preferredSourceIndex,
    stateRef,
    setState,
    setActivePlateIndex,
    setRebuildToken
  } = options
  const pendingScenePlatesRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    // Seed side effects once from the ref, outside a state updater that StrictMode may replay.
    if (stateRef.current) return
    if (hasNoBaseFile) {
      const seeded = seedEmptyEditorState()
      setActivePlateIndex(seeded.plates[0]?.index ?? 1)
      setState(seeded)
      return
    }
    if (!sourceIndex || !initialSceneSettled) return
    const seeded = seedEditorState(sourceIndex, scenesByPlate)
    pendingScenePlatesRef.current = new Set(
      seeded.plates
        .filter((plate) => plate.sourcePlateIndex !== null && !scenesByPlate.has(plate.sourcePlateIndex))
        .map((plate) => plate.plateId)
    )
    // The preferred source number is not necessarily the live positional index.
    setActivePlateIndex(seededActivePlateIndex(seeded.plates, preferredSourceIndex))
    setState(seeded)
  }, [hasNoBaseFile, sourceIndex, initialSceneSettled, scenesByPlate, preferredSourceIndex,
    stateRef, setState, setActivePlateIndex])

  useEffect(() => {
    const snapshot = stateRef.current
    if (scenesByPlate.size === 0 || !snapshot) return
    const filledPlates = new Map<number, EditorPlate>()
    const nextBeds = new Map<number, EditorPlate['bed']>()
    // New plates have no source index, but still inherit the target printer's bed.
    const anyScene = scenesByPlate.values().next().value as LibraryThreeMfScene | undefined
    for (const plate of snapshot.plates) {
      const ownScene = plate.sourcePlateIndex !== null
        ? scenesByPlate.get(plate.sourcePlateIndex)
        : undefined
      const scene = ownScene ?? (plate.sourcePlateIndex === null ? anyScene : undefined)
      if (!scene) continue
      if (ownScene && pendingScenePlatesRef.current.has(plate.plateId)) {
        pendingScenePlatesRef.current.delete(plate.plateId)
        // A user may have already edited a plate that appeared empty while its scene loaded.
        if (plate.instances.length === 0) {
          filledPlates.set(plate.plateId, fillPlateFromScene(plate, ownScene))
          continue
        }
      }
      const nextBed = {
        minX: scene.bed.minX,
        maxX: scene.bed.maxX,
        minY: scene.bed.minY,
        maxY: scene.bed.maxY,
        maxZ: scene.bed.maxZ,
        excludeAreas: scene.bed.excludeAreas
      }
      if (!bedsEqual(plate.bed, nextBed)) nextBeds.set(plate.plateId, nextBed)
    }
    if (filledPlates.size === 0 && nextBeds.size === 0) return

    // Resolve by stable plate ID against the latest state, since a reorder can land in this flush.
    // Retarget from each live bed to avoid applying a rapid machine change twice.
    setState((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        plates: prev.plates.map((plate) => {
          const filled = filledPlates.get(plate.plateId)
          if (filled) return { ...filled, index: plate.index }
          const bed = nextBeds.get(plate.plateId)
          return bed ? movePlateContentsToBed(plate, bed) : plate
        })
      }
    })
    // Bed model geometry is a build dependency, so even a bed-only target change rebuilds.
    // The incremental builder still reuses its surface until bedSurfaceSignature changes.
    setRebuildToken((token) => token + 1)
  }, [scenesByPlate, stateRef, setState, setRebuildToken])

  return pendingScenePlatesRef
}
