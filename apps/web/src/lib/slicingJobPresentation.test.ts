import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingJob } from '@printstream/shared'
import {
  formatSlicingMetadataDisplay,
  formatSlicingProgress,
  getLatestSlicingProgressFrame,
  getSlicingJobStatusLabel,
  getSlicingProgressPercent
} from './slicingJobPresentation.js'

function buildJob(overrides: Partial<SlicingJob> = {}): SlicingJob {
  return {
    id: 'job-1',
    sourceFileId: 'file-1',
    sourceFileName: 'widget.3mf',
    slicerTargetId: 'bambustudio-2-6-1-55',
    outputFileId: null,
    outputFileName: null,
    target: {
      mode: 'manualProfile',
      printerModel: 'X1C',
      printerProfileId: 'printer-profile-1'
    },
    plate: 0,
    status: 'slicing',
    queuePosition: null,
    slicerName: 'Bambu Studio',
    metadata: undefined,
    output: [],
    error: null,
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:05.000Z',
    startedAt: '2026-05-24T00:00:01.000Z',
    finishedAt: null,
    cancelRequested: false,
    ...overrides
  }
}

test('formatSlicingProgress prefers the latest system line over noisy raw slicer output', () => {
  const job = buildJob({
    output: [
      { stream: 'system', text: 'Starting the slice', createdAt: '2026-05-24T00:00:01.000Z' },
      { stream: 'stderr', text: '[2026-05-24 01:37:56.001056] [0x00007f98e49b13c0] [warning] cli mode, Current OrcaSlicer Version 2.4.0-dev', createdAt: '2026-05-24T00:00:02.000Z' },
      { stream: 'stderr', text: 'Segmentation fault (core dumped)', createdAt: '2026-05-24T00:00:03.000Z' }
    ]
  })

  assert.equal(formatSlicingProgress(job, getLatestSlicingProgressFrame(job)), 'Starting the slice')
})

test('formatSlicingProgress still shows structured progress frames when present', () => {
  const job = buildJob({
    output: [
      { stream: 'system', text: 'Starting the slice', createdAt: '2026-05-24T00:00:01.000Z' },
      { stream: 'stdout', text: '{"message":"Generating supports","total_percent":42.4}', createdAt: '2026-05-24T00:00:02.000Z' }
    ]
  })

  assert.equal(formatSlicingProgress(job, getLatestSlicingProgressFrame(job)), 'Generating supports (42%)')
})

test('formatSlicingProgress names the phase when no structured or system output exists', () => {
  const noisyOutput = [
    { stream: 'stderr' as const, text: '[2026-05-24 01:37:56.001056] [0x00007f98e49b13c0] [warning] noisy cli banner', createdAt: '2026-05-24T00:00:02.000Z' }
  ]

  // Preparation (baking the project, authoring the machine) is its own phase and is the slow
  // part of a large project, so it must not claim the slicer is already running.
  const preparing = buildJob({ status: 'preparing', output: noisyOutput })
  assert.equal(formatSlicingProgress(preparing, getLatestSlicingProgressFrame(preparing)), 'Starting the slice...')

  const slicing = buildJob({ status: 'slicing', output: noisyOutput })
  assert.equal(formatSlicingProgress(slicing, getLatestSlicingProgressFrame(slicing)), 'Slicing...')
})

test('a finished job reports its outcome, not the progress frame it stopped on', () => {
  // The engine's last frame stays in the output after the job ends; showing it left a completed
  // slice reading "Exporting 3mf (97%)" beside a "Ready" chip.
  const output = [
    { stream: 'stdout' as const, text: '{"message":"Exporting 3mf","total_percent":97}', createdAt: '2026-05-24T00:00:02.000Z' },
    { stream: 'system' as const, text: 'Slicing complete', createdAt: '2026-05-24T00:00:03.000Z' }
  ]

  const ready = buildJob({ status: 'ready', outputFileName: 'widget.gcode.3mf', output })
  assert.equal(formatSlicingProgress(ready, getLatestSlicingProgressFrame(ready)), 'Slicing complete')

  // With no status line to fall back on (a finished job the list trimmed), the outcome still wins.
  const cancelled = buildJob({ status: 'cancelled', output: output.slice(0, 1) })
  assert.equal(formatSlicingProgress(cancelled, getLatestSlicingProgressFrame(cancelled)), 'Slicing cancelled')

  const failed = buildJob({ status: 'failed', error: 'Slicer CLI exited with code 139', output: output.slice(0, 1) })
  assert.equal(formatSlicingProgress(failed, getLatestSlicingProgressFrame(failed)), 'Slicer CLI exited with code 139')
})

test('getLatestSlicingProgressFrame reports the newest engine frame', () => {
  const job = buildJob({
    output: [
      { stream: 'stdout', text: '{"message":"Preparing plate","total_percent":10}', createdAt: '2026-05-24T00:00:02.000Z' },
      { stream: 'stdout', text: '{"message":"Finalizing","total_percent":100}', createdAt: '2026-05-24T00:00:03.000Z' }
    ]
  })

  const frame = getLatestSlicingProgressFrame(job)

  assert.equal(frame?.totalPercent, 100)
  assert.equal(formatSlicingProgress(job, frame), 'Finalizing (100%)')
  assert.equal(getSlicingProgressPercent(job, frame), 100)
})

test('an all-plates engine frame keeps the current plate in the slicing chip', () => {
  const job = buildJob({
    output: [
      {
        stream: 'stdout',
        text: '{"message":"Generating supports","plate_count":4,"plate_index":2,"total_percent":42}',
        createdAt: '2026-05-24T00:00:02.000Z'
      }
    ]
  })

  assert.equal(getSlicingJobStatusLabel(job), 'Slicing 2 of 4')
  assert.equal(formatSlicingProgress(job, getLatestSlicingProgressFrame(job)), 'Generating supports (42%)')
})

test('the fallback slicer keeps its plate in the chip through progress and heartbeat lines', () => {
  const job = buildJob({
    output: [
      { stream: 'system', text: 'Slicing plate 3 of 4', createdAt: '2026-05-24T00:00:01.000Z' },
      // The per-plate CLI reports its actual plate id with a local plate_count of one.
      { stream: 'stdout', text: '{"message":"Generating walls","plate_count":1,"plate_index":3,"total_percent":28}', createdAt: '2026-05-24T00:00:02.000Z' },
      { stream: 'system', text: 'Slicing... 2m elapsed', createdAt: '2026-05-24T00:00:03.000Z' }
    ]
  })

  assert.equal(getSlicingJobStatusLabel(job), 'Slicing 3 of 4')
})

test('a post-slice system phase removes stale plate context from the chip', () => {
  const job = buildJob({
    output: [
      { stream: 'system', text: 'Slicing plate 4 of 4', createdAt: '2026-05-24T00:00:01.000Z' },
      { stream: 'system', text: 'Combining per-plate exports into a single project artifact', createdAt: '2026-05-24T00:00:02.000Z' }
    ]
  })

  assert.equal(getSlicingJobStatusLabel(job), 'Slicing')
})

test('saving replaces the stale 100% engine frame with the real server phase', () => {
  const job = buildJob({
    status: 'saving',
    output: [
      { stream: 'stdout', text: '{"message":"Finalizing","total_percent":100}', createdAt: '2026-05-24T00:00:02.000Z' },
      { stream: 'system', text: 'Finishing the sliced file', createdAt: '2026-05-24T00:00:03.000Z' }
    ]
  })
  const frame = getLatestSlicingProgressFrame(job)

  assert.equal(formatSlicingProgress(job, frame), 'Finishing the sliced file')
  assert.equal(getSlicingProgressPercent(job, frame), null)
})

test('collection replaces the stale 100% frame before the job leaves slicing', () => {
  const job = buildJob({
    status: 'slicing',
    output: [
      { stream: 'stdout', text: '{"message":"Finalizing","total_percent":100}', createdAt: '2026-05-24T00:00:02.000Z' },
      { stream: 'system', text: 'Collecting the sliced file', createdAt: '2026-05-24T00:00:03.000Z' }
    ]
  })
  const frame = getLatestSlicingProgressFrame(job)

  assert.equal(formatSlicingProgress(job, frame), 'Collecting the sliced file')
  assert.equal(getSlicingProgressPercent(job, frame), null)
})

test('formatSlicingMetadataDisplay rolls multi-day print estimates into days', () => {
  assert.equal(
    formatSlicingMetadataDisplay({ estimatedPrintTimeSeconds: 2 * 3600 + 30 * 60, estimatedFilamentWeightGrams: null, estimatedFilamentCost: null }),
    '2h 30m'
  )
  assert.equal(
    formatSlicingMetadataDisplay({ estimatedPrintTimeSeconds: 30 * 3600, estimatedFilamentWeightGrams: null, estimatedFilamentCost: null }),
    '1d 6h'
  )
})
