/**
 * Applies object-selection policy before part drill-down or tool actions. Empty-space clicks,
 * additive toggles, multi-selection collapse, and a newly selected object's Move drag all have
 * different release behavior; the viewport supplies live mode and drag controllers.
 */
import * as THREE from 'three'
import type { OrbitControls } from 'three-stdlib'
import { allowsSelectionPicking, RESTING_GIZMO_MODE, type GizmoMode } from '../editorGeometry'

interface ObjectPointerPressOptions {
  event: PointerEvent
  group: THREE.Group | null
  selectedKey: string | null
  extraSelectedKeys: ReadonlyArray<string>
  getMode: () => GizmoMode
  setMode: (mode: GizmoMode) => void
  beginEmptyClick: (event: PointerEvent) => void
  beginCollapseClick: (key: string, event: PointerEvent) => void
  toggleAdditiveSelection: (key: string) => void
  selectExclusive: (key: string) => void
  raycaster: THREE.Raycaster
  bedPlane: THREE.Plane
  dragPoint: THREE.Vector3
  resetPanelSync: () => void
  beginBodyDrag: (group: THREE.Group, point: THREE.Vector3) => void
  beginCoDrag: (key: string, point: THREE.Vector3) => void
  canvas: Pick<HTMLCanvasElement, 'setPointerCapture'>
  orbit: Pick<OrbitControls, 'enabled'>
}

/** Return true when selection owns the press and later part/tool handlers must not run. */
export function handleEditorObjectPointerPress(options: ObjectPointerPressOptions): boolean {
  const {
    event, group, selectedKey, extraSelectedKeys, getMode, setMode,
    beginEmptyClick, beginCollapseClick, toggleAdditiveSelection, selectExclusive,
    raycaster, bedPlane, dragPoint, resetPanelSync, beginBodyDrag, beginCoDrag,
    canvas, orbit
  } = options

  if (!group) {
    // Clear only on a motionless release; an empty-space orbit keeps the selection.
    beginEmptyClick(event)
    return true
  }

  const key = group.userData.instanceKey
  const wasSelected = typeof key === 'string' && key === selectedKey
  const wasExtra = typeof key === 'string' && extraSelectedKeys.includes(key)
  if (typeof key === 'string' && (event.ctrlKey || event.metaKey)) {
    toggleAdditiveSelection(key)
    return true
  }

  if (typeof key === 'string' && wasExtra) {
    // Even a resting, Rotate, or Scale press keeps the set. Only Move may drag it.
    if (!allowsSelectionPicking(getMode())) {
      selectExclusive(key)
      return true
    }
    beginCollapseClick(key, event)
    if (getMode() === 'translate' && raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
      resetPanelSync()
      beginBodyDrag(group, dragPoint)
      beginCoDrag(key, dragPoint)
      orbit.enabled = false
      canvas.setPointerCapture(event.pointerId)
    }
    return true
  }

  if (typeof key === 'string') {
    if (wasSelected && extraSelectedKeys.length > 0) {
      beginCollapseClick(key, event)
    } else {
      selectExclusive(key)
    }
  }

  if (!wasSelected) {
    // A picking tool acts on one selected object. Re-read the live mode after reset; the
    // viewport setter updates its ref, and a reset must not start an accidental Move drag.
    if (!allowsSelectionPicking(getMode())) setMode(RESTING_GIZMO_MODE)
    if (getMode() !== 'translate') return true
    if (raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
      resetPanelSync()
      beginBodyDrag(group, dragPoint)
      orbit.enabled = false
      canvas.setPointerCapture(event.pointerId)
    }
    return true
  }

  return false
}
