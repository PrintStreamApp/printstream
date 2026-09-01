import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRepairedFilamentConfigs, attachResolvedFilamentConfigs, rekeyByBakedSlot } from './filamentConfigAuthoring'
import type { SceneEdit } from '@printstream/shared'

const edit = (filaments: unknown[]): SceneEdit => ({ plates: [], filaments } as unknown as SceneEdit)

const resolver = (byProfile: Record<string, unknown>) => async (request: { filamentProfileId: string }) =>
  ({ config: byProfile[request.filamentProfileId] } as never)

test('attaches each slot\'s resolved preset config', async () => {
  const out = await attachResolvedFilamentConfigs(
    edit([
      { color: '#1', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle' },
      { color: '#2', settingsId: 'Bambu PLA Basic @BBL H2D' }
    ]),
    resolver({ 'p-petg': { nozzle_temperature: ['245'] }, 'p-pla': { nozzle_temperature: ['220'] } }),
    { targetId: 't1', sourceFileId: 'f1', profileIdByFilamentId: { 1: 'p-petg', 2: 'p-pla' } }
  )
  assert.deepEqual(out.filaments?.map((f) => f.config), [
    { nozzle_temperature: ['245'] },
    { nozzle_temperature: ['220'] }
  ])
})

test('a slot with no picked preset or no resolved name is left alone', async () => {
  const out = await attachResolvedFilamentConfigs(
    edit([
      { color: '#1', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle' },
      { color: '#2' },                                        // never resolved a preset name
      { color: '#3', settingsId: 'Some Third-Party PLA' }      // named, but no profile picked
    ]),
    resolver({ 'p-petg': { nozzle_temperature: ['245'] } }),
    { targetId: null, sourceFileId: null, profileIdByFilamentId: { 1: 'p-petg', 2: 'p-other' } }
  )
  assert.deepEqual(out.filaments?.map((f) => f.config ?? null), [{ nozzle_temperature: ['245'] }, null, null])
})

test('a slot whose EFFECTIVE config carries no physics falls back to the preset it names', async () => {
  // The live failure this exists to stop, measured end to end on a new project: the slot's preset
  // resolves to the PROJECT's own embedded preset (a scaffold seeds `filament_settings_id` and no
  // values), so `config` comes back truthy but describing the empty slot -- ONE key, against 141 for
  // the same slot's installed preset. Authoring that wrote nothing, so every editor-born project
  // saved with no material physics and reopened flagged "missing its material settings".
  const out = await attachResolvedFilamentConfigs(
    edit([{ color: '#FFFFFF', settingsId: 'Generic PLA @BBL A1 0.2 nozzle' }]),
    (async () => ({
      // What the route returns for a `project:` preset over a project that declares no physics:
      // identity only, which is not a material.
      config: { filament_settings_id: ['Generic PLA'] },
      baseConfig: { filament_settings_id: ['Generic PLA'], nozzle_temperature: ['220'], filament_flow_ratio: ['0.98'] }
    })) as never,
    { targetId: 't1', sourceFileId: 'f1', profileIdByFilamentId: { 1: 'project:filament:Generic PLA' } }
  )
  assert.deepEqual(out.filaments?.[0]?.config, {
    filament_settings_id: ['Generic PLA'],
    nozzle_temperature: ['220'],
    filament_flow_ratio: ['0.98']
  }, 'the named preset\'s values should stand in when the project declares none')
})

test('a slot whose effective config HAS physics keeps it, tweaks and all', async () => {
  // The inverse, which is the rule the fallback must not break: an effective config is the preset
  // PLUS whatever the project changed, so a project that really did raise its temperature keeps
  // that value rather than having the stock preset written back over it.
  const out = await attachResolvedFilamentConfigs(
    edit([{ color: '#FFFFFF', settingsId: 'Generic PLA @BBL A1 0.2 nozzle' }]),
    (async () => ({
      config: { nozzle_temperature: ['250'] },
      baseConfig: { nozzle_temperature: ['220'] }
    })) as never,
    { targetId: null, sourceFileId: null, profileIdByFilamentId: { 1: 'p-pla' } }
  )
  assert.deepEqual(out.filaments?.[0]?.config, { nozzle_temperature: ['250'] })
})

test('a slot with no physics anywhere is left unauthored rather than given identity keys', async () => {
  const out = await attachResolvedFilamentConfigs(
    edit([{ color: '#FFFFFF', settingsId: 'Generic PLA @BBL A1 0.2 nozzle' }]),
    (async () => ({ config: { filament_settings_id: ['Generic PLA'] }, baseConfig: undefined })) as never,
    { targetId: null, sourceFileId: null, profileIdByFilamentId: { 1: 'project:filament:Generic PLA' } }
  )
  assert.equal(out.filaments?.[0]?.config ?? null, null)
})

test('a resolver failure never fails the save', async () => {
  // Best-effort by contract: the slot goes unauthored and the bake falls back to its drop, which is
  // no worse than before this existed.
  const out = await attachResolvedFilamentConfigs(
    edit([{ color: '#1', settingsId: 'Bambu PETG HF @BBL H2D 0.4 nozzle' }]),
    async () => { throw new Error('offline') },
    { targetId: null, sourceFileId: null, profileIdByFilamentId: { 1: 'p-petg' } }
  )
  assert.equal(out.filaments?.[0]?.config ?? null, null)
})

test('no resolver is a no-op that returns the same edit', async () => {
  const input = edit([{ color: '#1', settingsId: 'x' }])
  assert.equal(await attachResolvedFilamentConfigs(input, undefined, { targetId: null, sourceFileId: null, profileIdByFilamentId: {} }), input)
})

/**
 * The in-editor repair resolves every slot up front and pins the result; the save must carry EXACTLY
 * those values. Re-resolving at save time could return something else if the catalogue moved, which
 * would silently persist a value the user never accepted (and the banner already cleared on).
 */
test('a repaired slot keeps its pinned config instead of being re-resolved', async () => {
  const input = {
    filaments: [
      { projectFilamentId: 1, settingsId: 'PETG', color: '#000000' },
      { projectFilamentId: 2, settingsId: 'PLA', color: '#ffffff' }
    ]
  } as unknown as SceneEdit

  const pinned = applyRepairedFilamentConfigs(input, {
    1: { config: { nozzle_temperature: ['245'] } as never, inherits: 'Bambu PETG HF @BBL H2D', changedKeys: ['nozzle_temperature'] }
  })

  let resolverCalls = 0
  const out = await attachResolvedFilamentConfigs(
    pinned,
    async () => {
      resolverCalls += 1
      return { config: { nozzle_temperature: ['999'] } } as never
    },
    { targetId: null, sourceFileId: null, profileIdByFilamentId: { 1: 'p-petg', 2: 'p-pla' } }
  )

  assert.deepEqual(out.filaments?.[0]?.config, { nozzle_temperature: ['245'] }, 'the pinned value must survive')
  assert.deepEqual(out.filaments?.[1]?.config, { nozzle_temperature: ['999'] }, 'an unpinned slot still resolves')
  assert.equal(resolverCalls, 1, 'the pinned slot must not be re-resolved')
  // The binding rides with the values. Without it BambuStudio reopens a slot backed by a USER
  // preset as a `(<project>.3mf)` copy however correct the values are.
  assert.equal(out.filaments?.[0]?.presetInherits, 'Bambu PETG HF @BBL H2D')
  assert.deepEqual(out.filaments?.[0]?.presetChangedKeys, ['nozzle_temperature'])
  // A resolver that reports no parent leaves the pair OFF, so the bake keeps the project's record.
  assert.equal('presetInherits' in (out.filaments?.[1] ?? {}), false)
})

/** No pin is the ordinary case and must not disturb the edit. */
test('applyRepairedFilamentConfigs is a no-op without a pin', () => {
  const input = { filaments: [{ projectFilamentId: 1, settingsId: 'PETG' }] } as unknown as SceneEdit
  assert.equal(applyRepairedFilamentConfigs(input, undefined), input)
})

/**
 * Session ids equal baked slots only until a mid-session remove or reorder: after that, reading a
 * session-keyed record by position hands one slot another slot's data (a slot once inherited the
 * preset of whichever slot happened to share its position). The boundary conversion is what keeps
 * the authoring functions' position reads honest.
 */
test('rekeyByBakedSlot follows a reordered session list', () => {
  // Session slots [3, 1, 2]: the user dragged material 3 first; the save bakes them as slots 1..3.
  assert.deepEqual(
    rekeyByBakedSlot({ 1: 'p-pla', 2: 'p-petg', 3: 'p-abs' }, [3, 1, 2]),
    { 1: 'p-abs', 2: 'p-pla', 3: 'p-petg' }
  )
})

test('rekeyByBakedSlot drops removed slots and keys the survivors by position', () => {
  // Material 1 was removed mid-session: slots [2, 3] bake as 1..2; the dead entry must not leak.
  assert.deepEqual(
    rekeyByBakedSlot({ 1: 'p-pla', 2: 'p-petg', 3: 'p-abs' }, [2, 3]),
    { 1: 'p-petg', 2: 'p-abs' }
  )
})

test('rekeyByBakedSlot is the identity for an undiverged session and {} for no record', () => {
  assert.deepEqual(rekeyByBakedSlot({ 1: 'a', 2: 'b' }, [1, 2]), { 1: 'a', 2: 'b' })
  // A slot with no entry stays absent rather than becoming an undefined-valued key.
  assert.deepEqual(Object.keys(rekeyByBakedSlot({ 2: 'b' }, [1, 2])), ['2'])
  assert.deepEqual(rekeyByBakedSlot(undefined, [1, 2]), {})
})
