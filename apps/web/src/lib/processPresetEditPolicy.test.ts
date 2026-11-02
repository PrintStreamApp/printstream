import assert from 'node:assert/strict'
import test from 'node:test'
import { slicingPresetProvenance, buildBuiltinSlicingPresetId } from '@printstream/shared'
import { canUpdateProcessPreset } from './processPresetEditPolicy'

const custom = 'custom:owned'
const builtin = buildBuiltinSlicingPresetId('process', 'Standard')
const workspacePolicy = (id: string) => slicingPresetProvenance(id) === 'workspace'

test('Update original follows the active draft in both switch directions', () => {
  assert.equal(canUpdateProcessPreset({ activeProfileId: builtin, originalProfileId: custom, canEditOriginal: true, canUpdateProfile: workspacePolicy }), false)
  assert.equal(canUpdateProcessPreset({ activeProfileId: custom, originalProfileId: builtin, canEditOriginal: false, canUpdateProfile: workspacePolicy }), true)
})

test('hosts without a storage policy cannot grant update rights to a different draft', () => {
  assert.equal(canUpdateProcessPreset({ activeProfileId: builtin, originalProfileId: custom, canEditOriginal: true }), false)
  assert.equal(canUpdateProcessPreset({ activeProfileId: custom, originalProfileId: custom, canEditOriginal: true }), true)
  assert.equal(canUpdateProcessPreset({ activeProfileId: 'local:process:Owned', originalProfileId: builtin }), false)
})
