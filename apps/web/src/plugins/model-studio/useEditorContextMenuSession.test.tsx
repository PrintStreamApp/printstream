import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorContextMenuSession } = await import('./useEditorContextMenuSession')

afterEach(cleanup)
after(() => dom.window.close())

test('context menu preserves selected objects and closes only for outside interactions', () => {
  let selected = ['cube', 'sphere']
  const allSelectedKeysRef = { current: () => selected }
  const selectExclusiveRef = { current: (key: string | null) => { selected = key ? [key] : [] } }
  const view = renderHook(() => useEditorContextMenuSession({ allSelectedKeysRef, selectExclusiveRef }))

  act(() => view.result.current.openContextMenuRef.current({ x: 12, y: 24, key: 'sphere' }))
  assert.deepEqual(selected, ['cube', 'sphere'])
  assert.equal(view.result.current.contextMenu?.kind, 'object')
  assert.equal(view.result.current.contextMenuOpenRef.current, true)

  const listbox = document.createElement('div')
  const item = document.createElement('button')
  listbox.append(item)
  document.body.append(listbox)
  view.result.current.contextMenuListboxRef.current = listbox
  act(() => item.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })))
  act(() => item.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
  assert.ok(view.result.current.contextMenu)

  const outside = document.createElement('button')
  document.body.append(outside)
  act(() => outside.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })))
  assert.equal(view.result.current.contextMenu, null)
  assert.equal(view.result.current.contextMenuOpenRef.current, false)

  act(() => view.result.current.openContextMenuRef.current({ x: 30, y: 40, key: 'cone' }))
  assert.deepEqual(selected, ['cone'])
  act(() => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })))
  assert.equal(view.result.current.contextMenu, null)
  listbox.remove()
  outside.remove()
})
