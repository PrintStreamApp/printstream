/**
 * Telling the context menu's OWN events from outside ones.
 *
 * The menu dismisses on an outside pointerdown or scroll, because it is anchored to a rect captured
 * when it opened and a scroll would otherwise leave it beside a different row. But the menu is
 * capped at the viewport height and scrolls ITSELF, so a guard that ignores where the event came
 * from closes it the moment someone wheels, or drags its scrollbar, toward the item they opened it
 * for. Uses real DOM nodes rather than fakes: `contains` and the `instanceof Node` check are the
 * whole behaviour under test.
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { isInsideContextMenu } from './contextMenuChrome'

let dom: JSDOM
let listbox: HTMLElement
let item: HTMLElement
let outside: HTMLElement

before(() => {
  dom = installJsdomGlobals()
  const { document } = dom.window
  listbox = document.createElement('ul')
  item = document.createElement('li')
  listbox.appendChild(item)
  outside = document.createElement('div')
  document.body.append(listbox, outside)
})

after(() => {
  dom.window.close()
})

test('the listbox itself counts as inside', () => {
  // THE case that matters: the listbox IS the scrolling element, so a scroll event targets it
  // directly rather than a descendant. Reading that as "outside" is what closed the menu on its
  // own wheel and on a drag of its own scrollbar.
  assert.equal(isInsideContextMenu(listbox, listbox), true)
})

test('a descendant counts as inside', () => {
  assert.equal(isInsideContextMenu(listbox, item), true)
})

test('an unrelated node is outside, so the menu still dismisses', () => {
  // The inverse. Without it the dismiss-on-scroll behaviour would be dead and the menu would hang
  // around beside a row it no longer belongs to.
  assert.equal(isInsideContextMenu(listbox, outside), false)
})

test('a missing listbox or target is outside', () => {
  assert.equal(isInsideContextMenu(null, item), false)
  assert.equal(isInsideContextMenu(undefined, item), false)
  assert.equal(isInsideContextMenu(listbox, null), false)
})
