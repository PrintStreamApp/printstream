/**
 * Computes the last printable layer that still needs a purge tower. Geometry and material usage
 * come from the live scene; a baked plate index only supplies materials with no own mesh, such as
 * support. Source plate identity is stable when the user reorders live plates.
 *
 * BambuStudio excludes modifiers from the instance bounding box, so helper volumes do not extend
 * the tower. Above the second-tallest material only one material prints and no purge is needed.
 */
import * as THREE from 'three'
import type { LibraryThreeMfPrimeTower } from '@printstream/shared'
import { threeMfPartSubtypeCarriesFilament } from '@printstream/shared'
import { printableMeshBox } from '../editorGeometry'
import { addedPartHostId, effectiveFilamentChanges, type EditorState } from './editorModel'
import { collectColorPaintFilamentIds } from './supportPaint'

interface BakedPlateMaterials {
  index: number
  filaments: ReadonlyArray<{ id: number }>
}

/**
 * Mirror BambuStudio's project-wide tower gate. Smooth timelapse or wrapping can force a tower;
 * otherwise spiral mode suppresses the multi-filament tower. Per-plate material usage is not the
 * gate because a single-material plate in a multi-material project still slices with a tower.
 */
export function shouldShowEditorPrimeTower(tower: LibraryThreeMfPrimeTower | null, projectFilamentCount: number): boolean {
  if (!tower) return false
  if (tower.sizing.needWipeTower) return true
  return !tower.sizing.spiralMode && projectFilamentCount > 1
}

/**
 * End the tower at the second-tallest material or last layer change, whichever is higher.
 * Helper volumes never extend printable height. A source material lacking its own mesh can purge
 * anywhere on the plate, so it conservatively keeps the tower to the printable top.
 */
export function computeEditorPrimeTowerHeight(
  state: EditorState | null,
  groups: ReadonlyMap<string, THREE.Group>,
  plateIndex: number,
  bakedPlates: ReadonlyArray<BakedPlateMaterials> = []
): number {
  const plate = state?.plates.find((entry) => entry.index === plateIndex)
  if (!plate) return 0
  const paintByKey = state?.colorPaint ?? {}
  const filamentTop = new Map<number, number>()
  let printableTop = 0

  for (const instance of plate.instances) {
    const group = groups.get(instance.key)
    if (!group) continue
    const box = printableMeshBox(group, false)
    if (box.isEmpty()) continue
    const top = box.max.z
    printableTop = Math.max(printableTop, top)

    // Attribute a material used by a short part to its whole instance height. A slightly tall
    // tower is safe; ending below a real material change is not.
    const ids = new Set<number>()
    if (instance.filamentId != null) ids.add(instance.filamentId)
    for (const part of instance.parts) {
      if (part.filamentId != null && threeMfPartSubtypeCarriesFilament(part.subtype)) {
        ids.add(part.filamentId)
      }
    }
    const hostId = addedPartHostId(instance)
    if (hostId != null) {
      for (const [key, codes] of Object.entries(paintByKey)) {
        if (Number.parseInt(key.split(':')[0] ?? '', 10) !== hostId) continue
        for (const code of Object.values(codes)) collectColorPaintFilamentIds(code, ids)
      }
    }
    for (const id of ids) filamentTop.set(id, Math.max(filamentTop.get(id) ?? 0, top))
  }

  if (printableTop <= 0) return 0
  // The baked index speaks source plate numbers. A live index can drift after reordering, and a
  // newly added plate has no baked source to consult. Support material can purge at any layer.
  const bakedPlate = plate.sourcePlateIndex !== null
    ? bakedPlates.find((entry) => entry.index === plate.sourcePlateIndex)
    : undefined
  for (const filament of bakedPlate?.filaments ?? []) {
    if (!filamentTop.has(filament.id)) return printableTop
  }

  let purgeTop = 0
  for (const change of effectiveFilamentChanges(plate)) purgeTop = Math.max(purgeTop, change.z)
  const tops = [...filamentTop.values()].sort((left, right) => right - left)
  if (tops.length >= 2) purgeTop = Math.max(purgeTop, tops[1]!)
  return Math.min(printableTop, purgeTop)
}
