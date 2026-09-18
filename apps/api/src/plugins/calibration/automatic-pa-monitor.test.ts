import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrinterStatus } from '@printstream/shared'
import { observeAutomaticPa } from './automatic-pa-monitor.js'
import { automaticPaSetup } from './automatic-pa-protocol.js'

const setup = automaticPaSetup({ nozzle_temperature: '220', textured_plate_temp: '55', filament_max_volumetric_speed: '12', filament_id: 'GFA00', setting_id: 'preset' }, 'Textured PEI Plate', 2)
const reply = { result: 'success', nozzle_diameter: '0.4', filaments: [{ tray_id: 2, filament_id: 'GFA00', k_value: 0.025, n_coef: 1.4, confidence: 0 }] }

/** Advance a simulated printer without opening transport connections or waiting on real timers. */
function observe(stages: Array<{ stage: PrinterStatus['stage']; taskId?: string; online?: boolean }>, results = [reply], tick = 2000) {
  let index = 0
  let reads = 0
  const abort = new AbortController()
  const promise = observeAutomaticPa(setup, '0.4', {
    status: () => ({ online: true, taskId: null, ...stages[Math.min(index, stages.length - 1)] }) as PrinterStatus,
    result: async () => results[Math.min(reads++, results.length - 1)]!,
    now: () => index * tick,
    wait: async () => { index += 1 },
    signal: abort.signal
  })
  return { promise, abort, reads: () => reads }
}

test('an old finished state cannot be adopted as a fresh measurement', async () => {
  const run = observe([{ stage: 'finished' }], [reply], 30_000)
  await assert.rejects(run.promise, /did not report.*starting/)
  assert.equal(run.reads(), 0)
})

test('reads only after an observed active job finishes and retries missing results', async () => {
  const missing = { ...reply, filaments: [] }
  const run = observe([{ stage: 'idle' }, { stage: 'printing', taskId: 'calibration' }, { stage: 'finished', taskId: 'calibration' }], [missing, reply])
  assert.deepEqual(await run.promise, { k: 0.025, n: 1.4 })
  assert.equal(run.reads(), 2)
})

test('a different finished task, cancellation and disconnect all refuse results', async () => {
  for (const terminal of [
    { stage: 'finished' as const, taskId: 'another-job' },
    { stage: 'failed' as const },
    { stage: 'idle' as const, online: false }
  ]) {
    const run = observe([{ stage: 'printing', taskId: 'calibration' }, terminal])
    await assert.rejects(run.promise)
    assert.equal(run.reads(), 0)
  }
})

test('active jobs and missing measurements have bounded deadlines', async () => {
  await assert.rejects(observe([{ stage: 'printing' }], [reply], 600_000).promise, /timed out/)
  await assert.rejects(observe([{ stage: 'printing' }, { stage: 'finished' }], [{ ...reply, filaments: [] }], 30_000).promise, /matching.*measurement/)
})

test('shutdown refuses a result even if its request was already in flight', async () => {
  const run = observe([{ stage: 'printing' }, { stage: 'finished' }])
  run.abort.abort()
  await assert.rejects(run.promise, { name: 'AbortError' })
})

test('a new job during a result request cannot lend its measurement to this run', async () => {
  let status = { online: true, stage: 'printing', taskId: 'calibration' } as PrinterStatus
  await assert.rejects(observeAutomaticPa(setup, '0.4', {
    status: () => status,
    wait: async () => { status = { ...status, stage: 'finished' } },
    result: async () => {
      status = { ...status, stage: 'printing', taskId: 'another-job' }
      return reply
    },
    signal: new AbortController().signal
  }), /changed jobs/)
})
