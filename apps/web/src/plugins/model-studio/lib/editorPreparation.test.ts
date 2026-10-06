import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retryEditorPreparationStatus, stopEditorPreparationStatusCheck } from './editorPreparation'

function recoveryFixture() {
  const events: string[] = []
  const retryRef = { current: (() => events.push('retry')) as (() => void) | null }
  const stopRef = { current: (() => events.push('stop')) as (() => void) | null }
  return { events, retryRef, stopRef }
}

test('retry clears callbacks before retrying save status', () => {
  const fixture = recoveryFixture()
  retryEditorPreparationStatus({
    retryRef: fixture.retryRef,
    stopRef: fixture.stopRef,
    preparingSave: true,
    setRecoveryMessage: (message) => fixture.events.push(`message:${message}`),
    setSaveReconciling: (value) => fixture.events.push(`save:${value}`),
    setSlicePhase: (phase) => fixture.events.push(`slice:${phase}`)
  })
  assert.deepEqual(fixture.events, ['message:null', 'save:true', 'retry'])
  assert.equal(fixture.retryRef.current, null)
  assert.equal(fixture.stopRef.current, null)
})

test('retrying slice status updates the slice phase', () => {
  const fixture = recoveryFixture()
  retryEditorPreparationStatus({
    retryRef: fixture.retryRef,
    stopRef: fixture.stopRef,
    preparingSave: false,
    setRecoveryMessage: (message) => fixture.events.push(`message:${message}`),
    setSaveReconciling: (value) => fixture.events.push(`save:${value}`),
    setSlicePhase: (phase) => fixture.events.push(`slice:${phase}`)
  })
  assert.deepEqual(fixture.events, ['message:null', 'slice:reconciling', 'retry'])
})

test('stop consumes the pending poll callback once', () => {
  const fixture = recoveryFixture()
  stopEditorPreparationStatusCheck({ retryRef: fixture.retryRef, stopRef: fixture.stopRef })
  stopEditorPreparationStatusCheck({ retryRef: fixture.retryRef, stopRef: fixture.stopRef })
  assert.deepEqual(fixture.events, ['stop'])
  assert.equal(fixture.retryRef.current, null)
  assert.equal(fixture.stopRef.current, null)
})
