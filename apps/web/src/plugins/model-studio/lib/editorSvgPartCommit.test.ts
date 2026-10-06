import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { SvgPartRecord } from '@printstream/shared/three-mf'
import type { EditorState } from './editorModel'
import type { prepareSvgArtwork } from './svgArtworkPreparation'
import { appendEditorSvgParts, storeEditorSvgSource } from './editorSvgPartCommit'

function prepared(split: boolean, markupToStore: string | null) {
  return {
    soups: [], split, entryPath: '3D/logo.svg', markupToStore,
    partName: (index: number) => split ? `Logo ${index}` : 'Logo',
    recordFor: (index: number): SvgPartRecord => ({
      entryPath: '3D/logo.svg', fileName: 'logo.svg', pieceIndex: split ? index : 0,
      widthMm: 40, thickness: 2, includeBackground: true
    }),
    bambuShapeFor: () => split ? null : ({ filePath: 'logo.svg' } as ReturnType<NonNullable<ReturnType<typeof prepareSvgArtwork>>['bambuShapeFor']>)
  } as NonNullable<ReturnType<typeof prepareSvgArtwork>>
}

const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])

test('hosted artwork parts share an origin and keep their source and records', () => {
  const state = { plates: [], addedParts: {}, svgSources: {} } as unknown as EditorState
  appendEditorSvgParts({
    state, hostId: 7, prepared: prepared(true, '<svg/>'),
    stagedPieces: [1, 2].map((index) => ({
      piece: { index, soup, coverage: 1 },
      staged: { importId: `piece-${index}`, soup, name: `Logo ${index}` }
    })),
    operation: 'normal_part', filamentId: 3,
    position: new THREE.Vector3(4, 5, 6)
  })

  const parts = state.addedParts?.[7] ?? []
  assert.equal(parts.length, 2)
  assert.deepEqual(parts.map((part) => part.importId), ['piece-1', 'piece-2'])
  assert.deepEqual(parts.map((part) => part.name), ['Logo 1', 'Logo 2'])
  assert.deepEqual(parts.map((part) => part.svgPart?.pieceIndex), [1, 2])
  assert.deepEqual(parts.map((part) => part.position.toArray()), [[4, 5, 6], [4, 5, 6]])
  assert.deepEqual(parts.map((part) => part.filamentId), [3, 3])
  assert.ok(parts.every((part) => part.bambuShape == null))
  assert.equal(state.svgSources?.['3D/logo.svg'], '<svg/>')
})

test('a helper volume carries no filament and reused artwork does not overwrite source bytes', () => {
  const state = { plates: [], addedParts: {}, svgSources: { '3D/logo.svg': 'original' } } as unknown as EditorState
  const artwork = prepared(false, null)
  storeEditorSvgSource(state, artwork)
  appendEditorSvgParts({
    state, hostId: 7, prepared: artwork,
    stagedPieces: [{ piece: { index: 1, soup, coverage: 1 }, staged: { importId: 'piece', soup, name: 'Logo' } }],
    operation: 'negative_part', filamentId: 3, position: new THREE.Vector3()
  })

  const part = state.addedParts?.[7]?.[0]
  assert.equal(part?.filamentId, undefined)
  assert.equal(part?.svgPart?.pieceIndex, 0)
  assert.equal(part?.bambuShape?.filePath, 'logo.svg')
  assert.equal(state.svgSources?.['3D/logo.svg'], 'original')
})
