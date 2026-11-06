/**
 * The by-object linked-copy prediction, pinned to the plates that were actually sliced on Bambu
 * Studio 2.8.2.61 while diagnosing it (cube projects built from a real X2D project's settings):
 *
 * - two linked copies alone: both copies printed, interleaved every layer, no Z restart;
 * - two linked copies plus another object: the second copy was absent from the G-code;
 * - the same with the other object listed between the copies: still absent (instances are
 *   ordered per object, not as listed);
 * - two copies at different rotations, or two different objects: printed one at a time.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assessByObjectLinkedCopies,
  assessThreeMfByObjectLinkedCopies,
  BY_OBJECT_LINKED_COPY_DEFECT_VERSIONS,
  byObjectPlacementTransform,
  describeByObjectLinkedCopyIssue,
  engineHasByObjectLinkedCopyDefect,
  type ByObjectLinkedCopyPlacement
} from './by-object-linked-copies.js'

const ENGINE = { family: 'bambustudio', version: '2.8.2.61' }

function place(objectKey: string, x: number, y: number, rotationZ = 0, printable = true): ByObjectLinkedCopyPlacement {
  return {
    objectKey,
    transform: byObjectPlacementTransform({
      position: { x, y, z: 4 },
      rotation: { x: 0, y: 0, z: rotationZ },
      scale: { x: 1, y: 1, z: 1 }
    }),
    printable
  }
}

test('linked copies alone print together on an affected engine', () => {
  const issues = assessByObjectLinkedCopies({
    engine: ENGINE,
    printSequence: 'by object',
    placements: [place('A', 70, 128), place('A', 190, 128)]
  })

  assert.deepEqual(issues, [{ defect: 'printsTogether', objectKey: 'A', placementIndexes: [0, 1], droppedPlacementIndexes: [] }])
})

test('linked copies beside another object lose every consecutive copy after the first', () => {
  const issues = assessByObjectLinkedCopies({
    engine: ENGINE,
    printSequence: 'by object',
    placements: [place('A', 40, 60), place('A', 140, 60), place('B', 90, 190), place('A', 200, 60)]
  })

  assert.deepEqual(issues, [{ defect: 'copiesDropped', objectKey: 'A', placementIndexes: [0, 1, 3], droppedPlacementIndexes: [1, 3] }])
})

test('another object listed between the copies does not separate them', () => {
  const issues = assessByObjectLinkedCopies({
    engine: ENGINE,
    printSequence: 'by object',
    placements: [place('A', 40, 60), place('B', 90, 190), place('A', 140, 60)]
  })

  assert.deepEqual(issues.map((issue) => issue.droppedPlacementIndexes), [[2]])
})

test('copies at different rotations are separate print objects and print correctly', () => {
  assert.deepEqual(assessByObjectLinkedCopies({
    engine: ENGINE,
    printSequence: 'by object',
    placements: [place('A', 70, 128), place('A', 190, 128, Math.PI / 2)]
  }), [])
})

test('a copy whose rotation differs only past the 3MF precision is still merged', () => {
  // The engine compares the parsed six-decimal strings, so a sub-precision difference is no difference.
  const issues = assessByObjectLinkedCopies({
    engine: ENGINE,
    printSequence: 'by object',
    placements: [place('A', 70, 128), place('A', 190, 128, 1e-9)]
  })

  assert.equal(issues[0]?.defect, 'printsTogether')
})

test('alternating rotations of one object are never consecutive, so nothing is dropped', () => {
  assert.deepEqual(assessByObjectLinkedCopies({
    engine: ENGINE,
    printSequence: 'by object',
    placements: [place('A', 40, 60), place('A', 140, 60, Math.PI / 2), place('A', 200, 60)]
  }), [])
})

test('distinct objects, single copies, by layer and non-printable copies report nothing', () => {
  assert.deepEqual(assessByObjectLinkedCopies({ engine: ENGINE, printSequence: 'by object', placements: [place('A', 70, 128), place('B', 190, 128)] }), [])
  assert.deepEqual(assessByObjectLinkedCopies({ engine: ENGINE, printSequence: 'by object', placements: [place('A', 70, 128)] }), [])
  assert.deepEqual(assessByObjectLinkedCopies({ engine: ENGINE, printSequence: 'by layer', placements: [place('A', 70, 128), place('A', 190, 128)] }), [])
  assert.deepEqual(assessByObjectLinkedCopies({ engine: ENGINE, printSequence: null, placements: [place('A', 70, 128), place('A', 190, 128)] }), [])
  assert.deepEqual(assessByObjectLinkedCopies({
    engine: ENGINE,
    printSequence: 'by object',
    placements: [place('A', 70, 128), place('A', 190, 128, 0, false)]
  }), [])
})

test('only verified Bambu Studio versions are flagged', () => {
  const linked = [place('A', 70, 128), place('A', 190, 128)]
  const mixed = [place('A', 40, 60), place('A', 140, 60), place('B', 90, 190)]

  // Unverified or other engines stay silent rather than guess.
  for (const engine of [
    { family: 'bambustudio', version: '2.9.0.1' },
    { family: 'bambustudio', version: 'legacy' },
    { family: 'orcaslicer', version: '2.8.2.61' },
    null
  ]) {
    assert.deepEqual(assessByObjectLinkedCopies({ engine, printSequence: 'by object', placements: linked }), [])
    assert.deepEqual(assessByObjectLinkedCopies({ engine, printSequence: 'by object', placements: mixed }), [])
  }

  // 2.5.0.66 merges copies but predates the dropped-copy skip.
  const older = { family: 'bambustudio', version: '2.5.0.66' }
  assert.equal(assessByObjectLinkedCopies({ engine: older, printSequence: 'by object', placements: linked })[0]?.defect, 'printsTogether')
  assert.deepEqual(assessByObjectLinkedCopies({ engine: older, printSequence: 'by object', placements: mixed }), [])

  for (const version of BY_OBJECT_LINKED_COPY_DEFECT_VERSIONS.copiesDropped) {
    assert.ok(engineHasByObjectLinkedCopyDefect({ family: 'bambustudio', version }, 'printsTogether'), version)
  }
})

test('the wording names the object and what will happen', () => {
  const together = assessByObjectLinkedCopies({ engine: ENGINE, printSequence: 'by object', placements: [place('A', 70, 128), place('A', 190, 128)] })[0]!
  assert.match(describeByObjectLinkedCopyIssue(together, 'Gutter'), /^Gutter: its 2 linked copies will print together layer by layer/)

  const dropped = assessByObjectLinkedCopies({ engine: ENGINE, printSequence: 'by object', placements: [place('A', 40, 60), place('A', 140, 60), place('B', 90, 190)] })[0]!
  assert.match(describeByObjectLinkedCopyIssue(dropped, 'Gutter'), /^Gutter: 1 linked copy will be left out of the print/)
})

/** A two-plate archive: plate 1 holds object 5 twice, plate 2 holds objects 7 and 5 (twice). */
function archive(options: { plateOneSequence?: string; projectSequence?: string; secondCopyPrintable?: boolean } = {}) {
  const item = (objectId: number, x: number, printable = true) =>
    `<item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 ${x} 128 4" printable="${printable ? 1 : 0}"/>`
  const modelXml = `<model><resources/><build>${[
    item(5, 70), item(5, 190, options.secondCopyPrintable ?? true), item(5, 380), item(5, 480), item(7, 430)
  ].join('')}</build></model>`
  const instance = (objectId: number, instanceId: number) =>
    `<model_instance><metadata key="object_id" value="${objectId}"/><metadata key="instance_id" value="${instanceId}"/></model_instance>`
  const modelSettingsXml = `<config>
    <object id="5"><metadata key="name" value="Gutter"/></object>
    <object id="7"><metadata key="name" value="Bracket"/></object>
    <plate><metadata key="plater_id" value="1"/>${options.plateOneSequence ? `<metadata key="print_sequence" value="${options.plateOneSequence}"/>` : ''}${instance(5, 0)}${instance(5, 1)}</plate>
    <plate><metadata key="plater_id" value="2"/>${instance(5, 2)}${instance(5, 3)}${instance(7, 0)}</plate>
  </config>`
  const projectSettingsJson = JSON.stringify({ print_sequence: options.projectSequence ?? 'by layer' })
  return { modelXml, modelSettingsXml, projectSettingsJson }
}

test('an archive is assessed per plate under each plate\'s effective sequence', () => {
  const byObjectProject = assessThreeMfByObjectLinkedCopies({ ...archive({ projectSequence: 'by object' }), engine: ENGINE })
  assert.deepEqual(byObjectProject.map((warning) => [warning.plateIndex, warning.objectId, warning.issue.defect]), [
    [1, 5, 'printsTogether'],
    [2, 5, 'copiesDropped']
  ])
  assert.match(byObjectProject[0]!.message, /^Gutter: its 2 linked copies/)

  // A plate's own sequence beats the project's, in both directions.
  const plateOverride = assessThreeMfByObjectLinkedCopies({ ...archive({ plateOneSequence: 'by object' }), engine: ENGINE })
  assert.deepEqual(plateOverride.map((warning) => warning.plateIndex), [1])
  const plateByLayer = assessThreeMfByObjectLinkedCopies({ ...archive({ projectSequence: 'by object', plateOneSequence: 'by layer' }), engine: ENGINE })
  assert.deepEqual(plateByLayer.map((warning) => warning.plateIndex), [2])
})

test('an archive check honours plate scope, printability and the engine', () => {
  const byObject = archive({ projectSequence: 'by object' })
  assert.deepEqual(assessThreeMfByObjectLinkedCopies({ ...byObject, engine: ENGINE, plates: [2] }).map((warning) => warning.plateIndex), [2])
  assert.deepEqual(assessThreeMfByObjectLinkedCopies({ ...archive({ projectSequence: 'by object', secondCopyPrintable: false }), engine: ENGINE, plates: [1] }), [])
  assert.deepEqual(assessThreeMfByObjectLinkedCopies({ ...byObject, engine: { family: 'orcaslicer', version: '2.4.2' } }), [])
  assert.deepEqual(assessThreeMfByObjectLinkedCopies({ ...byObject, projectSettingsJson: 'not json', engine: ENGINE }), [])
})
