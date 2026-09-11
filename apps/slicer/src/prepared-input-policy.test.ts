import assert from 'node:assert/strict'
import test from 'node:test'
import { slicerInputPolicy } from './prepared-input-policy.js'

test('browser-prepared-v1 makes the uploaded project authoritative', () => {
  assert.deepEqual(slicerInputPolicy({ preparedSource: { contractVersion: 1 } }), {
    projectSettingsAuthoritative: true,
    loadRequestProfiles: false,
    ensureEmbeddedProjectSettings: false,
    rewriteRequestMetadata: false
  })
})

test('ordinary, calibration, and unknown-version inputs retain legacy preparation', () => {
  const legacy = {
    projectSettingsAuthoritative: false,
    loadRequestProfiles: true,
    ensureEmbeddedProjectSettings: true,
    rewriteRequestMetadata: true
  }
  assert.deepEqual(slicerInputPolicy({}), legacy)
  assert.deepEqual(slicerInputPolicy({ preparedSource: null }), legacy)
  assert.deepEqual(slicerInputPolicy({ preparedSource: { contractVersion: 2 } }), legacy)
})
