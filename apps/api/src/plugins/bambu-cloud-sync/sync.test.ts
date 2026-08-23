import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { beforeEach, test } from 'node:test'
import { rootPrisma } from '../../lib/prisma.js'
import { usePrismaStubs } from '../../test-utils/prisma-stubs.js'
import { deleteCustomSlicingPreset, listCustomSlicingPresetRecords, upsertCustomSlicingPresetRecords } from '../../lib/slicing-presets.js'
import { checkBambuCloudSync, resolvePendingDeletion, runBambuCloudSync } from './sync.js'
import type { PluginLogger, PluginSettingStore } from '../../plugin/types.js'

const WORKSPACE_ID = 'workspace-1'

const stubPrisma = usePrismaStubs()

/** In-memory stand-in for the `Setting` table the preset store writes to. */
let settingRows: Map<string, string>

/** Cloud calls the engine made, so a test can assert what was NOT sent. */
let calls: Array<{ operation: string; settingId?: string; payload?: unknown }>
/** Cloud state the fake transport serves. */
let cloudPresets: Map<string, { type: string; name: string; update_time: string; base_id?: string | null; setting: Record<string, unknown> }>

const logger: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} }

function createStore(): PluginSettingStore {
  const values = new Map<string, string>()
  const store: PluginSettingStore = {
    async get(key) { return values.get(key) ?? null },
    async set(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
    forWorkspace() { return store }
  }
  return store
}

beforeEach(() => {
  settingRows = new Map()
  calls = []
  cloudPresets = new Map()
  stubPrisma(rootPrisma.setting, 'findUnique', (async (args: { where: { key: string } }) => {
    const value = settingRows.get(args.where.key)
    return value === undefined ? null : { key: args.where.key, value }
  }) as never)
  stubPrisma(rootPrisma.setting, 'upsert', (async (args: { where: { key: string }; update: { value: string } }) => {
    settingRows.set(args.where.key, args.update.value)
    return { key: args.where.key, value: args.update.value }
  }) as never)
})

async function connect(store: PluginSettingStore): Promise<void> {
  await store.set('connection', JSON.stringify({
    region: 'global',
    account: 'user@example.com',
    accessToken: 'token',
    connectedAt: new Date().toISOString(),
    connectedByUserId: null,
    status: 'connected',
    quotaBlockedKinds: [],
    pendingDeletes: []
  }))
}

test('a cloud preset that is newer is pulled and stored as a normal workspace preset', async () => {
  const store = createStore()
  await connect(store)

  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"', nozzle_temperature: '220,225' }
  })

  const result = await runSyncWithFakeCloud(store)

  assert.deepEqual(result.pulled.map((entry) => entry.name), ['My PLA'])
  const presets = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  assert.equal(presets.length, 1)
  assert.equal(presets[0]?.kind, 'filament')
  const record = JSON.parse(presets[0]?.content ?? '{}') as Record<string, unknown>
  // Decoded into the local array form, not left as Bambu's serialized strings.
  assert.deepEqual(record.filament_type, ['PLA'])
  assert.deepEqual(record.nozzle_temperature, ['220', '225'])
})

test('a second sync with nothing changed sends no writes at all', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })

  await runSyncWithFakeCloud(store)
  calls = []
  const second = await runSyncWithFakeCloud(store)

  assert.deepEqual(second.pulled, [])
  assert.deepEqual(second.created, [])
  assert.deepEqual(second.updated, [])
  // A pull must not look like a local edit on the next pass, that would push the
  // preset straight back up and churn the user's cloud library on every sync.
  assert.deepEqual(calls.filter((call) => call.operation !== 'listSettings'), [])
})

test('a preset edited here is updated in place, never deleted and recreated', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)

  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [{
    id: existing?.id,
    kind: 'filament',
    name: 'My PLA',
    content: JSON.stringify({ filament_type: ['PLA'], nozzle_temperature: ['230'] }),
    updatedAt: new Date(Date.now() + 60_000).toISOString()
  }])

  calls = []
  const result = await runSyncWithFakeCloud(store)

  assert.deepEqual(result.updated.map((entry) => entry.name), ['My PLA'])
  assert.equal(calls.some((call) => call.operation === 'deleteSetting'), false, 'an update must never delete first')
  const patch = calls.find((call) => call.operation === 'patchSetting')
  assert.equal(patch?.settingId, 'PFUS1')
})

test('when both sides changed, the cloud copy wins and nothing is pushed back', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)

  // Edited here...
  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [{
    id: existing?.id,
    kind: 'filament',
    name: 'My PLA',
    content: JSON.stringify({ filament_type: ['PLA'], nozzle_temperature: ['230'] }),
    updatedAt: new Date(Date.now() + 60_000).toISOString()
  }])
  // ...and in Studio, more recently on Bambu's clock.
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-05-01 10:00:00',
    setting: { filament_type: '"PLA"', nozzle_temperature: '"240"' }
  })

  calls = []
  const result = await runSyncWithFakeCloud(store)

  // Pull runs before push, so the cloud copy lands first and clears the local-edit
  // marker, which is exactly how Studio's ordering resolves this.
  assert.deepEqual(result.pulled.map((entry) => entry.name), ['My PLA'])
  assert.deepEqual(result.updated, [])
  assert.equal(calls.some((call) => call.operation === 'patchSetting'), false)
})

test('a local preset with no cloud copy is created, and its id is remembered', async () => {
  const store = createStore()
  await connect(store)
  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [{
    kind: 'process',
    name: 'My fast process',
    content: JSON.stringify({ layer_height: '0.28' })
  }])

  const result = await runSyncWithFakeCloud(store)

  assert.deepEqual(result.created.map((entry) => entry.name), ['My fast process'])
  const create = calls.find((call) => call.operation === 'createSetting')
  // Bambu calls a process preset "print".
  assert.equal((create?.payload as { type?: string } | undefined)?.type, 'print')

  calls = []
  const second = await runSyncWithFakeCloud(store)
  assert.deepEqual(second.created, [], 'a created preset must not be created again')
})

test('a child preset waits for its parent to reach the cloud first', async () => {
  const store = createStore()
  await connect(store)
  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [
    {
      kind: 'process',
      name: 'Child',
      content: JSON.stringify({ inherits: 'Parent', layer_height: '0.28' })
    },
    {
      kind: 'process',
      name: 'Parent',
      content: JSON.stringify({ layer_height: '0.2' })
    }
  ])

  const result = await runSyncWithFakeCloud(store)

  // Both go up in one pass, but the parent must be created first so the child can
  // carry its cloud id as base_id. A child uploaded with an empty base_id is silently
  // detached from the preset it inherits.
  assert.deepEqual(result.created.map((entry) => entry.name), ['Parent', 'Child'])
  const child = calls.find((call) => (call.payload as { name?: string } | undefined)?.name === 'Child')
  assert.equal((child?.payload as { base_id?: string } | undefined)?.base_id, 'PFUS-Parent')
})

test('a preset Bambu rejects is parked and not retried on the next pass', async () => {
  const store = createStore()
  await connect(store)
  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [{
    kind: 'process',
    name: 'Rejected',
    content: JSON.stringify({ layer_height: '0.28' })
  }])

  rejectCreates = true
  const first = await runSyncWithFakeCloud(store)
  assert.equal(first.failed.length, 1)

  calls = []
  const second = await runSyncWithFakeCloud(store)
  // Retrying a rejection every pass is what gets a client rate-limited. It is reported
  // once and then left alone until the user edits it.
  assert.equal(second.created.length, 0)
  rejectCreates = false
})

test('a cloud delete only happens for a preset the user confirmed', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)

  calls = []
  await runSyncWithFakeCloud(store)
  assert.equal(calls.some((call) => call.operation === 'deleteSetting'), false, 'nothing is deleted without an explicit confirmation')

  // `resolvePendingDeletion` is what queues one in production; poke the same state
  // directly here since this test is about the drain, not the resolution.
  const connection = JSON.parse((await store.get('connection')) ?? '{}') as Record<string, unknown>
  await store.set('connection', JSON.stringify({ ...connection, pendingDeletes: ['PFUS1'] }))

  calls = []
  const result = await runSyncWithFakeCloud(store)
  assert.deepEqual(result.deleted, ['PFUS1'])
  assert.equal(calls.filter((call) => call.operation === 'deleteSetting').length, 1)
})

test('a preset deleted in Bambu Cloud is frozen, reported, and never silently pushed back', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)

  // Deleted in Studio: it just stops appearing in the listing.
  cloudPresets.delete('PFUS1')
  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  const first = await runSyncWithFakeCloud(store)

  assert.deepEqual(first.missingRemotely.map((entry) => entry.name), ['My PLA'])
  assert.deepEqual(first.missingLocally, [])
  const stillLocal = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  assert.equal(stillLocal.length, 1, 'the local copy must not be deleted on its own')

  // Editing the survivor while frozen must not push a brand new cloud preset for it,
  // that would answer a question nobody asked yet.
  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [{
    id: existing?.id,
    kind: 'filament',
    name: 'My PLA',
    content: JSON.stringify({ filament_type: ['PLA'], nozzle_temperature: ['230'] }),
    updatedAt: new Date(Date.now() + 60_000).toISOString()
  }])
  calls = []
  const second = await runSyncWithFakeCloud(store)
  assert.equal(calls.some((call) => call.operation === 'createSetting'), false)
  // Still reported every pass until someone answers.
  assert.deepEqual(second.missingRemotely.map((entry) => entry.name), ['My PLA'])
})

test('a preset deleted here is frozen, reported, and never silently pulled back', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)

  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  await deleteCustomSlicingPreset(WORKSPACE_ID, existing?.id ?? '')

  calls = []
  const result = await runSyncWithFakeCloud(store)

  assert.deepEqual(result.missingLocally.map((entry) => entry.name), ['My PLA'])
  assert.deepEqual(result.missingRemotely, [])
  // Bambu still lists it, so a naive pull would recreate exactly what was just deleted.
  assert.equal((await listCustomSlicingPresetRecords(WORKSPACE_ID)).length, 0)
  assert.equal(calls.some((call) => call.operation === 'getSetting'), false)
})

test('a preset gone on both sides is forgotten with no question asked', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)

  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  await deleteCustomSlicingPreset(WORKSPACE_ID, existing?.id ?? '')
  cloudPresets.delete('PFUS1')

  const result = await runSyncWithFakeCloud(store)
  assert.deepEqual(result.missingLocally, [])
  assert.deepEqual(result.missingRemotely, [])
})

test('confirming a cloud-side deletion removes the local copy and clears the freeze', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)
  cloudPresets.delete('PFUS1')
  await runSyncWithFakeCloud(store)

  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  const resolved = await resolvePendingDeletion(WORKSPACE_ID, store, logger, existing?.id ?? '', 'confirm')

  assert.deepEqual(resolved, { kind: 'missingRemotely' })
  assert.equal((await listCustomSlicingPresetRecords(WORKSPACE_ID)).length, 0)

  // The freeze is gone too, nothing left to report.
  const after = await runSyncWithFakeCloud(store)
  assert.deepEqual(after.missingRemotely, [])
})

test('declining a cloud-side deletion keeps the local preset and re-creates it fresh next sync', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)
  cloudPresets.delete('PFUS1')
  await runSyncWithFakeCloud(store)

  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  const resolved = await resolvePendingDeletion(WORKSPACE_ID, store, logger, existing?.id ?? '', 'decline')
  assert.deepEqual(resolved, { kind: 'missingRemotely' })

  calls = []
  const result = await runSyncWithFakeCloud(store)
  // No binding anymore, so it looks exactly like a brand new local preset.
  assert.deepEqual(result.created.map((entry) => entry.name), ['My PLA'])
  assert.equal(cloudPresets.size, 1, 'it is back in Bambu Cloud, under a fresh id')
})

test('confirming a local-side deletion queues the cloud copy for removal', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)
  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  await deleteCustomSlicingPreset(WORKSPACE_ID, existing?.id ?? '')
  await runSyncWithFakeCloud(store)

  const resolved = await resolvePendingDeletion(WORKSPACE_ID, store, logger, existing?.id ?? '', 'confirm')
  assert.deepEqual(resolved, { kind: 'missingLocally' })
  // Queued, not deleted inline, a network blip mid-request must not lose it.
  assert.equal(cloudPresets.has('PFUS1'), true)

  calls = []
  const result = await runSyncWithFakeCloud(store)
  assert.deepEqual(result.deleted, ['PFUS1'])
  assert.equal(cloudPresets.has('PFUS1'), false)
})

test('confirming a local-side deletion must not re-import the preset before the delete drains', async () => {
  // THE regression. `propagateConfirmedDeletes` drains AFTER pull in the same pass, and
  // confirming drops the binding, so pull used to see an unbound remote preset and
  // re-import the very thing the user had just deleted. The cloud copy then went away,
  // leaving a resurrected LOCAL copy with no binding, which the next pass pushed back up
  // as a brand new cloud preset. It did this to six of Ryan's presets in one click.
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)

  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  await deleteCustomSlicingPreset(WORKSPACE_ID, existing?.id ?? '')
  await runSyncWithFakeCloud(store) // freezes it: missingLocally

  await resolvePendingDeletion(WORKSPACE_ID, store, logger, existing?.id ?? '', 'confirm')

  const result = await runSyncWithFakeCloud(store)

  assert.deepEqual(result.deleted, ['PFUS1'], 'the cloud copy is removed, as confirmed')
  assert.deepEqual(result.pulled, [], 'and it must NOT be pulled back in on the way past')
  assert.equal(
    (await listCustomSlicingPresetRecords(WORKSPACE_ID)).length,
    0,
    'the preset the user deleted must stay deleted locally'
  )

  // And it must not reappear in the cloud on the following pass either.
  const after = await runSyncWithFakeCloud(store)
  assert.deepEqual(after.created, [])
  assert.equal(cloudPresets.size, 0)
})

test('declining a local-side deletion leaves the Bambu Cloud copy untouched and forgotten', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)
  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  await deleteCustomSlicingPreset(WORKSPACE_ID, existing?.id ?? '')
  await runSyncWithFakeCloud(store)

  const resolved = await resolvePendingDeletion(WORKSPACE_ID, store, logger, existing?.id ?? '', 'decline')
  assert.deepEqual(resolved, { kind: 'missingLocally' })

  calls = []
  const result = await runSyncWithFakeCloud(store)
  assert.equal(cloudPresets.has('PFUS1'), true, 'declining must not touch the cloud copy')
  assert.deepEqual(result.missingLocally, [], 'forgotten, not re-reported')
  assert.equal((await listCustomSlicingPresetRecords(WORKSPACE_ID)).length, 0)
})

test('a sync in flight cannot clobber a concurrent resolve-delete for the same workspace', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await runSyncWithFakeCloud(store)
  cloudPresets.delete('PFUS1')
  await runSyncWithFakeCloud(store) // freezes it: missingRemotely

  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)

  // An unrelated cloud preset the next sync will need to fetch (a `getSetting` call
  // during pull), that call happens AFTER the sync reads the bindings blob, which is
  // where the real race window sits. Delaying the FIRST call (`listSettings`) instead
  // would pause the sync before it ever reads bindings and could not reproduce this.
  cloudPresets.set('PFUS2', {
    type: 'filament',
    name: 'Other material',
    update_time: '2026-07-01 00:00:00',
    setting: { filament_type: '"PETG"' }
  })

  // Start a slow sync, its bindings snapshot is captured almost immediately (listing
  // resolves fast), then it stalls fetching PFUS2's detail, and, WHILE it is stalled,
  // resolve the pending deletion it already knows about. Without a per-workspace lock,
  // the sync's stale snapshot still carries the frozen binding, and its final write
  // would overwrite whatever the resolve call just did: resurrecting a binding the
  // user just confirmed deleting.
  const slowSync = runSyncWithFakeCloud(store, { delayMs: 30, delayOperation: 'getSetting' })
  await delay(5) // let the slow sync read its bindings snapshot and reach the stall
  const resolved = await resolvePendingDeletion(WORKSPACE_ID, store, logger, existing?.id ?? '', 'confirm')
  await slowSync

  assert.deepEqual(resolved, { kind: 'missingRemotely' })
  // PFUS2 legitimately gets pulled in as its own new local preset by the slow sync:
  // the assertion that matters is that "My PLA" specifically stayed deleted.
  const presetsAfter = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  assert.equal(presetsAfter.some((preset) => preset.id === existing?.id), false)

  const bindingsAfter = JSON.parse((await store.get('presetBindings')) ?? '[]') as Array<{ presetId: string }>
  assert.equal(
    bindingsAfter.some((binding) => binding.presetId === existing?.id),
    false,
    'the resolved binding must not come back from a sync that started before the resolve'
  )
})

test('resolving a preset with no pending decision returns null', async () => {
  const store = createStore()
  await connect(store)
  const resolved = await resolvePendingDeletion(WORKSPACE_ID, store, logger, 'custom:does-not-exist', 'confirm')
  assert.equal(resolved, null)
})

/** Set by a test to make the fake cloud reject creates. */
let rejectCreates = false

/**
 * Runs the engine against the scripted cloud above through the injected transport, so
 * everything from the client down to the binding bookkeeping is the real code.
 */
async function runSyncWithFakeCloud(
  store: PluginSettingStore,
  options: { delayMs?: number; delayOperation?: string } = {}
): Promise<Awaited<ReturnType<typeof runBambuCloudSync>>> {
  return await runBambuCloudSync({
    workspaceId: WORKSPACE_ID,
    store,
    logger,
    call: async (_workspaceId, request) => {
      const operation = request.request.operation
      // Delaying `listSettings` (the FIRST call) would pause the sync before it ever
      // reads the bindings blob, which cannot reproduce a bindings race: the real
      // window is between the bindings read and the final write, i.e. during a LATER
      // call, so a caller wanting to exercise that race must name a later operation.
      if (options.delayMs && (!options.delayOperation || options.delayOperation === operation)) {
        await delay(options.delayMs)
      }
      const params = request.request as Record<string, unknown>
      calls.push({
        operation,
        settingId: params.settingId as string | undefined,
        payload: params.payload
      })
      return { response: respond(operation, params), route: 'direct' as const }
    }
  })
}

function respond(operation: string, request: Record<string, unknown>): { status: number; body: unknown } {
  switch (operation) {
    case 'listSettings': {
      const buckets: Record<string, { private: unknown[] }> = { print: { private: [] }, printer: { private: [] }, filament: { private: [] } }
      for (const [settingId, preset] of cloudPresets) {
        buckets[preset.type]?.private.push({ setting_id: settingId, name: preset.name, update_time: preset.update_time, base_id: preset.base_id ?? null })
      }
      return { status: 200, body: buckets }
    }
    case 'getSetting': {
      const settingId = request.settingId as string
      const preset = cloudPresets.get(settingId)
      if (!preset) return { status: 404, body: { error: 'not found' } }
      return { status: 200, body: { setting_id: settingId, name: preset.name, type: preset.type, update_time: preset.update_time, base_id: preset.base_id ?? null, setting: preset.setting } }
    }
    case 'createSetting': {
      if (rejectCreates) return { status: 400, body: { error: 'rejected by test' } }
      const payload = request.payload as { name: string; type: string; setting: Record<string, unknown>; base_id: string }
      const settingId = `PFUS-${payload.name}`
      cloudPresets.set(settingId, { type: payload.type, name: payload.name, update_time: '2026-06-01 00:00:00', base_id: payload.base_id || null, setting: payload.setting })
      return { status: 200, body: { setting_id: settingId, update_time: '2026-06-01 00:00:00' } }
    }
    case 'patchSetting': {
      const settingId = request.settingId as string
      const payload = request.payload as { name: string; type: string; setting: Record<string, unknown> }
      const existing = cloudPresets.get(settingId)
      cloudPresets.set(settingId, { type: payload.type, name: payload.name, update_time: '2026-06-02 00:00:00', base_id: existing?.base_id ?? null, setting: payload.setting })
      return { status: 200, body: { setting_id: settingId, update_time: '2026-06-02 00:00:00' } }
    }
    case 'deleteSetting': {
      cloudPresets.delete(request.settingId as string)
      return { status: 200, body: { message: 'success' } }
    }
    default:
      return { status: 400, body: { error: `unexpected operation ${operation}` } }
  }
}

async function checkWithFakeCloud(
  store: PluginSettingStore,
  options: { maxListingAgeMs?: number } = {}
): Promise<Awaited<ReturnType<typeof checkBambuCloudSync>>> {
  return await checkBambuCloudSync({
    workspaceId: WORKSPACE_ID,
    store,
    logger,
    call: async (_workspaceId, request) => {
      const operation = request.request.operation
      const params = request.request as Record<string, unknown>
      calls.push({ operation, settingId: params.settingId as string | undefined, payload: params.payload })
      return { response: respond(operation, params), route: 'direct' as const }
    }
  }, options)
}

test('a check reports what a sync would do, and writes nothing anywhere', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', {
    type: 'filament',
    name: 'My PLA',
    update_time: '2026-04-06 19:03:50',
    setting: { filament_type: '"PLA"' }
  })
  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [{
    kind: 'process',
    name: 'Local only',
    content: JSON.stringify({ layer_height: '0.28' })
  }])

  calls = []
  const plan = await checkWithFakeCloud(store)

  assert.deepEqual(plan.pullable.map((entry) => entry.name), ['My PLA'])
  assert.deepEqual(plan.pushable.map((entry) => entry.name), ['Local only'])

  // ONE listing read and nothing else. No preset bodies fetched, nothing created,
  // patched or deleted, that is what makes this cheap enough to run on a timer.
  assert.deepEqual(calls.map((call) => call.operation), ['listSettings'])
  // The local library is untouched: the cloud preset was NOT imported.
  const presets = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  assert.deepEqual(presets.map((preset) => preset.name), ['Local only'])
  assert.equal(cloudPresets.size, 1, 'and nothing was uploaded')
})

test('a check and the sync that follows agree on what is outstanding', async () => {
  // The planner is shared precisely so a surface cannot promise three changes and then
  // deliver five. If these two ever disagree, the indicator is lying.
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', { type: 'filament', name: 'A', update_time: '2026-04-06 19:03:50', setting: { filament_type: '"PLA"' } })
  cloudPresets.set('PFUS2', { type: 'filament', name: 'B', update_time: '2026-04-06 19:03:50', setting: { filament_type: '"PETG"' } })
  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [{ kind: 'process', name: 'Mine', content: JSON.stringify({ layer_height: '0.28' }) }])

  const plan = await checkWithFakeCloud(store)
  const result = await runSyncWithFakeCloud(store)

  assert.equal(plan.pullable.length, result.pulled.length)
  assert.equal(plan.pushable.length, result.created.length + result.updated.length)
})

test('a check records its answer so a surface can read it without calling Bambu', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', { type: 'filament', name: 'My PLA', update_time: '2026-04-06 19:03:50', setting: { filament_type: '"PLA"' } })

  await checkWithFakeCloud(store)

  const connection = JSON.parse((await store.get('connection')) ?? '{}') as { lastCheck?: { pullable: number; pushable: number } }
  assert.equal(connection.lastCheck?.pullable, 1)
  assert.equal(connection.lastCheck?.pushable, 0)
})

test('a check still notices a deletion and freezes it for a decision', async () => {
  // Freezing is bookkeeping, not a write to presets or the cloud, and it is the only way
  // a deletion becomes a question the user can answer, so the check must still do it.
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', { type: 'filament', name: 'My PLA', update_time: '2026-04-06 19:03:50', setting: { filament_type: '"PLA"' } })
  await runSyncWithFakeCloud(store)

  const [existing] = await listCustomSlicingPresetRecords(WORKSPACE_ID)
  await deleteCustomSlicingPreset(WORKSPACE_ID, existing?.id ?? '')

  const plan = await checkWithFakeCloud(store)

  assert.deepEqual(plan.pending.map((entry) => entry.name), ['My PLA'])
  assert.equal(cloudPresets.has('PFUS1'), true, 'and the cloud copy is untouched')
})

test('a reused listing still reflects a preset edited here since', async () => {
  // The cache is the LISTING, never the verdict. Caching the verdict meant a local edit
  // showed nothing until the cache aged out, a stale answer to a question whose inputs
  // had all changed locally, which reads as the feature being broken.
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', { type: 'filament', name: 'My PLA', update_time: '2026-04-06 19:03:50', setting: { filament_type: '"PLA"' } })
  await runSyncWithFakeCloud(store)

  // Warm the listing cache.
  await checkWithFakeCloud(store, { maxListingAgeMs: 60_000 })

  await upsertCustomSlicingPresetRecords(WORKSPACE_ID, [{
    kind: 'process',
    name: 'Made just now',
    content: JSON.stringify({ layer_height: '0.28' })
  }])

  calls = []
  const plan = await checkWithFakeCloud(store, { maxListingAgeMs: 60_000 })

  assert.deepEqual(plan.pushable.map((entry) => entry.name), ['Made just now'], 'the new preset must be seen immediately')
  assert.deepEqual(calls, [], 'and Bambu must not have been called again to see it')
})

test('a stale listing is refetched', async () => {
  const store = createStore()
  await connect(store)
  cloudPresets.set('PFUS1', { type: 'filament', name: 'My PLA', update_time: '2026-04-06 19:03:50', setting: { filament_type: '"PLA"' } })
  await checkWithFakeCloud(store, { maxListingAgeMs: 60_000 })

  calls = []
  await checkWithFakeCloud(store, { maxListingAgeMs: 0 })

  assert.deepEqual(calls.map((call) => call.operation), ['listSettings'])
})
