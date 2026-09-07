import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PRINT_CANCELLATION_DEVICE_ERROR_CODES,
  hasPrinterErrorReport,
  isPrintCancellationError,
  isPrinterErrorState,
  wasPrintCancelled
} from './printer-error-state.js'

const CANCELLED = { code: '0300400C', message: 'The task was canceled.' }
const CANCELLED_ALT = { code: '0500400E', message: 'Printing was cancelled.' }
const REAL_FAULT = { code: '0C008043', message: 'Nozzle clumping detected' }

test('cancellation codes are recognized case-insensitively and nothing else is', () => {
  assert.equal(isPrintCancellationError(CANCELLED), true)
  assert.equal(isPrintCancellationError(CANCELLED_ALT), true)
  assert.equal(isPrintCancellationError({ code: '0300400c', message: null }), true)
  assert.equal(isPrintCancellationError(REAL_FAULT), false)
  assert.equal(isPrintCancellationError(null), false)
  assert.equal(isPrintCancellationError(undefined), false)
  // A near-miss must not be swallowed: 0300400D is "Resume failed after power loss".
  assert.equal(isPrintCancellationError({ code: '0300400D', message: null }), false)
  assert.deepEqual([...PRINT_CANCELLATION_DEVICE_ERROR_CODES], ['0300400C', '0500400E'])
})

test('a cancelled print is not a fault, so it offers nothing to act on', () => {
  const cancelled = { stage: 'failed' as const, deviceError: CANCELLED, hmsErrors: [] }
  assert.equal(wasPrintCancelled(cancelled), true)
  assert.equal(hasPrinterErrorReport(cancelled), false)
  assert.equal(isPrinterErrorState(cancelled), false)
})

test('a genuine failure still reads as an error, with or without a code', () => {
  const withCode = { stage: 'failed' as const, deviceError: REAL_FAULT, hmsErrors: [] }
  assert.equal(wasPrintCancelled(withCode), false)
  assert.equal(hasPrinterErrorReport(withCode), true)
  assert.equal(isPrinterErrorState(withCode), true)

  // The printer said the job failed and named no reason. That is exactly when
  // the user needs to see it, so an absent code must not read as "fine".
  const silent = { stage: 'failed' as const, deviceError: null, hmsErrors: [] }
  assert.equal(hasPrinterErrorReport(silent), false)
  assert.equal(isPrinterErrorState(silent), true)
})

test('an HMS alert alongside a cancellation is still a fault', () => {
  const status = {
    stage: 'failed' as const,
    deviceError: CANCELLED,
    hmsErrors: [{ code: '0700220000020001', message: 'AMS A Slot 3 filament has run out.' }]
  }
  assert.equal(hasPrinterErrorReport(status), true)
  assert.equal(isPrinterErrorState(status), true)
})

test('a stale cancellation code cannot make a live print look cancelled', () => {
  // `deviceError` only changes when the printer sends a new `print_error`, so the
  // cancellation code survives into the next job. Gating on the stage is what
  // stops the following print being reported as cancelled the moment it ends.
  const printing = { stage: 'printing' as const, deviceError: CANCELLED, hmsErrors: [] }
  assert.equal(wasPrintCancelled(printing), false)
  // It is still not a fault while it lingers, so the printer keeps reading as healthy.
  assert.equal(isPrinterErrorState(printing), false)
})

test('missing status is neither cancelled nor faulty', () => {
  assert.equal(wasPrintCancelled(undefined), false)
  assert.equal(hasPrinterErrorReport(undefined), false)
  assert.equal(isPrinterErrorState(null), false)
})
