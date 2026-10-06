import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installEditorRenderTriggers } from './editorRenderTriggers'

test('camera and pointer changes render with current state only while mounted', () => {
  const canvas = new EventTarget() as HTMLElement
  const orbit = new EventTarget()
  const frames: number[] = []
  let revision = 1
  const release = installEditorRenderTriggers(canvas, orbit, () => frames.push(revision))

  orbit.dispatchEvent(new Event('change'))
  canvas.dispatchEvent(new Event('pointermove'))
  revision = 2
  orbit.dispatchEvent(new Event('change'))
  assert.deepEqual(frames, [1, 1, 2])

  release()
  orbit.dispatchEvent(new Event('change'))
  canvas.dispatchEvent(new Event('pointermove'))
  assert.deepEqual(frames, [1, 1, 2])
})
