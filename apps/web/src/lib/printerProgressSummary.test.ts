import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatSecondaryStageLabel,
  getPrinterAttentionSummary,
  shouldClearPendingDispatchedPrint,
  shouldPreferSecondaryStageLabel,
  shouldShowLiveSecondaryStageSummary
} from './printerProgressSummary'

test('formatSecondaryStageLabel maps Bambu numeric stage codes to readable labels', () => {
  assert.equal(formatSecondaryStageLabel({ stage: 'printing', subStage: '49' }), 'Heating chamber')
})

test('formatSecondaryStageLabel suppresses sentinel stage codes', () => {
  assert.equal(formatSecondaryStageLabel({ stage: 'printing', subStage: '0' }), null)
})

test('formatSecondaryStageLabel suppresses plain layer counters', () => {
  assert.equal(formatSecondaryStageLabel({ stage: 'printing', subStage: 'Layer 86 / 205' }), null)
})

test('shouldPreferSecondaryStageLabel keeps startup sub-stages visible while a new print is beginning', () => {
  assert.equal(shouldPreferSecondaryStageLabel({
    stage: 'printing',
    currentLayer: 1,
    remainingMinutes: 42
  }, 'Auto bed leveling'), true)
})

test('shouldPreferSecondaryStageLabel keeps sub-stages visible during preparing and heating stages', () => {
  assert.equal(shouldPreferSecondaryStageLabel({
    stage: 'preparing',
    currentLayer: null,
    remainingMinutes: 18
  }, 'Cleaning nozzle tip'), true)
})

test('shouldPreferSecondaryStageLabel falls back to remaining time after the print is underway', () => {
  assert.equal(shouldPreferSecondaryStageLabel({
    stage: 'printing',
    currentLayer: 6,
    remainingMinutes: 21
  }, 'Outer wall'), false)
})

test('shouldPreferSecondaryStageLabel keeps preparation sub-stages visible even when the printer reports printing', () => {
  assert.equal(shouldPreferSecondaryStageLabel({
    stage: 'printing',
    currentLayer: 6,
    remainingMinutes: 21
  }, 'Auto bed leveling'), true)
})

test('shouldPreferSecondaryStageLabel keeps H2D calibration-style sub-stages visible during active print startup', () => {
  assert.equal(shouldPreferSecondaryStageLabel({
    stage: 'printing',
    currentLayer: 4,
    remainingMinutes: 17
  }, 'Nozzle offset calibration'), true)
})

test('shouldShowLiveSecondaryStageSummary shows H2D startup labels even while the coarse stage is still idle-like', () => {
  assert.equal(shouldShowLiveSecondaryStageSummary({
    online: true,
    stage: 'idle',
    currentLayer: null,
    remainingMinutes: null
  }, 'Heating chamber'), true)
})

test('shouldShowLiveSecondaryStageSummary stays hidden when there is no meaningful secondary label', () => {
  assert.equal(shouldShowLiveSecondaryStageSummary({
    online: true,
    stage: 'idle',
    currentLayer: null,
    remainingMinutes: null
  }, null), false)
})

test('getPrinterAttentionSummary prefers the device error when one is present', () => {
  assert.deepEqual(getPrinterAttentionSummary({
    deviceError: { code: '0C008043', message: 'Cancelled by the printer' },
    hmsErrors: [{ code: '0C0003000002001C', message: 'Nozzle issue' }]
  }), {
    kind: 'deviceError',
    code: '0C008043',
    message: 'Cancelled by the printer',
    count: 1
  })
})

test('getPrinterAttentionSummary falls back to the first HMS alert when no device error is present', () => {
  assert.deepEqual(getPrinterAttentionSummary({
    deviceError: null,
    hmsErrors: [
      { code: '0C0003000002001C', message: 'Nozzle issue' },
      { code: '0C0003000002001D', message: 'Heatbed issue' }
    ]
  }), {
    kind: 'hmsError',
    code: '0C0003000002001C',
    message: 'Nozzle issue',
    count: 2
  })
})

test('getPrinterAttentionSummary returns null when the printer has no active attention state', () => {
  assert.equal(getPrinterAttentionSummary({
    deviceError: null,
    hmsErrors: []
  }), null)
})

test('shouldClearPendingDispatchedPrint clears the starting-soon state when an H2D startup sub-stage appears', () => {
  assert.equal(shouldClearPendingDispatchedPrint({
    online: true,
    stage: 'idle',
    progressPercent: null,
    subStage: '49'
  }), true)
})

test('shouldClearPendingDispatchedPrint keeps the starting-soon state for idle printers without meaningful activity', () => {
  assert.equal(shouldClearPendingDispatchedPrint({
    online: true,
    stage: 'idle',
    progressPercent: null,
    subStage: '0'
  }), false)
})