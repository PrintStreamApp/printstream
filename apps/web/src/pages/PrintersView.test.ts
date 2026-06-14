import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrinterConnectionValidationFeedback } from '../lib/printerConnectionValidation'
import { shouldShowNoConnectedPrintersEmptyState } from '../lib/printersEmptyState'

test('buildPrinterConnectionValidationFeedback returns null for a successful validation', () => {
  assert.equal(buildPrinterConnectionValidationFeedback({
    ok: true,
    mqttReachable: true,
    developerModeEnabled: true,
    warnings: []
  }), null)
})

test('buildPrinterConnectionValidationFeedback marks local connection failures as danger', () => {
  assert.deepEqual(buildPrinterConnectionValidationFeedback({
    ok: false,
    mqttReachable: false,
    developerModeEnabled: null,
    warnings: [{
      code: 'localConnectionFailed',
      message: 'The selected bridge could not reach the printer over the local network.'
    }]
  }), {
    color: 'danger',
    messages: ['The selected bridge could not reach the printer over the local network.']
  })
})

test('buildPrinterConnectionValidationFeedback keeps developer mode failures actionable', () => {
  assert.deepEqual(buildPrinterConnectionValidationFeedback({
    ok: false,
    mqttReachable: true,
    developerModeEnabled: false,
    warnings: [{
      code: 'developerModeDisabled',
      message: 'The bridge reached the printer, but the printer rejected the LAN connection. Confirm LAN-only mode is enabled and the access code is correct.'
    }]
  }), {
    color: 'warning',
    messages: ['The bridge reached the printer, but the printer rejected the LAN connection. Confirm LAN-only mode is enabled and the access code is correct.']
  })
})

test('shouldShowNoConnectedPrintersEmptyState defers to the no-connected-bridges placeholder', () => {
  assert.equal(shouldShowNoConnectedPrintersEmptyState({
    showNoConnectedBridgesPlaceholder: true,
    printersCount: 0,
    loading: false,
    hasError: false
  }), false)
})

test('shouldShowNoConnectedPrintersEmptyState shows the generic empty state for a real empty printer list', () => {
  assert.equal(shouldShowNoConnectedPrintersEmptyState({
    showNoConnectedBridgesPlaceholder: false,
    printersCount: 0,
    loading: false,
    hasError: false
  }), true)
})
