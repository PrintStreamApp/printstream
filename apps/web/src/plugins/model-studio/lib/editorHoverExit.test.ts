import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installEditorHoverExit } from './editorHoverExit'

test('hover exit clears every transient aid and removes its listener on teardown', () => {
  const canvas = new EventTarget() as HTMLElement
  const calls: string[] = []
  let renderedVersion = 1
  const release = installEditorHoverExit(canvas, {
    clearBrushHover: () => calls.push('brush-and-paint'),
    clearMeasureHover: () => calls.push('measure'),
    clearFaceHighlight: () => calls.push('face'),
    requestRender: () => calls.push(`render:${renderedVersion}`)
  })

  canvas.dispatchEvent(new Event('pointerleave'))
  renderedVersion = 2
  canvas.dispatchEvent(new Event('pointerleave'))
  assert.deepEqual(calls, [
    'brush-and-paint', 'measure', 'face', 'render:1',
    'brush-and-paint', 'measure', 'face', 'render:2'
  ])

  release()
  canvas.dispatchEvent(new Event('pointerleave'))
  assert.equal(calls.length, 8)
})
