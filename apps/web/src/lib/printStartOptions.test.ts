import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintStartOptionSelection, PrinterPrintStartOptions } from '@printstream/shared'
import {
  applyRecordedPrintStartOptions,
  arePrintStartModesAvailable,
  DEFAULT_PRINT_START_OPTIONS,
  resolvePrintStartDefaults,
  type PrintStartDialogOptions
} from './printStartOptions'

test('resolvePrintStartDefaults ignores printer current values for dialog defaults', () => {
  const defaults = {
    ...DEFAULT_PRINT_START_OPTIONS,
    vibrationCompensation: false
  }
  const printStartOptions: PrinterPrintStartOptions = {
    bedLevel: { supported: true, autoSupported: true, current: null },
    vibrationCompensation: { supported: true, current: true },
    flowCalibration: { supported: true, autoSupported: true, current: null },
    firstLayerInspection: { supported: true, current: null },
    timelapse: { supported: true, current: null },
    internalTimelapseStorage: { supported: true, current: null },
    externalFilamentChangeAssist: { supported: true, current: null },
    filamentDynamicsCalibration: { supported: false, current: null },
    nozzleOffsetCalibration: { supported: true, current: null }
  }

  assert.deepEqual(resolvePrintStartDefaults(defaults, printStartOptions), defaults)
})

test('resolvePrintStartDefaults clamps unsupported auto to on so the dropdown is not blank', () => {
  const defaults = {
    ...DEFAULT_PRINT_START_OPTIONS,
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
    internalTimelapseStorage: { supported: false, current: null },
    externalFilamentChangeAssist: { supported: false, current: null },
    filamentDynamicsCalibration: { supported: false, current: null },
    nozzleOffsetCalibration: { supported: true, current: null }
  }

  assert.deepEqual(resolvePrintStartDefaults(defaults, printStartOptions), {
    ...defaults,
    bedLevel: 'on',
    flowCalibration: 'on'
  })
})

test('resolvePrintStartDefaults leaves explicit on/off values untouched', () => {
  const defaults = {
    ...DEFAULT_PRINT_START_OPTIONS,
    bedLevel: 'off' as const,
    flowCalibration: 'on' as const
  }
  const printStartOptions: PrinterPrintStartOptions = {
    bedLevel: { supported: true, autoSupported: false, current: null },
    vibrationCompensation: { supported: true, current: true },
    flowCalibration: { supported: true, autoSupported: false, current: null },
    firstLayerInspection: { supported: true, current: null },
    timelapse: { supported: true, current: null },
    internalTimelapseStorage: { supported: false, current: null },
    externalFilamentChangeAssist: { supported: false, current: null },
    filamentDynamicsCalibration: { supported: false, current: null },
    nozzleOffsetCalibration: { supported: true, current: null }
  }

  assert.equal(resolvePrintStartDefaults(defaults, printStartOptions), defaults)
})

test('resolvePrintStartDefaults returns defaults unchanged when no printer options are known', () => {
  const defaults = {
    ...DEFAULT_PRINT_START_OPTIONS,
    bedLevel: 'auto' as const
  }
  assert.equal(resolvePrintStartDefaults(defaults, null), defaults)
})

test('arePrintStartModesAvailable rejects only visible auto modes the target cannot represent', () => {
  const onOffOnly: PrinterPrintStartOptions = {
    ...AUTO_CAPABLE_PRINTER,
    bedLevel: { supported: true, autoSupported: false, current: null },
    flowCalibration: { supported: true, autoSupported: false, current: null }
  }

  assert.equal(arePrintStartModesAvailable(DEFAULT_PRINT_START_OPTIONS, onOffOnly), false)
  assert.equal(arePrintStartModesAvailable({ bedLevel: 'on', flowCalibration: 'off' }, onOffOnly), true)
  assert.equal(arePrintStartModesAvailable(DEFAULT_PRINT_START_OPTIONS, null), true)
  assert.equal(arePrintStartModesAvailable(DEFAULT_PRINT_START_OPTIONS, {
    ...onOffOnly,
    bedLevel: { supported: false, autoSupported: false, current: null },
    flowCalibration: { supported: false, autoSupported: false, current: null }
  }), true)
})
// The print dialog's seed for a re-print: the job's own recorded options layered over the
// shared defaults, then clamped to the selected printer (PrintModal composes the two
// in that order). Issue #97: the dialog could not show Auto for a job that chose Auto.
function seedForReprint(
  defaults: PrintStartDialogOptions,
  recorded: Partial<PrintStartOptionSelection> | null,
  printStartOptions?: PrinterPrintStartOptions | null
): PrintStartDialogOptions {
  return resolvePrintStartDefaults(
    applyRecordedPrintStartOptions(defaults, recorded),
    printStartOptions
  )
}

const AUTO_CAPABLE_PRINTER: PrinterPrintStartOptions = {
  bedLevel: { supported: true, autoSupported: true, current: null },
  vibrationCompensation: { supported: true, current: null },
  flowCalibration: { supported: true, autoSupported: true, current: null },
  firstLayerInspection: { supported: true, current: null },
  timelapse: { supported: true, current: null },
  internalTimelapseStorage: { supported: true, current: null },
  externalFilamentChangeAssist: { supported: true, current: null },
  filamentDynamicsCalibration: { supported: false, current: null },
  nozzleOffsetCalibration: { supported: true, current: null }
}

test('re-printing an auto bed-leveling job shows Auto on a printer that supports it', () => {
  const seeded = seedForReprint(
    { ...DEFAULT_PRINT_START_OPTIONS, bedLevel: 'off' },
    { bedLevel: 'auto' },
    AUTO_CAPABLE_PRINTER
  )

  assert.equal(seeded.bedLevel, 'auto')
})

test('a re-printed job restores recorded options except retired vibration compensation', () => {
  const defaults: PrintStartDialogOptions = {
    bedLevel: 'off',
    vibrationCompensation: false,
    flowCalibration: 'off',
    timelapse: false,
    timelapseStorage: 'external',
    externalFilamentChangeAssist: false,
    nozzleOffsetCalibration: 'off'
  }
  const seeded = seedForReprint(defaults, {
    bedLevel: 'auto',
    vibrationCompensation: true,
    flowCalibration: 'auto',
    timelapse: true,
    timelapseStorage: 'internal',
    externalFilamentChangeAssist: true,
    nozzleOffsetCalibration: 'on'
  }, AUTO_CAPABLE_PRINTER)

  assert.deepEqual(seeded, {
    bedLevel: 'auto',
    vibrationCompensation: false,
    flowCalibration: 'auto',
    timelapse: true,
    timelapseStorage: 'internal',
    externalFilamentChangeAssist: true,
    nozzleOffsetCalibration: 'on'
  })
})

// A partially-recorded job (written before the options were persisted, so it knows only
// bedLevel) uses the current fresh-print defaults for fields it did not record.
test('options a job did not record fall back to the shared defaults', () => {
  const defaults: PrintStartDialogOptions = {
    bedLevel: 'auto',
    vibrationCompensation: true,
    flowCalibration: 'auto',
    timelapse: true,
    timelapseStorage: 'internal',
    externalFilamentChangeAssist: true,
    nozzleOffsetCalibration: 'on'
  }
  const seeded = seedForReprint(defaults, { bedLevel: 'off' }, AUTO_CAPABLE_PRINTER)

  assert.deepEqual(seeded, { ...defaults, bedLevel: 'off', vibrationCompensation: false })
})

test('a job with nothing recorded seeds entirely from the shared defaults', () => {
  const seeded = seedForReprint(DEFAULT_PRINT_START_OPTIONS, null, AUTO_CAPABLE_PRINTER)

  assert.deepEqual(seeded, DEFAULT_PRINT_START_OPTIONS)
})

// Restoring a choice must never show a value the selected printer cannot perform: clamping
// runs after the job's options are layered on, not before.
test('a restored auto is clamped to on for a printer without auto bed leveling', () => {
  const seeded = seedForReprint(DEFAULT_PRINT_START_OPTIONS, { bedLevel: 'auto' }, {
    ...AUTO_CAPABLE_PRINTER,
    bedLevel: { supported: true, autoSupported: false, current: null }
  })

  assert.equal(seeded.bedLevel, 'on')
})
