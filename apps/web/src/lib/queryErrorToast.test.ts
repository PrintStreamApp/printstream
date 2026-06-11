import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldSuppressGlobalErrorToast, shouldSuppressPassiveAuthQueryError } from './queryErrorToast'

test('shouldSuppressGlobalErrorToast only suppresses when explicitly requested', () => {
  assert.equal(shouldSuppressGlobalErrorToast(undefined), false)
  assert.equal(shouldSuppressGlobalErrorToast(null), false)
  assert.equal(shouldSuppressGlobalErrorToast({}), false)
  assert.equal(shouldSuppressGlobalErrorToast({ suppressGlobalErrorToast: false }), false)
  assert.equal(shouldSuppressGlobalErrorToast({ suppressGlobalErrorToast: true }), true)
})

test('shouldSuppressPassiveAuthQueryError suppresses standard passive auth failures', () => {
  assert.equal(shouldSuppressPassiveAuthQueryError(new Error('Authentication required.')), true)
  assert.equal(shouldSuppressPassiveAuthQueryError(new Error('You do not have permission to perform this action.')), true)
  assert.equal(shouldSuppressPassiveAuthQueryError(new Error('Something else failed.')), false)
  assert.equal(shouldSuppressPassiveAuthQueryError('You do not have permission to perform this action.'), false)
})