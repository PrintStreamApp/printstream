import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { applyEditorCutAction, commitEditorCut } from './editorCutAction'
import { prepareCutCommit } from './editorCutCommit'
import { addedPartHostId, instanceFromStagedImport, seedEmptyEditorState, type EditorState } from './editorModel'
import type { EditorImportStore } from './editorImportStore'
import { GROOVE_CUT_DEFAULTS } from './meshCut'

function staged(importId: string): StagedImport {
  const bounds = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
  return {
    importId, name: importId, format: 'stl', triangleCount: 12, bounds,
    parts: [{ name: importId, triangleCount: 12, bounds, subtype: null }]
  }
}

test('one cut state swap carries volumes and appends its relation without touching another plate', () => {
  const state = seedEmptyEditorState()
  const plate = state.plates[0]!
  const source = instanceFromStagedImport(staged('source'))
  const untouched = instanceFromStagedImport(staged('other'))
  plate.instances.push(source)
  state.plates.push({ ...plate, index: plate.index + 1, instances: [untouched] })

  const lower = instanceFromStagedImport(staged('lower'))
  const upper = instanceFromStagedImport(staged('upper'))
  const commit = prepareCutCommit({
    halves: [
      {
        import: { importId: 'lower' },
        carried: [{
          importId: 'helper',
          volume: { subtype: 'modifier_part', name: 'Helper', filamentId: 2 },
          soup: new Float32Array([0, 0, 0])
        }],
        connectorParts: []
      },
      { import: { importId: 'upper' }, carried: [], connectorParts: [] }
    ],
    pinImportIds: [],
    hostIds: [addedPartHostId(lower), addedPartHostId(upper)],
    connectorCount: 0,
    nextPartKey: () => 'helper-part'
  })

  const next = applyEditorCutAction(state, plate.index, source.key, [lower, upper], commit)
  assert.deepEqual(next.plates[0]?.instances.map((entry) => entry.key), [lower.key, upper.key])
  assert.equal(next.plates[1]?.instances[0], untouched)
  assert.deepEqual(next.cutGroups?.[0]?.importIds, ['lower', 'upper'])
  assert.equal(next.addedParts?.[addedPartHostId(lower)!]?.[0]?.importId, 'helper')
  assert.equal(state.plates[0]?.instances[0], source)
  assert.equal(state.cutGroups?.length ?? 0, 0)
  assert.equal(Object.keys(state.addedParts ?? {}).length, 0)
})

test('a complete two-half cut stages before one history checkpoint and selects the replacement', async () => {
  let state: EditorState | null = seedEmptyEditorState()
  const plate = state.plates[0]!
  const original = instanceFromStagedImport(staged('original'))
  plate.instances.push(original)

  const geometry = new THREE.BoxGeometry(20, 20, 20).toNonIndexed()
  geometry.translate(0, 0, 10)
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry))
  group.updateWorldMatrix(true, true)

  let stageCount = 0
  let checkpoints = 0
  let selected: string | null = null
  let closed = 0
  const busy: boolean[] = []
  const store: Pick<EditorImportStore, 'stageFile' | 'meshUrl'> = {
    stageFile: async (file: File) => {
      stageCount += 1
      assert.equal(checkpoints, 0, 'all staging finishes before history changes')
      return { ...staged(`half-${stageCount}`), name: file.name }
    },
    meshUrl: (id: string) => `mesh:${id}`
  }

  try {
    await commitEditorCut({
      selectedKey: original.key,
      activePlateIndex: plate.index,
      stateRef: { current: state },
      groupByKey: new Map([[original.key, group]]),
      preparation: {
        mode: 'plane', axis: 'z', offset: 8,
        groove: { depth: 4, width: 8, ...GROOVE_CUT_DEFAULTS },
        keepLower: true, keepUpper: true,
        orientLower: 'keep', orientUpper: 'keep', connectorProblem: null
      },
      connectors: [],
      importStore: store,
      collectHelperVolumes: () => [],
      recordHistory: () => { checkpoints += 1 },
      setState: (value) => { state = typeof value === 'function' ? value(state) : value },
      invalidateAddedParts: () => {},
      rebuildScene: () => {},
      selectReplacement: (key) => { selected = key },
      closeCutTool: () => { closed += 1 },
      setCutting: (value) => { busy.push(value) }
    })
  } finally {
    geometry.dispose()
  }

  assert.equal(stageCount, 2)
  assert.equal(checkpoints, 1)
  assert.equal(state?.plates[0]?.instances.length, 2)
  assert.equal(state?.cutGroups?.length, 1)
  assert.equal(selected, state?.plates[0]?.instances[0]?.key)
  assert.equal(closed, 1)
  assert.deepEqual(busy, [true, false])
})
