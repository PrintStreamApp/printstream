import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEditorSavePreparation } from './editorSavePreparation'

function createFixture() {
  const abortRef = { current: null as AbortController | null }
  const retryRef = { current: null as { kind: 'version' } | { kind: 'saveAs'; name: string; destinationFolderId: string | null } | null }
  const errorRef = { current: 'old error' as string | null }
  const finalizingRef = { current: true }
  const recoveryRetryRef = { current: (() => undefined) as (() => void) | null }
  const recoveryStopRef = { current: (() => undefined) as (() => void) | null }
  const events: string[] = []
  const preparation = createEditorSavePreparation({
    abortRef,
    retryRef,
    errorRef,
    finalizingRef,
    recoveryRetryRef,
    recoveryStopRef,
    setPreparing: (value) => { events.push(`preparing:${value}`) },
    setPhase: (value) => { events.push(`phase:${value}`) },
    setError: (value) => { events.push(`error:${value}`) },
    setFinalizing: (value) => { events.push(`finalizing:${value}`) },
    setReconciling: (value) => { events.push(`reconciling:${value}`) },
    setRecoveryMessage: (value) => { events.push(`recovery:${value}`) },
    setProgress: (value) => { events.push(`progress:${value === null ? 'clear' : 'update'}`) }
  })
  return { preparation, abortRef, retryRef, errorRef, finalizingRef, recoveryRetryRef, recoveryStopRef, events }
}

test('save preparation retries abort prior work and reset both save paths alike', () => {
  const fixture = createFixture()
  const first = fixture.preparation.begin({ kind: 'version' }, 'checking')
  assert.equal(first.signal?.aborted, false)
  assert.deepEqual(fixture.retryRef.current, { kind: 'version' })
  assert.equal(fixture.errorRef.current, null)
  assert.equal(fixture.finalizingRef.current, false)
  assert.equal(fixture.recoveryRetryRef.current, null)
  assert.equal(fixture.recoveryStopRef.current, null)
  assert.deepEqual(fixture.events, [
    'preparing:true', 'error:null', 'phase:checking', 'finalizing:false',
    'reconciling:false', 'recovery:null', 'progress:clear'
  ])

  fixture.events.length = 0
  const second = fixture.preparation.begin({ kind: 'saveAs', name: 'Part.3mf', destinationFolderId: null }, 'creating')
  assert.equal(first.signal?.aborted, true)
  assert.equal(second.signal?.aborted, false)
  assert.deepEqual(fixture.retryRef.current, { kind: 'saveAs', name: 'Part.3mf', destinationFolderId: null })
  assert.deepEqual(fixture.events, [
    'preparing:true', 'error:null', 'phase:creating', 'finalizing:false',
    'reconciling:false', 'recovery:null', 'progress:clear'
  ])
})

test('commit and reconciliation close the cancellation window before rendering state', () => {
  const fixture = createFixture()
  const lifecycle = fixture.preparation.begin({ kind: 'version' }, 'checking')
  fixture.events.length = 0
  lifecycle.onCommitStart?.()
  assert.equal(fixture.finalizingRef.current, true)
  assert.deepEqual(fixture.events, ['finalizing:true'])

  fixture.finalizingRef.current = false
  const stop = () => undefined
  lifecycle.onReconciliationStart?.(stop)
  assert.equal(fixture.finalizingRef.current, true)
  assert.equal(fixture.recoveryStopRef.current, stop)
  assert.equal(fixture.events.at(-1), 'reconciling:true')

  fixture.finalizingRef.current = false
  const retry = () => undefined
  lifecycle.onReconciliationRequired?.(retry, 'Check save status', stop)
  assert.equal(fixture.finalizingRef.current, true)
  assert.equal(fixture.recoveryRetryRef.current, retry)
  assert.equal(fixture.recoveryStopRef.current, stop)
  assert.deepEqual(fixture.events.slice(-2), ['recovery:Check save status', 'reconciling:false'])

  lifecycle.onError?.('Upload failed')
  assert.equal(fixture.errorRef.current, 'Upload failed')
  assert.equal(fixture.events.at(-1), 'error:Upload failed')
})

test('save cancellation aborts before commit and refuses to abort after commit starts', () => {
  const fixture = createFixture()
  const first = fixture.preparation.begin({ kind: 'version' }, 'checking')
  fixture.events.length = 0
  assert.equal(fixture.preparation.cancelPending(), true)
  assert.equal(first.signal?.aborted, true)
  assert.equal(fixture.abortRef.current, null)
  assert.equal(fixture.retryRef.current, null)
  assert.deepEqual(fixture.events, ['preparing:false'])

  const committed = fixture.preparation.begin({ kind: 'version' }, 'checking')
  committed.onCommitStart?.()
  fixture.events.length = 0
  assert.equal(fixture.preparation.cancelPending(), false)
  assert.equal(committed.signal?.aborted, false)
  assert.deepEqual(fixture.events, [])
})

test('dismissing a save error clears its retry and closes the dialog', () => {
  const fixture = createFixture()
  fixture.preparation.begin({ kind: 'version' }, 'checking')
  fixture.errorRef.current = 'Upload failed'
  fixture.events.length = 0
  fixture.preparation.dismissError()
  assert.equal(fixture.errorRef.current, null)
  assert.equal(fixture.retryRef.current, null)
  assert.deepEqual(fixture.events, ['error:null', 'preparing:false'])
})
