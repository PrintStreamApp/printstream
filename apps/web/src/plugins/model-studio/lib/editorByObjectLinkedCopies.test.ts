/**
 * The editor's adapter onto the shared by-object linked-copy rule: what counts as a linked copy
 * (the same identity the bake turns into one object) and which copy keys each issue names.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StagedImport } from '@printstream/shared'
import { duplicateInstance, instanceFromStagedImport, makeInstanceIndependent, seedEmptyEditorState } from './editorModel'
import { assessEditorPlateByObjectLinkedCopies, plateHasLinkedCopies, selectedSliceEngine } from './editorByObjectLinkedCopies'

const ENGINE = { family: 'bambustudio', version: '2.8.2.61' }
const bounds = { min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 10 } }

function staged(importId: string, name: string): StagedImport {
  return { importId, name, format: 'stl', triangleCount: 12, bounds, parts: [{ name, triangleCount: 12, bounds, subtype: null }] }
}

test('a linked pair alone prints together, keyed to both copies', () => {
  const gutter = instanceFromStagedImport(staged('g', 'Gutter'))
  const copy = duplicateInstance(gutter)

  assert.ok(plateHasLinkedCopies({ instances: [gutter, copy] }))
  const issues = assessEditorPlateByObjectLinkedCopies({ plate: { instances: [gutter, copy] }, engine: ENGINE, printSequence: 'by object' })

  assert.equal(issues.length, 1)
  assert.equal(issues[0]!.defect, 'printsTogether')
  assert.equal(issues[0]!.key, gutter.key)
  assert.deepEqual(issues[0]!.instanceKeys, [gutter.key, copy.key])
  assert.match(issues[0]!.message, /^Gutter: its 2 linked copies will print together/)
})

test('a linked pair beside another object loses its second copy', () => {
  const gutter = instanceFromStagedImport(staged('g', 'Gutter'))
  const copy = duplicateInstance(gutter)
  const bracket = instanceFromStagedImport(staged('b', 'Bracket'))

  const issues = assessEditorPlateByObjectLinkedCopies({ plate: { instances: [gutter, bracket, copy] }, engine: ENGINE, printSequence: 'by object' })

  assert.equal(issues.length, 1)
  assert.equal(issues[0]!.defect, 'copiesDropped')
  assert.deepEqual(issues[0]!.instanceKeys, [gutter.key, copy.key])
  assert.equal(issues[0]!.summary, '1 linked copy will not print')
})

test('an independent copy, a rotated copy and a non-printable copy are all fine', () => {
  const gutter = instanceFromStagedImport(staged('g', 'Gutter'))

  const independent = duplicateInstance(gutter)
  makeInstanceIndependent(seedEmptyEditorState(), independent)
  assert.equal(plateHasLinkedCopies({ instances: [gutter, independent] }), false)
  assert.deepEqual(assessEditorPlateByObjectLinkedCopies({ plate: { instances: [gutter, independent] }, engine: ENGINE, printSequence: 'by object' }), [])

  const rotated = duplicateInstance(gutter)
  rotated.rotation.z = Math.PI / 2
  assert.deepEqual(assessEditorPlateByObjectLinkedCopies({ plate: { instances: [gutter, rotated] }, engine: ENGINE, printSequence: 'by object' }), [])

  const hidden = duplicateInstance(gutter)
  hidden.printable = false
  assert.deepEqual(assessEditorPlateByObjectLinkedCopies({ plate: { instances: [gutter, hidden] }, engine: ENGINE, printSequence: 'by object' }), [])
})

test('the selected engine is read from the slice controller target list', () => {
  const targets = [
    { id: 'bambustudio-2-8-2-61', label: 'BS', family: 'bambustudio' as const, version: '2.8.2.61', slicerName: 'Bambu Studio', supportsEstimateModeMachineSwitch: false, isDefault: true, prerelease: false }
  ]
  assert.deepEqual(selectedSliceEngine({ slicerTargets: targets, selectedSlicerTargetId: 'bambustudio-2-8-2-61' }), ENGINE)
  assert.equal(selectedSliceEngine({ slicerTargets: targets, selectedSlicerTargetId: 'missing' }), null)
  assert.equal(selectedSliceEngine(undefined), null)
})
