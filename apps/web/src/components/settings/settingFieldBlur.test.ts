import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settingFieldBlurRestore } from './settingFieldBlur'

test('a cleared numeric field restores its previous value', () => {
  // An empty numeric never reaches the file, so leaving the box blank stood as a pending change the
  // save silently drops.
  assert.equal(settingFieldBlurRestore('', '200', true), '200')
  assert.equal(settingFieldBlurRestore('   ', '200', true), '200')
})

test('a numeric field the user actually filled in is left alone', () => {
  assert.equal(settingFieldBlurRestore('60', '200', true), null)
  // Zero is a legitimate value, not an empty one.
  assert.equal(settingFieldBlurRestore('0', '200', true), null)
})

test('a cleared text field is left alone', () => {
  // `ConfigOptionString` accepts an empty value; clearing a custom gcode field is a real edit.
  assert.equal(settingFieldBlurRestore('', 'M400', false), null)
})

test('a field that was never filled in has nothing to restore', () => {
  assert.equal(settingFieldBlurRestore('', null, true), null)
  assert.equal(settingFieldBlurRestore('', '', true), null)
  assert.equal(settingFieldBlurRestore('', undefined, true), null)
})

test('the restore is the value at edit START, not an abandoned intermediate', () => {
  // Found by adversarial review. Every keystroke round-trips through the parent, so a "last
  // non-empty value" ref advances to each intermediate: typing 3 over 0.2, reconsidering, clearing
  // the box and clicking away would have committed layer_height = 3 as an override the user never
  // confirmed. Passing the focus-time value is what makes the revert mean what it says.
  assert.equal(settingFieldBlurRestore('', '0.2', true), '0.2')
})

test('a field that was already empty when focused has nothing to restore', () => {
  assert.equal(settingFieldBlurRestore('', null, true), null)
})
