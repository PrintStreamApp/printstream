/**
 * Owns layer-height range/profile writes and the selected object's visual aid.
 * The editor retains tool state and scene groups; this hook keeps profile
 * bounds, one-checkpoint-per-stroke policy, and overlay refresh together.
 * A rebuilt scene receives its aid again when its state changes.
 */
import { useCallback, useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type * as THREE from 'three'
import { editorLayerHeightBounds } from './lib/editorLayerHeightSettings'
import { syncLayerHeightVisuals } from './lib/layerHeightOverlay'
import {
  addedPartHostId,
  effectiveLayerHeightProfile,
  type EditorHeightRange,
  type EditorState
} from './lib/editorModel'
import { printableMeshBox, type GizmoMode } from './editorGeometry'

type LayerHeightTarget = { key: string; objectId: number; name: string }
type LayerHeightBrush = { z: number; bandWidth: number }

interface EditorLayerHeightEditingOptions {
  state: EditorState | null
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  activePlateIndex: number
  nozzleDiameter: string | number | null | undefined
  nominalHeight: number
  target: LayerHeightTarget | null
  setTarget: Dispatch<SetStateAction<LayerHeightTarget | null>>
  brush: LayerHeightBrush | null
  groupsRef: MutableRefObject<Map<string, THREE.Group>>
  recordHistoryRef: MutableRefObject<() => void>
  setMode: Dispatch<SetStateAction<GizmoMode>>
}

/** Return the current machine band and history-aware layer-height actions. */
export function useEditorLayerHeightEditing({
  state,
  stateRef,
  setState,
  activePlateIndex,
  nozzleDiameter,
  nominalHeight,
  target,
  setTarget,
  brush,
  groupsRef,
  recordHistoryRef,
  setMode
}: EditorLayerHeightEditingOptions) {
  const setObjectHeightRanges = useCallback((hostId: number, ranges: EditorHeightRange[]) => {
    recordHistoryRef.current()
    setState((current) => current
      ? { ...current, heightRanges: { ...(current.heightRanges ?? {}), [hostId]: ranges } }
      : current)
  }, [recordHistoryRef, setState])

  // A drag samples repeatedly; only pointer-down checkpoints, so one stroke is one undo step.
  const setObjectLayerHeightProfile = useCallback((hostId: number, profile: number[], checkpoint = true) => {
    if (checkpoint) recordHistoryRef.current()
    setState((current) => current
      ? { ...current, layerHeightProfiles: { ...(current.layerHeightProfiles ?? {}), [hostId]: profile } }
      : current)
  }, [recordHistoryRef, setState])

  const layerHeightBounds = useMemo(() => {
    // Printer limits live on the scene, not in per-object process overrides. An out-of-band
    // value makes BambuStudio discard the entire profile instead of clamping that sample.
    const stated = state?.plates.find((plate) => plate.index === activePlateIndex)?.layerHeightLimits
    return editorLayerHeightBounds(stated, nozzleDiameter)
  }, [state, activePlateIndex, nozzleDiameter])

  useEffect(() => {
    const group = target ? groupsRef.current.get(target.key) : null
    if (!group || !target) return
    const instance = state?.plates.flatMap((plate) => plate.instances)
      .find((entry) => entry.key === target.key)
    if (!instance) return
    const box = printableMeshBox(group)
    if (!(box.max.z - box.min.z > 0)) return
    // Idempotent: state changes after rebuild, undo, or a plate switch repaint the overlay.
    syncLayerHeightVisuals(group, {
      box,
      profile: effectiveLayerHeightProfile(state, instance),
      bounds: layerHeightBounds,
      nominalHeight,
      brush
    })
  }, [target, state, layerHeightBounds, nominalHeight, brush, groupsRef])

  const openLayerHeightFor = useCallback((key: string) => {
    const instance = stateRef.current?.plates
      .flatMap((plate) => plate.instances).find((entry) => entry.key === key)
    const hostId = instance ? addedPartHostId(instance) : null
    if (!instance || hostId == null) return
    setTarget({ key, objectId: hostId, name: instance.name })
    setMode('layerHeight')
  }, [stateRef, setTarget, setMode])

  return { setObjectHeightRanges, setObjectLayerHeightProfile, layerHeightBounds, openLayerHeightFor }
}
