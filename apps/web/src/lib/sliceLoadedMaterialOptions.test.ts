import assert from 'node:assert/strict'
import test from 'node:test'
import { prioritizeLoadedMaterialOptionsForFilament } from './sliceLoadedMaterialOptions'

test('prioritizeLoadedMaterialOptionsForFilament keeps loaded materials from every nozzle', () => {
  const options = prioritizeLoadedMaterialOptionsForFilament([
    { id: 'right', source: 'ams' as const, nozzleId: 0 },
    { id: 'left', source: 'externalSpool' as const, nozzleId: 1 },
    { id: 'manual', source: 'manual' as const, nozzleId: null }
  ], 0)

  assert.deepEqual(options.map((option) => option.id), ['left', 'right'])
})

test('prioritizeLoadedMaterialOptionsForFilament orders left nozzle before right nozzle without hiding alternatives', () => {
  const options = prioritizeLoadedMaterialOptionsForFilament([
    { id: 'left-a', source: 'ams' as const, nozzleId: 1 },
    { id: 'right-a', source: 'ams' as const, nozzleId: 0 },
    { id: 'shared', source: 'externalSpool' as const, nozzleId: null },
    { id: 'left-b', source: 'externalSpool' as const, nozzleId: 1 }
  ], 1)

  assert.deepEqual(options.map((option) => option.id), ['left-a', 'left-b', 'right-a', 'shared'])
})

test('prioritizeLoadedMaterialOptionsForFilament returns all loaded materials when there is no baked nozzle', () => {
  const options = prioritizeLoadedMaterialOptionsForFilament([
    { id: 'right', source: 'ams' as const, nozzleId: 0 },
    { id: 'left', source: 'externalSpool' as const, nozzleId: 1 }
  ], null)

  assert.deepEqual(options.map((option) => option.id), ['left', 'right'])
})