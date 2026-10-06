/**
 * Owns direct prime-tower dragging on an editor plate.
 *
 * The tower has no selection gizmo. Keep its footprint inside the bed and outside exclusion
 * zones during movement, then commit the tower's corner coordinates on release.
 */
import * as THREE from 'three'
import { footprintHitsExcludeZones } from '../editorGeometry'
import type { EditorPlate } from './editorModel'

export interface EditorPrimeTowerDragOptions {
  getBed: () => EditorPlate['bed'] | null
  commitPosition: (x: number, y: number) => void
}

/** Return per-mount tower-drag state; pointer capture remains with the viewport. */
export function createEditorPrimeTowerDrag(options: EditorPrimeTowerDragOptions) {
  const { getBed, commitPosition } = options
  const offset = new THREE.Vector3()
  let tower: THREE.Object3D | null = null

  return {
    get active() { return tower !== null },

    /** Capture the press offset from the tower's centre. */
    begin(nextTower: THREE.Object3D, point: THREE.Vector3) {
      tower = nextTower
      offset.set(nextTower.position.x - point.x, nextTower.position.y - point.y, 0)
    },

    /** Move the centre within bed bounds, sliding along blocked zone edges. */
    move(point: THREE.Vector3): boolean {
      if (!tower) return false
      const halfW = (typeof tower.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0) / 2
      const halfD = (typeof tower.userData.towerDepth === 'number' ? tower.userData.towerDepth : 0) / 2
      let centerX = point.x + offset.x
      let centerY = point.y + offset.y
      const bed = getBed()
      if (bed) {
        centerX = THREE.MathUtils.clamp(centerX, bed.minX + halfW, bed.maxX - halfW)
        centerY = THREE.MathUtils.clamp(centerY, bed.minY + halfD, bed.maxY - halfD)
        const blocked = (cx: number, cy: number) =>
          footprintHitsExcludeZones(cx - halfW, cx + halfW, cy - halfD, cy + halfD, bed.excludeAreas)
        if (blocked(centerX, tower.position.y)) centerX = tower.position.x
        if (blocked(centerX, centerY)) centerY = tower.position.y
      }
      tower.position.x = centerX
      tower.position.y = centerY
      return true
    },

    /** Commit the tower's corner, even after a selection-only click. */
    finish(): boolean {
      if (!tower) return false
      const width = typeof tower.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0
      const depth = typeof tower.userData.towerDepth === 'number' ? tower.userData.towerDepth : width
      commitPosition(tower.position.x - width / 2, tower.position.y - depth / 2)
      tower = null
      return true
    }
  }
}
