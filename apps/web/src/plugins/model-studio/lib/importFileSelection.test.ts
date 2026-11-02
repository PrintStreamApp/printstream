import assert from 'node:assert/strict'
import test from 'node:test'
import { STAGED_IMPORT_FORMATS } from '@printstream/shared'
import { resolveImportFileSelection, resolveImportFileSelections, takeSelectedImportFiles } from './importFileSelection'

test('one OBJ and its material files are classified from a single selection', () => {
  const obj = new File([''], 'model.obj')
  const first = new File([''], 'shell.mtl')
  const second = new File([''], 'details.MTL')

  assert.deepEqual(
    resolveImportFileSelection([first, obj, second], STAGED_IMPORT_FORMATS),
    { file: obj, companionFiles: [first, second] }
  )
})

test('targeted replacement and part insertion still reject multiple models', () => {
  assert.throws(
    () => resolveImportFileSelection([new File([''], 'a.obj'), new File([''], 'b.stl')], STAGED_IMPORT_FORMATS),
    /only one model/i
  )
})

test('batch picks preserve model order and attach the companion pool only to OBJ models', () => {
  const models = ['first.stl', 'second.OBJ', 'third.step', 'fourth.obj'].map((name) => new File([''], name))
  const companions = ['second.mtl', 'fourth.mtl', 'texture.png'].map((name) => new File([''], name))
  assert.deepEqual(resolveImportFileSelections([companions[0]!, ...models, ...companions.slice(1)], STAGED_IMPORT_FORMATS),
    models.map((file, index) => ({ file, companionFiles: index === 1 || index === 3 ? companions : [] })))
})

test('unrelated sidecars and picks without a supported model are rejected before staging', () => {
  assert.deepEqual(
    resolveImportFileSelection([new File([''], 'a.obj'), new File([''], 'texture.png')], STAGED_IMPORT_FORMATS)
      .companionFiles.map((file) => file.name),
    ['texture.png']
  )
  assert.throws(
    () => resolveImportFileSelection([new File([''], 'a.obj'), new File([''], 'notes.txt')], STAGED_IMPORT_FORMATS),
    /Only MTL, PNG, and JPEG/
  )
  assert.throws(
    () => resolveImportFileSelection([new File([''], 'a.stl'), new File([''], 'a.mtl')], STAGED_IMPORT_FORMATS),
    /only accompany an OBJ/i
  )
  assert.throws(() => resolveImportFileSelections([new File([''], 'only.mtl')], STAGED_IMPORT_FORMATS), /supported model/i)
  assert.throws(() => resolveImportFileSelections([new File([''], 'a.step')], ['stl']), /supported model/i)
})

test('resetting the picker preserves a model and companions from its live FileList', () => {
  const model = new File([''], 'model.obj')
  const material = new File([''], 'model.mtl')
  const liveFiles = [model, material]
  const input = {
    files: liveFiles as unknown as FileList,
    get value() { return '' },
    set value(_value: string) { liveFiles.length = 0 }
  }

  const selected = takeSelectedImportFiles(input)
  assert.equal(input.files.length, 0)
  assert.deepEqual(resolveImportFileSelection(selected, STAGED_IMPORT_FORMATS), {
    file: model,
    companionFiles: [material]
  })

  // Picking the same model again must not be lost after the first input reset.
  liveFiles.push(model)
  assert.deepEqual(takeSelectedImportFiles(input), [model])
  assert.deepEqual(takeSelectedImportFiles(input), [])
})
