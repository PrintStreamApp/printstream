import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { installJsdomGlobals } from '../../../test-utils/jsdom'
import { installEditorWindowListeners } from './editorWindowListeners'

const dom = installJsdomGlobals()
after(() => dom.window.close())

test('viewport window listeners resize, dismiss menus on right click, and clean up', () => {
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  const originalKeyboardEvent = Object.getOwnPropertyDescriptor(globalThis, 'KeyboardEvent')
  const container = dom.window.document.createElement('div')
  const menu = dom.window.document.createElement('div')
  menu.setAttribute('role', 'menu')
  dom.window.document.body.append(menu)

  let observed: Element | null = null
  let disconnected = false
  const observer = { notifyResize: null as (() => void) | null }
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      observer.notifyResize = () => callback([], this as unknown as ResizeObserver)
    }
    observe(element: Element) { observed = element }
    disconnect() { disconnected = true }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver })
  Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: dom.window.KeyboardEvent })

  try {
    const suppressEditorEscapeRef = { current: false }
    let resizeCount = 0
    const escapeStates: boolean[] = []
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') escapeStates.push(suppressEditorEscapeRef.current)
    })
    const release = installEditorWindowListeners({
      container,
      onResize: () => { resizeCount += 1 },
      suppressEditorEscapeRef
    })

    assert.equal(observed, container)
    dom.window.dispatchEvent(new dom.window.Event('resize'))
    observer.notifyResize?.()
    assert.equal(resizeCount, 2)

    dom.window.dispatchEvent(new dom.window.Event('contextmenu'))
    assert.deepEqual(escapeStates, [true])
    assert.equal(suppressEditorEscapeRef.current, false)

    release()
    assert.equal(disconnected, true)
    dom.window.dispatchEvent(new dom.window.Event('resize'))
    dom.window.dispatchEvent(new dom.window.Event('contextmenu'))
    assert.equal(resizeCount, 2)
    assert.deepEqual(escapeStates, [true])
  } finally {
    menu.remove()
    if (originalObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalObserver)
    else Reflect.deleteProperty(globalThis, 'ResizeObserver')
    if (originalKeyboardEvent) Object.defineProperty(globalThis, 'KeyboardEvent', originalKeyboardEvent)
    else Reflect.deleteProperty(globalThis, 'KeyboardEvent')
  }
})
