import assert from 'node:assert/strict'
import test from 'node:test'
import type { StagedImport } from '@printstream/shared'
import { defaultTextInfo } from '@printstream/shared/three-mf'
import { resolveEditorTextSession } from './editorTextSession'
import { instanceFromStagedImport, type EditorAddedPart } from './editorModel'
import type { TextToolValue } from './textToolValue'

const info = defaultTextInfo('Saved words', 'DejaVu Sans')
const current: TextToolValue = {
  text: 'Previous', family: 'DejaVu Sans', bold: false, italic: false,
  fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0,
  embeddedDepth: 0.5, surfaceMode: 'surface', operation: 'normal_part'
}
const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'host', name: 'Host', format: 'stl', triangleCount: 1, bounds,
  parts: [{ name: 'Host', triangleCount: 1, bounds, subtype: null }]
}

test('Text session adoption respects standalone, baked, and added identities', () => {
  const instance = instanceFromStagedImport(staged)
  const transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30]
  const bakedPart = {
    entryPath: '3D/Objects/object_1.model', componentObjectId: 3, partIndex: 2,
    transform, filamentId: 1, name: 'Baked text', color: null, subtype: 'negative_part' as const,
    textInfo: info
  }
  const baked = { part: bakedPart, instance, hostId: 7, partIndex: 2 }
  const added = {
    part: { key: 'added-text', textInfo: info, subtype: 'modifier_part' } as EditorAddedPart,
    hostInstanceKey: instance.key
  }

  const standalone = resolveEditorTextSession({
    current, selectedInstance: { ...instance, textInfo: info }, baked, added
  })
  assert.equal(standalone.kind, 'standalone')
  assert.equal(standalone.value.text, 'Saved words')

  const saved = resolveEditorTextSession({ current, selectedInstance: instance, baked, added })
  assert.equal(saved.kind, 'baked')
  if (saved.kind !== 'baked') return
  assert.equal(saved.hostKey, instance.key)
  assert.equal(saved.partIndex, 2)
  assert.equal(saved.value.operation, 'negative_part')
  assert.deepEqual(saved.transform, transform)
  assert.notEqual(saved.transform, transform, 'the promotion record must not alias the live part')

  const live = resolveEditorTextSession({ current, selectedInstance: instance, baked: null, added })
  assert.equal(live.kind, 'added')
  if (live.kind !== 'added') return
  assert.equal(live.partKey, 'added-text')
  assert.equal(live.value.operation, 'modifier_part')

  const fresh = resolveEditorTextSession({ current, selectedInstance: instance, baked: null, added: null })
  assert.equal(fresh.kind, 'new')
  assert.equal(fresh.value.text, 'Text')
  assert.equal(fresh.value.fontSize, current.fontSize)
  assert.equal(current.text, 'Previous')
})
