import assert from 'node:assert/strict'
import test from 'node:test'
import { STAGED_IMPORT_FORMATS } from '@printstream/shared'
import { resolveImportFileSelection, takeSelectedImportFiles } from './importFileSelection'

test('one OBJ and its material files are classified from a single selection', () => {
  const obj = new File([''], 'model.obj')
  const first = new File([''], 'shell.mtl')
  const second = new File([''], 'details.MTL')

  assert.deepEqual(
    resolveImportFileSelection([first, obj, second], STAGED_IMPORT_FORMATS),
    { file: obj, companionFiles: [first, second] }
  )
})

test('multiple models and unrelated sidecars are rejected before staging', () => {
  assert.throws(
    () => resolveImportFileSelection([new File([''], 'a.obj'), new File([''], 'b.stl')], STAGED_IMPORT_FORMATS),
    /only one model/i
  )
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
