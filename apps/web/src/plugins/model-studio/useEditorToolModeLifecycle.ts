/**
 * Keeps selection-bound editor tools and their temporary visuals in step with
 * the active mode. The editor owns the state and scene refs; this hook owns the
 * transitions that must run regardless of how selection or mode changed.
 */
import { useEffect, type MutableRefObject } from 'react'
import type * as THREE from 'three'
import { removeLayerHeightVisuals } from './lib/layerHeightOverlay'
import {
  isSelectionOnlyGizmoMode,
  RESTING_GIZMO_MODE,
  type GizmoMode
} from './editorGeometry'

interface ToolModeLifecycleOptions {
  mode: GizmoMode
  setMode: (mode: GizmoMode) => void
  selectedKey: string | null
  previousSelectedKeyRef: MutableRefObject<string | null>
  layerHeightTarget: { key: string } | null
  clearLayerHeight: (value: null) => void
  clearLayerHeightBrush: (value: null) => void
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  textPartKey: string | null
  textHostKey: string | null
  textSettleRef: MutableRefObject<number | undefined>
  clearTextPart: (value: null) => void
  clearTextHost: (value: null) => void
}

/** Reset abandoned tools and remove visuals when a mode or target changes. */
export function useEditorToolModeLifecycle({
  mode,
  setMode,
  selectedKey,
  previousSelectedKeyRef,
  layerHeightTarget,
  clearLayerHeight,
  clearLayerHeightBrush,
  groupByKeyRef,
  textPartKey,
  textHostKey,
  textSettleRef,
  clearTextPart,
  clearTextHost
}: ToolModeLifecycleOptions): void {
  // A selection-only mode has no panel or gizmo after deselection. Text differs:
  // it can start on an empty plate, but an actual deselection closes it.
  useEffect(() => {
    if (!selectedKey && isSelectionOnlyGizmoMode(mode)) {
      setMode(RESTING_GIZMO_MODE)
    }
    if (mode === 'text' && previousSelectedKeyRef.current != null && selectedKey == null) {
      setMode(RESTING_GIZMO_MODE)
    }
    previousSelectedKeyRef.current = selectedKey
  }, [mode, selectedKey, previousSelectedKeyRef, setMode])

  // Leaving Variable Layers closes its panel even through keyboard or Escape.
  useEffect(() => {
    if (mode !== 'layerHeight' && layerHeightTarget) {
      clearLayerHeight(null)
      clearLayerHeightBrush(null)
    }
  }, [mode, layerHeightTarget, clearLayerHeight, clearLayerHeightBrush])

  // Leaving Text cancels the delayed reseat before it can commit an edit later.
  useEffect(() => {
    if (mode === 'text' || (textPartKey == null && textHostKey == null)) return
    window.clearTimeout(textSettleRef.current)
    clearTextPart(null)
    clearTextHost(null)
  }, [mode, textPartKey, textHostKey, textSettleRef, clearTextPart, clearTextHost])

  // Capture the ref object, then inspect its current group at teardown. A scene
  // rebuild can replace the map and the old group before a target switch.
  useEffect(() => {
    const key = layerHeightTarget?.key
    if (!key) return
    const groups = groupByKeyRef
    return () => {
      const group = groups.current.get(key)
      if (group) removeLayerHeightVisuals(group)
    }
  }, [layerHeightTarget?.key, groupByKeyRef])
}
