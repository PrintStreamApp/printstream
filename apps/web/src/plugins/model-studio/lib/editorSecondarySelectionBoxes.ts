/**
 * Owns the viewport outlines for co-selected objects and selected parts.
 * The frame owner supplies current selection and scene maps; this controller keeps
 * box resources and selection-owner layers in sync, then releases both on teardown.
 * The primary outline remains in editorPrimarySelectionBox.ts.
 */
import * as THREE from 'three'
import {
  isAddedPartMesh,
  isViewportAidMesh,
  partGroupRef,
  printableMeshBox,
  rotorOf
} from '../editorGeometry'
import type { EditorInstance } from './editorModel'
import type { PartRef, PartSelection } from './selectionModel'
import {
  EXTRA_SELECTION_STYLE,
  PRIMARY_SELECTION_STYLE,
  createSelectionBox,
  createSelectionOwnerTracker,
  fitSelectionBox
} from './selectionBox'

export interface SecondarySelectionFrame {
  extraKeys: ReadonlyArray<string>
  groups: ReadonlyMap<string, THREE.Group>
  partSelection: PartSelection | null
  gizmoPart: PartRef | null
  instances: ReadonlyArray<EditorInstance>
  primaryOwner: THREE.Object3D | null
}

/** Keep the secondary selection boxes current for each rendered frame. */
export function createEditorSecondarySelectionBoxes(scene: THREE.Scene) {
  const extraBoxes = new Map<string, THREE.Box3Helper>()
  const partBoxes = new Map<string, THREE.Box3Helper>()
  const owners = createSelectionOwnerTracker()

  /** A removed selection must release its GPU resources before the scene is discarded. */
  const removeBox = (boxes: Map<string, THREE.Box3Helper>, key: string, helper: THREE.Box3Helper) => {
    scene.remove(helper)
    helper.geometry.dispose()
    ;(helper.material as THREE.Material).dispose()
    boxes.delete(key)
  }

  const getBox = (boxes: Map<string, THREE.Box3Helper>, key: string, extra: boolean) => {
    let helper = boxes.get(key)
    if (!helper) {
      helper = createSelectionBox(new THREE.Box3(), extra ? EXTRA_SELECTION_STYLE : PRIMARY_SELECTION_STYLE)
      boxes.set(key, helper)
      scene.add(helper)
    }
    return helper
  }

  const syncExtras = (frame: SecondarySelectionFrame) => {
    for (const [key, helper] of extraBoxes) {
      if (!frame.extraKeys.includes(key) || !frame.groups.has(key)) removeBox(extraBoxes, key, helper)
    }
    for (const key of frame.extraKeys) {
      const group = frame.groups.get(key)
      if (!group) continue
      const helper = getBox(extraBoxes, key, true)
      helper.userData.selectionOwner = group
      // Co-drags use the cheap transformed bounds so outlines track without a vertex walk.
      fitSelectionBox(helper.box, printableMeshBox(group, false))
    }
  }

  const selectedPartOwners = (frame: SecondarySelectionFrame) => {
    const gizmo = frame.gizmoPart
    const selection = frame.partSelection
      ?? (gizmo ? { objectId: gizmo.objectId, members: [gizmo.member] } : null)
    const wanted = new Map<string, THREE.Object3D>()
    const bodies = new Map<string, THREE.Group>()
    if (!selection) return { wanted, bodies }

    // Baked parts use component ordinals; added parts use session keys. Each needs a
    // different scene scan, and a body has no node of its own to select directly.
    const bakedIndexes = selection.members.flatMap((member) => (
      member.kind === 'baked' ? [member.partIndex] : []
    ))
    const addedKeys = new Set(selection.members.flatMap((member) => (
      member.kind === 'added' ? [member.key] : []
    )))
    const wantsBody = selection.members.some((member) => member.kind === 'body')

    for (const instance of frame.instances) {
      const ownerId = instance.source.kind === 'object'
        ? instance.objectId
        : instance.source.replacedObjectId
      if (ownerId !== selection.objectId) continue
      const group = frame.groups.get(instance.key)
      if (!group) continue

      if (bakedIndexes.length > 0) {
        group.traverse((node) => {
          const ref = partGroupRef(node)
          // The ordinal distinguishes volumes that share one underlying mesh id.
          if (ref && bakedIndexes.includes(ref.partIndex)) {
            wanted.set(`${instance.key}:${ref.partIndex}`, node)
          }
        })
      }
      if (addedKeys.size > 0) {
        // Added volumes are direct rotor children. Traversing every decoration here
        // would repeat thousands of visits on each rendered frame.
        for (const node of rotorOf(group).children) {
          const addedKey = node.userData.addedPartKey
          if (typeof addedKey === 'string' && addedKeys.has(addedKey)) {
            wanted.set(`${instance.key}:added:${addedKey}`, node)
          }
        }
      }
      if (wantsBody) bodies.set(`${instance.key}:body`, group)
    }
    return { wanted, bodies }
  }

  const syncParts = (frame: SecondarySelectionFrame) => {
    const { wanted, bodies } = selectedPartOwners(frame)
    for (const [key, helper] of partBoxes) {
      if (!wanted.has(key) && !bodies.has(key)) removeBox(partBoxes, key, helper)
    }

    // Several selected parts share one owner-depth buffer, so their siblings would
    // hide each other's outlines. Draw the set on top; keep depth for a single part.
    const depthTest = wanted.size + bodies.size <= 1
    for (const [key, partGroup] of wanted) {
      const helper = getBox(partBoxes, key, false)
      helper.userData.selectionOwner = partGroup
      ;(helper.material as THREE.LineBasicMaterial).depthTest = depthTest
      fitSelectionBox(helper.box, new THREE.Box3().setFromObject(partGroup))
    }
    for (const [key, group] of bodies) {
      const helper = getBox(partBoxes, key, false)
      // A body is the owner's printed meshes beside its added parts. Fitting the
      // whole group would swallow the added volume that this box distinguishes.
      const box = new THREE.Box3()
      group.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh || isViewportAidMesh(mesh) || isAddedPartMesh(mesh)) return
        box.expandByObject(mesh)
      })
      helper.userData.selectionOwner = group
      ;(helper.material as THREE.LineBasicMaterial).depthTest = depthTest
      if (!box.isEmpty()) fitSelectionBox(helper.box, box)
    }
  }

  const sync = (frame: SecondarySelectionFrame) => {
    syncExtras(frame)
    syncParts(frame)
    const nextOwners = new Set<THREE.Object3D>()
    if (frame.primaryOwner) nextOwners.add(frame.primaryOwner)
    for (const helper of extraBoxes.values()) {
      const owner = helper.userData.selectionOwner as THREE.Object3D | undefined
      if (owner) nextOwners.add(owner)
    }
    for (const helper of partBoxes.values()) {
      const owner = helper.userData.selectionOwner as THREE.Object3D | undefined
      if (owner) nextOwners.add(owner)
    }
    owners.sync(nextOwners)
  }

  const dispose = () => {
    owners.dispose()
    for (const [key, helper] of extraBoxes) removeBox(extraBoxes, key, helper)
    for (const [key, helper] of partBoxes) removeBox(partBoxes, key, helper)
  }

  return {
    sync,
    dispose,
    get active(): boolean { return owners.active }
  }
}
