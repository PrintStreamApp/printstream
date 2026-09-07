import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AmsUnit, PrinterStatus } from '@printstream/shared'
import {
  amsUnitSlotSpan,
  derivePrinterStateBucket,
  filamentPresetLabel,
  matchesPrinterStateFilter,
  printerStateSortRank
} from './printersViewHelpers.js'

const BAMBU_RFID = '0F674662BC86478AA008E7CCAD3B3A2A'

test('filamentPresetLabel surfaces the Bambu preset name for a scanned Bambu spool', () => {
  assert.equal(
    filamentPresetLabel('GFA00', 'PLA', 'PLA', { trayUuid: BAMBU_RFID }),
    'Bambu PLA Basic'
  )
})

test('filamentPresetLabel uses the plain type for custom filament assigned a Bambu preset without an RFID tag', () => {
  // A custom spool mapped to "Bambu PLA Basic" for slicing (GFA00) but with no scanned tag is not
  // genuine Bambu filament, so it reads "PLA", never "Bambu PLA Basic".
  assert.equal(filamentPresetLabel('GFA00', 'PLA', 'PLA', { trayUuid: null }), 'PLA')
})

test('filamentPresetLabel uses the plain type for custom filament with no preset or RFID tag', () => {
  assert.equal(filamentPresetLabel(null, 'PLA', 'PLA'), 'PLA')
})

test('filamentPresetLabel never prepends "Bambu" to the material fallback for non-RFID filament', () => {
  assert.equal(filamentPresetLabel('GFA00', 'PLA', null, { trayUuid: null }), 'PLA')
})

test('filamentPresetLabel still prepends "Bambu" to the material fallback for a scanned spool without a mapped preset', () => {
  assert.equal(filamentPresetLabel('GFUNKNOWN', 'PLA', null, { trayUuid: BAMBU_RFID }), 'Bambu PLA')
})

// amsUnitSlotSpan only reads slots.length, so a minimal fixture suffices.
const unitWithSlots = (count: number): AmsUnit => ({ slots: new Array(count).fill({}) } as unknown as AmsUnit)

test('amsUnitSlotSpan gives single-slot units (AMS HT) a two-column span so the header fits', () => {
  assert.equal(amsUnitSlotSpan(unitWithSlots(1)), 2)
})

test('amsUnitSlotSpan spans multi-slot units by slot count, capped at four', () => {
  assert.equal(amsUnitSlotSpan(unitWithSlots(4)), 4)
  assert.equal(amsUnitSlotSpan(unitWithSlots(6)), 4)
})

// The state grading reads only these four fields, so a minimal fixture suffices.
const stateStatus = (
  stage: PrinterStatus['stage'],
  deviceError: PrinterStatus['deviceError'] = null,
  hmsErrors: PrinterStatus['hmsErrors'] = []
): PrinterStatus => ({ online: true, stage, deviceError, hmsErrors } as unknown as PrinterStatus)

const CANCELLED_ERROR = { code: '0300400C', message: 'The task was canceled.' }

test('a cancelled print does not grade the printer as an error', () => {
  // Cancelling leaves the printer on the FAILED stage with a `print_error`, which
  // is the same shape a jam produces. Graded literally it sorted the printer to
  // the top of the fleet view under "needs attention" with nothing wrong with it.
  const cancelled = stateStatus('failed', CANCELLED_ERROR)
  assert.equal(derivePrinterStateBucket(cancelled), 'idle')
  assert.equal(printerStateSortRank(cancelled), 1)
  assert.equal(matchesPrinterStateFilter(cancelled, 'error'), false)
  // ...and it must land in some bucket: filtering by Idle has to find it, or a
  // cancelled printer matches no filter at all.
  assert.equal(matchesPrinterStateFilter(cancelled, 'idle'), true)
})

test('a genuine failure still grades as an error', () => {
  const failedWithCode = stateStatus('failed', { code: '0C008043', message: 'Nozzle clumping detected' })
  assert.equal(derivePrinterStateBucket(failedWithCode), 'error')
  assert.equal(printerStateSortRank(failedWithCode), 3)
  assert.equal(matchesPrinterStateFilter(failedWithCode, 'error'), true)

  // A failure the printer did not explain is still a failure.
  const failedSilently = stateStatus('failed')
  assert.equal(derivePrinterStateBucket(failedSilently), 'error')
  assert.equal(matchesPrinterStateFilter(failedSilently, 'error'), true)
})

test('an HMS alert alongside a cancellation still grades as an error', () => {
  const status = stateStatus('failed', CANCELLED_ERROR, [
    { code: '0700220000020001', message: 'AMS A Slot 3 filament has run out.' }
  ])
  assert.equal(derivePrinterStateBucket(status), 'error')
  assert.equal(matchesPrinterStateFilter(status, 'error'), true)
})
