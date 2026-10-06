import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { prepareEditorCut } from './editorCutPreparation'
import { GROOVE_CUT_DEFAULTS } from './meshCut'

function boxSoup(): Float32Array {
  const geometry = new THREE.BoxGeometry(20, 20, 20).toNonIndexed()
  geometry.translate(0, 0, 10)
  const soup = new Float32Array(geometry.getAttribute('position').array)
  geometry.dispose()
  return soup
}

function input() {
  return {
    soup: boxSoup(),
    mode: 'plane' as const,
    axis: 'z' as const,
    offset: 8,
    groove: { depth: 4, width: 8, ...GROOVE_CUT_DEFAULTS },
    keepLower: true,
    keepUpper: true,
    orientLower: 'keep' as const,
    orientUpper: 'placeOnCut' as const,
    connectorCount: 0,
    connectorProblem: null
  }
}

test('cut preparation keeps lower and upper halves with their chosen orientations', () => {
  const result = prepareEditorCut(input())
  assert.equal(result.error, null)
  assert.deepEqual(result.halves?.map(({ side, suffix, orientation }) => [side, suffix, orientation]), [
    ['lower', 'lower', 'keep'],
    ['upper', 'upper', 'placeOnCut']
  ])
  assert.ok(result.halves?.every((half) => half.soup.length > 0))
})

test('cut preparation refuses no kept geometry and connectors without two halves', () => {
  assert.equal(prepareEditorCut({ ...input(), keepLower: false, keepUpper: false }).error,
    'Nothing to keep: move the cut plane or keep at least one side.')
  assert.equal(prepareEditorCut({ ...input(), keepLower: false, connectorCount: 1 }).error,
    'Connectors need both halves kept.')
  assert.equal(prepareEditorCut({ ...input(), connectorProblem: 'pin outside cut face' }).error,
    'Invalid connectors: pin outside cut face.')
})
