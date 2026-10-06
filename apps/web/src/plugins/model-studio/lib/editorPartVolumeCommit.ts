/**
 * Adds a staged part volume to a live editor object. A primitive or loaded mesh uses the same
 * staged import path; the editor supplies history and UI publication after staging succeeds.
 */
import * as THREE from 'three'
import { threeMfPartSubtypeCarriesFilament, type SceneEditPartSubtype } from '@printstream/shared'
import { toast } from '../../../lib/toast'
import { printableMeshBox, rotorOf } from '../editorGeometry'
import {
  addedPartDropPosition,
  addedPartLabel,
  soupSize,
  stageAddedPartGeometry,
  type AddedPartSource
} from './addedParts'
import type { EditorImportStore } from './editorImportStore'
import { addedPartHostId, nextInstanceKey, type EditorAddedPart, type EditorState } from './editorModel'

export interface PartVolumeCommitOptions {
  stateRef: { current: EditorState | null }
  activePlateIndex: number
  key: string
  subtype: SceneEditPartSubtype
  source: AddedPartSource
  groupByKey: ReadonlyMap<string, THREE.Group>
  importStore: EditorImportStore
  recordHistory: () => void
  setImporting: (importing: boolean) => void
  refreshAddedPartMeshes: () => void
  selectPart: (hostId: number, key: string) => void
  setMoveMode: () => void
  regenerateThumbnail: () => void
}

/**
 * Stage and add one volume. An unsaved import and a saved object both use `addedPartHostId`;
 * normal parts inherit the host's filament, as BambuStudio's generic subobject loader does.
 * Staging failures leave the editor state and history untouched and surface a toast.
 */
export async function commitEditorPartVolume(options: PartVolumeCommitOptions): Promise<void> {
  const state = options.stateRef.current
  const plate = state?.plates.find((entry) => entry.index === options.activePlateIndex)
  const instance = plate?.instances.find((entry) => entry.key === options.key)
  const group = options.groupByKey.get(options.key)
  if (!state || !instance || !group) return

  const hostId = addedPartHostId(instance)
  if (hostId == null) {
    toast.error('This model cannot take added parts yet.')
    return
  }

  const label = addedPartLabel(options.subtype)
  const box = printableMeshBox(group)
  const maxDim = box.isEmpty()
    ? 20
    : Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
  const size = Math.min(20, Math.max(4, maxDim * 0.25))

  options.setImporting(true)
  try {
    const staged = await stageAddedPartGeometry(options.importStore, options.source, size)
    // Staging can outlive a project switch or object removal. Do not checkpoint or mutate the
    // captured scene after it stops being the live editor state.
    if (options.stateRef.current !== state) return
    if (!state.plates.some((entry) => entry.instances.some((item) => item.key === instance.key))) return
    options.recordHistory()

    const rotor = rotorOf(group)
    rotor.updateWorldMatrix(true, false)
    const part: EditorAddedPart = {
      key: nextInstanceKey(),
      importId: staged.importId,
      subtype: options.subtype,
      name: options.source.kind === 'primitive' ? label : staged.name,
      ...(threeMfPartSubtypeCarriesFilament(options.subtype) ? { filamentId: instance.filamentId } : {}),
      position: addedPartDropPosition(options.subtype, box, soupSize(staged.soup), (point) => rotor.worldToLocal(point)),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
      soup: staged.soup
    }
    if (!state.addedParts) state.addedParts = {}
    ;(state.addedParts[hostId] ??= []).push(part)

    options.refreshAddedPartMeshes()
    options.selectPart(hostId, part.key)
    options.setMoveMode()
    options.regenerateThumbnail()
    toast.success(`Added a ${label.toLowerCase()}: drag it into position.`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Unable to add the part.')
  } finally {
    options.setImporting(false)
  }
}
