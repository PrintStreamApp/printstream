/**
 * Owns the primary viewport selection box, including its deferred precise fit and disposal.
 * The scene still decides when to render; this controller only updates the box on those frames.
 * A cheap initial fit stays hidden until the printed mesh bounds have been measured precisely.
 */
import * as THREE from 'three'
import { printableMeshBox, selectionBoxSignature } from '../editorGeometry'
import {
  PRIMARY_SELECTION_STYLE,
  createSelectionBox,
  fitSelectionBox,
  selectionBoxNeedsPreciseBounds
} from './selectionBox'

export interface PrimarySelectionBoxFrame {
  interacting: boolean
  dragJustEnded: boolean
  changedOrientation: boolean
}

/** Return a scene-bound selection-box controller; call `set(null)` before scene disposal. */
export function createEditorPrimarySelectionBox(scene: THREE.Scene) {
  let target: THREE.Object3D | null = null
  let helper: THREE.Box3Helper | null = null
  let signature = ''
  let preciseFitDelay = 0
  const bounds = new THREE.Box3()

  const set = (group: THREE.Object3D | null) => {
    target = group
    if (helper) {
      scene.remove(helper)
      helper.geometry.dispose()
      ;(helper.material as THREE.Material).dispose()
      helper = null
      preciseFitDelay = 0
    }
    if (!group) return

    // The transformed local box is responsive but can be much larger than a rotated mesh.
    fitSelectionBox(bounds, printableMeshBox(group, false))
    signature = selectionBoxSignature(group)
    preciseFitDelay = 2
    helper = createSelectionBox(bounds, PRIMARY_SELECTION_STYLE)
    helper.visible = false
    scene.add(helper)
  }

  /** Fit a rendered frame; return true when the deferred precise fit needs another frame. */
  const update = ({ interacting, dragJustEnded, changedOrientation }: PrimarySelectionBoxFrame): boolean => {
    if (!helper || !target) return false
    const nextSignature = selectionBoxSignature(target)

    // A move's cheap drop fit can be loose on an already rotated model, so upgrade after settling.
    if (dragJustEnded && !changedOrientation) preciseFitDelay = 2
    let upgrade = false
    let wantAnotherFrame = false
    if (preciseFitDelay > 0) {
      if (interacting) {
        preciseFitDelay = 0
      } else {
        preciseFitDelay -= 1
        upgrade = preciseFitDelay === 0
        if (!upgrade) wantAnotherFrame = true
      }
    }
    if (nextSignature !== signature || dragJustEnded || upgrade) {
      signature = nextSignature
      const precise = selectionBoxNeedsPreciseBounds({
        interacting,
        changedOrientation,
        dragJustEnded,
        upgrade
      })
      fitSelectionBox(bounds, printableMeshBox(target, precise))
      if (precise) helper.visible = true
    }
    return wantAnotherFrame
  }

  return {
    set,
    update,
    /** The outline owner participates in the selection overlay only once its fit is visible. */
    visibleOwner: () => helper?.visible ? target : null
  }
}
