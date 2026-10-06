import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { GizmoMode } from '../editorGeometry'
import { handleEditorPointerHoverMove } from './editorPointerHoverMove'

function fixture(mode: GizmoMode) {
  const calls: string[] = []
  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
  let textConsumes = false
  let paintConsumes = false
  const options = {
    event: {} as PointerEvent,
    mode,
    moveText: (_event: PointerEvent, active: boolean) => {
      calls.push(`text:${active}`)
      return textConsumes
    },
    updateCutHover: () => { calls.push('cut') },
    movePaint: (_event: PointerEvent, active: boolean) => {
      calls.push(`paint:${active}`)
      return paintConsumes
    },
    updateMeasureHover: (_event: PointerEvent, active: boolean) => {
      calls.push(`measure:${active}`)
    },
    faceHull: null as THREE.Mesh | null,
    aimPointerRay: () => { calls.push('aim') },
    raycaster,
    highlightFace: (_hull: THREE.Mesh, faceIndex: number | null) => {
      calls.push(`face:${faceIndex === null ? 'none' : 'hit'}`)
    },
    moveActiveDrag: () => { calls.push('drag') }
  }
  return {
    calls, options,
    consumeText: () => { textConsumes = true },
    consumePaint: () => { paintConsumes = true }
  }
}

test('text and paint consume motion at their respective priority points', () => {
  const text = fixture('text')
  text.consumeText()
  handleEditorPointerHoverMove(text.options)
  assert.deepEqual(text.calls, ['text:true'])

  const paint = fixture('paintColor')
  paint.consumePaint()
  handleEditorPointerHoverMove(paint.options)
  assert.deepEqual(paint.calls, ['text:false', 'cut', 'paint:true'])
})

test('measure preview and active drag follow tool hover when nothing consumes the move', () => {
  const measure = fixture('measure')
  handleEditorPointerHoverMove(measure.options)
  assert.deepEqual(measure.calls, ['text:false', 'cut', 'paint:false', 'measure:true', 'drag'])
})

test('Place on face highlights the current hull hit before body drag routing', () => {
  const face = fixture('layFace')
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1))
  hull.position.z = 1
  hull.updateMatrixWorld(true)
  face.options.faceHull = hull
  handleEditorPointerHoverMove(face.options)
  assert.deepEqual(face.calls, [
    'text:false', 'cut', 'paint:false', 'measure:false', 'aim', 'face:hit', 'drag'
  ])
})
