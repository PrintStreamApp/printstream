import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AUTO_HOMING_CONFIRMATION_MESSAGE,
  CHAMBER_TEMPERATURE_COOLING_MODE_WARNING_MESSAGE,
  CHAMBER_TEMPERATURE_HEATING_SWITCH_WARNING_MESSAGE,
  CONTINUE_PRINT_CONFIRMATION_TITLE,
  FAN_SPEED_DURING_PRINT_WARNING_MESSAGE,
  STOP_PRINT_CONFIRMATION_MESSAGE,
  getPrinterCommandPrompt
} from './printerCommandWarnings'

test('getPrinterCommandPrompt returns the expected BambuStudio-style confirmations', () => {
  assert.equal(
    getPrinterCommandPrompt(null, { type: 'stop' })?.message,
    STOP_PRINT_CONFIRMATION_MESSAGE
  )

  assert.equal(
    getPrinterCommandPrompt(null, { type: 'homeAxes' })?.message,
    AUTO_HOMING_CONFIRMATION_MESSAGE
  )

  assert.equal(
    getPrinterCommandPrompt(
      { stage: 'printing', ductMode: null, chamberLightOffRequiresConfirm: false, deviceError: null },
      { type: 'setFanSpeed', fan: 'part', percent: 40 }
    )?.message,
    FAN_SPEED_DURING_PRINT_WARNING_MESSAGE
  )

  assert.equal(
    getPrinterCommandPrompt(
      { stage: 'printing', ductMode: null, chamberLightOffRequiresConfirm: false, deviceError: null },
      { type: 'setFanSpeed', fan: 'part', percent: 40 },
      { fanSpeedWarningSeen: true }
    ),
    null
  )
})

test('getPrinterCommandPrompt blocks or confirms chamber temperature changes that BambuStudio warns about', () => {
  assert.deepEqual(
    getPrinterCommandPrompt(
      { stage: 'printing', ductMode: 'cooling', chamberLightOffRequiresConfirm: false, deviceError: null },
      { type: 'setChamberTemperature', target: 45 }
    ),
    {
      kind: 'notice',
      title: null,
      message: CHAMBER_TEMPERATURE_COOLING_MODE_WARNING_MESSAGE,
      acknowledgeLabel: 'OK'
    }
  )

  assert.equal(
    getPrinterCommandPrompt(
      { stage: 'printing', ductMode: 'heating', chamberLightOffRequiresConfirm: false, deviceError: null },
      { type: 'setChamberTemperature', target: 45 }
    ),
    null
  )

  assert.equal(
    getPrinterCommandPrompt(
      { stage: 'printing', ductMode: null, chamberLightOffRequiresConfirm: false, deviceError: null },
      { type: 'setChamberTemperature', target: 45 }
    )?.message,
    CHAMBER_TEMPERATURE_HEATING_SWITCH_WARNING_MESSAGE
  )

  assert.equal(
    getPrinterCommandPrompt(
      { stage: 'idle', ductMode: null, chamberLightOffRequiresConfirm: false, deviceError: null },
      { type: 'setChamberTemperature', target: 45 }
    ),
    null
  )
})

test('getPrinterCommandPrompt preserves the chamber-light confirmation path', () => {
  const prompt = getPrinterCommandPrompt(
    { stage: 'printing', ductMode: null, chamberLightOffRequiresConfirm: true, deviceError: null },
    { type: 'light', node: 'chamber', on: false }
  )

  assert.equal(prompt?.kind, 'confirm')
  assert.equal(prompt?.confirmLabel, 'Still turn it Off')
  assert.equal(prompt?.cancelLabel, 'Keep it On')
})

test('getPrinterCommandPrompt asks for confirmation before continuing through printer warnings', () => {
  assert.deepEqual(
    getPrinterCommandPrompt(
      {
        stage: 'paused',
        ductMode: null,
        chamberLightOffRequiresConfirm: false,
        deviceError: { code: '0C008043', message: 'Build plate mismatch detected' }
      },
      { type: 'ignoreHmsError' }
    ),
    {
      kind: 'confirm',
      title: CONTINUE_PRINT_CONFIRMATION_TITLE,
      message: 'Build plate mismatch detected Continue anyway?',
      cancelLabel: 'Cancel',
      confirmLabel: 'Continue',
      color: 'warning'
    }
  )
})