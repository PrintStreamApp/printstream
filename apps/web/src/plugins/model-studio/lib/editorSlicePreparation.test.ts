import assert from 'node:assert/strict'
import test from 'node:test'
import type { LibraryFile, SlicingTarget } from '@printstream/shared'
import { buildSceneEdit, seedEmptyEditorState } from './editorModel'
import {
  cancelEditorSlicePreparation,
  startEditorSlicePreparation,
  type EditorSliceRequest,
  type SliceStageCallbacks
} from './editorSlicePreparation'

test('canceling a slice attempt stops recovery polling and aborts its pending handoff', () => {
  const abort = new AbortController()
  const abortRef = { current: abort as AbortController | null }
  const events: string[] = []
  const recoveryRetryRef = { current: (() => events.push('retry')) as (() => void) | null }
  const recoveryStopRef = { current: (() => events.push('stop')) as (() => void) | null }

  cancelEditorSlicePreparation({
    abortRef,
    recoveryRetryRef,
    recoveryStopRef,
    setRecoveryMessage: (message) => events.push(`message:${message}`),
    setProgress: (progress) => events.push(`progress:${progress === null ? 'clear' : 'update'}`),
    setPreparing: (preparing) => events.push(`preparing:${preparing}`)
  })

  assert.equal(abort.signal.aborted, true)
  assert.equal(abortRef.current, null)
  assert.equal(recoveryRetryRef.current, null)
  assert.equal(recoveryStopRef.current, null)
  assert.deepEqual(events, ['stop', 'message:null', 'progress:clear', 'preparing:false'])
})

type SliceOptions = Parameters<typeof startEditorSlicePreparation>[1]

function preparationOptions(onSlice: NonNullable<SliceOptions['onSlice']>) {
  const state = seedEmptyEditorState()
  const phases: string[] = []
  const preparing: boolean[] = []
  const errors: Array<string | null> = []
  const abortRef = { current: null as AbortController | null }
  const lastPlateRef = { current: 0 }
  const recoveryRetryRef = { current: null as (() => void) | null }
  const recoveryStopRef = { current: null as (() => void) | null }
  const options: SliceOptions = {
    stateRef: { current: state },
    abortRef,
    lastPlateRef,
    recoveryRetryRef,
    recoveryStopRef,
    onSlice,
    contentBase: null,
    buildSceneEdit,
    authorFilamentConfigs: async (edit) => edit,
    makeStageSnapshot: (_edit, callbacks) => async () => {
      callbacks.onPhase('applying')
      callbacks.onReconciliationStart(() => {})
      return 'prepared-snapshot'
    },
    setError: (value) => errors.push(value),
    setPhase: (value) => phases.push(value),
    setRecoveryMessage: () => {},
    setProgress: () => {},
    setPreparing: (value) => preparing.push(value),
    waitForPaint: async () => {}
  }
  return { options, phases, preparing, errors, abortRef, lastPlateRef, recoveryStopRef }
}

test('slice preparation hands the authored scene to the host and closes after a cached handoff', async () => {
  const received = { current: null as EditorSliceRequest | null }
  const harness = preparationOptions(async (request) => {
    received.current = request
    const result = await request.stageSnapshot({} as SlicingTarget, null, request.signal)
    assert.equal(result, 'prepared-snapshot')
  })
  const adopted = { id: 'adopted' } as LibraryFile
  harness.options.sourceFile = adopted
  const task = startEditorSlicePreparation(2, harness.options)
  assert.ok(task)
  assert.deepEqual(harness.preparing, [true])
  await task

  assert.equal(received.current?.plate, 2)
  assert.equal(received.current?.contentBase, null)
  assert.equal(received.current?.sourceFile, adopted)
  assert.equal(harness.lastPlateRef.current, 2)
  assert.deepEqual(harness.phases, ['collecting', 'applying', 'reconciling'])
  assert.deepEqual(harness.preparing, [true, false])
  assert.equal(harness.abortRef.current, null)
  assert.equal(typeof harness.recoveryStopRef.current, 'function')
  assert.deepEqual(harness.errors, [null])
})

test('an aborted older attempt cannot clear a newer preparation dialog', async () => {
  const resolveAuthoring: Array<() => void> = []
  const handedOff: number[] = []
  const harness = preparationOptions(async (request) => { handedOff.push(request.plate) })
  harness.options.authorFilamentConfigs = async (edit) => new Promise((resolve) => {
    resolveAuthoring.push(() => resolve(edit))
  })

  const first = startEditorSlicePreparation(1, harness.options)
  assert.ok(first)
  await Promise.resolve()
  assert.equal(resolveAuthoring.length, 1)
  const second = startEditorSlicePreparation(2, harness.options)
  assert.ok(second)
  await Promise.resolve()
  assert.equal(resolveAuthoring.length, 2)

  resolveAuthoring[0]!()
  await first
  assert.deepEqual(harness.preparing, [true, true], 'older abort does not settle the newer dialog')
  assert.equal(harness.abortRef.current?.signal.aborted, false)

  resolveAuthoring[1]!()
  await second
  assert.deepEqual(handedOff, [2])
  assert.deepEqual(harness.preparing, [true, true, false])
})

test('a current handoff failure logs and surfaces a preparation error', async () => {
  const harness = preparationOptions(async () => { throw new Error('slice host failed') })
  const reported: unknown[] = []
  harness.options.reportError = (error) => reported.push(error)
  await startEditorSlicePreparation(1, harness.options)

  assert.equal((reported[0] as Error).message, 'slice host failed')
  assert.deepEqual(harness.errors, [null, 'slice host failed'])
  assert.deepEqual(harness.preparing, [true, false])
  assert.equal(harness.abortRef.current, null)
})

test('late recovery callbacks from a superseded slice leave the new dialog alone', async () => {
  const resumeFirst = { current: null as (() => void) | null }
  const blockedFirst = new Promise<void>((resolve) => { resumeFirst.current = resolve })
  let firstReady: (() => void) | null = null
  const firstPrepared = new Promise<void>((resolve) => { firstReady = resolve })
  const callbacks: SliceStageCallbacks[] = []
  const harness = preparationOptions(async (request) => {
    if (request.plate === 1) await blockedFirst
  })
  harness.options.makeStageSnapshot = (_edit, value) => {
    callbacks.push(value)
    if (callbacks.length === 1) firstReady?.()
    return async () => null
  }

  const first = startEditorSlicePreparation(1, harness.options)
  await firstPrepared
  const second = startEditorSlicePreparation(2, harness.options)
  await second
  const phases = [...harness.phases]
  callbacks[0]!.onPhase('uploading')
  callbacks[0]!.onReconciliationRequired(() => {}, 'old status', () => {})
  assert.deepEqual(harness.phases, phases)
  assert.equal(harness.recoveryStopRef.current, null)

  resumeFirst.current?.()
  await first
  assert.deepEqual(harness.preparing, [true, true, false])
})
