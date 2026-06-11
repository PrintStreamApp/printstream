import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSupportedEmbeddedMachineSwitch, shouldUseEstimateModeMachineSwitch } from './machine-switch-guard.js'

test('allows single-nozzle targets to keep using embedded project data', () => {
  assert.doesNotThrow(() => assertSupportedEmbeddedMachineSwitch({
    request: {
      sourceFileId: 'source',
      target: {
        mode: 'manualProfile',
        printerModel: 'P1S',
        printerProfileId: 'machine-profile'
      },
      plate: 0
    },
    profileFiles: [{ kind: 'machine', name: 'Bambu Lab P1S 0.4 nozzle' }],
    projectSettings: {
      printer_model: 'Bambu Lab X1 Carbon',
      physical_extruder_map: ['0'],
      default_nozzle_volume_type: ['Standard']
    }
  }))
})

test('allows X2D retargeting even when the source project is single-extruder shaped', () => {
  assert.doesNotThrow(() => assertSupportedEmbeddedMachineSwitch({
    request: {
      sourceFileId: 'source',
      target: {
        mode: 'manualProfile',
        printerModel: 'X2D',
        printerProfileId: 'machine-profile'
      },
      plate: 0
    },
    profileFiles: [{ kind: 'machine', name: 'Bambu Lab X2D 0.4 nozzle' }],
    projectSettings: {
      printer_model: 'Bambu Lab X1 Carbon',
      physical_extruder_map: ['0'],
      default_nozzle_volume_type: ['Standard']
    }
  }))
})

test('rejects H2D retargeting when the source project lacks H2 dual-nozzle metadata', () => {
  assert.throws(() => assertSupportedEmbeddedMachineSwitch({
    request: {
      sourceFileId: 'source',
      target: {
        mode: 'manualProfile',
        printerModel: 'H2D',
        printerProfileId: 'machine-profile'
      },
      plate: 0
    },
    profileFiles: [{ kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' }],
    projectSettings: {
      printer_model: 'Bambu Lab X1 Carbon',
      physical_extruder_map: ['0'],
      extruder_nozzle_stats: [],
      extruder_max_nozzle_count: ['1'],
      default_nozzle_volume_type: ['Standard']
    }
  }), /cannot retarget this 3MF directly to H2D yet/)
})

test('uses estimate-mode machine switch when the target runtime supports it', () => {
  const input = {
    request: {
      sourceFileId: 'source',
      target: {
        mode: 'manualProfile',
        printerModel: 'H2D',
        printerProfileId: 'machine-profile'
      },
      plate: 0
    },
    profileFiles: [{ kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' }],
    projectSettings: {
      printer_model: 'Bambu Lab X1 Carbon',
      physical_extruder_map: ['0'],
      extruder_nozzle_stats: [],
      extruder_max_nozzle_count: ['1'],
      default_nozzle_volume_type: ['Standard']
    },
    supportedFlags: new Set(['--estimate-mode'])
  } as const

  assert.equal(shouldUseEstimateModeMachineSwitch(input), true)
  assert.doesNotThrow(() => assertSupportedEmbeddedMachineSwitch(input))
})

test('detects A1 source projects ("Bambu Lab A1" has no trailing space after A1)', () => {
  const input = {
    request: {
      sourceFileId: 'source',
      target: { mode: 'manualProfile', printerModel: 'P1S', printerProfileId: 'machine-profile' },
      plate: 0
    },
    profileFiles: [{ kind: 'machine', name: 'Bambu Lab P1S 0.4 nozzle' }],
    projectSettings: {
      printer_model: 'Bambu Lab A1',
      physical_extruder_map: ['0'],
      extruder_nozzle_stats: [],
      extruder_max_nozzle_count: ['1'],
      default_nozzle_volume_type: ['Standard']
    },
    supportedFlags: new Set(['--estimate-mode'])
  } as const

  // A1 -> P1S is a genuine machine switch; failing to normalize "Bambu Lab A1" used to
  // make this report "no switch" and skip estimate mode.
  assert.equal(shouldUseEstimateModeMachineSwitch(input), true)
  // Same-model A1 -> A1 must NOT count as a switch.
  assert.equal(shouldUseEstimateModeMachineSwitch({
    ...input,
    request: { ...input.request, target: { mode: 'manualProfile', printerModel: 'A1', printerProfileId: 'machine-profile' } },
    profileFiles: [{ kind: 'machine', name: 'Bambu Lab A1 0.4 nozzle' }]
  }), false)
})

test('allows H2D projects that already carry H2 dual-nozzle metadata', () => {
  assert.doesNotThrow(() => assertSupportedEmbeddedMachineSwitch({
    request: {
      sourceFileId: 'source',
      target: {
        mode: 'manualProfile',
        printerModel: 'H2D',
        printerProfileId: 'machine-profile'
      },
      plate: 0
    },
    profileFiles: [{ kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' }],
    projectSettings: {
      printer_model: 'Bambu Lab H2D',
      physical_extruder_map: ['1', '0'],
      extruder_nozzle_stats: ['Standard#1', 'Standard#1'],
      extruder_max_nozzle_count: ['1', '1'],
      default_nozzle_volume_type: ['Standard', 'Standard']
    }
  }))
})