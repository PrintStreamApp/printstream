import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { installJsdomGlobals } from '../../../test-utils/jsdom'
import { installEditorPointerListeners } from './editorPointerListeners'

const dom = installJsdomGlobals()
after(() => dom.window.close())

test('pointer listeners keep ownership and tool order, then release every handler', () => {
  const canvas = dom.window.document.createElement('div')
  const calls: string[] = []
  let revision = 1
  const installed = installEditorPointerListeners(canvas, {
    claimSelectedObjectPointer: () => calls.push('claim'),
    onPointerDown: () => calls.push('down'),
    onPointerMove: () => calls.push(`move:${revision}`),
    endBodyDrag: () => calls.push('end'),
    onContextMenu: () => calls.push('menu'),
    installOrbitPivot: () => {
      calls.push('pivot installed')
      return () => calls.push('pivot released')
    },
    installHoverExit: () => {
      calls.push('hover installed')
      return () => calls.push('hover released')
    }
  })

  assert.deepEqual(calls, ['pivot installed', 'hover installed'])
  canvas.dispatchEvent(new dom.window.Event('pointerdown'))
  canvas.dispatchEvent(new dom.window.Event('pointermove'))
  revision = 2
  canvas.dispatchEvent(new dom.window.Event('pointermove'))
  canvas.dispatchEvent(new dom.window.Event('pointerup'))
  canvas.dispatchEvent(new dom.window.Event('pointercancel'))
  canvas.dispatchEvent(new dom.window.Event('contextmenu'))
  assert.deepEqual(calls.slice(2), ['claim', 'down', 'move:1', 'move:2', 'end', 'end', 'menu'])

  installed.releaseOrbitPivot()
  installed.releaseCanvasListeners()
  const callCount = calls.length
  assert.deepEqual(calls.slice(-2), ['pivot released', 'hover released'])
  canvas.dispatchEvent(new dom.window.Event('pointerdown'))
  canvas.dispatchEvent(new dom.window.Event('pointermove'))
  canvas.dispatchEvent(new dom.window.Event('pointerup'))
  canvas.dispatchEvent(new dom.window.Event('pointercancel'))
  canvas.dispatchEvent(new dom.window.Event('contextmenu'))
  assert.equal(calls.length, callCount)
})
