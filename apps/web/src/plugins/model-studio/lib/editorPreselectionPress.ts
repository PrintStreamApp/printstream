/**
 * Routes a viewport press through active tools and the prime tower before object selection.
 * Cut connector mode consumes misses to preserve the connector set; brim ears fall through
 * on misses so the user can select another object. The viewport owns the live tool refs.
 */
import * as THREE from 'three'
import type { OrbitControls } from 'three-stdlib'
import { allowsSelectionPicking, paintChannelForGizmoMode, type GizmoMode } from '../editorGeometry'
import { pickBrimEarEdit, type BrimEarPick } from './editorObjectPicking'
import { pickCutConnectorEdit, type CutConnectorEdit, type CutConnectorTargets } from './editorCutConnectorPicking'

interface PreselectionPressOptions {
  event: PointerEvent
  mode: GizmoMode
  gizmoAxis: string | null | undefined
  cutConnectorMode: boolean
  cutConnectorTargets: CutConnectorTargets
  editCutConnector: (edit: CutConnectorEdit) => void
  getSelectedGroup: () => THREE.Group | null
  hitOnSelected: (event: PointerEvent) => { point: THREE.Vector3 } | null
  editBrimEar: (edit: BrimEarPick) => void
  beginMeasure: (event: PointerEvent) => void
  beginPaint: (event: PointerEvent) => boolean
  beginText: (event: PointerEvent) => boolean
  tower: THREE.Object3D | null
  beginTowerDrag: (tower: THREE.Object3D, point: THREE.Vector3) => void
  aimPointerRay: (event: PointerEvent) => void
  raycaster: THREE.Raycaster
  bedPlane: THREE.Plane
  dragPoint: THREE.Vector3
  canvas: Pick<HTMLCanvasElement, 'setPointerCapture'>
  orbit: Pick<OrbitControls, 'enabled'>
}

/** Return true when this press must not reach object selection. */
export function handleEditorPreselectionPress(options: PreselectionPressOptions): boolean {
  const {
    event, mode, gizmoAxis, cutConnectorMode, cutConnectorTargets, editCutConnector,
    getSelectedGroup, hitOnSelected, editBrimEar, beginMeasure, beginPaint, beginText,
    tower, beginTowerDrag, aimPointerRay, raycaster, bedPlane, dragPoint, canvas, orbit
  } = options

  if (event.button !== 0 || gizmoAxis) return true

  // Measurement resolves a motionless click on release. Selection and drags stay suspended.
  if (mode === 'measure') {
    beginMeasure(event)
    return true
  }

  if (mode === 'cut' && cutConnectorMode) {
    aimPointerRay(event)
    const edit = pickCutConnectorEdit(raycaster, cutConnectorTargets)
    if (edit) editCutConnector(edit)
    return true
  }

  if (mode === 'brimEars') {
    const selectedGroup = getSelectedGroup()
    if (selectedGroup) {
      const meshHit = hitOnSelected(event) // Also aims the shared raycaster.
      const edit = pickBrimEarEdit(raycaster, selectedGroup, meshHit)
      if (edit) {
        editBrimEar(edit)
        return true
      }
    }
  }

  if (paintChannelForGizmoMode(mode) !== null && beginPaint(event)) return true
  if (mode === 'text' && beginText(event)) return true

  // The tower is never selectable and has no gizmo. It remains directly draggable in resting
  // and transform modes, while picking tools must not move it under their own click or stroke.
  if (allowsSelectionPicking(mode) && tower) {
    aimPointerRay(event)
    if (raycaster.intersectObject(tower, true).length > 0
      && raycaster.ray.intersectPlane(bedPlane, dragPoint)) {
      beginTowerDrag(tower, dragPoint)
      orbit.enabled = false
      canvas.setPointerCapture(event.pointerId)
      return true
    }
  }

  return false
}
