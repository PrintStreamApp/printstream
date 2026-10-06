import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { defaultTextInfo, type SvgPartRecord } from '@printstream/shared/three-mf'
import { instanceFromStagedImport, seedEmptyEditorState } from './editorModel'
import { changeEditorToolMode, type ToolModeChangeOptions } from './editorToolModeChange'
import type { TextToolValue } from './textToolValue'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'host', name: 'Host', format: 'stl', triangleCount: 1, bounds,
  parts: [{ name: 'Body', triangleCount: 1, bounds, subtype: null }]
}
const textValue: TextToolValue = {
  text: 'Previous', family: 'DejaVu Sans', bold: false, italic: false,
  fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0,
  embeddedDepth: 0.5, surfaceMode: 'surface', operation: 'normal_part'
}

/** Keep callback order visible without mounting the whole editor or replacing its state model. */
function fixture() {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  instance.parts.push({
    entryPath: '3D/Objects/object_1.model', componentObjectId: 3, partIndex: 0,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    filamentId: 1, name: 'Authored part', color: null, subtype: null
  })
  state.plates[0]!.instances.push(instance)
  const events: string[] = []
  const options: ToolModeChangeOptions = {
    mode: 'select',
    selectedKey: instance.key,
    selectedBakedPart: null,
    selectedAddedPartKey: null,
    activePlateRef: { current: state.plates[0] },
    reeditBakedPartRef: { current: { hostId: 99, partIndex: 9, transform: [] } },
    editingTextSurfaceRef: { current: { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1) } },
    textApplyLoadedRef: { current: null },
    textTool: textValue,
    openLayerHeightFor: (key) => { events.push(`layers:${key}`) },
    findBakedAuthoredPart: () => null,
    findAddedSvgPart: () => null,
    findAddedTextPart: () => null,
    reopenSvgArtwork: async () => { events.push('reopen-svg') },
    clearSvgReedit: () => { events.push('clear-svg') },
    recordHistory: () => { events.push('history') },
    setTextTool: (value) => { events.push(`text:${value.text}`) },
    setEditingTextPartKey: (key) => { events.push(`part:${key}`) },
    setEditingTextHost: (key) => { events.push(`host:${key}`) },
    setEditingTextObject: (key) => { events.push(`object:${key}`) },
    setGizmoMode: (mode) => { events.push(`mode:${mode}`) }
  }
  return { instance, options, events }
}

test('Layers clears a stale baked promotion before its early return', () => {
  const { instance, options, events } = fixture()
  options.mode = 'layerHeight'
  changeEditorToolMode(options)
  assert.equal(options.reeditBakedPartRef.current, null)
  assert.deepEqual(events, [`layers:${instance.key}`])
})

test('SVG reopens selected authored artwork without a history checkpoint', () => {
  const { instance, options, events } = fixture()
  const record: SvgPartRecord = {
    entryPath: '3D/logo.svg', fileName: 'logo.svg', pieceIndex: 0,
    widthMm: 40, thickness: 2, includeBackground: false
  }
  instance.parts[0]!.svgPart = record
  instance.parts[0]!.subtype = 'modifier_part'
  options.mode = 'svg'
  options.selectedBakedPart = { objectId: 7, partIndex: 0 }
  options.findBakedAuthoredPart = () => ({ part: instance.parts[0]!, instance, hostId: 7, partIndex: 0 })
  options.reopenSvgArtwork = async (actual, hostId, subtype) => {
    assert.equal(actual, record)
    assert.equal(hostId, 7)
    assert.equal(subtype, 'modifier_part')
    events.push('reopen-svg')
  }

  changeEditorToolMode(options)
  assert.equal(options.reeditBakedPartRef.current, null)
  assert.deepEqual(events, ['reopen-svg', 'mode:svg'])
})

test('Text reopens a baked part, then a standalone object without carrying its promotion', () => {
  const { instance, options, events } = fixture()
  const info = defaultTextInfo('Saved words', 'DejaVu Sans')
  instance.parts[0]!.textInfo = info
  options.mode = 'text'
  options.selectedBakedPart = { objectId: 7, partIndex: 0 }
  options.findBakedAuthoredPart = () => ({ part: instance.parts[0]!, instance, hostId: 7, partIndex: 0 })

  changeEditorToolMode(options)
  assert.equal(options.reeditBakedPartRef.current?.hostId, 7)
  assert.equal(options.textApplyLoadedRef.current?.text, 'Saved words')
  assert.equal(options.editingTextSurfaceRef.current, null)
  assert.deepEqual(events, ['history', 'text:Saved words', 'part:null', `host:${instance.key}`, 'object:null', 'mode:text'])

  events.length = 0
  instance.textInfo = info
  options.selectedBakedPart = null
  changeEditorToolMode(options)
  assert.equal(options.reeditBakedPartRef.current, null)
  assert.deepEqual(events, ['history', 'text:Saved words', 'part:null', 'host:null', `object:${instance.key}`, 'mode:text'])
})
