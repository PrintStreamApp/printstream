/**
 * Adds any newly staged model to the active editor plate. Imports, primitives, cut halves, and
 * standalone Text use this shared placement gate so material and collision rules cannot drift.
 */
import * as THREE from 'three'
import { toast } from '../../../lib/toast'
import { printableMeshBox } from '../editorGeometry'
import {
  findFreePlatePosition,
  type EditorInstance,
  type EditorPlate,
  type EditorState,
  type PlateFootprintRect
} from './editorModel'

export interface EditorInstanceFootprint {
  /** XY centre in the new model's own mesh coordinates. */
  center: { x: number; y: number }
  /** XY dimensions in mm. */
  size: { width: number; depth: number }
}

export interface EditorInstanceInsertionOptions {
  instance: EditorInstance
  footprint?: EditorInstanceFootprint
  recordHistory?: boolean
  projectFilamentCount: number
  activePlateIndex: number
  state: EditorState | null
  groups: ReadonlyMap<string, THREE.Group>
  updatePlates: (
    updater: (plates: EditorPlate[]) => EditorPlate[],
    kind: 'structure',
    options: { recordHistory?: boolean }
  ) => void
  selectInstance: (key: string) => void
}

/**
 * Place the mesh centre, not its local origin, at a free bed spot. Returns false before any state
 * mutation when the project has no material, matching the shared add-object guard.
 */
export function insertEditorInstance(options: EditorInstanceInsertionOptions): boolean {
  if (options.projectFilamentCount === 0) {
    toast.error('Add a material to the project before adding objects.')
    return false
  }

  const plate = options.state?.plates.find((entry) => entry.index === options.activePlateIndex)
  if (plate) {
    const occupied: PlateFootprintRect[] = []
    for (const placed of plate.instances) {
      const group = options.groups.get(placed.key)
      if (!group) continue
      const box = printableMeshBox(group, false)
      if (!box.isEmpty()) {
        occupied.push({ minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y })
      }
    }

    const spot = findFreePlatePosition(plate, {
      size: options.footprint?.size,
      occupied: occupied.length > 0 ? occupied : undefined
    })
    // Imported meshes retain file coordinates, often with the origin at a corner. Primitives are
    // already centred, so subtracting their near-zero centroid changes nothing.
    options.instance.position.set(
      spot.x - (options.footprint?.center.x ?? 0),
      spot.y - (options.footprint?.center.y ?? 0),
      options.instance.position.z
    )
  }

  options.updatePlates(
    (plates) => plates.map((entry) => entry.index === options.activePlateIndex
      ? { ...entry, instances: [...entry.instances, options.instance] }
      : entry
    ),
    'structure',
    { recordHistory: options.recordHistory }
  )
  options.selectInstance(options.instance.key)
  return true
}
