/**
 * Owns TransformControls' rotation-snap lifecycle. The editor supplies the
 * current mode and controls ref; only Rotate listens for Shift, and leaving it
 * returns every axis to free movement.
 */
import { useEffect, type MutableRefObject } from 'react'
import type { TransformControls } from 'three-stdlib'
import { ROTATE_SNAP_COARSE, ROTATE_SNAP_FINE, type GizmoMode } from './editorGeometry'

/**
 * three-stdlib types these setters as numbers, but their runtime accepts null
 * to disable snapping, matching upstream three.js.
 */
type TransformControlsSnap = {
  setRotationSnap: (snap: number | null) => void
  setTranslationSnap: (snap: number | null) => void
  setScaleSnap: (snap: number | null) => void
}

/** Apply fine rotation snap by default and coarse snap while Shift is held. */
export function useEditorRotationSnap(
  mode: GizmoMode,
  transformRef: MutableRefObject<TransformControls | null>
): void {
  useEffect(() => {
    const transform = transformRef.current as unknown as TransformControlsSnap | null
    if (!transform) return
    transform.setTranslationSnap(null)
    transform.setScaleSnap(null)
    transform.setRotationSnap(mode === 'rotate' ? ROTATE_SNAP_FINE : null)
  }, [mode, transformRef])

  useEffect(() => {
    if (mode !== 'rotate') return
    const setSnap = (coarse: boolean) => {
      const transform = transformRef.current as unknown as TransformControlsSnap | null
      transform?.setRotationSnap(coarse ? ROTATE_SNAP_COARSE : ROTATE_SNAP_FINE)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Shift') setSnap(true) }
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Shift') setSnap(false) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [mode, transformRef])
}
