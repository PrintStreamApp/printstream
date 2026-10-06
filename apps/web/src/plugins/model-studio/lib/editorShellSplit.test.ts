import assert from 'node:assert/strict'
import test from 'node:test'
import { unzipSync } from 'fflate'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import type { EditorImportStore } from './editorImportStore'
import { discardedHelperVolumeNotice } from './editorGeometryActionMessages'
import {
  prepareEditorShellSplit,
  stageEditorObjectShells,
  stageEditorPartShells
} from './editorShellSplit'

function twoShellGroup(): THREE.Group {
  const group = new THREE.Group()
  for (const x of [10, 40]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
    mesh.position.set(x, 5, 1)
    group.add(mesh)
  }
  group.updateMatrixWorld(true)
  return group
}

test('both Split actions accept the same printable shells and preserve target-specific refusal', () => {
  const group = twoShellGroup()
  const objects = prepareEditorShellSplit(group, 'Bracket', 'objects')
  const parts = prepareEditorShellSplit(group, 'Bracket', 'parts')
  assert.equal(objects.error, null)
  assert.equal(parts.error, null)
  assert.equal(objects.shells?.length, 2)
  assert.equal(parts.shells?.length, 2)

  const one = new THREE.Group()
  one.add(group.children[0]!)
  one.updateMatrixWorld(true)
  assert.equal(prepareEditorShellSplit(one, 'Bracket', 'objects').error, 'Bracket is already a single connected part.')
  const crowded = new THREE.Group()
  for (let index = 0; index < 51; index++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    mesh.position.x = index * 3
    crowded.add(mesh)
  }
  crowded.updateMatrixWorld(true)
  assert.equal(prepareEditorShellSplit(crowded, 'Bracket', 'parts').error,
    'Bracket has 51 shells, too many to split into parts.')
  assert.equal(discardedHelperVolumeNotice(0), '')
  assert.match(discardedHelperVolumeNotice(1), /1 helper volume.*get it back/)
  assert.match(discardedHelperVolumeNotice(2), /2 helper volumes.*get them back/)
})

test('Split to objects stages each rebased shell with its own plate offset', async () => {
  const files: File[] = []
  const store = {
    async stageFile(file: File, normalization: string) {
      assert.equal(normalization, 'object')
      files.push(file)
      return { importId: `import-${files.length}` } as StagedImport
    }
  } as Pick<EditorImportStore, 'stageFile'>
  const prepared = prepareEditorShellSplit(twoShellGroup(), 'Bracket', 'objects')
  assert.ok(prepared.shells)
  const staged = await stageEditorObjectShells(prepared.shells, 'Bracket', store)

  assert.deepEqual(files.map((file) => file.name), ['Bracket (part 1).stl', 'Bracket (part 2).stl'])
  assert.ok(files.every((file) => file.size > 84))
  assert.deepEqual(staged.map((shell) => [shell.offset.x, shell.offset.y, shell.offset.z]), [
    [10, 5, 0], [40, 5, 0]
  ])
})

test('Split to parts stages one vanilla 3MF with both named solids', async () => {
  const files: File[] = []
  const store = {
    async stageFile(file: File, normalization: string) {
      assert.equal(normalization, 'object')
      files.push(file)
      return { importId: 'one-assembly' } as StagedImport
    }
  } as Pick<EditorImportStore, 'stageFile'>
  const prepared = prepareEditorShellSplit(twoShellGroup(), 'Bracket', 'parts')
  assert.ok(prepared.shells)
  const staged = await stageEditorPartShells(prepared.shells, 'Bracket', store)

  assert.equal(staged.importId, 'one-assembly')
  assert.equal(files.length, 1)
  assert.equal(files[0]!.name, 'Bracket.3mf')
  const entries = unzipSync(new Uint8Array(await files[0]!.arrayBuffer()))
  assert.equal(Object.keys(entries).some((entry) => entry.endsWith('model_settings.config')), false)
  const modelEntry = Object.entries(entries).find(([entry]) => entry.endsWith('.model'))
  assert.ok(modelEntry)
  const model = new TextDecoder().decode(modelEntry[1])
  assert.match(model, /Bracket_1/)
  assert.match(model, /Bracket_2/)
})
