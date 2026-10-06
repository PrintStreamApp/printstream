/**
 * Collects the helper volumes carried into geometry operations. Both baked 3MF parts and volumes
 * added this session are read in world space, so replacement geometry can attach them without
 * recovering the original object's transform frame.
 */
import * as THREE from 'three'
import type { SceneEditPartSubtype } from '@printstream/shared'
import { partGroupRef } from '../editorGeometry'
import { addedPartLabel } from './addedParts'
import type { CutHelperVolume } from './editorCutStaging'
import { effectiveAddedParts, type EditorInstance, type EditorState } from './editorModel'
import { helperVolumeSpec } from './helperVolumes'
import { collectWorldTriangles } from './meshCut'

/**
 * Baked parts retain their part ordinal even after another part is removed. Resolving by array
 * position can turn an enforcer into the blocker that moved into its old slot. A helper's group and
 * mesh can both be tagged, so collect the outer tagged node once rather than duplicating its soup.
 */
export function collectEditorHelperVolumes(
  state: EditorState | null,
  instance: EditorInstance,
  group: THREE.Group
): CutHelperVolume[] {
  const addedByKey = new Map(effectiveAddedParts(state, instance).map((part) => [part.key, part]))
  const out: CutHelperVolume[] = []

  group.traverse((node) => {
    if (node.userData.isHelperVolume !== true) return
    if (node.parent?.userData.isHelperVolume === true) return

    const soup = collectWorldTriangles(node, { includeModifierVolumes: true })
    if (soup.length === 0) return

    const addedKey = typeof node.userData.addedPartKey === 'string' ? node.userData.addedPartKey : null
    const addedPart = addedKey ? addedByKey.get(addedKey) : undefined
    if (addedPart) {
      out.push({ soup, subtype: addedPart.subtype, name: addedPart.name, filamentId: addedPart.filamentId ?? null })
      return
    }

    const ref = partGroupRef(node)
    const bakedPart = ref ? instance.parts.find((entry) => entry.partIndex === ref.partIndex) : undefined
    const subtype = bakedPart?.subtype ?? null
    // The scene uses this same predicate to tag a helper, so an unrecognised subtype is stale data.
    if (subtype == null || helperVolumeSpec(subtype) == null) return

    out.push({
      soup,
      subtype: subtype as SceneEditPartSubtype,
      name: bakedPart?.name ?? addedPartLabel(subtype as SceneEditPartSubtype),
      filamentId: bakedPart?.filamentId ?? null
    })
  })

  return out
}
