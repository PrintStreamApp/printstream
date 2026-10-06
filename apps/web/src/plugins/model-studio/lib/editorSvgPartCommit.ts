/**
 * Commits newly staged SVG parts to an editor session. Both a hosted artwork import and the
 * smaller pieces of a standalone artwork use this shape, so their records, material, placement,
 * and source bytes cannot drift. The caller stages geometry and records history first.
 */
import { threeMfPartSubtypeCarriesFilament, type SceneEditPartSubtype } from '@printstream/shared'
import * as THREE from 'three'
import { nextInstanceKey, type EditorState } from './editorModel'
import { stageAddedPartGeometry, type StagedAddedPartGeometry } from './addedParts'
import type { EditorImportStore } from './editorImportStore'
import type { prepareSvgArtwork } from './svgArtworkPreparation'
import type { SvgPieceSoup } from './svgGeometry'

type PreparedSvgArtwork = NonNullable<ReturnType<typeof prepareSvgArtwork>>

export interface StagedSvgPiece {
  piece: SvgPieceSoup
  staged: StagedAddedPartGeometry
}

/** Stage every piece before any editor state changes, preserving source paint order. */
export async function stageEditorSvgPieces(
  store: EditorImportStore,
  pieces: readonly SvgPieceSoup[],
  partName: (index: number) => string
): Promise<StagedSvgPiece[]> {
  return Promise.all(pieces.map(async (piece) => ({
    piece,
    staged: await stageAddedPartGeometry(
      store, { kind: 'soup', soup: piece.soup, name: partName(piece.index) }, 0
    )
  })))
}

/** Store source bytes only when preparation minted or replaced an archive entry. */
export function storeEditorSvgSource(state: EditorState, prepared: PreparedSvgArtwork): void {
  if (prepared.entryPath == null || prepared.markupToStore == null) return
  state.svgSources = { ...state.svgSources, [prepared.entryPath]: prepared.markupToStore }
}

interface AppendSvgPartsOptions {
  state: EditorState
  hostId: number
  prepared: PreparedSvgArtwork
  stagedPieces: readonly StagedSvgPiece[]
  operation: SceneEditPartSubtype
  filamentId: number | null
  position: THREE.Vector3
}

/** Append every piece at one artwork origin, preserving offsets inside each staged soup. */
export function appendEditorSvgParts({
  state, hostId, prepared, stagedPieces, operation, filamentId, position
}: AppendSvgPartsOptions): void {
  storeEditorSvgSource(state, prepared)
  const parts = ((state.addedParts ??= {})[hostId] ??= [])

  for (const { piece, staged } of stagedPieces) {
    const record = prepared.recordFor(piece.index)
    const shape = prepared.bambuShapeFor()
    parts.push({
      key: nextInstanceKey(),
      importId: staged.importId,
      subtype: operation,
      name: prepared.partName(piece.index),
      ...(threeMfPartSubtypeCarriesFilament(operation) ? { filamentId } : {}),
      position: position.clone(),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
      soup: staged.soup,
      ...(record ? { svgPart: record } : {}),
      ...(shape ? { bambuShape: shape } : {})
    })
  }
}
