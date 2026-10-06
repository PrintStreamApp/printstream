/**
 * Applies a preflighted SVG re-extrusion to one host's session parts. The caller stages every
 * replacement and records one history checkpoint before invoking this mutation. Baked parts are
 * removed from the precomputed safe state; added parts are updated, inserted, or dropped by the
 * piece reconciliation plan. The caller publishes the changed state and refreshes the scene.
 */
import { threeMfPartSubtypeCarriesFilament, type SceneEditPartSubtype } from '@printstream/shared'
import * as THREE from 'three'
import { decomposeThreeMfPartTransform } from './threeMfPartTransform'
import { nextInstanceKey, type EditorState, type SvgArtworkPart } from './editorModel'
import type { StagedAddedPartGeometry } from './addedParts'
import type { prepareSvgArtwork } from './svgArtworkPreparation'
import type { planSvgReextrude } from './editorModel'
import type { prepareSvgReextrudeSafety } from './editorSvgReextrudeSafety'
import type { SvgPieceSoup } from './svgGeometry'
import { storeEditorSvgSource } from './editorSvgPartCommit'

type PreparedSvgArtwork = NonNullable<ReturnType<typeof prepareSvgArtwork>>
type SvgReextrudePlan = ReturnType<typeof planSvgReextrude>
type SvgReextrudeSafety = ReturnType<typeof prepareSvgReextrudeSafety>

interface SvgReextrudeCommitOptions {
  state: EditorState
  hostId: number
  operation: SceneEditPartSubtype
  prepared: PreparedSvgArtwork
  plan: SvgReextrudePlan
  safety: SvgReextrudeSafety
  stagedPieces: ReadonlyArray<{ piece: SvgPieceSoup; staged: StagedAddedPartGeometry }>
  dropPosition: THREE.Vector3
  fallbackFilamentId: number
}

export interface SvgReextrudeCommitResult {
  replacedCount: number
  addedCount: number
  removedCount: number
  bakedStateChanged: boolean
}

/** Mutate the live session only after staging and refusal checks have succeeded. */
export function applyEditorSvgReextrude(options: SvgReextrudeCommitOptions): SvgReextrudeCommitResult {
  const {
    state, hostId, operation, prepared, plan, safety, stagedPieces,
    dropPosition, fallbackFilamentId
  } = options
  if (safety.refused) {
    console.error('[editor] refused SVG re-extrusion reached the commit stage')
    throw new Error('Refused SVG re-extrusion cannot be committed.')
  }

  storeEditorSvgSource(state, prepared)

  const parts = ((state.addedParts ??= {})[hostId] ??= [])
  const pieceKey = (index: number) => (prepared.split ? index : 0)
  const survivorByPiece = new Map<number, SvgArtworkPart>(
    plan.replace.map(({ pieceIndex, survivor }) => [pieceKey(pieceIndex), survivor])
  )
  let replacedCount = 0
  let addedCount = 0

  for (const { piece, staged } of stagedPieces) {
    const record = prepared.recordFor(piece.index)
    const survivor = survivorByPiece.get(pieceKey(piece.index))
    const shape = prepared.bambuShapeFor()

    if (survivor?.kind === 'added') {
      const existing = parts.find((entry) => entry.key === survivor.key)
      if (!existing) continue
      existing.importId = staged.importId
      existing.soup = staged.soup
      existing.subtype = operation
      existing.name = prepared.partName(piece.index)
      if (!threeMfPartSubtypeCarriesFilament(operation)) delete existing.filamentId
      if (record) existing.svgPart = record
      // A whole-artwork Studio record is invalid after a split or backdrop change.
      if (shape) existing.bambuShape = shape
      else delete existing.bambuShape
      replacedCount += 1
      continue
    }

    // A baked survivor has no editable soup. Its replacement inherits the part's own material
    // and full placement, not the host object's material or a translation alone.
    const placement = survivor ? decomposeThreeMfPartTransform(survivor.transform) : null
    if (survivor) replacedCount += 1
    else addedCount += 1
    const inheritedFilament = survivor?.kind === 'baked' ? survivor.filamentId : null
    parts.push({
      key: nextInstanceKey(),
      importId: staged.importId,
      subtype: operation,
      name: prepared.partName(piece.index),
      ...(threeMfPartSubtypeCarriesFilament(operation)
        ? { filamentId: inheritedFilament ?? fallbackFilamentId }
        : {}),
      position: placement?.position ?? dropPosition.clone(),
      rotation: placement?.rotation ?? new THREE.Euler(),
      scale: placement?.scale ?? new THREE.Vector3(1, 1, 1),
      soup: staged.soup,
      ...(record ? { svgPart: record } : {}),
      ...(shape ? { bambuShape: shape } : {})
    })
  }

  if (safety.droppedAdded.size > 0) {
    const kept = parts.filter((entry) => !safety.droppedAdded.has(entry.key))
    parts.length = 0
    parts.push(...kept)
  }
  const bakedStateChanged = safety.removedBaked.size > 0 && safety.removedState !== null
  if (bakedStateChanged && safety.removedState) {
    state.plates = safety.removedState.plates
    state.removedParts = safety.removedState.removedParts
    state.partOrder = safety.removedState.partOrder
  }

  return { replacedCount, addedCount, removedCount: plan.remove.length, bakedStateChanged }
}
