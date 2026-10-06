import assert from 'node:assert/strict'
import test from 'node:test'
import { installJsdomGlobals } from '../../../test-utils/jsdom'

installJsdomGlobals()

const { installEditorContextRecovery } = await import('./editorContextRecovery')

test('context loss rebuilds once per interval and teardown ignores deliberate loss', () => {
  const canvas = document.createElement('canvas')
  const lastRebuildRef = { current: 0 }
  let timestamp = 100_000
  let rebuilds = 0
  const release = installEditorContextRecovery({
    canvas,
    lastRebuildRef,
    onRebuild: () => { rebuilds += 1 },
    now: () => timestamp
  })
  const loseContext = () => {
    const event = new window.Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(event)
    return event
  }

  assert.equal(loseContext().defaultPrevented, true)
  assert.equal(rebuilds, 1)
  assert.equal(lastRebuildRef.current, 100_000)

  timestamp = 129_999
  assert.equal(loseContext().defaultPrevented, true)
  assert.equal(rebuilds, 1)
  timestamp = 130_000
  loseContext()
  assert.equal(rebuilds, 2)

  release()
  timestamp = 200_000
  assert.equal(loseContext().defaultPrevented, false)
  assert.equal(rebuilds, 2)
})
