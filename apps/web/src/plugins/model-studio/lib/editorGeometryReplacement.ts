/**
 * Owns an editor object's staged geometry replacement across all its copies. Placement, identity,
 * material, and named helper-volume types follow the revised mesh; geometry-bound parts and paint
 * are cleared after the shared plate updater has recorded one undo checkpoint.
 */
import type { Dispatch, SetStateAction } from 'react'
import type { StagedImport } from '@printstream/shared'
import { paintMapsAfterMeshReplacement } from './meshReplacementPaint'
import type { EditorImportStore } from './editorImportStore'
import {
  addedPartHostId,
  carriedPartSubtypes,
  dropAddedPartsForReplacedHost,
  partSlotKey,
  replaceInstanceGeometry,
  type EditorInstance,
  type EditorPlate,
  type EditorState
} from './editorModel'

export interface SourceColorPaintCommit {
  filamentId: number
  colorPaint: Record<number, string>
}

interface GeometryReplacementOptions {
  key: string
  staged: StagedImport
  sourceColorPaint?: SourceColorPaintCommit
  history?: { recordHistory?: boolean }
  stateRef: { current: EditorState | null }
  setState: Dispatch<SetStateAction<EditorState | null>>
  updatePlates: (
    updater: (plates: EditorPlate[]) => EditorPlate[],
    kind: 'structure',
    options: { recordHistory?: boolean }
  ) => void
  meshUrl: EditorImportStore['meshUrl']
  worldFootprintCenterFor: (key: string) => { x: number; y: number } | null
  selectReplacement: (key: string) => void
}

/** Replace one object's geometry on every plate, preserving one undoable scene transition. */
export function replaceEditorGeometry(options: GeometryReplacementOptions): boolean {
  const target = options.stateRef.current?.plates.flatMap((plate) => plate.instances)
    .find((entry) => entry.key === options.key)
  if (!target) return false

  const replacedObjectId = target.source.kind === 'object'
    ? target.objectId
    : target.source.replacedObjectId
  const isMember = (instance: EditorInstance): boolean => {
    if (target.source.kind === 'object') {
      return instance.source.kind === 'object' && instance.objectId === target.objectId
    }
    if (target.source.replacedObjectId != null) {
      return instance.source.kind === 'import'
        && instance.source.replacedObjectId === target.source.replacedObjectId
    }
    return instance.source.kind === 'import'
      && instance.source.replacedObjectId == null
      && instance.source.importId === target.source.importId
  }

  // Named helpers keep their slicing subtype across a revised export of the same object.
  const carriedSubtypes = carriedPartSubtypes(target.parts, options.staged.parts)
  let selectedReplacementKey: string | null = null
  options.updatePlates((plates) => plates.map((plate) => ({
    ...plate,
    instances: plate.instances.map((instance) => {
      if (!isMember(instance)) return instance
      const replacement = replaceInstanceGeometry(
        instance,
        options.staged,
        replacedObjectId,
        options.meshUrl,
        options.worldFootprintCenterFor(instance.key),
        carriedSubtypes
      )
      if (options.sourceColorPaint) replacement.filamentId = options.sourceColorPaint.filamentId
      if (instance.key === options.key) selectedReplacementKey = replacement.key
      return replacement
    })
  })), 'structure', options.history ?? {})

  // Clear old-geometry state only after updatePlates has captured history for Undo.
  const state = options.stateRef.current
  if (state) dropAddedPartsForReplacedHost(state, target)
  if (carriedSubtypes.size > 0 && replacedObjectId != null) {
    options.setState((current) => {
      if (!current) return current
      const partTypeChanges = { ...(current.partTypeChanges ?? {}) }
      for (const [partIndex, subtype] of carriedSubtypes) {
        partTypeChanges[partSlotKey(replacedObjectId, partIndex)] = subtype
      }
      return { ...current, partTypeChanges }
    })
  }
  const replacementHostId = addedPartHostId(target)
  if (replacementHostId != null) {
    options.setState((current) => current ? {
      ...current,
      ...paintMapsAfterMeshReplacement(current, replacementHostId, options.sourceColorPaint?.colorPaint)
    } : current)
  }
  if (selectedReplacementKey) options.selectReplacement(selectedReplacementKey)
  return true
}
