import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEditorFrameLoop } from './editorFrameLoop'

/** Run scheduled callbacks deterministically without a browser or WebGL renderer. */
function withFrames(run: (step: (now: number) => void, pending: () => number) => void) {
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 0
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextId, callback)
    return nextId
  }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }

  const step = (now: number) => {
    const entry = frames.entries().next().value
    assert.ok(entry, 'expected a pending frame')
    const [id, callback] = entry
    frames.delete(id)
    callback(now)
  }
  try {
    run(step, () => frames.size)
  } finally {
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
  }
}

test('renders on demand, on the idle safety tick, and once more for deferred selection fit', () => {
  withFrames((step, pending) => {
    let renders = 0
    let renderAgain = false
    const loop = createEditorFrameLoop({
      isCovered: () => false,
      advanceCamera: () => false,
      isInteracting: () => false,
      render: () => { renders += 1; return renderAgain },
      recomputePlacementWarnings: () => undefined
    })
    loop.start()
    assert.equal(renders, 1)
    step(100)
    assert.equal(renders, 1)
    step(250)
    assert.equal(renders, 2)

    renderAgain = true
    loop.requestRender()
    step(251)
    renderAgain = false
    step(252)
    assert.equal(renders, 4)
    loop.dispose()
    assert.equal(pending(), 0)
  })
})

test('covered frames pause work; drag release repaints and recomputes placement immediately', () => {
  withFrames((step, pending) => {
    let covered = false
    let interacting = false
    let cameras = 0
    let renders = 0
    let warnings = 0
    const loop = createEditorFrameLoop({
      isCovered: () => covered,
      advanceCamera: () => { cameras += 1; return false },
      isInteracting: () => interacting,
      render: () => { renders += 1; return false },
      recomputePlacementWarnings: () => { warnings += 1 }
    })
    loop.start()
    covered = true
    step(50)
    assert.deepEqual([cameras, renders, warnings], [1, 1, 0])

    covered = false
    interacting = true
    step(51)
    assert.deepEqual([cameras, renders, warnings], [2, 2, 0])
    interacting = false
    step(52)
    assert.deepEqual([cameras, renders, warnings], [3, 3, 1])
    for (let i = 0; i < 12; i += 1) step(53 + i)
    assert.equal(warnings, 2, 'the fifteenth active frame also checks placement')
    loop.dispose()
    assert.equal(pending(), 0)
  })
})
