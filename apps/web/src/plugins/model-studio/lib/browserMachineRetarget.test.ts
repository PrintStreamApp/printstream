/**
 * What the public editor's "save for a different printer" resolves, and what it refuses to.
 *
 * The rewriting itself is shared and tested elsewhere (`packages/shared/src/machine-retarget.ts`);
 * what is only decided here is which lookups an anonymous browser is allowed to make and how the
 * plan degrades when one fails. Both matter to the user: refusing too much silently keeps the
 * project on its old printer, and refusing too little sends a workspace preset id at a route that
 * cannot serve it.
 *
 * Counterpart: `apps/api/src/lib/save-retarget.ts` (the workspace host).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { slicingPresetProvenance } from '@printstream/shared'
import {
  applyMachineRetargetToProjectSettings,
  buildBuiltinSlicingPresetId,
  buildProjectSlicingPresetId,
  parseBuiltinSlicingPresetId,
  type ProfileRecord,
  type ResolveFilamentConfigResponse,
  type ResolveProcessConfigResponse,
  type SlicingManualProfileTarget
} from '@printstream/shared'
import { PUBLIC_RETARGET_RESOLVERS, WORKSPACE_RETARGET_RESOLVERS, buildMachineRetargetPlan, type RetargetResolvers } from './browserMachineRetarget'

/**
 * The resolve responses carry the settings-catalog value types, which are narrower than the plain
 * record the retarget passes around; these fixtures only need to be shaped right, not typed right.
 */
function processResponse(config: Record<string, string>): ResolveProcessConfigResponse {
  return { config, baseConfig: {}, overriddenKeys: [] } as unknown as ResolveProcessConfigResponse
}

function filamentResponse(config: Record<string, string>): ResolveFilamentConfigResponse {
  return { config, baseConfig: {}, overriddenKeys: [] } as unknown as ResolveFilamentConfigResponse
}

const H2D_MACHINE = buildBuiltinSlicingPresetId('machine', 'Bambu Lab H2D 0.4 nozzle')
const STANDARD_PROCESS = buildBuiltinSlicingPresetId('process', '0.20mm Standard @BBL H2D')

function target(overrides: Partial<SlicingManualProfileTarget> = {}): SlicingManualProfileTarget {
  return {
    mode: 'manualProfile',
    printerModel: 'Bambu Lab H2D',
    printerProfileId: H2D_MACHINE,
    ...overrides
  } as SlicingManualProfileTarget
}

interface RecordedCall { kind: 'machine' | 'process' | 'filament'; id: string; targetId: string | null }

/**
 * Records every lookup with BOTH arguments, so a test can assert a resolver was never reached and,
 * just as importantly, that the one that was reached got the preset id rather than the target
 * id. Both params are `string`, so a swap at the call site type-checks and would otherwise pass.
 */
function stubResolvers(overrides: Partial<RetargetResolvers> = {}) {
  const calls: RecordedCall[] = []
  const resolvers: RetargetResolvers = {
    // The default under test is the public host's: built-ins only.
    canResolve: (presetId) => slicingPresetProvenance(presetId) === 'builtin',
    machine: async (id, targetId) => {
      calls.push({ kind: 'machine', id, targetId })
      return {
        config: {
          printer_model: ['Bambu Lab H2D'],
          inherits: 'Bambu Lab H2D 0.4 nozzle'
        } as ProfileRecord,
        name: 'Bambu Lab H2D 0.4 nozzle'
      }
    },
    process: async (id, targetId) => {
      calls.push({ kind: 'process', id, targetId })
      return processResponse({ layer_height: '0.2' })
    },
    filament: async (id, targetId) => {
      calls.push({ kind: 'filament', id, targetId })
      return filamentResponse({ nozzle_temperature: '250' })
    },
    ...overrides
  }
  return { calls, resolvers }
}

function input(overrides: Partial<Parameters<typeof buildMachineRetargetPlan>[0]> = {}) {
  return {
    target: target(),
    slicerTargetId: 'slicer-1',
    projectSettings: null,
    filamentPresets: [],
    ...overrides
  }
}

test('a project preset is never sent to the anonymous machine route', async () => {
  const { calls, resolvers } = stubResolvers()
  const plan = await buildMachineRetargetPlan(input({
    target: target({ printerProfileId: buildProjectSlicingPresetId('machine', 'My Printer') }),
    resolvers
  }))
  // Null, not a partial plan: authoring half a machine is worse than leaving the embedded one.
  assert.equal(plan, null)
  assert.deepEqual(calls, [], 'a non-builtin printer id must not reach the endpoint at all')
})

test('no target at all is not a retarget', async () => {
  const { calls, resolvers } = stubResolvers()
  assert.equal(await buildMachineRetargetPlan(input({ target: null, resolvers })), null)
  assert.deepEqual(calls, [])
})

test('an unresolvable machine leaves the project on its embedded printer rather than failing the save', async () => {
  const { resolvers } = stubResolvers({
    machine: async () => { throw new Error('offline') }
  })
  // The save still proceeds, this is the one hard requirement, so its absence means "do nothing".
  assert.equal(await buildMachineRetargetPlan(input({ resolvers })), null)
})

test('passes cancellation to preset resolution and never degrades an abort into a partial save', async () => {
  const abort = new AbortController()
  let observedSignal: AbortSignal | undefined
  const { resolvers } = stubResolvers({
    machine: async (_id, _targetId, options) => {
      observedSignal = options?.signal
      abort.abort()
      options?.signal?.throwIfAborted()
      throw new Error('unreachable')
    }
  })

  await assert.rejects(
    () => buildMachineRetargetPlan(input({ resolvers, signal: abort.signal })),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.equal(observedSignal, abort.signal)
})

test('the plan carries the resolved machine, its name, and the model it reports', async () => {
  const { calls, resolvers } = stubResolvers()
  const plan = await buildMachineRetargetPlan(input({ resolvers }))
  assert.ok(plan)
  assert.equal(plan.printerSettingsId, 'Bambu Lab H2D 0.4 nozzle')
  assert.equal(plan.printerModel, 'Bambu Lab H2D')
  // Positive assertion on the ARGUMENTS, not just that a call happened: the preset id must be the
  // first argument and the slicer target the second.
  assert.deepEqual(calls, [{ kind: 'machine', id: H2D_MACHINE, targetId: 'slicer-1' }])
})

test('a machine preset that names no model falls back to its own name, without the nozzle suffix', async () => {
  const { resolvers } = stubResolvers({
    machine: async () => ({ config: {} as ProfileRecord, name: 'Bambu Lab A1 mini 0.4 nozzle' })
  })
  const plan = await buildMachineRetargetPlan(input({ resolvers }))
  assert.equal(plan?.printerModel, 'Bambu Lab A1 mini')
})

test('a builtin process preset is resolved for the new machine', async () => {
  const { calls, resolvers } = stubResolvers()
  const plan = await buildMachineRetargetPlan(input({
    target: target({ processProfileId: STANDARD_PROCESS }),
    resolvers
  }))
  assert.deepEqual(plan?.processConfig, { layer_height: '0.2' })
  assert.ok(calls.some((call) => call.kind === 'process' && call.id === STANDARD_PROCESS && call.targetId === 'slicer-1'))
})

test("a project process preset keeps the project's own values instead of being resolved", async () => {
  const { calls, resolvers } = stubResolvers()
  const plan = await buildMachineRetargetPlan(input({
    target: target({ processProfileId: buildProjectSlicingPresetId('process', 'My Process') }),
    resolvers
  }))
  // Its values are already inside the 3MF; there is no separate preset to fetch.
  assert.equal(plan?.processConfig, null)
  assert.ok(!calls.some((call) => call.kind === 'process'), 'a project process id must not be requested')
})

test('an unresolvable process preset still lets the machine retarget through', async () => {
  const { resolvers } = stubResolvers({
    process: async () => { throw new Error('offline') }
  })
  const plan = await buildMachineRetargetPlan(input({
    target: target({ processProfileId: STANDARD_PROCESS }),
    resolvers
  }))
  // Best-effort by contract: the machine switch is the part that makes the file openable at all.
  assert.ok(plan)
  assert.equal(plan.processConfig, null)
  assert.equal(plan.printerSettingsId, 'Bambu Lab H2D 0.4 nozzle')
})

/**
 * The seam that makes the rest of this file testable also hides the wire contract from it: every
 * other test injects stubs, so a renamed body key, a wrong method, or a wrong URL would type-check
 * (the api client takes `body: unknown`) and pass, then 400/405 in the browser and silently drop the
 * user's printer switch. These pin the real requests instead.
 *
 * The expected keys are the ones `apps/api/src/private/cloud/public-slicing/routes.ts` parses.
 */
test('the real resolvers post the ids the anonymous routes actually parse', async () => {
  const sent: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    // A plausible machine response, so hardening the reader (a Zod parse at this boundary, which the
    // conventions ask for) does not fail a test that only claims to pin the REQUEST.
    return new Response(JSON.stringify({ config: {}, name: 'Bambu Lab H2D 0.4 nozzle', baseConfig: {}, overriddenKeys: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  try {
    await PUBLIC_RETARGET_RESOLVERS.machine(H2D_MACHINE, 'slicer-1')
    await PUBLIC_RETARGET_RESOLVERS.process(STANDARD_PROCESS, 'slicer-1')
    await PUBLIC_RETARGET_RESOLVERS.filament('builtin:filament:Bambu PLA Basic', 'slicer-1')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(sent.map((request) => request.url.replace(/^[^/]*\/\/[^/]*/, '')), [
    '/api/public/slicing/resolve-machine',
    '/api/public/slicing/resolve-process',
    '/api/public/slicing/resolve-filament'
  ])
  // The METHOD is part of the contract: these are POST-only routes, and a GET/PUT would 404/405 into
  // the same silent "saved on the old printer" outcome as a wrong body key.
  assert.deepEqual(sent.map((request) => request.method), ['POST', 'POST', 'POST'])
  // Argument ORDER is pinned by these too: swapping id and targetId type-checks silently.
  assert.deepEqual(sent[0]?.body, { machineProfileId: H2D_MACHINE, targetId: 'slicer-1' })
  assert.deepEqual(sent[1]?.body, { processProfileId: STANDARD_PROCESS, targetId: 'slicer-1' })
  assert.deepEqual(sent[2]?.body, { filamentProfileId: 'builtin:filament:Bambu PLA Basic', targetId: 'slicer-1' })
})

test('an unresolved slicer target is sent as null, not as an empty string', async () => {
  const { calls, resolvers } = stubResolvers()
  // `resolveSlicerTargetId` returns '' until the targets query settles, and the resolve routes'
  // schema REJECTS '' while accepting null, so passing it through 400s the retarget and saves the
  // project on its old printer with nothing but a console warning.
  const plan = await buildMachineRetargetPlan(input({ slicerTargetId: null, resolvers }))
  assert.ok(plan)
  assert.deepEqual(calls, [{ kind: 'machine', id: H2D_MACHINE, targetId: null }])
})

test('unreadable project settings skip the filament rebind rather than guessing slots', async () => {
  const { calls, resolvers } = stubResolvers()
  const plan = await buildMachineRetargetPlan(input({ projectSettings: null, resolvers }))
  assert.equal(plan?.filamentRebinds, null)
  assert.ok(!calls.some((call) => call.kind === 'filament'))
})

/**
 * The rebind half is the reason the seam exists, and the tests above all stop short of it (they pass
 * `projectSettings: null`). Without a case that reaches it, gutting `resolveFilamentRebinds` to
 * `return null` leaves the whole file green, while the user's materials silently keep the OLD
 * machine's physics.
 */
const H2D_PLA = buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL H2D')
const h2dPlaPreset = {
  id: H2D_PLA, source: 'builtin', kind: 'filament', name: 'Bambu PLA Basic @BBL H2D', printerModels: ['Bambu Lab H2D']
} as unknown as Parameters<typeof buildMachineRetargetPlan>[0]['filamentPresets'][number]

test('each filament slot is rebound to a preset for the new machine, with its config resolved', async () => {
  const { calls, resolvers } = stubResolvers()
  const plan = await buildMachineRetargetPlan(input({
    projectSettings: { filament_settings_id: ['Bambu PLA Basic @BBL X1C'] } as unknown as ProfileRecord,
    filamentPresets: [h2dPlaPreset],
    resolvers
  }))
  assert.ok(plan, 'the retarget should produce a plan')
  const rebinds = plan.filamentRebinds
  assert.ok(rebinds, 'the slot should rebind rather than keep the old machine values')
  assert.equal(rebinds.length, 1)
  assert.deepEqual(rebinds[0]?.config, { nozzle_temperature: '250' })
  // Resolved through the anonymous endpoint, by preset id and against the same slicer target.
  assert.ok(calls.some((call) => call.kind === 'filament' && call.id === H2D_PLA && call.targetId === 'slicer-1'))
})

test('a slot whose preset will not resolve keeps its own values instead of losing the whole rebind', async () => {
  const { resolvers } = stubResolvers({
    filament: async () => { throw new Error('offline') }
  })
  const plan = await buildMachineRetargetPlan(input({
    projectSettings: { filament_settings_id: ['Bambu PLA Basic @BBL X1C'] } as unknown as ProfileRecord,
    filamentPresets: [h2dPlaPreset],
    resolvers
  }))
  // A null config for the slot is "leave it alone"; the machine retarget itself still stands.
  assert.ok(plan)
  assert.equal(plan.printerSettingsId, 'Bambu Lab H2D 0.4 nozzle')
  const rebinds = plan.filamentRebinds
  assert.ok(rebinds == null || rebinds.every((rebind) => rebind.config == null))
})

test('which presets a host can retarget onto is the resolvers\' answer, not a rule in here', async () => {
  // The public host reaches the anonymous endpoints, which serve BambuStudio's bundled presets and
  // refuse everything else, so a retarget onto a workspace preset is declined rather than attempted:
  // authoring a partial machine from a failed lookup is worse than leaving the project's own.
  // The workspace host reaches endpoints that DO resolve its presets, so the same target proceeds.
  const workspacePreset = target({ printerProfileId: 'custom:printer-abc' })

  const publicHost = stubResolvers()
  assert.equal(
    await buildMachineRetargetPlan(input({ target: workspacePreset, resolvers: publicHost.resolvers })),
    null
  )
  assert.deepEqual(publicHost.calls, [], 'declined before resolving anything')

  const workspaceHost = stubResolvers({ canResolve: () => true })
  const plan = await buildMachineRetargetPlan(input({ target: workspacePreset, resolvers: workspaceHost.resolvers }))
  assert.ok(plan, 'the workspace host retargets onto its own preset')
  assert.equal(workspaceHost.calls[0]?.id, 'custom:printer-abc', 'and resolves it by id')
  assert.equal(plan.printerPresetInherits, 'Bambu Lab H2D 0.4 nozzle')
})

test('a project preset is refused by BOTH hosts, since it lives in the file being saved', () => {
  // Not a capability difference: "retarget onto the preset embedded in this project" is not a
  // question with an answer, so neither set of resolvers claims it.
  assert.equal(PUBLIC_RETARGET_RESOLVERS.canResolve('project:machine:Embedded'), false)
  assert.equal(WORKSPACE_RETARGET_RESOLVERS.canResolve('project:machine:Embedded'), false)
})

/**
 * A project whose process is the 3MF's OWN preset, renamed, inheriting a P1P process. This is the
 * prod shape from 7 September 2026: retargeted onto an X2D, it kept a process whose parent lists
 * only the P1P, and the engine refused every slice of it (exit 239). The retarget had re-declared
 * `print_compatible_printers` for the X2D, which is the one field that decision does not read.
 */
const P1P_LINEAGE_PROJECT: ProfileRecord = {
  print_settings_id: '0.20mm Speed - Tablet Mount',
  printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
  inherits_group: ['0.20mm Strength @BBL P1P', '', '']
}

/** A target keeping the project's own process: a `project:` id resolves to nothing, so none is chosen. */
function keepingTheProjectsProcess(): SlicingManualProfileTarget {
  return target({
    printerProfileId: buildBuiltinSlicingPresetId('machine', 'Bambu Lab X2D 0.4 nozzle'),
    processProfileId: buildProjectSlicingPresetId('process', '0.20mm Speed - Tablet Mount')
  })
}

/**
 * Resolvers for an X2D target whose process lookups answer from `catalogue`, BY NAME.
 *
 * Recording is done here rather than by overriding `stubResolvers`'s `process`, because an override
 * replaces the recording stub wholesale: the first version of these tests did exactly that and then
 * asserted against a `calls` list nothing had ever pushed to, which passes for the wrong reason as
 * easily as it fails.
 */
function x2dResolvers(catalogue: (name: string) => Record<string, string> | Error) {
  const processNames: string[] = []
  const { calls, resolvers } = stubResolvers({
    machine: async () => ({
      config: { printer_model: ['Bambu Lab X2D'], default_print_profile: '0.20mm Standard @BBL X2D' } as ProfileRecord,
      name: 'Bambu Lab X2D 0.4 nozzle'
    }),
    process: async (id) => {
      const name = parseBuiltinSlicingPresetId(id)?.name ?? ''
      processNames.push(name)
      const answer = catalogue(name)
      if (answer instanceof Error) throw answer
      return processResponse(answer)
    }
  })
  return { calls, processNames, resolvers }
}

test('a retarget onto a machine the project\'s own process refuses switches to the machine default', async () => {
  const { processNames, resolvers } = x2dResolvers((name) => name === '0.20mm Strength @BBL P1P'
    ? { name, compatible_printers: 'Bambu Lab P1P 0.4 nozzle' }
    : { name, compatible_printers: 'Bambu Lab X2D 0.4 nozzle' })

  const plan = await buildMachineRetargetPlan(input({
    target: keepingTheProjectsProcess(),
    projectSettings: P1P_LINEAGE_PROJECT,
    resolvers
  }))

  assert.deepEqual(processNames, ['0.20mm Strength @BBL P1P', '0.20mm Standard @BBL X2D'],
    'the project\'s own parent is asked first, the machine default only once it has refused')

  // Asserted through the REWRITE, not on the plan: `applyProcessProfileToProjectSettings` writes
  // `print_settings_id` and blanks `inherits_group[0]` only when the resolved preset carries a
  // `name`, and blanking that slot is the entire fix -- a project left naming the P1P parent is
  // refused by the engine no matter which values were copied over it.
  const retargeted = applyMachineRetargetToProjectSettings(P1P_LINEAGE_PROJECT, plan!)
  assert.equal(retargeted.print_settings_id, '0.20mm Standard @BBL X2D')
  assert.deepEqual(retargeted.inherits_group, ['', '', ''])
  assert.deepEqual(retargeted.print_compatible_printers, ['Bambu Lab X2D 0.4 nozzle'])
})

test('a process the target machine still accepts is left exactly alone', async () => {
  // The inverse, and what keeps the fallback from rewriting every retarget: a parent that lists the
  // target is not a mismatch, so the project keeps its own tuned process.
  const { resolvers } = x2dResolvers((name) => ({ name, compatible_printers: 'Bambu Lab X2D 0.4 nozzle' }))

  const plan = await buildMachineRetargetPlan(input({
    target: keepingTheProjectsProcess(),
    projectSettings: P1P_LINEAGE_PROJECT,
    resolvers
  }))
  assert.equal(plan?.processConfig, null)

  // And the project keeps its own lineage, rather than having the slot blanked by a write that
  // never happened.
  assert.deepEqual(
    applyMachineRetargetToProjectSettings(P1P_LINEAGE_PROJECT, plan!).inherits_group,
    ['0.20mm Strength @BBL P1P', '', '']
  )
})

test('an unresolvable lineage leaves the project\'s process alone rather than guessing', async () => {
  // A parent from the user's own BambuStudio install is not in this catalogue. Unknown is not
  // wrong: leaving the process is the pre-existing behaviour, so a lookup miss can never make a
  // save worse than it was.
  const { resolvers } = x2dResolvers(() => new Error('404'))

  const plan = await buildMachineRetargetPlan(input({
    target: keepingTheProjectsProcess(),
    projectSettings: P1P_LINEAGE_PROJECT,
    resolvers
  }))
  assert.equal(plan?.processConfig, null)
})

test('a project with no settings to read makes no lineage lookup at all', async () => {
  // `projectSettings` is null when the bake could not read `project_settings.config`. There is no
  // lineage to judge, so the pass must degrade to what it did before rather than resolve blindly.
  const { processNames, resolvers } = x2dResolvers((name) => ({ name }))
  const plan = await buildMachineRetargetPlan(input({
    target: keepingTheProjectsProcess(),
    projectSettings: null,
    resolvers
  }))
  assert.equal(plan?.processConfig, null)
  assert.deepEqual(processNames, [])
})
