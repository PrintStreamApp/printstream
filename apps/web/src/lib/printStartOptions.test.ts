import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrinterPrintStartOptions } from '@printstream/shared'
import {
  DEFAULT_STORED_PRINT_START_OPTIONS,
  parseStoredPrintStartOptions,
  resolvePrintStartPreferenceDefaults
} from './printStartOptions'

test('parseStoredPrintStartOptions keeps legacy stored values and fills new toggles with defaults', () => {
  const parsed = parseStoredPrintStartOptions(JSON.stringify({
    bedLevel: 'auto',
    flowCalibration: 'on',
    timelapse: true,
    nozzleOffsetCalibration: 'off'
  }))

  assert.deepEqual(parsed, {
    ...DEFAULT_STORED_PRINT_START_OPTIONS,
    bedLevel: 'auto',
    flowCalibration: 'on',
    timelapse: true,
    nozzleOffsetCalibration: 'off'
  })
})

test('resolvePrintStartPreferenceDefaults ignores printer current values for remembered options', () => {
  const remembered = {
    ...DEFAULT_STORED_PRINT_START_OPTIONS,
    vibrationCompensation: false
  }
  const printStartOptions: PrinterPrintStartOptions = {
    bedLevel: { supported: true, autoSupported: true, current: null },
    vibrationCompensation: { supported: true, current: true },
    flowCalibration: { supported: true, autoSupported: true, current: null },
    firstLayerInspection: { supported: true, current: null },
    timelapse: { supported: true, current: null },
    filamentDynamicsCalibration: { supported: false, current: null },
    nozzleOffsetCalibration: { supported: true, current: null }
  }

  assert.deepEqual(resolvePrintStartPreferenceDefaults(remembered, printStartOptions), remembered)
})

test('resolvePrintStartPreferenceDefaults clamps unsupported auto to on so the dropdown is not blank', () => {
  const remembered = {
    ...DEFAULT_STORED_PRINT_START_OPTIONS,
    bedLevel: 'auto' as const,
    flowCalibration: 'auto' as const
  }
  // A printer (e.g. P1S) that supports the toggles but not the "auto" mode.
  const printStartOptions: PrinterPrintStartOptions = {
    bedLevel: { supported: true, autoSupported: false, current: null },
    vibrationCompensation: { supported: true, current: true },
    flowCalibration: { supported: true, autoSupported: false, current: null },
    firstLayerInspection: { supported: true, current: null },
    timelapse: { supported: true, current: null },
    filamentDynamicsCalibration: { supported: false, current: null },
    nozzleOffsetCalibration: { supported: true, current: null }
  }

  assert.deepEqual(resolvePrintStartPreferenceDefaults(remembered, printStartOptions), {
    ...remembered,
    bedLevel: 'on',
    flowCalibration: 'on'
  })
})

test('resolvePrintStartPreferenceDefaults leaves explicit on/off values untouched', () => {
  const remembered = {
    ...DEFAULT_STORED_PRINT_START_OPTIONS,
    bedLevel: 'off' as const,
    flowCalibration: 'on' as const
  }
  const printStartOptions: PrinterPrintStartOptions = {
    bedLevel: { supported: true, autoSupported: false, current: null },
    vibrationCompensation: { supported: true, current: true },
    flowCalibration: { supported: true, autoSupported: false, current: null },
    firstLayerInspection: { supported: true, current: null },
    timelapse: { supported: true, current: null },
    filamentDynamicsCalibration: { supported: false, current: null },
    nozzleOffsetCalibration: { supported: true, current: null }
  }

  assert.equal(resolvePrintStartPreferenceDefaults(remembered, printStartOptions), remembered)
})

test('resolvePrintStartPreferenceDefaults returns remembered unchanged when no printer options are known', () => {
  const remembered = {
    ...DEFAULT_STORED_PRINT_START_OPTIONS,
    bedLevel: 'auto' as const
  }
  assert.equal(resolvePrintStartPreferenceDefaults(remembered, null), remembered)
})