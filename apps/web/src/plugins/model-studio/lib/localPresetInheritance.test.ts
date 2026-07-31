/**
 * A preset uploaded through the editor's "Manage" dialog is a BambuStudio EXPORT, and those are
 * deltas: `inherits` names the parent and the document carries only the changed keys. Treating one
 * as a complete config is what made a repair report success and write nothing — the repair only
 * writes keys EVERY slot defines, and a delta defines a handful.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { flattenLocalPreset } from './localPresetInheritance'

const PARENT = { nozzle_temperature: ['245', '245'], filament_density: ['1.27'], chamber_temperatures: ['0'] }

test('a thin BambuStudio export is flattened onto its parent', async () => {
  const thin = {
    id: 'local:filament:My PETG',
    kind: 'filament' as const,
    name: 'My PETG',
    raw: { name: 'My PETG', inherits: 'Bambu PETG HF @BBL H2D', from: 'User', filament_density: ['1.30'] },
    addedAt: ''
  }
  const out = await flattenLocalPreset(thin, [], async () => PARENT as never)
  assert.deepEqual(out.config.filament_density, ['1.30'], 'the override wins')
  assert.deepEqual(out.config.nozzle_temperature, ['245', '245'], 'the parent fills the rest')
  assert.equal(out.config.inherits, undefined, 'bookkeeping keys are not settings')
  assert.equal(out.config.from, undefined)
  // The parent comes back too — by NAME, for the project's `inherits_group`, and by VALUE, so the
  // resolver can measure the whole SLOT against it. Without both, a saved project cannot bind a slot
  // to a user preset (see `filament-preset-binding.ts`).
  assert.equal(out.parentName, 'Bambu PETG HF @BBL H2D')
  assert.deepEqual(out.changedKeys, ['filament_density'])
  assert.equal(out.parentConfig, PARENT)
})

test('no parent leaves the preset thin rather than inventing values', async () => {
  const orphan = { id: 'local:filament:X', kind: 'filament' as const, name: 'X', raw: { filament_density: ['1.30'] }, addedAt: '' }
  const out = await flattenLocalPreset(orphan, [], async () => PARENT as never)
  assert.deepEqual(Object.keys(out.config), ['filament_density'])
  // "Unknown", not "system" — the save then leaves the project's own record alone.
  assert.equal(out.parentName, null)
  assert.deepEqual(out.changedKeys, [])
  assert.equal(out.parentConfig, null)
})

/**
 * The exact failure this caused: a delta carrying only the FIRST variant column replaced the
 * parent's full vector, so the High Flow value was lost and had to be invented. BambuStudio then
 * reported "max volumetric speed changed to 25" on a project that had simply been repaired.
 */
test('a delta that spells out one variant column keeps the parent for the rest', async () => {
  const parent = { filament_max_volumetric_speed: ['25', '40'], nozzle_temperature: ['245', '245'] }
  const thin = {
    id: 'local:filament:Custom PETG',
    kind: 'filament' as const,
    name: 'Custom PETG',
    raw: { inherits: 'Bambu PETG HF @BBL H2D 0.4 nozzle', filament_max_volumetric_speed: ['25'] },
    addedAt: ''
  }
  const out = await flattenLocalPreset(thin, [], async () => parent as never)
  assert.deepEqual(out.config.filament_max_volumetric_speed, ['25', '40'], 'High Flow must survive from the parent')
  assert.deepEqual(out.config.nozzle_temperature, ['245', '245'])
  // ...and because the merged value now EQUALS the parent's, the key is not a declared change.
  // Declaring it from the raw delta would exempt it from BambuStudio's normalization.
  assert.deepEqual(out.changedKeys, [])
})

/** A delta that is genuinely wider or equal still wins outright. */
test('a delta at full width replaces the parent value', async () => {
  const parent = { filament_max_volumetric_speed: ['25', '40'] }
  const full = {
    id: 'local:filament:X', kind: 'filament' as const, name: 'X',
    raw: { inherits: 'P', filament_max_volumetric_speed: ['30', '50'] }, addedAt: ''
  }
  const out = await flattenLocalPreset(full, [], async () => parent as never)
  assert.deepEqual(out.config.filament_max_volumetric_speed, ['30', '50'])
  assert.deepEqual(out.changedKeys, ['filament_max_volumetric_speed'])
})
