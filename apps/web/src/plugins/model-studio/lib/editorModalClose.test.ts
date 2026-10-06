import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backGestureCloseEvent } from '../../../components/dialogBackGesture'
import { routeEditorModalClose } from './editorModalClose'
import type { GizmoMode } from '../editorGeometry'

type CloseOptions = Parameters<typeof routeEditorModalClose>[2]
type CloseEvent = Parameters<typeof routeEditorModalClose>[0]

function closeSession() {
  const actions: string[] = []
  const options: CloseOptions = {
    suppressEscapeRef: { current: false },
    contextMenuOpenRef: { current: false },
    closeContextMenu: () => { actions.push('menu') },
    mode: 'select',
    measurePickCount: 0,
    removeLastMeasurePick: () => { actions.push('measure') },
    selectedKey: null,
    partSelection: null,
    gizmoPart: null,
    changeMode: (mode: GizmoMode) => { actions.push(`tool:${mode}`) },
    clearSelection: () => { actions.push('selection') },
    requestClose: (source: string) => { actions.push(`close:${source}`) }
  }
  const escape = () => routeEditorModalClose({} as CloseEvent, 'escapeKeyDown', options)
  return { actions, options, escape }
}

test('Escape peels menu, measurement, tool, and part selection before closing', () => {
  const session = closeSession()
  session.options.contextMenuOpenRef.current = true
  session.options.mode = 'measure'
  session.options.measurePickCount = 2
  session.options.partSelection = { objectId: 7, members: [{ kind: 'baked', partIndex: 0 }] }

  session.escape()
  session.options.contextMenuOpenRef.current = false
  session.escape()
  session.options.measurePickCount = 0
  session.escape()
  session.options.mode = 'select'
  session.escape()
  session.options.partSelection = null
  session.escape()

  assert.deepEqual(session.actions, [
    'menu', 'measure', 'tool:select', 'selection', 'close:escape'
  ])
})

test('synthetic Escape is ignored and Back keeps its diagnostic source', () => {
  const session = closeSession()
  session.options.suppressEscapeRef.current = true
  session.escape()
  assert.deepEqual(session.actions, [])

  routeEditorModalClose(backGestureCloseEvent() as CloseEvent, 'closeClick', session.options)
  routeEditorModalClose({} as CloseEvent, 'closeClick', session.options)
  assert.deepEqual(session.actions, ['close:dialog:back', 'close:dialog:closeClick'])
})
