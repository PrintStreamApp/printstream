import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StagedImport } from '@printstream/shared'
import { CONNECTOR_DEFAULTS, type CutConnector } from './cutConnectors'
import { stageCutDowelPins, stageCutHalf } from './editorCutStaging'
import type { EditorImportStore } from './editorImportStore'

test('a cut half keeps its world placement and carries only overlapping helpers at identity', async () => {
  const staged: Array<{ name: string; normalization: string; bytes: number }> = []
  const store = {
    async stageFile(file: File, normalization: string) {
      staged.push({ name: file.name, normalization, bytes: file.size })
      return { importId: `import-${staged.length}` } as StagedImport
    }
  } as Pick<EditorImportStore, 'stageFile'>
  const lowerSoup = new Float32Array([10, 20, 0, 12, 20, 1, 10, 22, 0])
  const lowerHelper = new Float32Array([10, 20, 0, 11, 20, 0.5, 10, 21, 0])
  const upperHelper = new Float32Array([10, 20, 2, 11, 20, 2.5, 10, 21, 2])

  const half = await stageCutHalf(
    { soup: lowerSoup, suffix: 'lower', side: 'lower', orientation: 'keep' },
    {
      instanceName: 'Bracket', axis: 'z', offset: 1, connectors: [], importStore: store,
      helperVolumes: [
        { soup: lowerHelper, subtype: 'support_blocker', name: 'Blocker', filamentId: null },
        { soup: upperHelper, subtype: 'support_enforcer', name: 'Enforcer', filamentId: null }
      ]
    }
  )

  assert.deepEqual(half.placement, { x: 11, y: 21 })
  assert.deepEqual(staged.map(({ name, normalization }) => [name, normalization]), [
    ['Bracket (lower).stl', 'object'], ['Blocker.stl', 'part']
  ])
  assert.ok(staged.every(({ bytes }) => bytes > 84))
  assert.equal(half.carried.length, 1)
  assert.deepEqual([...half.carried[0]!.soup.slice(0, 3)], [-1, -1, 0])
  assert.deepEqual([...lowerHelper.slice(0, 3)], [10, 20, 0])
  assert.equal(half.halfWidth, 1)
  assert.equal(half.halfDepth, 1)
})

test('loose dowel pins stage as printable objects with stable one-based names', async () => {
  const names: string[] = []
  const store = {
    async stageFile(file: File, normalization: string) {
      assert.equal(normalization, 'object')
      names.push(file.name)
      return { importId: `pin-${names.length}` } as StagedImport
    }
  } as Pick<EditorImportStore, 'stageFile'>
  const dowel: CutConnector = { ...CONNECTOR_DEFAULTS, id: 'one', x: 0, y: 0, z: 1, type: 'dowel' }
  const pins = await stageCutDowelPins({
    instanceName: 'Bracket', axis: 'z', offset: 1, connectors: [dowel],
    helperVolumes: [], importStore: store
  })

  assert.deepEqual(names, ['Bracket (dowel 1).stl'])
  assert.deepEqual(pins.map((pin) => [pin.staged.importId, pin.name]), [['pin-1', 'Bracket (dowel 1)']])
})
