import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installEditorOrbitActivity } from './editorOrbitActivity'

test('orbit gestures update live activity and release both listeners on teardown', () => {
  const orbit = new EventTarget()
  let active = false
  let adjusted = false
  const release = installEditorOrbitActivity(
    orbit,
    () => {
      active = true
      adjusted = true
    },
    () => { active = false }
  )

  orbit.dispatchEvent(new Event('start'))
  assert.equal(active, true)
  assert.equal(adjusted, true)
  orbit.dispatchEvent(new Event('end'))
  assert.equal(active, false)

  adjusted = false
  release()
  orbit.dispatchEvent(new Event('start'))
  assert.equal(active, false)
  assert.equal(adjusted, false)
})
