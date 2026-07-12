import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSupportedEmbeddedMachineSwitch, shouldRetargetEmbeddedMachine } from './machine-switch-guard.js'

test('same-family switches and cross-model switches both retarget natively', () => {
  const input = {
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
  } as const

  // X1C -> P1S is a model change, so the input is retargeted; nothing to guard.
  assert.equal(shouldRetargetEmbeddedMachine(input), true)
  assert.doesNotThrow(() => assertSupportedEmbeddedMachineSwitch(input))
})

test('cross-family X2D switch retargets natively even from a single-extruder-shaped project', () => {
  const input = {
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
  } as const

  assert.equal(shouldRetargetEmbeddedMachine(input), true)
  assert.doesNotThrow(() => assertSupportedEmbeddedMachineSwitch(input))
})

test('cross-model H2D switch retargets natively (the retarget rebuilds the dual-nozzle topology)', () => {
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
    }
  } as const

  assert.equal(shouldRetargetEmbeddedMachine(input), true)
  assert.doesNotThrow(() => assertSupportedEmbeddedMachineSwitch(input))
})

test('rejects a nominally-H2D project that lacks the H2 dual-nozzle metadata (no retarget to repair it)', () => {
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
      printer_model: 'Bambu Lab H2D',
      physical_extruder_map: ['0'],
      extruder_nozzle_stats: [],
      extruder_max_nozzle_count: ['1'],
      default_nozzle_volume_type: ['Standard']
    }
  }), /missing its dual-nozzle machine data/)
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
    }
  } as const

  // A1 -> P1S is a genuine machine switch; failing to normalize "Bambu Lab A1" used to
  // make this report "no switch" and skip the retarget.
  assert.equal(shouldRetargetEmbeddedMachine(input), true)
  // Same-model A1 -> A1 must NOT count as a switch.
  assert.equal(shouldRetargetEmbeddedMachine({
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
