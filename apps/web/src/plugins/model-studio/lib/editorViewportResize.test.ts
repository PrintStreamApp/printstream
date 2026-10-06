import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../../test-utils/jsdom'
import { createEditorViewportResize } from './editorViewportResize'

const dom = installJsdomGlobals()
after(() => dom.window.close())

test('resize caps DPR, updates the camera, and follows only an untouched visible home view', () => {
  const container = dom.window.document.createElement('div')
  let width = 600
  let height = 300
  Object.defineProperty(container, 'clientWidth', { get: () => width })
  Object.defineProperty(container, 'clientHeight', { get: () => height })
  const originalDpr = Object.getOwnPropertyDescriptor(dom.window, 'devicePixelRatio')
  Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: 3 })
  const sizes: Array<[number, number]> = []
  const ratios: number[] = []
  const renderer = {
    setPixelRatio: (ratio: number) => { ratios.push(ratio) },
    setSize: (w: number, h: number) => { sizes.push([w, h]) }
  } as unknown as Pick<THREE.WebGLRenderer, 'setPixelRatio' | 'setSize'>
  const camera = new THREE.PerspectiveCamera()
  let adjusted = false
  let framed = 0
  let rendered = 0
  const resize = createEditorViewportResize({
    container,
    renderer,
    camera,
    userAdjusted: () => adjusted,
    frameDefaultView: () => { framed += 1 },
    requestRender: () => { rendered += 1 }
  })

  try {
    resize()
    assert.deepEqual(sizes, [[600, 300]])
    assert.deepEqual(ratios, [2])
    assert.equal(camera.aspect, 2)
    assert.equal(framed, 1)

    adjusted = true
    width = 450
    height = 0
    resize()
    assert.deepEqual(sizes.at(-1), [450, 1])
    assert.equal(framed, 1)

    adjusted = false
    width = 0
    resize()
    assert.deepEqual(sizes.at(-1), [1, 1])
    assert.equal(framed, 1)
    assert.equal(rendered, 3)
  } finally {
    if (originalDpr) Object.defineProperty(dom.window, 'devicePixelRatio', originalDpr)
    else Reflect.deleteProperty(dom.window, 'devicePixelRatio')
  }
})
