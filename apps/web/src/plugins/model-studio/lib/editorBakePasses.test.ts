/**
 * Which post-bake passes a save request asks for.
 *
 * The ORDER is `clientThreeMfBake.ts`'s business (a property of the file being written); what is
 * decided here is which passes are wanted at all, and that differs per request and per host.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBuiltinSlicingPresetId, processPresetFitsMachine } from '@printstream/shared'
import type { SaveArrangedThreeMf } from '@printstream/shared'
import { bakeOptionsFor, bakePassesFor } from './editorBakePasses'
import type { RetargetResolvers } from './browserMachineRetarget'

const RESOLVERS: RetargetResolvers = {
  canResolve: () => true,
  machine: async () => ({ config: { printer_model: ['Bambu Lab H2D'] }, name: 'Bambu Lab H2D 0.4 nozzle' }),
  process: async () => ({ config: {} }) as never,
  filament: async () => ({ config: { nozzle_temperature: ['230'] } }) as never
}

const OPTIONS = { resolvers: RESOLVERS, filamentPresets: async () => [] }

function save(overrides: Partial<SaveArrangedThreeMf> = {}): SaveArrangedThreeMf {
  return {
    baseFileId: 'file-1',
    mode: 'newVersion',
    sceneEdit: { plates: [{ index: 1 }], instances: [] },
    ...overrides
  } as SaveArrangedThreeMf
}

test('a plain save heals the topology, since no retarget will rebuild it', () => {
  const passes = bakePassesFor(save(), OPTIONS)
  assert.ok(passes.machineTopologyHeal)
  assert.equal(passes.machineRetarget, undefined)
})

test('a retarget replaces the heal rather than joining it', () => {
  // The api's own branching. Asking for both would re-author a topology the retarget just built.
  const passes = bakePassesFor(save({ retarget: { printerProfileId: 'builtin:machine:X' } as never }), OPTIONS)
  assert.ok(passes.machineRetarget)
  assert.equal(passes.machineTopologyHeal, undefined)
})

test('a single-object export gets no machine passes, but keeps its material edits', () => {
  // An export is a copy of one object taken OUT of the project, not the project being saved for a
  // different printer. Its filament overrides still describe the material it prints in.
  const passes = bakePassesFor(save({
    objectExport: true,
    retarget: { printerProfileId: 'builtin:machine:X' } as never,
    filamentSettingOverrides: { 1: { nozzle_temperature: ['235'] } }
  }), OPTIONS)
  assert.equal(passes.machineRetarget, undefined)
  assert.equal(passes.machineTopologyHeal, undefined)
  assert.ok(passes.filamentSettingOverrides)
})

test('an empty filament override map asks for no pass at all', () => {
  assert.equal(bakePassesFor(save({ filamentSettingOverrides: {} }), OPTIONS).filamentSettingOverrides, undefined)
})

test('the heal declines a machine this host cannot resolve, rather than authoring half of one', async () => {
  // A custom preset on the public host. The slicer's own slice-time heal still covers it.
  const passes = bakePassesFor(save(), { ...OPTIONS, resolvers: { ...RESOLVERS, canResolve: () => false } })
  assert.equal(await passes.machineTopologyHeal?.('Some Custom Printer'), null)
})

test('bake options carry the export marker and the overrides the bake itself applies', () => {
  const options = bakeOptionsFor(save({ objectExport: true, processSettingOverrides: { layer_height: ['0.2'] } }))
  assert.equal(options.objectExportMarker, true)
  assert.deepEqual(options.globalProcessOverrides, { layer_height: ['0.2'] })
})

test('the heal resolves the machine the project NAMES, as a builtin id', async () => {
  // The project carries `printer_settings_id`, a bare name; the resolvers take an ID. Passing the
  // name through made `canResolve` false for every project (an unprefixed string has no
  // provenance), so the heal silently never ran.
  const asked: string[] = []
  const passes = bakePassesFor(save(), {
    ...OPTIONS,
    resolvers: {
      ...RESOLVERS,
      machine: async (id) => { asked.push(id); return { config: { printer_model: ['X'] }, name: 'X' } }
    }
  })
  const config = await passes.machineTopologyHeal?.('Bambu Lab H2D 0.4 nozzle')

  assert.ok(config, 'the heal resolved something')
  assert.equal(asked[0], buildBuiltinSlicingPresetId('machine', 'Bambu Lab H2D 0.4 nozzle'))
})

const PROC = '0.10mm Standard @BBL A1 0.2 nozzle'
const P1S_PROJECT = {
  print_settings_id: PROC,
  printer_model: ['Bambu Lab P1S'],
  printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
  nozzle_diameter: ['0.4']
}

function retargetTo(overrides: Record<string, unknown> = {}) {
  return {
    processProfileId: buildBuiltinSlicingPresetId('process', PROC),
    printerProfileId: 'builtin:machine:X',
    printerModel: 'Bambu Lab P1S',
    nozzleDiameters: [0.4],
    ...overrides
  } as never
}

test('a save that changes no printer does not re-author the machine it already defines', async () => {
  // A retarget target is materialized on essentially every save, so running the retarget whenever
  // one is present rewrites the machine block and overwrites the project's process values on a save
  // the user made without touching the printer.
  const passes = bakePassesFor(save({ retarget: retargetTo() }), {
    ...OPTIONS,
    // The name the project already carries: nothing to author.
    resolvers: { ...RESOLVERS, machine: async () => ({ config: {}, name: 'Bambu Lab P1S 0.4 nozzle' }) }
  })

  assert.equal(await passes.machineRetarget?.(P1S_PROJECT), null, 'already on this preset')
})

test('a same-model preset the user PICKED is authored, machine only', async () => {
  // The narrow branch: an H2D variant, a nozzle size, a user's own tuned machine. Authoring the
  // process preset or rebinding filaments here is what the completeness gate exists to prevent.
  const passes = bakePassesFor(save({ retarget: retargetTo({ printerProfileChosen: true }) }), {
    ...OPTIONS,
    resolvers: {
      ...RESOLVERS,
      machine: async () => ({ config: { printer_model: ['Bambu Lab P1S'] }, name: 'Bambu Lab P1S 0.6 nozzle' })
    }
  })

  const plan = await passes.machineRetarget?.(P1S_PROJECT)
  assert.equal(plan?.printerSettingsId, 'Bambu Lab P1S 0.6 nozzle')
  assert.equal(plan?.processConfig, null, 'the process preset is left alone')
  assert.equal(plan?.filamentRebinds, null, 'so are the filament slots')
})

test('a preset that merely DIFFERS, unpicked, is not treated as a switch', async () => {
  // The client always sends a resolved id, and for a project whose preset this workspace does not
  // hold that resolution fell back to the first catalogue profile matching the model. Rewriting on
  // "differs" re-authored every such project onto a stock preset on an ordinary save, discarding
  // its start G-code, accelerations and limits.
  const passes = bakePassesFor(save({ retarget: retargetTo() }), {
    ...OPTIONS,
    resolvers: { ...RESOLVERS, machine: async () => ({ config: {}, name: 'Bambu Lab P1S 0.4 nozzle (stock)' }) }
  })

  assert.equal(await passes.machineRetarget?.(P1S_PROJECT), null, 'the nozzles still match')
})

test('an unpicked preset IS authored when the embedded nozzles no longer describe the target', async () => {
  // A nozzle switch keeps the model, so completeness alone would skip it forever.
  const passes = bakePassesFor(save({ retarget: retargetTo({ nozzleDiameters: [0.6] }) }), {
    ...OPTIONS,
    resolvers: { ...RESOLVERS, machine: async () => ({ config: {}, name: 'Bambu Lab P1S 0.6 nozzle' }) }
  })

  assert.ok(await passes.machineRetarget?.(P1S_PROJECT), 'the machine no longer describes the target')
})

test('the same printer still gets authored when the project defines it INCOMPLETELY', async () => {
  // "Same printer" is not "fully defined": an H2D naming the model without its dual-nozzle arrays
  // is the state that made the CLI refuse the file.
  const passes = bakePassesFor(save({ retarget: retargetTo({ printerModel: 'Bambu Lab H2D' }) }), OPTIONS)

  const plan = await passes.machineRetarget?.({
    printer_model: ['Bambu Lab H2D'],
    printer_settings_id: 'Bambu Lab H2D 0.4 nozzle'
  })
  assert.ok(plan, 'missing topology still needs the machine written')
})


test('a nozzle change carries the process preset the dialog re-picked with it', async () => {
  // Changing a nozzle re-picks the process preset in the dialog, because a 0.2 preset is not
  // compatible with a 0.4 machine. A save that ignored that left the project NAMING a preset it was
  // not using: the UI showed one thing and the file recorded another.
  const repicked = '0.20mm Standard @BBL A1'
  const passes = bakePassesFor(save({
    retarget: retargetTo({
      printerProfileChosen: true,
      processProfileId: buildBuiltinSlicingPresetId('process', repicked)
    })
  }), {
    ...OPTIONS,
    resolvers: {
      ...RESOLVERS,
      machine: async () => ({ config: {}, name: 'Bambu Lab A1 0.4 nozzle' }),
      process: async () => ({ config: { print_settings_id: repicked, layer_height: ['0.2'] } }) as never
    }
  })

  const plan = await passes.machineRetarget?.(P1S_PROJECT)
  assert.equal(plan?.printerSettingsId, 'Bambu Lab A1 0.4 nozzle', 'the machine still follows')
  assert.equal(plan?.processConfig?.print_settings_id, repicked, 'and so does the process preset')
})

test('an unchanged process preset is never re-authored, so hand-tuned values survive', async () => {
  // The other half. On an ordinary save the chosen preset IS the project's, and writing it back
  // would overwrite process values the user tuned by hand.
  let processResolved = 0
  const passes = bakePassesFor(save({ retarget: retargetTo({ printerProfileChosen: true }) }), {
    ...OPTIONS,
    resolvers: {
      ...RESOLVERS,
      machine: async () => ({ config: {}, name: 'Bambu Lab A1 0.4 nozzle' }),
      process: async () => { processResolved += 1; return { config: {} } as never }
    }
  })

  const plan = await passes.machineRetarget?.(P1S_PROJECT)
  assert.equal(plan?.processConfig, null, 'the project already names it')
  assert.equal(processResolved, 0, 'and it is not even resolved')
})

test('a nozzle change rebinds the filament slots, as Studio does', async () => {
  // A filament preset declares the machine PRESETS it fits, and the nozzle is part of a preset's
  // identity: "@BBL A1 0.2 nozzle" lists only the 0.2 machine. Leaving a slot alone across a nozzle
  // change leaves it on a preset incompatible with the machine being authored, which is why
  // BambuStudio re-picks every slot on any printer-preset switch.
  const passes = bakePassesFor(save({
    retarget: retargetTo({ printerProfileChosen: true, printerModel: 'Bambu Lab A1' })
  }), {
    ...OPTIONS,
    filamentPresets: async () => ([
      { id: buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL A1'), kind: 'filament',
        name: 'Bambu PLA Basic @BBL A1', source: 'builtin' }
    ] as never),
    resolvers: {
      ...RESOLVERS,
      machine: async () => ({ config: {}, name: 'Bambu Lab A1 0.4 nozzle' }),
      filament: async () => ({ config: { filament_type: ['PLA'] } }) as never
    }
  })

  const plan = await passes.machineRetarget?.({
    print_settings_id: PROC,
    printer_model: ['Bambu Lab A1'],
    printer_settings_id: 'Bambu Lab A1 0.2 nozzle',
    nozzle_diameter: ['0.2'],
    filament_settings_id: ['Bambu PLA Basic @BBL A1 0.2 nozzle'],
    filament_colour: ['#00AE42']
  })
  assert.ok(plan, 'the preset change is authored')
  assert.notEqual(plan.filamentRebinds, null, 'and the slots are re-picked with it')
})

test('a process preset the machine does not accept is never AUTHORED into the file', () => {
  // The dialog blocks a SLICE on an incompatible process but nothing blocked a save, so the pick was
  // written into the project and read back on the next open as its own baseline. Compatibility is
  // BambuStudio's rule: the machine preset's name must be in the process's `compatible_printers`.
  const forOtherMachine = { compatible_printers: ['Bambu Lab H2D 0.4 nozzle'], layer_height: ['0.2'] }
  assert.equal(processPresetFitsMachine(forOtherMachine, 'Bambu Lab A1 0.4 nozzle'), false)
  assert.equal(processPresetFitsMachine(forOtherMachine, 'Bambu Lab H2D 0.4 nozzle'), true)
})

test('a process preset declaring no printers fits any machine', () => {
  // Absence of evidence is not a mismatch here either: a hand-written or project-embedded preset
  // carries no list and must not be refused for it.
  assert.equal(processPresetFitsMachine({ layer_height: ['0.2'] }, 'Bambu Lab A1 0.4 nozzle'), true)
  assert.equal(processPresetFitsMachine(null, 'Bambu Lab A1 0.4 nozzle'), true)
})
