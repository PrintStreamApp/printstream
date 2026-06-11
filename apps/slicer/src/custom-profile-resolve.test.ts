import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCustomProfileConfigWith, type SystemPresetReader } from './custom-profile-resolve.js'

const H2D_BASE = {
  type: 'process',
  name: '0.20mm Standard @BBL H2D',
  from: 'system',
  inherits: 'fdm_process_bbl_common',
  instantiation: 'true',
  layer_height: '0.2',
  sparse_infill_density: '15%',
  compatible_printers: ['Bambu Lab H2D 0.4 nozzle']
}

test('merges a sparse custom process onto its inherited system base', async () => {
  const reader: SystemPresetReader = async (kind, name) => {
    assert.equal(kind, 'process')
    if (name === '0.20mm Standard @BBL H2D') return { ...H2D_BASE }
    // The base inherits an internal template that is not shipped as a preset.
    return null
  }

  const merged = await resolveCustomProfileConfigWith(JSON.stringify({
    type: 'process',
    name: '0.20mm Standard @BBL H2D - Ryan',
    from: 'User',
    inherits: '0.20mm Standard @BBL H2D',
    sparse_infill_density: '20%'
  }), 'process', reader)

  // Inherited values (including the critical compatible_printers) are restored.
  assert.deepEqual(merged.compatible_printers, ['Bambu Lab H2D 0.4 nozzle'])
  assert.equal(merged.layer_height, '0.2')
  // Custom keys win over the base.
  assert.equal(merged.sparse_infill_density, '20%')
  assert.equal(merged.name, '0.20mm Standard @BBL H2D - Ryan')
  assert.equal(merged.from, 'User')
  assert.equal(merged.type, 'process')
})

test('keeps the custom profile as authored when the inherited base is missing', async () => {
  const reader: SystemPresetReader = async () => null

  const merged = await resolveCustomProfileConfigWith(JSON.stringify({
    name: 'Orphan Process',
    from: 'User',
    inherits: 'No Such Base',
    sparse_infill_density: '20%'
  }), 'process', reader)

  assert.equal(merged.sparse_infill_density, '20%')
  assert.equal(merged.type, 'process')
  assert.equal(merged.compatible_printers, undefined)
})

test('resolves a multi-level inherits chain (custom -> base -> grandparent)', async () => {
  const reader: SystemPresetReader = async (_kind, name) => {
    if (name === 'Mid Base') {
      return { type: 'process', name: 'Mid Base', from: 'system', inherits: 'Root Base', layer_height: '0.2' }
    }
    if (name === 'Root Base') {
      return { type: 'process', name: 'Root Base', from: 'system', compatible_printers: ['Bambu Lab H2D 0.4 nozzle'] }
    }
    return null
  }

  const merged = await resolveCustomProfileConfigWith(JSON.stringify({
    name: 'Custom',
    from: 'User',
    inherits: 'Mid Base',
    sparse_infill_density: '20%'
  }), 'process', reader)

  assert.deepEqual(merged.compatible_printers, ['Bambu Lab H2D 0.4 nozzle'])
  assert.equal(merged.layer_height, '0.2')
  assert.equal(merged.sparse_infill_density, '20%')
  assert.equal(merged.name, 'Custom')
})

test('does not loop on a self-referential inherits chain', async () => {
  const reader: SystemPresetReader = async (_kind, name) => ({
    type: 'process',
    name,
    from: 'system',
    inherits: name
  })

  const merged = await resolveCustomProfileConfigWith(JSON.stringify({
    name: 'Custom',
    from: 'User',
    inherits: 'Custom'
  }), 'process', reader)

  assert.equal(merged.name, 'Custom')
  assert.equal(merged.type, 'process')
})
