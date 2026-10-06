/**
 * Owns the editor's object placement actions over the live Three.js scene.
 *
 * The editor session still owns history, scene persistence, thumbnail capture, and selected refs.
 * Every multi-object gesture records one checkpoint and writes each member back in selection order.
 * Alignment may deliberately lift an object; resting remains an explicit caller choice.
 */
import { useCallback, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { MODEL_UNIT_MILLIMETRES, type ConvertibleModelUnit } from '@printstream/shared/three-mf'
import {
  alignOffsets,
  distributeOffsets,
  minimumMembersFor,
  type AlignDistributeOperation,
  type AlignMember
} from './lib/alignDistribute'
import {
  DOWN_VECTOR,
  largestHullFaceNormal,
  printableMeshBox,
  restObjectOnBed,
  rotorOf,
  scaleGroupAboutPoint
} from './editorGeometry'
import type { EditorState } from './lib/editorModel'
import { toast } from '../../lib/toast'

interface ObjectPlacementOptions {
  selectedKey: string | null
  selectedKeyRef: MutableRefObject<string | null>
  allSelectedKeysRef: MutableRefObject<() => string[]>
  activePlateIndex: number
  stateRef: MutableRefObject<EditorState | null>
  groupByKeyRef: MutableRefObject<Map<string, THREE.Group>>
  recordHistory: () => void
  bakeExactMatrix: (group: THREE.Object3D) => void
  writeBackGroupTransform: (group: THREE.Object3D) => void
  syncSelectedTransform: (group: THREE.Object3D) => void
  regenerateActivePlateThumbnail: () => void
}

/** Return the selected object and selection placement gestures for this mounted editor session. */
export function useEditorObjectPlacement({
  selectedKey,
  selectedKeyRef,
  allSelectedKeysRef,
  activePlateIndex,
  stateRef,
  groupByKeyRef,
  recordHistory,
  bakeExactMatrix,
  writeBackGroupTransform,
  syncSelectedTransform,
  regenerateActivePlateThumbnail
}: ObjectPlacementOptions) {
  const handleDropToBed = useCallback(() => {
    if (!selectedKey) return
    const group = groupByKeyRef.current.get(selectedKey)
    if (!group) return
    // Measured with `printableMeshBox`, like every other resting path (the gizmo drop, lay-flat,
    // align, `mutateSelectedGroup`), NOT a raw `Box3.setFromObject`: that counted the viewport aids.
    // A brim-ear marker sits at world z=0, so its box floor was already 0 and Drop to bed did
    // nothing at all on any object carrying an ear; a helper volume hanging below the body made it
    // LIFT the object off the plate instead.
    if (printableMeshBox(group).isEmpty()) return
    recordHistory()
    bakeExactMatrix(group)
    restObjectOnBed(group)
    writeBackGroupTransform(group)
    syncSelectedTransform(group)
    regenerateActivePlateThumbnail()
  }, [selectedKey, groupByKeyRef, recordHistory, bakeExactMatrix, writeBackGroupTransform, syncSelectedTransform, regenerateActivePlateThumbnail])


  /**
   * Apply a mutation to the currently selected group, then write the result back
   * into state, refresh the gizmo, the manual panel, and the plate thumbnail.
   */
  const mutateSelectedGroup = useCallback(
    (mutate: (group: THREE.Group) => void) => {
      const key = selectedKeyRef.current
      if (!key) return
      const group = groupByKeyRef.current.get(key)
      if (!group) return
      recordHistory()
      bakeExactMatrix(group)
      mutate(group)
      restObjectOnBed(group)
      writeBackGroupTransform(group)
      syncSelectedTransform(group)
      regenerateActivePlateThumbnail()
    },
    [selectedKeyRef, groupByKeyRef, recordHistory, bakeExactMatrix, writeBackGroupTransform, syncSelectedTransform, regenerateActivePlateThumbnail]
  )

  /** Auto-orient: rest the selected object on its largest hull face (most stable base). */
  const handleAutoOrient = useCallback(() => {
    if (!selectedKey) return
    // BambuStudio refuses this on a locked plate with a notification of its own
    // (`OrientJob.cpp:113-117`), and so must we: the lock's copy promises the plate's models stay
    // where they are, and a lock that stops one of three automatic placement tools is worse than
    // none, because the user has been told otherwise.
    const activePlate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (activePlate?.locked) {
      toast.error('This plate is locked. Unlock it in plate settings to auto-orient.')
      return
    }
    const group = groupByKeyRef.current.get(selectedKey)
    if (!group) return
    const normal = largestHullFaceNormal(group)
    if (!normal) return
    mutateSelectedGroup((target) => {
      rotorOf(target).quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(normal, DOWN_VECTOR))
    })
  }, [activePlateIndex, selectedKey, stateRef, groupByKeyRef, mutateSelectedGroup])

  /**
   * Apply a mutation to EVERY selected object as ONE undo step.
   *
   * The multi-selection sibling of {@link mutateSelectedGroup}, which reads `selectedKeyRef` alone
   * and so silently ignores the rest of a multi-selection. Resting on the bed is the CALLER's
   * choice here rather than automatic: an action that moves a body in Z deliberately (Align top,
   * Align front-back centre) would be undone on the spot by a re-floor, which is exactly what
   * routing such an action through `mutateSelectedGroup` does.
   *
   * `mutate` receives each group already baked to an exact matrix, and runs in selection order with
   * the primary first. It must not add or remove instances: structural edits belong in
   * `updatePlates`, which records its own history.
   */
  const mutateSelection = useCallback((
    mutate: (group: THREE.Group, key: string) => void,
    options: { restOnBed?: boolean } = {}
  ) => {
    const keys = allSelectedKeysRef.current()
    if (keys.length === 0) return
    recordHistory()
    for (const key of keys) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      bakeExactMatrix(group)
      mutate(group, key)
      if (options.restOnBed) restObjectOnBed(group)
      writeBackGroupTransform(group)
    }
    const primary = selectedKeyRef.current ? groupByKeyRef.current.get(selectedKeyRef.current) : null
    if (primary) syncSelectedTransform(primary)
    regenerateActivePlateThumbnail()
  }, [allSelectedKeysRef, selectedKeyRef, groupByKeyRef, recordHistory, bakeExactMatrix, writeBackGroupTransform, syncSelectedTransform, regenerateActivePlateThumbnail])

  /**
   * BambuStudio's "Convert from inch" / "Convert from meter" (`ModelObject::convert_units`,
   * `Model.cpp:1868`): a CAD export whose author worked in another unit arrives 25.4x or 1000x too
   * small, which is not an error anywhere, just a model the user has to notice. Applied to every
   * selected object, as Studio's does (it iterates the whole selection's object indexes).
   *
   * TWO DELIBERATE DIVERGENCES.
   *
   * We scale the instance's TRANSFORM where Studio rewrites the mesh's vertices
   * (`scale_geometry_after_creation`). The rendered result and the baked file agree either way, and
   * a transform edit is undoable and keeps paint on the facets it was painted on; rewriting the
   * geometry would have to stage a replacement import and lose them.
   *
   * We also grow each object IN PLACE rather than multiplying its offset by the same factor as
   * Studio does. Studio can afford to fling the object away because `convert_unit` immediately
   * removes and re-loads it through `load_model_objects`, which places it again; we have no such
   * reload, so the equivalent behaviour is to keep it where the user can see it.
   *
   * Studio's inverse items ("Restore to inch"/"Restore to meter") are deliberately not offered: it
   * gates them on each volume's `source.is_converted_from_inches`, a provenance flag we do not
   * carry, and an always-available inverse would let a user shrink an unconverted model 25.4x with
   * nothing to warn them. Undo is our exact inverse.
   */
  const handleConvertUnits = useCallback((unit: ConvertibleModelUnit) => {
    const factor = MODEL_UNIT_MILLIMETRES[unit]
    if (!factor || factor === 1) return
    mutateSelection((group) => { scaleGroupAboutPoint(group, factor) })
  }, [mutateSelection])

  /**
   * BambuStudio's Align/Distribute (`GLGizmoAlignment.cpp`), applied to the object selection.
   *
   * The arithmetic lives in `lib/alignDistribute.ts`; this only measures each member and applies
   * what comes back. Measurement is the world PRINTABLE box, the same one resting and the
   * placement warnings use, so an object lines up by the geometry that actually prints rather than
   * by its local origin (which is wherever the file's exporter left it) or by a helper volume
   * hanging off its side.
   *
   * Deliberately NOT routed through `mutateSelectedGroup`: that one is single-selection and
   * re-rests every object on the bed, which would silently undo Align top and Align top-bottom
   * centre the instant they ran. Z alignment lifts bodies off the plate on purpose here, exactly
   * as Studio's does; `Drop to bed` is how a user puts them back.
   */
  const applyAlignDistribute = useCallback((operation: AlignDistributeOperation) => {
    const keys = allSelectedKeysRef.current()
    const members: AlignMember[] = []
    for (const key of keys) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      const box = printableMeshBox(group)
      if (box.isEmpty()) continue
      members.push({ key, min: box.min[operation.axis], max: box.max[operation.axis] })
    }
    if (members.length < minimumMembersFor(operation)) return
    const offsets = operation.mode ? alignOffsets(members, operation.mode) : distributeOffsets(members)
    if (offsets.size === 0) return
    mutateSelection((group, key) => {
      const delta = offsets.get(key)
      if (delta) group.position[operation.axis] += delta
    })
  }, [allSelectedKeysRef, groupByKeyRef, mutateSelection])

  /**
   * BambuStudio's "Scale to print volume" (`Selection::scale_to_fit_print_volume`,
   * `Selection.cpp:1576`): grow or shrink the selection by ONE uniform factor so it fits the
   * machine, then land it on the plate.
   *
   * The factor is Studio's: `min(sx, sy, sz)` over the print volume divided by the selection's
   * combined box, with its 0.02mm pad on X and Y only (`:1659-1667`). HEIGHT IS PART OF IT --
   * dropping `sz` is what makes a "scale to print volume" that produces a model taller than the
   * printer, which is why the bed's `maxZ` had to be plumbed through the scene before this could
   * be written honestly. A bed that states no height REFUSES rather than fitting XY and calling it
   * done: the answer would be wrong in exactly the direction the user cannot see.
   *
   * Applied about the plate centre, matching Studio's re-centre after the scale, and every member
   * moves by the same factor about that one point so a multi-selection keeps its relative layout.
   */
  const handleScaleToPrintVolume = useCallback(() => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    if (plate.bed.maxZ == null) {
      toast.error('This project does not say how tall the printer is, so it cannot be scaled to the print volume.')
      return
    }
    const keys = allSelectedKeysRef.current()
    const box = new THREE.Box3()
    for (const key of keys) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      const groupBox = printableMeshBox(group)
      if (!groupBox.isEmpty()) box.union(groupBox)
    }
    if (box.isEmpty()) return

    const size = box.getSize(new THREE.Vector3())
    // Studio's pad, and its axes: 1/100th of a mm on both XY sides, nothing on Z.
    const factor = Math.min(
      (plate.bed.maxX - plate.bed.minX) / (size.x + 0.02),
      (plate.bed.maxY - plate.bed.minY) / (size.y + 0.02),
      plate.bed.maxZ / size.z
    )
    // Studio aborts on `s <= 0.0 || s == 1.0` rather than writing a no-op transform.
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return

    // Studio scales the selection JOINTLY about its own centre and then translates the whole thing
    // onto the print volume's centre. So each member's new centre is the plate centre plus its own
    // offset from the selection centre, scaled: pinning every member to one point instead would
    // stack a multi-selection into a single pile.
    const selectionCentre = box.getCenter(new THREE.Vector3())
    const plateCentre = { x: (plate.bed.minX + plate.bed.maxX) / 2, y: (plate.bed.minY + plate.bed.maxY) / 2 }
    mutateSelection((group) => {
      const centre = printableMeshBox(group).getCenter(new THREE.Vector3())
      scaleGroupAboutPoint(group, factor, {
        x: plateCentre.x + (centre.x - selectionCentre.x) * factor,
        y: plateCentre.y + (centre.y - selectionCentre.y) * factor
      })
    })
  }, [activePlateIndex, stateRef, allSelectedKeysRef, groupByKeyRef, mutateSelection])

  /** Nudge every selected instance together on the bed (multi-select aware). */
  const nudgeSelection = useCallback((dx: number, dy: number) => {
    mutateSelection((group) => {
      group.position.x += dx
      group.position.y += dy
    })
  }, [mutateSelection])

  /**
   * Centre the selection on the active plate: BambuStudio's "Center" (`Selection::center`), which
   * moves the WHOLE selection by one delta computed from its combined bounding box, so the objects
   * keep their relative layout. Centring each object on its own would stack them all on one spot,
   * which is why this is a selection-level action rather than a per-object one repeated N times.
   *
   * The delta is measured from the rendered FOOTPRINT, never by assigning the plate centre to
   * `position`: that field is the transform's translation (the object's local origin) and a Bambu
   * mesh routinely carries plate coordinates in its vertices, so assigning there displaces the
   * model by its whole origin-to-centroid offset, the same trap the single-object 3MF export hit.
   * Z is untouched: centring is a bed-plane operation, and resting is `Drop to bed`'s job.
   */
  const centerSelectionOnPlate = useCallback(() => {
    const plate = stateRef.current?.plates.find((entry) => entry.index === activePlateIndex)
    if (!plate) return
    const box = new THREE.Box3()
    for (const key of allSelectedKeysRef.current()) {
      const group = groupByKeyRef.current.get(key)
      if (!group) continue
      const groupBox = printableMeshBox(group)
      if (!groupBox.isEmpty()) box.union(groupBox)
    }
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    nudgeSelection(
      (plate.bed.minX + plate.bed.maxX) / 2 - center.x,
      (plate.bed.minY + plate.bed.maxY) / 2 - center.y
    )
  }, [activePlateIndex, stateRef, allSelectedKeysRef, groupByKeyRef, nudgeSelection])

  return {
    handleDropToBed,
    mutateSelectedGroup,
    handleAutoOrient,
    handleConvertUnits,
    applyAlignDistribute,
    handleScaleToPrintVolume,
    nudgeSelection,
    centerSelectionOnPlate
  }
}
