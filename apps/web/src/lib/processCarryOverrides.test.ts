import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ResolveProcessConfigResponse } from '@printstream/shared'
import { deriveProjectCarryOverrides } from './processCarryOverrides'

test('a null response carries nothing', () => {
  assert.deepEqual(deriveProjectCarryOverrides(null), {})
  assert.deepEqual(deriveProjectCarryOverrides(undefined), {})
})

test('it carries only the value-diff against a resolved baseline', () => {
  // The project sets wall_loops = 4 over an A1 baseline of 2; the speed matches the baseline and
  // must not be carried. overriddenKeys is empty because the baseline resolved.
  const resolve: ResolveProcessConfigResponse = {
    config: { wall_loops: '4', outer_wall_speed: '200' },
    baseConfig: { wall_loops: '2', outer_wall_speed: '200' },
    overriddenKeys: []
  }
  assert.deepEqual(deriveProjectCarryOverrides(resolve), { wall_loops: '4' })
})

test('a serialization-only difference is not a carried delta', () => {
  // "15" (preset JSON form) vs "15%" (3MF project form) is the same percent value; the option-aware
  // comparator inside diffProcessConfig treats them as equal for a percent-typed key.
  const resolve: ResolveProcessConfigResponse = {
    config: { sparse_infill_density: '15%' },
    baseConfig: { sparse_infill_density: '15' },
    overriddenKeys: []
  }
  assert.deepEqual(deriveProjectCarryOverrides(resolve), {})
})

test('when the baseline did not resolve, the 3MF changed-from-system keys are authoritative', () => {
  // baseConfig === config (no separate baseline), so a raw diff would find nothing; the endpoint
  // hands back overriddenKeys instead, valued from the effective config.
  const resolve: ResolveProcessConfigResponse = {
    config: { wall_loops: '4', sparse_infill_density: '15%' },
    baseConfig: { wall_loops: '4', sparse_infill_density: '15%' },
    overriddenKeys: ['wall_loops']
  }
  assert.deepEqual(deriveProjectCarryOverrides(resolve), { wall_loops: '4' })
})

test('an overridden key absent from the config is skipped rather than carried as undefined', () => {
  const resolve: ResolveProcessConfigResponse = {
    config: { wall_loops: '4' },
    baseConfig: { wall_loops: '4' },
    overriddenKeys: ['wall_loops', 'phantom_key']
  }
  assert.deepEqual(deriveProjectCarryOverrides(resolve), { wall_loops: '4' })
})
