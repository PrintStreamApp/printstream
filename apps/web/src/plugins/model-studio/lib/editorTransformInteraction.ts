/**
 * Installs the editor's transform-gizmo event family and owns its drag state.
 *
 * The viewport keeps the TransformControls object and disposes it after this controller removes
 * its listeners. Every editor value is read through a callback so a long-lived mount sees live state.
 */
import * as THREE from 'three'
import type { TransformControls } from 'three-stdlib'
import { createEditorMultiSelectionDrag } from './editorMultiSelectionDrag'
import { partGroupRef, restObjectOnBed, rotorOf, type GizmoMode } from '../editorGeometry'
import type { MultiTransformMode } from './multiSelectionTransform'

/** Custom events dispatched by three-stdlib but absent from its Object3D event map. */
type TransformControlsEvent = { value?: boolean }
type TransformControlsEvents = {
  addEventListener: (type: 'dragging-changed' | 'objectChange', listener: (event: TransformControlsEvent) => void) => void
  removeEventListener: (type: 'dragging-changed' | 'objectChange', listener: (event: TransformControlsEvent) => void) => void
}

export interface EditorTransformInteractionOptions {
  transform: TransformControls
  orbit: { enabled: boolean }
  multiPivot: THREE.Group
  snapGuides: THREE.Object3D
  getSelectedKey: () => string | null
  getSelectedKeys: () => string[]
  groupFor: (key: string) => THREE.Group | null
  getMode: () => GizmoMode
  bakeExactMatrix: (group: THREE.Object3D) => void
  writeBackGroupTransform: (group: THREE.Object3D) => void
  writeBackPartMesh: (part: THREE.Object3D) => void
  syncSelectedTransform: (group: THREE.Object3D) => void
  setRotationReadout: (degrees: number | null) => void
  regenerateActiveThumbnail: () => void
  recordHistory: () => void
  setInteractionActive: (active: boolean) => void
}

/** Install drag/object-change callbacks and return the live status and matching cleanup. */
export function createEditorTransformInteraction(options: EditorTransformInteractionOptions) {
  const {
    transform, orbit, multiPivot, snapGuides, getSelectedKey, getSelectedKeys,
    groupFor, getMode, bakeExactMatrix, writeBackGroupTransform, writeBackPartMesh,
    syncSelectedTransform, setRotationReadout, regenerateActiveThumbnail,
    recordHistory, setInteractionActive
  } = options
  const transformEvents = transform as unknown as TransformControlsEvents
  const selectedOuterGroup = (): THREE.Group | null => {
    const key = getSelectedKey()
    return key ? groupFor(key) ?? null : null
  }
  // Mirroring the live transform into the manual-input panel is a React state update,
  // so doing it every gizmo/pointer frame re-renders the editor ~60x/sec. The 3D object
  // is mutated directly (the viewport stays smooth regardless), and every drag path
  // force-syncs the exact final values on release, so the panel can lag slightly mid-drag.
  // Throttle it to ~20 updates/sec to keep manipulation responsive on large scenes.
  const PANEL_SYNC_EVERY = 3
  let panelSyncTick = 0
  // True while a transform gizmo (move/rotate/scale) is being dragged. Combined with the
  // viewport's body- and tower-drag state, it lets the validation loop skip its expensive
  // placement-warning recompute mid-drag and run it once when the drag finishes.
  let gizmoDragging = false
  // Did the drag that just ended change the object's ORIENTATION (rotate/scale)? It decides which
  // way the drop frame pays: a rotate/scale takes the per-vertex walk there and then, while a pure
  // move takes the cheap transformed-AABB and lets the delayed upgrade tighten it. Not because a
  // move leaves the box exact (it does not -- a cheap fit of an already-rotated object is the AABB
  // of a rotated AABB), but because deferring keeps the walk out of the gesture, which is what
  // stopped every drop of a high-poly / many-part object freezing for a beat.
  let lastDragChangedOrientation = false
  const throttledPanelSync = (group: THREE.Object3D) => {
    panelSyncTick += 1
    if (panelSyncTick % PANEL_SYNC_EVERY === 0) syncSelectedTransform(group)
  }

  /** The part the gizmo is attached to: an added part volume's mesh or a baked part's group. */
  const attachedPartMesh = (): THREE.Object3D | null => {
    const target = (transform as unknown as { object?: THREE.Object3D }).object
    return target && (typeof target.userData.addedPartKey === 'string' || partGroupRef(target)) ? target : null
  }

  // Studio's drag-start snapshot semantics, with two deliberate divergences: no Alt
  // independent-member mode, and unselected linked siblings keep their own placements.
  const multiDrag = createEditorMultiSelectionDrag({
    proxy: multiPivot,
    selectedKeys: () => getSelectedKeys(),
    groupFor: (key) => groupFor(key) ?? null,
    bakeExactMatrix: (group) => bakeExactMatrix(group),
    writeBack: writeBackGroupTransform
  })

  const attachedToMultiPivot = (): boolean =>
    (transform as unknown as { object?: THREE.Object3D }).object === multiPivot

  const activeMultiMode = (): MultiTransformMode => {
    const mode = getMode()
    return mode === 'rotate' || mode === 'scale' ? mode : 'translate'
  }

  const onDraggingChanged = (event: TransformControlsEvent) => {
    orbit.enabled = !event.value
    const dragging = Boolean(event.value)
    gizmoDragging = dragging
    setInteractionActive(dragging)
    // A rotate/scale gizmo drag reorients the object; a translate gizmo drag does not.
    if (dragging) lastDragChangedOrientation = getMode() === 'rotate' || getMode() === 'scale'
    // Snapshot once at drag start (onObjectChange fires per-frame, so not there).
    if (dragging) {
      panelSyncTick = 0
      recordHistory()
      if (attachedToMultiPivot()) {
        multiDrag.begin()
      } else {
        // Snap a shearing object to editable T·S·R before the drag (it rendered an exact matrix
        // with matrixAutoUpdate off, which the gizmo can't move).
        const outerForBake = selectedOuterGroup()
        if (outerForBake) bakeExactMatrix(outerForBake)
      }
    }
    // Multi-selection drag via the pivot proxy: guides/readout track the PIVOT (where the
    // rotation actually happens), and the end-of-drag choreography runs per member.
    const multiPivotAtPress = multiDrag.pivot()
    if (multiPivotAtPress) {
      if (dragging && getMode() === 'rotate') {
        snapGuides.position.copy(multiPivotAtPress)
        snapGuides.visible = true
        // Relative readout (Studio labels its multi-selection rotate field "Rotate (relative)"
        // and zeroes it at drag start), there is no single absolute angle for N members.
        setRotationReadout(0)
      } else {
        snapGuides.visible = false
        setRotationReadout(null)
      }
      if (!dragging) {
        multiDrag.finish(activeMultiMode())
        const primary = selectedOuterGroup()
        if (primary) syncSelectedTransform(primary)
        regenerateActiveThumbnail()
      }
      return
    }
    // Added part volumes transform freely inside their object: no bed rest, no
    // group write-back, just persist the part's object-local placement.
    const partMesh = attachedPartMesh()
    if (partMesh) {
      snapGuides.visible = false
      setRotationReadout(null)
      if (!dragging) {
        writeBackPartMesh(partMesh)
        // Push the exact final placement to the manual panel (mid-drag syncs are throttled).
        syncSelectedTransform(partMesh)
        regenerateActiveThumbnail()
      }
      return
    }
    const outer = selectedOuterGroup()
    const rotating = dragging && getMode() === 'rotate'
    if (rotating && outer) {
      snapGuides.position.copy(outer.position)
      snapGuides.visible = true
      setRotationReadout(THREE.MathUtils.radToDeg(rotorOf(outer).rotation.z))
    } else {
      snapGuides.visible = false
      setRotationReadout(null)
      if (!dragging) {
        if (outer) {
          // Always re-rest on drag end: scaling/rotating can move the lowest point, so
          // pin the object's bottom back to the bed (no float). Scale also rests every
          // frame (see onObjectChange) so this is a no-op for scale, no release jump.
          restObjectOnBed(outer)
          writeBackGroupTransform(outer)
          syncSelectedTransform(outer)
        }
        regenerateActiveThumbnail()
      }
    }
  }
  transformEvents.addEventListener('dragging-changed', onDraggingChanged)
  // Write the live transform back into state and the manual-input panel as the user
  // drags. Scaling rests the object on the bed every frame so it grows UPWARD from the
  // bed (the bottom never leaves z=0), regardless of which handle (uniform white or a
  // single coloured axis) is used: TransformControls computes scale from the pointer
  // delta, not the object's position, so adjusting z here doesn't perturb the drag.
  const onObjectChange = () => {
    // Multi-selection: the gizmo drives the pivot proxy; apply its delta rigid-body to every
    // member, offsets orbit/scale about the pivot while each member's own orientation/scale
    // composes (Studio's transform_instance_relative). Recomputed from the drag-start
    // snapshot each frame, never accumulated.
    const mode = activeMultiMode()
    const multiDelta = multiDrag.apply(mode)
    if (multiDelta) {
      const primary = selectedOuterGroup()
      if (primary) throttledPanelSync(primary)
      if (mode === 'rotate' && snapGuides.visible) {
        setRotationReadout(THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(multiDelta.rotation).z))
      }
      return
    }
    const partMesh = attachedPartMesh()
    if (partMesh) {
      writeBackPartMesh(partMesh)
      throttledPanelSync(partMesh)
      return
    }
    const outer = selectedOuterGroup()
    if (!outer) return
    if (getMode() === 'scale') restObjectOnBed(outer)
    writeBackGroupTransform(outer)
    throttledPanelSync(outer)
    if (getMode() === 'rotate' && snapGuides.visible) {
      setRotationReadout(THREE.MathUtils.radToDeg(rotorOf(outer).rotation.z))
    }
  }
  transformEvents.addEventListener('objectChange', onObjectChange)

  return {
    get isDragging() { return gizmoDragging },
    get changedOrientation() { return lastDragChangedOrientation },
    markTranslationDrag() { lastDragChangedOrientation = false },
    resetPanelSync() { panelSyncTick = 0 },
    activeMultiMode,
    reseatPivot() { multiDrag.reseatPivot(activeMultiMode()) },
    throttledPanelSync,
    dispose() {
      transformEvents.removeEventListener('dragging-changed', onDraggingChanged)
      transformEvents.removeEventListener('objectChange', onObjectChange)
      multiDrag.reset()
    }
  }
}
