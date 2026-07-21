import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalThreeMfPartSubtype,
  isNonRenderableThreeMfPartSubtype,
  threeMfPartSubtypeCarriesFilament
} from './three-mf-part-subtype'

test('canonicalThreeMfPartSubtype accepts both 3MF spellings and defaults to a normal part', () => {
  assert.equal(canonicalThreeMfPartSubtype('support_blocker'), 'support_blocker')
  // `volume_type` metadata (older/foreign files) spells the same types in CamelCase.
  assert.equal(canonicalThreeMfPartSubtype('ParameterModifier'), 'modifier_part')
  assert.equal(canonicalThreeMfPartSubtype('NegativeVolume'), 'negative_part')
  assert.equal(canonicalThreeMfPartSubtype('ModelPart'), 'normal_part')
  // Absent or unknown: the 3MF default, and the safe reading of a vocabulary we don't know.
  assert.equal(canonicalThreeMfPartSubtype(null), 'normal_part')
  assert.equal(canonicalThreeMfPartSubtype('something_new'), 'normal_part')
})

test('helper volumes are non-renderable; only normal parts and modifiers carry a filament', () => {
  for (const subtype of ['support_blocker', 'support_enforcer', 'negative_part', 'ParameterModifier']) {
    assert.equal(isNonRenderableThreeMfPartSubtype(subtype), true, subtype)
  }
  assert.equal(isNonRenderableThreeMfPartSubtype('normal_part'), false)
  assert.equal(isNonRenderableThreeMfPartSubtype(null), false)

  // Mirrors BambuStudio's extruder-swatch rule (MODEL_PART + PARAMETER_MODIFIER only): a modifier
  // region can change the filament printed inside it; a blocker/enforcer/negative volume cannot.
  assert.equal(threeMfPartSubtypeCarriesFilament(null), true)
  assert.equal(threeMfPartSubtypeCarriesFilament('normal_part'), true)
  assert.equal(threeMfPartSubtypeCarriesFilament('modifier_part'), true)
  assert.equal(threeMfPartSubtypeCarriesFilament('ParameterModifier'), true)
  assert.equal(threeMfPartSubtypeCarriesFilament('support_blocker'), false)
  assert.equal(threeMfPartSubtypeCarriesFilament('support_enforcer'), false)
  assert.equal(threeMfPartSubtypeCarriesFilament('negative_part'), false)
})
