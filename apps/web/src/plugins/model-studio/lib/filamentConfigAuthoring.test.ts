import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRepairedFilamentConfigs, attachResolvedFilamentConfigs } from './filamentConfigAuthoring'
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
