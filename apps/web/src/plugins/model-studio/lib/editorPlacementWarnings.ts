/**
 * Recomputes editor placement warnings from one viewport's live plate and scene refs.
 *
 * Translation shifts cached raster cells. A changed rotor shape or rebuilt group rasterizes again,
 * so warnings cannot keep the old footprint after a rotation or scene rebuild. The caller decides
 * when recomputation is safe during interaction and owns warning state and viewport teardown.
 */
import type { MutableRefObject } from 'react'
import * as THREE from 'three'
import {
  computeFootprintCells,
  computePlacementWarnings,
  groupShapeSignature,
  type PlacementWarning
} from '../editorGeometry'
import { FOOTPRINT_CELL_MM, shiftFootprintCells } from './arrange'
import type { EditorInstance, EditorPlate } from './editorModel'

export type PlacementFootprintCache = Map<string, {
  group: THREE.Group
  shapeSig: string
  cells: Set<number>
  baseX: number
  baseY: number
}>

interface PlacementWarningOptions {
  activePlateRef: MutableRefObject<EditorPlate | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  isInstancePrintedRef: MutableRefObject<(instance: EditorInstance) => boolean>
  instanceNozzlesRef: MutableRefObject<(instance: EditorInstance) => Set<number>>
  footprintCacheRef: MutableRefObject<PlacementFootprintCache>
  primeTowerObjRef: MutableRefObject<THREE.Object3D | null>
  lastWarningSigRef: MutableRefObject<string>
  placementWarningsSetterRef: MutableRefObject<(warnings: PlacementWarning[]) => void>
}

/** Read the live prime tower footprint after a drag or plate rebuild. */
function primeTowerRect(tower: THREE.Object3D | null) {
  if (!tower) return null
  const halfW = (typeof tower.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0) / 2
  const halfD = (typeof tower.userData.towerDepth === 'number' ? tower.userData.towerDepth : 0) / 2
  if (halfW <= 0 || halfD <= 0) return null
  const center = tower.getWorldPosition(new THREE.Vector3())
  return { minX: center.x - halfW, maxX: center.x + halfW, minY: center.y - halfD, maxY: center.y + halfD }
}

/** Get printed footprints, rasterizing only after a shape or group identity change. */
function footprintsForPlate(
  plate: EditorPlate,
  groups: Map<string, THREE.Group>,
  isPrinted: (instance: EditorInstance) => boolean,
  cache: PlacementFootprintCache
): Map<string, Set<number>> {
  const footprints = new Map<string, Set<number>>()
  for (const instance of plate.instances) {
    const group = groups.get(instance.key)
    if (!group || !isPrinted(instance)) continue

    // Rasterization is O(triangles). A pure move can shift the original cells in O(cells), but
    // rotation, scaling, or replacing a group invalidates the shape and requires a fresh raster.
    const shapeSig = groupShapeSignature(group)
    const cached = cache.get(instance.key)
    let cells: Set<number>
    if (cached?.group === group && cached.shapeSig === shapeSig) {
      const dCellX = Math.round((group.position.x - cached.baseX) / FOOTPRINT_CELL_MM)
      const dCellY = Math.round((group.position.y - cached.baseY) / FOOTPRINT_CELL_MM)
      cells = shiftFootprintCells(cached.cells, dCellX, dCellY)
    } else {
      cells = computeFootprintCells(group)
      cache.set(instance.key, {
        group,
        shapeSig,
        cells,
        baseX: group.position.x,
        baseY: group.position.y
      })
    }
    footprints.set(instance.key, cells)
  }
  // Removed instances must not pin old scene groups for the rest of the editor session.
  for (const key of cache.keys()) {
    if (!footprints.has(key)) cache.delete(key)
  }
  return footprints
}

/** Return a stable recompute callback whose reads stay live across editor renders. */
export function createEditorPlacementWarningRecompute({
  activePlateRef,
  groupByKeyRef,
  isInstancePrintedRef,
  instanceNozzlesRef,
  footprintCacheRef,
  primeTowerObjRef,
  lastWarningSigRef,
  placementWarningsSetterRef
}: PlacementWarningOptions): () => void {
  return () => {
    const plate = activePlateRef.current
    const warnings = plate
      ? computePlacementWarnings(
        groupByKeyRef.current,
        plate,
        isInstancePrintedRef.current,
        footprintsForPlate(plate, groupByKeyRef.current, isInstancePrintedRef.current, footprintCacheRef.current),
        instanceNozzlesRef.current,
        primeTowerRect(primeTowerObjRef.current)
      )
      : []
    if (!plate) footprintCacheRef.current.clear()

    const signature = JSON.stringify(warnings)
    if (signature === lastWarningSigRef.current) return
    lastWarningSigRef.current = signature
    placementWarningsSetterRef.current(warnings)
  }
}
