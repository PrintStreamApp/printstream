import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintStartOptionSelection, PrinterPrintStartOptions } from '@printstream/shared'
import {
  applyRecordedPrintStartOptions,
  DEFAULT_STORED_PRINT_START_OPTIONS,
  parseStoredPrintStartOptions,
  resolvePrintStartPreferenceDefaults,
  type StoredPrintStartOptions
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
// The print dialog's seed for a re-print: the job's own recorded options layered over the
// remembered preferences, then clamped to the selected printer (PrintModal composes the two
// in that order). Issue #97: the dialog could not show Auto for a job that chose Auto.
function seedForReprint(
  remembered: StoredPrintStartOptions,
  recorded: Partial<PrintStartOptionSelection> | null,
  printStartOptions?: PrinterPrintStartOptions | null
): StoredPrintStartOptions {
  return resolvePrintStartPreferenceDefaults(
    applyRecordedPrintStartOptions(remembered, recorded),
    printStartOptions
  )
}

const AUTO_CAPABLE_PRINTER: PrinterPrintStartOptions = {
  bedLevel: { supported: true, autoSupported: true, current: null },
  vibrationCompensation: { supported: true, current: null },
  flowCalibration: { supported: true, autoSupported: true, current: null },
  firstLayerInspection: { supported: true, current: null },
  timelapse: { supported: true, current: null },
  filamentDynamicsCalibration: { supported: false, current: null },
  nozzleOffsetCalibration: { supported: true, current: null }
}

test('re-printing an auto bed-leveling job shows Auto on a printer that supports it', () => {
  const seeded = seedForReprint(
    { ...DEFAULT_STORED_PRINT_START_OPTIONS, bedLevel: 'off' },
    { bedLevel: 'auto' },
    AUTO_CAPABLE_PRINTER
  )

  assert.equal(seeded.bedLevel, 'auto')
})

test('a re-printed job overrides the remembered preference for every option it recorded', () => {
  const remembered: StoredPrintStartOptions = {
    bedLevel: 'off',
    vibrationCompensation: false,
    flowCalibration: 'off',
    timelapse: false,
    nozzleOffsetCalibration: 'off'
  }
  const seeded = seedForReprint(remembered, {
    bedLevel: 'auto',
    vibrationCompensation: true,
    flowCalibration: 'auto',
    timelapse: true,
    nozzleOffsetCalibration: 'on'
  }, AUTO_CAPABLE_PRINTER)

  assert.deepEqual(seeded, {
    bedLevel: 'auto',
    vibrationCompensation: true,
    flowCalibration: 'auto',
    timelapse: true,
    nozzleOffsetCalibration: 'on'
  })
})

// A partially-recorded job (written before the options were persisted, so it knows only
// bedLevel) must not drag the other four to the schema defaults; they still come from this
// browser's preferences, exactly as a fresh print would.
test('options a job did not record fall back to the remembered preference', () => {
  const remembered: StoredPrintStartOptions = {
    bedLevel: 'auto',
    vibrationCompensation: true,
    flowCalibration: 'auto',
    timelapse: true,
    nozzleOffsetCalibration: 'on'
  }
  const seeded = seedForReprint(remembered, { bedLevel: 'off' }, AUTO_CAPABLE_PRINTER)

  assert.deepEqual(seeded, { ...remembered, bedLevel: 'off' })
})

test('a job with nothing recorded seeds entirely from the remembered preference', () => {
  const seeded = seedForReprint(DEFAULT_STORED_PRINT_START_OPTIONS, null, AUTO_CAPABLE_PRINTER)

  assert.deepEqual(seeded, DEFAULT_STORED_PRINT_START_OPTIONS)
})

// Restoring a choice must never show a value the selected printer cannot perform: clamping
// runs after the job's options are layered on, not before.
test('a restored auto is clamped to on for a printer without auto bed leveling', () => {
  const seeded = seedForReprint(DEFAULT_STORED_PRINT_START_OPTIONS, { bedLevel: 'auto' }, {
    ...AUTO_CAPABLE_PRINTER,
    bedLevel: { supported: true, autoSupported: false, current: null }
  })

  assert.equal(seeded.bedLevel, 'on')
})
