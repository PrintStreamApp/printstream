/**
 * Covers the anonymous slicer catalogue's query definitions: the keys the public editor's
 * controller reads, the "no target yet" gate, the descriptor mapping the settings panel depends
 * on, and the stall guard that is the module's whole reason to exist.
 *
 * Time is driven with the runner's mock timers rather than waited out — the guard arms a plain
 * global `setTimeout`, so ticking it exercises the real 25-second budget in microseconds. The
 * network seam is the global `fetch` that `apiFetch` calls (nothing here is stubbed at the module
 * level), so the composed abort signal under test is the one the guard actually hands the request.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { SlicingPresetSummary } from '@printstream/shared'
import { publicSlicerTargetsQueryOptions, publicSlicingPresetsQueryOptions } from './publicSlicingCatalog'

/** Mirrors the module's private `CATALOGUE_STALL_TIMEOUT_MS`. */
const STALL_TIMEOUT_MS = 25_000

interface FetchCall {
  url: string
  signal: AbortSignal | undefined
}

/** Replace the global `fetch` with `respond`, recording every call so URLs/signals can be asserted. */
function installFetch(respond: (call: FetchCall) => Promise<unknown>) {
  const original = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = ((input: unknown, init: { signal?: AbortSignal | null } = {}) => {
    const call: FetchCall = { url: String(input), signal: init.signal ?? undefined }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** A fetch that never resolves on its own, rejecting only when its signal aborts (real fetch semantics). */
function stallingFetch() {
  return installFetch(({ signal }) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
  }))
}

/** Let already-settled promise chains run; the mock timers leave microtasks alone. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

const target = {
  id: 'bs-2.1',
  label: 'Bambu Studio 2.1',
  family: 'bambustudio' as const,
  version: '02.01.00.00',
  isDefault: true,
  prerelease: false
}

const presetSummary = (name: string): SlicingPresetSummary => ({
  id: `builtin:process:${name}`, source: 'builtin', kind: 'process', name, printerModels: ['X1C']
} as SlicingPresetSummary)

test('the query keys are the ones the public editor caches under', () => {
  assert.deepEqual(publicSlicerTargetsQueryOptions().queryKey, ['public-slicer-targets'])
  assert.deepEqual(publicSlicingPresetsQueryOptions('bs-2.1').queryKey, ['public-slicing-profiles', 'bs-2.1'])
  // The target rides IN the key: switching slicer version must not serve the previous version's
  // catalogue out of cache.
  assert.notDeepEqual(
    publicSlicingPresetsQueryOptions('bs-2.2').queryKey,
    publicSlicingPresetsQueryOptions('bs-2.1').queryKey
  )
})

test('an empty target id disables the presets query instead of fetching', async () => {
  const { calls, restore } = installFetch(async () => jsonResponse({ profiles: [] }))
  // gcTime: Infinity keeps an inactive query from scheduling a ref'd gc timer that outlives the test.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  try {
    assert.equal(publicSlicingPresetsQueryOptions('').enabled, false)

    const disabled = new QueryObserver(client, publicSlicingPresetsQueryOptions(''))
    const stopDisabled = disabled.subscribe(() => {})
    await flushMicrotasks()
    assert.equal(calls.length, 0, 'a query with no target must not hit the network')
    stopDisabled()

    // The control: the same observer DOES fetch once a target exists, so the assertion above is
    // measuring the gate rather than a mount that never fetches.
    assert.equal(publicSlicingPresetsQueryOptions('bs-2.1').enabled, true)
    const enabled = new QueryObserver(client, publicSlicingPresetsQueryOptions('bs-2.1'))
    const stopEnabled = enabled.subscribe(() => {})
    await flushMicrotasks()
    assert.equal(calls.length, 1, 'a query with a target fetches')
    stopEnabled()
  } finally {
    client.clear()
    restore()
  }
})

test('a targets response becomes the full descriptor the settings panel expects', async () => {
  const { calls, restore } = installFetch(async () => jsonResponse({
    configured: true,
    defaultTargetId: 'bs-2.1',
    targets: [target]
  }))
  try {
    const result = await publicSlicerTargetsQueryOptions().queryFn({})
    assert.equal(calls[0]?.url, '/api/public/slicing/targets')
    assert.equal(result.configured, true)
    assert.equal(result.defaultTargetId, 'bs-2.1')
    // The public endpoint omits the deployment-only fields, so the mapping fills them: the label
    // doubles as the slicer name and the estimate-mode switch is off (no real printer here).
    assert.deepEqual(result.targets, [{ ...target, slicerName: 'Bambu Studio 2.1', supportsEstimateModeMachineSwitch: false }])
  } finally {
    restore()
  }
})

test('an unconfigured slicer maps to an empty target list, not an error', async () => {
  const { restore } = installFetch(async () => jsonResponse({ configured: false, defaultTargetId: null, targets: [] }))
  try {
    const result = await publicSlicerTargetsQueryOptions().queryFn({})
    assert.deepEqual(result, { configured: false, defaultTargetId: null, targets: [] })
  } finally {
    restore()
  }
})

test('the presets query unwraps the profiles body and encodes the target id', async () => {
  const profiles = [presetSummary('0.20mm Standard @BBL X1C')]
  const { calls, restore } = installFetch(async () => jsonResponse({ profiles }))
  try {
    const result = await publicSlicingPresetsQueryOptions('bs 2.1/beta').queryFn({})
    assert.equal(calls[0]?.url, '/api/public/slicing/profiles?targetId=bs+2.1%2Fbeta')
    assert.deepEqual(result, profiles, 'the array is returned bare, not the { profiles } envelope')
  } finally {
    restore()
  }
})

for (const catalogue of [
  { name: 'targets', options: () => publicSlicerTargetsQueryOptions(), message: 'Loading slicer versions stalled' },
  { name: 'presets', options: () => publicSlicingPresetsQueryOptions('bs-2.1'), message: 'Loading slicing presets stalled' }
]) {
  test(`a ${catalogue.name} fetch that never settles aborts on the stall budget`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { calls, restore } = stallingFetch()
    try {
      const pending = catalogue.options().queryFn({})
      await flushMicrotasks()
      t.mock.timers.tick(STALL_TIMEOUT_MS - 1)
      await flushMicrotasks()
      assert.equal(calls[0]?.signal?.aborted, false, 'a slow-but-live load must not be aborted early')

      t.mock.timers.tick(1)
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof Error)
        // A plain Error, never the AbortError: React Query treats an abort as cancellation and would
        // not retry, which is exactly the forever-pending state this guard exists to break.
        assert.equal(error.name, 'Error')
        assert.ok(error.message.includes(catalogue.message), `unexpected stall message: ${error.message}`)
        return true
      })
      assert.equal(calls[0]?.signal?.aborted, true, 'the in-flight request is actually cancelled')
    } finally {
      restore()
      t.mock.timers.reset()
    }
  })
}

test('a fetch that settles passes its value through and disarms the stall timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const profiles = [presetSummary('0.16mm Optimal @BBL X1C')]
  const { calls, restore } = installFetch(async () => jsonResponse({ profiles }))
  try {
    const result = await publicSlicingPresetsQueryOptions('bs-2.1').queryFn({})
    assert.deepEqual(result, profiles)
    // Past the budget with the request long finished: the timer must have been cleared, or a
    // completed load's controller still aborts (and, in the browser, the timer keeps firing).
    t.mock.timers.tick(STALL_TIMEOUT_MS * 2)
    assert.equal(calls[0]?.signal?.aborted, false, 'the stall timer outlived the settled request')
  } finally {
    restore()
    t.mock.timers.reset()
  }
})

test('a caller-cancelled fetch surfaces the cancellation, not the stall error', async () => {
  // React Query aborts on unmount/key change. That must stay a cancellation (no retry): only an
  // abort the guard ITSELF raised is rewritten into a retryable stall error.
  const { calls, restore } = stallingFetch()
  try {
    const outer = new AbortController()
    const pending = publicSlicerTargetsQueryOptions().queryFn({ signal: outer.signal })
    await flushMicrotasks()
    outer.abort(new DOMException('The operation was aborted.', 'AbortError'))
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      return true
    })
    assert.equal(calls[0]?.signal?.aborted, true, 'the outer signal is composed onto the request')
  } finally {
    restore()
  }
})
