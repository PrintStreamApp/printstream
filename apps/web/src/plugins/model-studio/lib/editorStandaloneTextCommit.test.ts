import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import opentype from 'opentype.js'
import type { StagedImport } from '@printstream/shared'
import { commitStandaloneText } from './editorStandaloneTextCommit'
import { seedEmptyEditorState, type EditorPlate } from './editorModel'
import type { EditorImportStore } from './editorImportStore'
import type { TextToolValue } from './textToolValue'

function staged(importId: string, name: string): StagedImport {
  const bounds = { min: { x: -5, y: -2, z: 0 }, max: { x: 5, y: 2, z: 2 } }
  return {
    importId, name, format: 'stl', triangleCount: 12, bounds,
    parts: [{ name, triangleCount: 12, bounds, subtype: null }]
  }
}

test('standalone text create and retype share the tool-open history frame', async () => {
  const fontPath = path.resolve(import.meta.dirname, '../../../../public/fonts/text-tool/dejavu-sans.ttf')
  const bytes = await readFile(fontPath)
  const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const face = { id: 'dejavu-sans', family: 'DejaVu Sans', bold: false, italic: false }
  const value: TextToolValue = {
    text: 'Text', family: face.family, bold: false, italic: false,
    fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0,
    embeddedDepth: 0.5, surfaceMode: 'horizontal', operation: 'normal_part'
  }
  let plates: EditorPlate[] = seedEmptyEditorState().plates
  let editingKey: string | null = null
  let selectedKey: string | null = null
  const previousSelectedKeyRef = { current: null as string | null }
  let stages = 0
  const store: Pick<EditorImportStore, 'stageFile' | 'meshUrl'> = {
    stageFile: async (file) => staged(`stage-${++stages}`, file.name.replace(/\.stl$/, '')),
    meshUrl: (id) => `mesh:${id}`
  }
  const callbacks = {
    activePlateIndex: plates[0]!.index,
    resolveFace: async () => ({ face, font }),
    importStore: store,
    footprintCenterFor: () => null,
    setEditingObject: (key: string | null) => { editingKey = key },
    selectObject: (key: string) => { selectedKey = key },
    previousSelectedKeyRef,
    updatePlates: (updater: (current: EditorPlate[]) => EditorPlate[], kind: 'structure', options: { recordHistory: false }) => {
      assert.equal(kind, 'structure')
      assert.equal(options.recordHistory, false)
      plates = updater(plates)
    },
    addInstance: (instance: EditorPlate['instances'][number], _footprint: unknown, options: { recordHistory: false }) => {
      assert.equal(options.recordHistory, false)
      plates[0]!.instances.push(instance)
      selectedKey = instance.key
      return true
    }
  }

  await commitStandaloneText({ ...callbacks, plate: plates[0]!, editingObjectKey: null, value })
  assert.equal(plates[0]?.instances.length, 1)
  assert.equal(plates[0]?.instances[0]?.name, 'Text')
  assert.equal(editingKey, selectedKey)

  await commitStandaloneText({
    ...callbacks,
    plate: plates[0]!,
    editingObjectKey: editingKey,
    value: { ...value, text: 'Proof' }
  })
  assert.equal(plates[0]?.instances.length, 1)
  assert.equal(plates[0]?.instances[0]?.name, 'Proof')
  assert.equal(plates[0]?.instances[0]?.textInfo?.text, 'Proof')
  assert.equal(stages, 2)
  assert.equal(editingKey, selectedKey)
  assert.equal(previousSelectedKeyRef.current, selectedKey)
})
