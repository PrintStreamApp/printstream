/**
 * The LAYOUT is what this must get right, so the fixtures are the widths measured on a real
 * dual-nozzle (H2D) project saved by BambuStudio: `nozzle_temperature` carries 2 values per slot
 * (variant-expanded) while `filament_density` carries 1. Getting that wrong is not cosmetic, an
 * undersized `slots x variants` array makes BambuStudio read out of bounds and die mid-slice.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restoreFilamentPhysics } from './restore-filament-physics.js'
import { inspectProjectFilamentPhysics } from './filament-physics.js'
import type { ProcessConfig } from '../process-settings.js'

/** Per-slot presets as a resolver returns them: each key at the preset's own width. */
const PETG = { nozzle_temperature: ['245', '245'], filament_density: ['1.28'], filament_flow_ratio: ['0.95', '0.95'] } as unknown as ProcessConfig
const PLA = { nozzle_temperature: ['220', '220'], filament_density: ['1.26'], filament_flow_ratio: ['0.98', '0.98'] } as unknown as ProcessConfig

const dropped = () => ({
  filament_settings_id: ['Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PLA Basic @BBL H2D'],
  filament_type: ['PETG', 'PETG', 'PLA'],
  filament_ids: ['GFG02', 'GFG02', 'GFA00'],
  // The variant layout SURVIVES the physics drop (it is an identity key), and it is what says a
  // variant-scoped option needs 2 columns per slot here. Without it the restore correctly falls
  // back to 1: writing narrow is recoverable, writing wide corrupts the slot count.
  filament_extruder_variant: [
    'Direct Drive Standard', 'Direct Drive High Flow',
    'Direct Drive Standard', 'Direct Drive High Flow',
    'Direct Drive Standard', 'Direct Drive High Flow'
  ]
}) as Record<string, unknown>

test('restores each key at the preset\'s own width, matching BambuStudio\'s layout', () => {
  const record = dropped()
  const result = restoreFilamentPhysics(record, [PETG, PETG, PLA])

  // Exactly the widths measured in the real BS-saved file: 2 per slot here, 1 per slot there.
  assert.deepEqual(record.nozzle_temperature, ['245', '245', '245', '245', '220', '220'])
  assert.deepEqual(record.filament_flow_ratio, ['0.95', '0.95', '0.95', '0.95', '0.98', '0.98'])
  assert.deepEqual(record.filament_density, ['1.28', '1.28', '1.26'])
  // The whole compared block is authored, including keys no preset here defines: BambuStudio's
  // comparison config starts from the DEFAULT PRESET (not from PrintConfig option defaults), so an
  // omitted key takes that preset's value, which need not match the user's. `filament_notes` is the
  // one exception: BambuStudio writes it as a bare `""` we cannot reproduce per slot.
  assert.ok(result.restoredKeys.length > 50, `expected the compared block, got ${result.restoredKeys.length}`)
  assert.ok(result.restoredKeys.includes('pressure_advance'), 'a key no preset defines still gets its default')
  assert.ok(!result.restoredKeys.includes('filament_notes'), 'the un-authorable key stays out')
  assert.deepEqual(result.unresolvedSlots, [])
  // The project now reads as intact.
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent, false)
})

test('identity keys are never touched', () => {
  const record = dropped()
  const before = JSON.stringify({ ids: record.filament_ids, names: record.filament_settings_id, types: record.filament_type })
  restoreFilamentPhysics(record, [PETG, PETG, PLA])
  assert.equal(JSON.stringify({ ids: record.filament_ids, names: record.filament_settings_id, types: record.filament_type }), before)
})

/**
 * A key one slot's preset defines and another's does not must still be WRITTEN, with the option's
 * default standing in for the slot that lacks it, which is exactly what BambuStudio does (verified
 * against its own save: `pressure_advance` is ["0.02","0.02","0.02"]).
 *
 * SUPERSEDES a test that asserted such a key was skipped entirely. That behaviour dropped the key
 * for EVERY slot, so a repaired project reached BambuStudio missing 9 keys it expects; BambuStudio
 * read the absences as deviations and minted a `(<project>.3mf)` preset instead of binding the
 * user's own preset.
 */
test('a key some slot does not define is filled from the option default, not dropped', () => {
  const sparse = { nozzle_temperature: ['999', '999'] } as unknown as ProcessConfig
  const record = dropped()
  restoreFilamentPhysics(record, [PETG, sparse, PLA])

  // Every slot defines nozzle_temperature, so it is written, at the project's variant width.
  assert.deepEqual(record.nozzle_temperature, ['245', '245', '999', '999', '220', '220'])
  // Slot 2 defines no density: it takes the catalogue default rather than a neighbour's value.
  const density = record.filament_density as string[]
  assert.equal(density.length, 3, 'one entry per slot')
  assert.equal(density[0], '1.28')
  assert.equal(density[2], '1.26')
  assert.notEqual(density[1], '1.28', 'never another material\'s value')
})

/**
 * SUPERSEDES a test that expected a scalar to broadcast across the variants. The variants genuinely
 * differ, BambuStudio writes `filament_max_volumetric_speed: ["25","40"]` for one slot, so copying
 * column 0 into column 1 invents a value, and BambuStudio then reports it as the user's own change.
 * A short source means the preset was never flattened onto its parent; skip rather than guess.
 */
test('a source short of the variant width is skipped, never padded from column 0', () => {
  const scalarTemp = { nozzle_temperature: ['210'], filament_density: ['1.20'] } as unknown as ProcessConfig
  // `1.20` canonicalises to `1.2`: BambuStudio writes numbers without redundant decimals, and a
  // cosmetic `.0` is enough to make a compared key differ from the preset.
  const record = dropped()
  const result = restoreFilamentPhysics(record, [scalarTemp, scalarTemp, scalarTemp])

  assert.equal(record.nozzle_temperature, undefined, 'a variant key needs every column')
  assert.ok(result.skippedKeys.includes('nozzle_temperature'))
  // A per-slot key is complete at one column, so it still writes.
  assert.deepEqual(record.filament_density, ['1.2', '1.2', '1.2'])
})

test('one material keeps a scalar preset value as a valid variant broadcast', () => {
  const record: Record<string, unknown> = {
    filament_settings_id: ['Generic PLA'],
    filament_colour: ['#FFFFFF'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
    filament_self_index: ['1', '1'],
    filament_diameter: ['1.75'],
    filament_density: ['1.24']
  }
  const config = {
    nozzle_temperature: ['220'],
    nozzle_temperature_initial_layer: ['220'],
    filament_flow_ratio: ['0.98']
  } as unknown as ProcessConfig

  const result = restoreFilamentPhysics(record, [config])
  assert.deepEqual(record.nozzle_temperature, ['220'])
  assert.deepEqual(record.filament_flow_ratio, ['0.98'])
  assert.ok(result.restoredKeys.includes('nozzle_temperature'))
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent, false)
})

/**
 * REPLACES a test that asserted the opposite, that an unresolved slot still occupied its columns,
 * filled with empty strings. That is what shipped, and it corrupted a real project: with a width of
 * 2 the padding pushed every physics array to 6 entries for a 3-slot file, and because
 * `parseProjectFilaments` sizes the material list from the longest filament array, the project
 * reopened showing 6 materials. Positional arrays cannot be partially written.
 */
test('one unresolved slot leaves the whole project alone rather than padding it', () => {
  const record = dropped()
  const before = JSON.stringify(record)
  const result = restoreFilamentPhysics(record, [PETG, null, PLA])

  assert.deepEqual(result.unresolvedSlots, [2])
  assert.deepEqual(result.restoredKeys, [], 'nothing may be written while a slot is unresolved')
  assert.equal(JSON.stringify(record), before, 'the project must be untouched, not half-repaired')
})

/**
 * The exact shape of the real failure: two slots resolving at width 2 and a third not resolving must
 * never produce `[v, v, v, v, '', '']`, whose length exceeds the slot count.
 */
test('no per-slot key may grow past the slot count', () => {
  const record = dropped()
  restoreFilamentPhysics(record, [PETG, PETG, PLA])

  // These are the keys `parseProjectFilaments` sizes the material list from. One of them written at
  // variant width is what made a 3-material project reopen showing 6, so they must stay at exactly
  // one entry per slot. (A variant-scoped key like `nozzle_temperature` is legitimately 6 here.)
  for (const key of ['filament_density', 'chamber_temperatures', 'filament_is_support', 'filament_soluble']) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    assert.equal(value.length, 3, `${key} must be one entry per slot, got ${value.length}`)
  }
})

test('no resolved presets leaves the project alone', () => {
  const record = dropped()
  const before = JSON.stringify(record)
  const result = restoreFilamentPhysics(record, [null, null, null])
  assert.deepEqual(result.restoredKeys, [])
  assert.equal(JSON.stringify(record), before)
})

/**
 * A resolved preset is a preset DOCUMENT, not a bag of settings: it also carries `type`,
 * `instantiation`, `inherits`, `include`, `setting_id`, `filament_id` and `compatible_printers`.
 * Copying those into a project's config produced a file BambuStudio refused to open at all
 * ("invalid config file"): strictly worse than the mis-binding the change was meant to fix.
 */
test('preset bookkeeping never reaches the project config', () => {
  const document = {
    nozzle_temperature: ['245', '245'],
    type: 'filament',
    instantiation: 'true',
    inherits: 'Bambu PETG HF @base',
    include: 'fdm_filament_template_direct_dual',
    setting_id: 'GFSG02_09',
    filament_id: 'GFG02',
    compatible_printers: 'Bambu Lab H2D 0.4 nozzle'
  } as unknown as ProcessConfig
  const record = dropped()
  restoreFilamentPhysics(record, [document, document, document])

  for (const key of ['type', 'instantiation', 'inherits', 'include', 'setting_id', 'filament_id', 'compatible_printers']) {
    assert.equal(record[key], undefined, `${key} is preset bookkeeping and must not be authored`)
  }
  // The settings alongside it still are.
  assert.deepEqual(record.nozzle_temperature, ['245', '245', '245', '245', '245', '245'])
})

test('a partially-damaged project keeps its present keys and gains only the missing ones', () => {
  // The CHM - H2 shape: blunt detection fires on a file where SOME keys survived (here a
  // nozzle_temperature carrying an in-project tweak on slot 2). The restore must write the
  // missing sentinels and leave the healthy key alone: overwriting it from the presets would
  // quietly normalise a value the user never touched.
  const record = {
    ...dropped(),
    nozzle_temperature: ['245', '245', '245', '245', '221', '221']
  }
  restoreFilamentPhysics(record, [PETG, PETG, PLA])

  assert.deepEqual(record.nozzle_temperature, ['245', '245', '245', '245', '221', '221'])
  assert.deepEqual(record.filament_flow_ratio, ['0.95', '0.95', '0.95', '0.95', '0.98', '0.98'])
  // The restored file must inspect clean, or detection and repair would disagree forever.
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent, false)
})

test('a stale-width key is rewritten from the presets, not preserved', () => {
  // A 2-wide density in a 3-slot project is positional garbage; preserve-present must not
  // protect it. The shared width rule decides which side of the line a key falls on.
  const record = {
    ...dropped(),
    filament_density: ['1.28', '1.26']
  }
  restoreFilamentPhysics(record, [PETG, PETG, PLA])
  assert.deepEqual(record.filament_density, ['1.28', '1.28', '1.26'])
})

/**
 * A NON-UNIFORM variant layout is restored at its real per-slot widths, and an UNREADABLE one is
 * refused rather than split evenly.
 *
 * TPU owns every printer variant while its neighbours share the standard ones, so PLA + TPU on an
 * H2D is 2 + 3 = 5 rows across 2 slots. Writing one width for every slot truncated the TPU column
 * away and left the array short of the layout the project declares, the out-of-bounds shape that
 * kills a slice, while the file stayed flagged, so the user could never clear it.
 */
const NON_UNIFORM = {
  filament_colour: ['#1', '#2'],
  filament_type: ['PLA', 'TPU'],
  filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu TPU 95A HF @BBL H2D'],
  filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU High Flow'],
  filament_density: ['1.26', '1.21'],
  filament_diameter: ['1.75', '1.75']
}
const NON_UNIFORM_SOURCES = [
  { nozzle_temperature: ['220', '220'], nozzle_temperature_initial_layer: ['220', '220'], filament_flow_ratio: ['0.98', '0.98'] },
  { nozzle_temperature: ['230', '230', '235'], nozzle_temperature_initial_layer: ['230', '230', '235'], filament_flow_ratio: ['1', '1', '1'] }
]

test('a non-uniform layout is restored at each slot\'s own width', () => {
  // `filament_self_index` names the owning slot per row, which is what makes the split readable.
  const record: Record<string, unknown> = { ...NON_UNIFORM, filament_self_index: ['1', '1', '2', '2', '2'] }
  const result = restoreFilamentPhysics(record, NON_UNIFORM_SOURCES as never)
  assert.deepEqual(record.nozzle_temperature, ['220', '220', '230', '230', '235'])
  assert.ok(result.restoredKeys.includes('nozzle_temperature'))
  // Detection and repair are one implementation: what the restore writes must inspect clean.
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent, false)
})

test('an unreadable layout leaves the variant keys alone rather than splitting them evenly', () => {
  // Rows that do not divide by the slot count, and no self-index to say how they are shared. An
  // even split would write 4 values for a 5-row layout, which is the undersized array that makes
  // BambuStudio read out of bounds mid-slice.
  const record: Record<string, unknown> = { ...NON_UNIFORM }
  const result = restoreFilamentPhysics(record, NON_UNIFORM_SOURCES as never)
  assert.equal(record.nozzle_temperature, undefined, 'a guessed split must never be written')
  assert.ok(result.skippedKeys.includes('nozzle_temperature'), 'and the refusal must be reported')
  // Per-slot keys are unaffected by an unreadable VARIANT layout and are still restored.
  assert.ok(result.restoredKeys.length > 0)
})
