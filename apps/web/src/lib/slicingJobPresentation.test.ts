import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingJob } from '@printstream/shared'
import { formatSlicingMetadataDisplay, formatSlicingProgress, getLatestSlicingProgressFrame } from './slicingJobPresentation.js'

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
      { stream: 'system', text: 'Submitted to slicer service', createdAt: '2026-05-24T00:00:01.000Z' },
      { stream: 'stderr', text: '[2026-05-24 01:37:56.001056] [0x00007f98e49b13c0] [warning] cli mode, Current OrcaSlicer Version 2.4.0-dev', createdAt: '2026-05-24T00:00:02.000Z' },
      { stream: 'stderr', text: 'Segmentation fault (core dumped)', createdAt: '2026-05-24T00:00:03.000Z' }
    ]
  })

  assert.equal(formatSlicingProgress(job, getLatestSlicingProgressFrame(job)), 'Submitted to slicer service')
})

test('formatSlicingProgress still shows structured progress frames when present', () => {
  const job = buildJob({
    output: [
      { stream: 'system', text: 'Submitted to slicer service', createdAt: '2026-05-24T00:00:01.000Z' },
      { stream: 'stdout', text: '{"message":"Generating supports","total_percent":42.4}', createdAt: '2026-05-24T00:00:02.000Z' }
    ]
  })

  assert.equal(formatSlicingProgress(job, getLatestSlicingProgressFrame(job)), 'Generating supports (42%)')
})

test('formatSlicingProgress falls back to a generic active message when no structured or system output exists', () => {
  const job = buildJob({
    output: [
      { stream: 'stderr', text: '[2026-05-24 01:37:56.001056] [0x00007f98e49b13c0] [warning] noisy cli banner', createdAt: '2026-05-24T00:00:02.000Z' }
    ]
  })

  assert.equal(formatSlicingProgress(job, getLatestSlicingProgressFrame(job)), 'Slicer is still processing...')
})

test('getLatestSlicingProgressFrame uses explicit machine-switch stage markers for two-pass slicing', () => {
  const job = buildJob({
    output: [
      { stream: 'system', text: 'Normalizing project with upstream machine-switch export', createdAt: '2026-05-24T00:00:01.000Z' },
      { stream: 'stdout', text: '{"message":"Preparing plate","total_percent":100}', createdAt: '2026-05-24T00:00:02.000Z' },
      { stream: 'system', text: 'Slicing normalized project', createdAt: '2026-05-24T00:00:03.000Z' },
      { stream: 'stdout', text: '{"message":"Generating supports","total_percent":4}', createdAt: '2026-05-24T00:00:04.000Z' }
    ]
  })

  const frame = getLatestSlicingProgressFrame(job)

  assert.equal(frame?.stageIndex, 2)
  assert.equal(frame?.totalStages, 2)
  assert.equal(Math.round(frame?.displayPercent ?? 0), 52)
  assert.equal(formatSlicingProgress(job, frame), 'Stage 2 of 2: Generating supports (4%)')
})

test('getLatestSlicingProgressFrame leaves single-stage progress unchanged', () => {
  const job = buildJob({
    output: [
      { stream: 'stdout', text: '{"message":"Finalizing","total_percent":100}', createdAt: '2026-05-24T00:00:03.000Z' }
    ]
  })

  const frame = getLatestSlicingProgressFrame(job)

  assert.equal(frame?.stageIndex, 1)
  assert.equal(frame?.totalStages, 1)
  assert.equal(frame?.displayPercent, 100)
  assert.equal(formatSlicingProgress(job, frame), 'Finalizing (100%)')
})

test('formatSlicingProgress surfaces explicit machine-switch stage messages even before pipe progress arrives', () => {
  const job = buildJob({
    output: [
      { stream: 'system', text: 'Normalizing project with upstream machine-switch export', createdAt: '2026-05-24T00:00:01.000Z' }
    ]
  })

  assert.equal(formatSlicingProgress(job, getLatestSlicingProgressFrame(job)), 'Stage 1 of 2: Normalizing project')
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