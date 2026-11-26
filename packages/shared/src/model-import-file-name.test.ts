import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildModelImportFileName } from './model-import-file-name.js'

test('chosen names preserve spaces, Unicode, and the original simple or compound extension', () => {
  assert.equal(buildModelImportFileName('provider.stl', 'My model'), 'My model.stl')
  assert.equal(buildModelImportFileName('provider.gcode.3mf', 'My sliced model'), 'My sliced model.gcode.3mf')
  assert.equal(buildModelImportFileName('provider.STEP', 'Custom name.STEP'), 'Custom name.STEP')
  assert.equal(buildModelImportFileName('provider.obj', 'Mod\u00e8le'), 'Mod\u00e8le.obj')
  assert.equal(buildModelImportFileName('provider.3mf'), 'provider.3mf')
})

test('invalid or oversized names are rejected before a model is saved', () => {
  for (const name of ['', '   ', '.', '..', '../model', 'folder\\model', 'bad\u0000name', 'x'.repeat(255)]) {
    assert.throws(() => buildModelImportFileName('provider.stl', name), /valid file name/)
  }
})
