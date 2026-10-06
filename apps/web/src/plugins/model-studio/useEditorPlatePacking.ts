/**
 * Owns the editor's two automatic plate-packing gestures.
 *
 * Reads live scene footprints and nozzle constraints at invocation time. `updatePlates` remains the
 * session's history and viewport-sync owner: arranging is a transform edit, while adding linked
 * copies is a structure edit. No scene objects or listeners are owned here.
 */
import { useCallback, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { arrangePlateItems, planFillBedCopies } from './lib/arrange'
import { computePlateObstacles } from './lib/plateObstacles'
import { duplicateInstance, placeInstanceAt, type EditorInstance, type EditorPlate, type EditorState } from './lib/editorModel'
import { computeFootprintCells, rasterizePolygonCells, zoneRequiredNozzle } from './editorGeometry'
import { toast } from '../../lib/toast'

/** Shared clearance for Auto-arrange and Fill bed so they agree about what fits. */
const PLATE_PACKING_GAP_MM = 6

interface EditorPlatePackingOptions {
  activePlateIndex: number
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  primeTowerObjRef: MutableRefObject<THREE.Object3D | null>
  instanceNozzlesRef: MutableRefObject<(instance: EditorInstance) => Set<number>>
  updatePlates: (updater: (plates: EditorPlate[]) => EditorPlate[], kind?: 'structure' | 'transform') => void
}

/** Return the two history-aware plate gestures while keeping scene refs at their existing owner. */
export function useEditorPlatePacking({
  activePlateIndex,
  stateRef,
  groupByKeyRef,
  primeTowerObjRef,
  instanceNozzlesRef,
  updatePlates
}: EditorPlatePackingOptions) {
  /**
   * Read the plate's packing constraints out of the LIVE scene: which zones bar which nozzle, and
   * where the prime tower currently stands (its size depends on the plate's filament count and
   * tallest object, so it is measured off the rendered object rather than the plate record).
   *
   * `demandingInstances` are the objects whose nozzle reach must be honoured: every instance for
   * Auto-arrange, which moves them all, but only the copied object for Fill bed, since nothing
   * already placed moves and a neighbour's reach is therefore not this operation's problem.
   */
  const plateObstaclesFor = useCallback((plate: EditorPlate, demandingInstances: ReadonlyArray<EditorInstance>) => {
    const tower = primeTowerObjRef.current
    const towerCenter = tower ? tower.getWorldPosition(new THREE.Vector3()) : null
    return computePlateObstacles({
      bed: plate.bed,
      zones: plate.bed.excludeAreas.map((zone) => ({
        polygon: zone.polygon,
        requiredNozzle: zoneRequiredNozzle(zone.label)
      })),
      nozzleDemands: demandingInstances.map((instance) => instanceNozzlesRef.current(instance)),
      primeTower: tower && towerCenter
        ? {
            centerX: towerCenter.x,
            centerY: towerCenter.y,
            width: typeof tower.userData.towerWidth === 'number' ? tower.userData.towerWidth : 0,
            depth: typeof tower.userData.towerDepth === 'number' ? tower.userData.towerDepth : 0
          }
        : null,
      rasterizePolygon: rasterizePolygonCells
    })
  }, [instanceNozzlesRef, primeTowerObjRef])

  /**
   * Auto-arrange: pack the active plate's models centre-out by their TRUE rasterized
   * footprints (the placement-warning grid), so concave parts nest instead of
   * reserving their whole bounding box. The usable area shrinks to what every
   * object's nozzle can reach; unprintable zones and the prime tower are blocked
   * cells. Items that cannot fit stay where they are and are reported.
   */
  const handleArrangeAll = useCallback(() => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate || plate.instances.length === 0) return
    // A locked plate keeps its layout. Mirrors BambuStudio, whose arrange skips every object on a
    // locked plate (`PartPlate.cpp:6046`). The toolbar button is disabled too, so this guard is
    // belt-and-braces rather than the only stop: it keeps the rule with the operation, where a
    // future caller (a shortcut, a context-menu item, a batch action) will find it.
    if (plate.locked) return
    const items: Array<{ key: string; cells: number[] }> = []
    for (const instance of plate.instances) {
      const group = groupByKeyRef.current.get(instance.key)
      if (!group) continue
      const cells = computeFootprintCells(group)
      if (cells.size === 0) continue
      items.push({ key: instance.key, cells: [...cells] })
    }
    if (items.length === 0) return

    // Every object on the plate moves, so every object's nozzle reach constrains the usable area.
    const obstacles = plateObstaclesFor(plate, plate.instances)
    const result = arrangePlateItems(items, {
      bed: obstacles.safeArea,
      blockedCells: obstacles.blockedCells,
      spacingMm: PLATE_PACKING_GAP_MM
    })
    if (result.moves.size === 0) {
      toast.error('No room to arrange the objects on this plate.')
      return
    }
    updatePlates((plates) => plates.map((entry) => entry.index !== activePlateIndex ? entry : {
      ...entry,
      instances: entry.instances.map((instance) => {
        const move = result.moves.get(instance.key)
        if (!move) return instance
        const position = instance.position.clone()
        position.x += move.dx
        position.y += move.dy
        // Moving a shearing object bakes it to T·S·R (drop the exact matrix) so it renders/saves
        // at its new position rather than the original baked-in one.
        return { ...instance, position, exactMatrix: undefined }
      })
    }), 'transform')
    if (result.unplaced.length > 0) {
      toast.error(`${result.unplaced.length} model${result.unplaced.length === 1 ? '' : 's'} did not fit and stayed in place.`)
    }
  }, [activePlateIndex, groupByKeyRef, plateObstaclesFor, stateRef, updatePlates])

  /**
   * BambuStudio's "Fill bed with copies" (`FillBedJob`): fill the plate's remaining space with
   * copies of the selected object, packing centre-out around whatever is already there. Nothing
   * already placed moves: this ADDS to a layout rather than redoing it, which is what separates
   * it from Auto-arrange.
   *
   * We deliberately diverge from Studio on ONE point: its `ap.setter` calls `Model::add_object`,
   * so every copy is a whole new object and each one carries its own duplicate of the source's
   * per-object process overrides; edit the original afterwards and the copies do not follow.
   * Ours adds linked INSTANCES against the same `objectId` (the `Duplicate` path), so all copies
   * share one object's parts, materials, paint and overrides, and the sidebar's `xN` badge makes
   * the linkage visible. That is issue #89's "add instances" note, and it is also why the copies
   * cost nothing extra in the saved 3MF: they are extra build items, not extra meshes.
   */
  const handleFillBedWithCopies = useCallback((key: string) => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    const template = plate?.instances.find((entry) => entry.key === key)
    if (!plate || !template) return
    // A locked plate keeps its layout, and that has to mean every AUTOMATIC placement, not just
    // Auto-arrange: filling the bed drops new copies onto it, which is the same promise broken.
    if (plate.locked) {
      toast.error('This plate is locked. Unlock it in plate settings to fill it with copies.')
      return
    }
    const templateGroup = groupByKeyRef.current.get(template.key)
    const templateFootprint = templateGroup ? computeFootprintCells(templateGroup) : null
    if (!templateFootprint || templateFootprint.size === 0) {
      toast.error('That model has no printable footprint to copy.')
      return
    }

    // Everything on the plate holds its ground, so every footprint is an obstacle: the template's
    // own instance included, or the first copy would be planned on top of it.
    const occupiedFootprints: number[][] = []
    for (const instance of plate.instances) {
      const group = groupByKeyRef.current.get(instance.key)
      if (!group) continue
      const cells = computeFootprintCells(group)
      if (cells.size > 0) occupiedFootprints.push([...cells])
    }

    // Only the copied object's reach constrains the area: the objects already down are staying put
    // whatever their materials need.
    const obstacles = plateObstaclesFor(plate, [template])
    const offsets = planFillBedCopies({
      bed: obstacles.safeArea,
      blockedCells: obstacles.blockedCells,
      spacingMm: PLATE_PACKING_GAP_MM,
      templateFootprint: [...templateFootprint],
      occupiedFootprints
    })
    if (offsets.length === 0) {
      toast.error('No room on this plate for another copy.')
      return
    }

    // The copies are new instances with no live group. A structure sync rebuilds them; a
    // transform sync would leave them invisible until a later rebuild.
    updatePlates((plates) => plates.map((entry) => {
      if (entry.index !== activePlateIndex) return entry
      const source = entry.instances.find((instance) => instance.key === template.key)
      if (!source) return entry
      const copies = offsets.map((offset) => {
        const clone = duplicateInstance(source)
        // `duplicateInstance` nudges its copy clear of the source; the planner already decided
        // where this one goes, so place it outright rather than composing with that nudge.
        // Through `placeInstanceAt`, because a copy KEEPS a sheared object's exact matrix (that
        // matrix is what renders and saves, so dropping it would reshape the copy) and the matrix
        // carries the translation `position` only mirrors.
        placeInstanceAt(clone, source.position.x + offset.dx, source.position.y + offset.dy)
        return clone
      })
      return { ...entry, instances: [...entry.instances, ...copies] }
    }), 'structure')
    toast.success(`Added ${offsets.length} cop${offsets.length === 1 ? 'y' : 'ies'} to fill the plate.`)
  }, [activePlateIndex, groupByKeyRef, plateObstaclesFor, stateRef, updatePlates])

  return { handleArrangeAll, handleFillBedWithCopies }
}
