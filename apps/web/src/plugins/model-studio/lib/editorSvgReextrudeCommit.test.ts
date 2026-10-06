import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { SvgPartRecord } from '@printstream/shared/three-mf'
import type { StagedAddedPartGeometry } from './addedParts'
import type { EditorAddedPart, EditorState, SvgArtworkPart } from './editorModel'
import { applyEditorSvgReextrude } from './editorSvgReextrudeCommit'
import type { prepareSvgArtwork } from './svgArtworkPreparation'
import type { prepareSvgReextrudeSafety } from './editorSvgReextrudeSafety'

const record = (pieceIndex: number): SvgPartRecord => ({
  entryPath: '3D/artwork.svg', fileName: 'artwork.svg', pieceIndex,
  widthMm: 40, thickness: 2, includeBackground: true
})

function prepared(split: boolean) {
  return {
    soups: [], split, entryPath: '3D/artwork.svg', markupToStore: '<svg/>',
    partName: (index: number) => `Artwork ${index}`,
    recordFor: (index: number) => record(split ? index : 0),
    bambuShapeFor: () => null
  } as NonNullable<ReturnType<typeof prepareSvgArtwork>>
}

function staged(index: number): { piece: { index: number; soup: Float32Array; coverage: number }; staged: StagedAddedPartGeometry } {
  const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  return {
    piece: { index, soup, coverage: 1 },
    staged: { importId: `new-${index}`, soup, name: `Artwork ${index}` }
  }
}

function existing(key: string, pieceIndex: number): EditorAddedPart {
  return {
    key, importId: `old-${key}`, subtype: 'normal_part', name: key, filamentId: 3,
    position: new THREE.Vector3(1, 2, 3), rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1), soup: new Float32Array(),
    svgPart: record(pieceIndex),
    bambuShape: { filePath: 'artwork.svg' } as EditorAddedPart['bambuShape']
  }
}

test('re-extrusion updates, adds, and drops session parts as one reconciled artwork', () => {
  const old = existing('old', 1)
  const orphan = existing('orphan', 3)
  const state = { plates: [], addedParts: { 7: [old, orphan] }, svgSources: {} } as unknown as EditorState
  const safety = {
    refused: false, removedBaked: new Set<number>(), droppedAdded: new Set(['orphan']),
    removedState: state, otherPrintedParts: 2
  } as ReturnType<typeof prepareSvgReextrudeSafety>
  const result = applyEditorSvgReextrude({
    state, hostId: 7, operation: 'normal_part', prepared: prepared(true),
    plan: {
      replace: [{ pieceIndex: 1, survivor: { kind: 'added', key: 'old', pieceIndex: 1 } }],
      add: [2], remove: [{ kind: 'added', key: 'orphan', pieceIndex: 3 }]
    },
    safety,
    stagedPieces: [staged(1), staged(2)],
    dropPosition: new THREE.Vector3(9, 8, 7),
    fallbackFilamentId: 4
  })

  assert.deepEqual(result, { replacedCount: 1, addedCount: 1, removedCount: 1, bakedStateChanged: false })
  assert.equal(state.svgSources?.['3D/artwork.svg'], '<svg/>')
  assert.equal(state.addedParts?.[7]?.length, 2)
  assert.equal(old.importId, 'new-1')
  assert.equal(old.filamentId, 3)
  assert.equal(old.bambuShape, undefined)
  const added = state.addedParts?.[7]?.find((part) => part.key !== 'old')
  assert.equal(added?.importId, 'new-2')
  assert.equal(added?.filamentId, 4)
  assert.deepEqual(added?.position.toArray(), [9, 8, 7])
})

test('a baked survivor contributes its own material and placement to the new volume', () => {
  const state = { plates: [], addedParts: {}, svgSources: {} } as unknown as EditorState
  const removedState = {
    ...state,
    plates: [{ plateId: 2 }],
    removedParts: { 7: [0] },
    partOrder: { 7: [1] }
  } as unknown as EditorState
  const survivor: SvgArtworkPart = {
    kind: 'baked', partIndex: 0, pieceIndex: 0,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 4, 5, 6], subtype: null,
    filamentId: 9
  }
  const safety = {
    refused: false, removedBaked: new Set([0]), droppedAdded: new Set<string>(),
    removedState, otherPrintedParts: 1
  } as ReturnType<typeof prepareSvgReextrudeSafety>

  const result = applyEditorSvgReextrude({
    state, hostId: 7, operation: 'normal_part', prepared: prepared(false),
    plan: { replace: [{ pieceIndex: 1, survivor }], add: [], remove: [] },
    safety, stagedPieces: [staged(1)], dropPosition: new THREE.Vector3(),
    fallbackFilamentId: 4
  })

  assert.equal(result.replacedCount, 1)
  assert.equal(result.bakedStateChanged, true)
  assert.equal(state.plates, removedState.plates)
  assert.equal(state.removedParts, removedState.removedParts)
  assert.equal(state.partOrder, removedState.partOrder)
  const part = state.addedParts?.[7]?.[0]
  assert.equal(part?.filamentId, 9)
  assert.deepEqual(part?.position.toArray(), [4, 5, 6])
  assert.equal(part?.svgPart?.pieceIndex, 0)
})

test('a refused preflight cannot mutate session artwork or parts', () => {
  const original = existing('old', 0)
  const state = { plates: [], addedParts: { 7: [original] }, svgSources: {} } as unknown as EditorState
  const safety = {
    refused: true, removedBaked: new Set<number>(), droppedAdded: new Set<string>(),
    removedState: null, otherPrintedParts: 0
  } as ReturnType<typeof prepareSvgReextrudeSafety>
  const oldLog = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    assert.throws(() => applyEditorSvgReextrude({
      state, hostId: 7, operation: 'normal_part', prepared: prepared(false),
      plan: { replace: [], add: [], remove: [] }, safety,
      stagedPieces: [staged(1)], dropPosition: new THREE.Vector3(), fallbackFilamentId: 4
    }), /Refused SVG re-extrusion/)
  } finally {
    console.error = oldLog
  }
  assert.equal(errors.length, 1)
  assert.equal(state.svgSources?.['3D/artwork.svg'], undefined)
  assert.deepEqual(state.addedParts?.[7], [original])
})
