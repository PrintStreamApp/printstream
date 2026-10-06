import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StagedImport } from '@printstream/shared'
import { placeCutReplacementInstances, prepareCutCommit } from './editorCutCommit'
import { instanceFromStagedImport, seedEmptyEditorState } from './editorModel'

function staged(importId: string): StagedImport {
  const bounds = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
  return {
    importId,
    name: importId,
    format: 'stl',
    triangleCount: 12,
    bounds,
    parts: [{ name: importId, triangleCount: 12, bounds, subtype: null }]
  }
}

test('cut replacements keep the lower half and spread later pieces across free spots', () => {
  const plate = seedEmptyEditorState().plates[0]!
  const source = instanceFromStagedImport(staged('source'))
  source.position.set(0, 0, 0)
  source.filamentId = 4
  source.printable = false
  plate.instances.push(source)

  const replacements = placeCutReplacementInstances({
    halves: [
      { import: staged('lower'), placement: { x: 0, y: 0 }, halfWidth: 4, halfDepth: 4 },
      { import: staged('upper'), placement: { x: 0, y: 0 }, halfWidth: 4, halfDepth: 4 }
    ],
    pins: [
      { staged: staged('pin-1'), name: 'Dowel 1' },
      { staged: staged('pin-2'), name: 'Dowel 2' }
    ],
    plate,
    source,
    meshUrl: (id) => `mesh:${id}`
  })

  assert.deepEqual(replacements.map((item) => item.name), ['lower', 'upper', 'Dowel 1', 'Dowel 2'])
  assert.deepEqual(replacements[0]!.position.toArray(), [0, 0, 0])
  const spots = replacements.slice(1).map((item) => `${item.position.x},${item.position.y}`)
  assert.equal(new Set(spots).size, spots.length)
  assert.ok(replacements.every((item) => item.filamentId === 4 && !item.printable))
  assert.equal(plate.instances.length, 1)
})

test('cut metadata names existing connector volumes and carries helpers with identity placement', () => {
  const soup = new Float32Array([1, 2, 3])
  let key = 0
  const result = prepareCutCommit({
    halves: [
      {
        import: { importId: 'lower' },
        carried: [
          { importId: 'modifier', volume: { subtype: 'modifier_part', name: 'Modifier', filamentId: 4 }, soup },
          { importId: 'blocker', volume: { subtype: 'support_blocker', name: 'Blocker', filamentId: 4 }, soup }
        ],
        connectorParts: [{
          importId: 'peg', subtype: 'normal_part', name: 'Connector-1', soup,
          connector: { type: 'plug', radius: 2, height: 4, radiusTolerance: 0.1, heightTolerance: 0.2 }
        }]
      },
      { import: { importId: 'upper' }, carried: [], connectorParts: [] }
    ],
    pinImportIds: ['pin'],
    hostIds: [77, 88, 99],
    connectorCount: 2,
    nextPartKey: () => `part-${++key}`
  })

  assert.deepEqual(result.cutGroup?.importIds, ['lower', 'upper', 'pin'])
  assert.equal(result.cutGroup?.connectorCount, 2)
  assert.deepEqual(result.cutGroup?.connectors.map((part) => [part.importId, part.meshImportId]), [['lower', 'peg']])
  assert.equal(result.carriedCount, 2)
  assert.deepEqual([...result.carriedByHost.keys()], [77])
  const parts = result.carriedByHost.get(77)!
  assert.deepEqual(parts.map((part) => part.importId), ['peg', 'modifier', 'blocker'])
  assert.equal(parts[1]?.filamentId, 4)
  assert.equal(parts[2]?.filamentId, undefined)
  assert.ok(parts.every((part) => part.position.length() === 0 && part.scale.equals(parts[0]!.scale)))
})

test('a one-sided chop carries its volumes without creating an invalid cut group', () => {
  const result = prepareCutCommit({
    halves: [{ import: { importId: 'only-half' }, carried: [], connectorParts: [] }],
    pinImportIds: [],
    hostIds: [44],
    connectorCount: 0,
    nextPartKey: () => 'unused'
  })
  assert.equal(result.cutGroup, null)
  assert.equal(result.carriedByHost.size, 0)
})
