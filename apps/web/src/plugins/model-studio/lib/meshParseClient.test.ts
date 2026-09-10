import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
// Type only: the client itself is imported dynamically below (cache-busted per scenario), so its
// return types do not survive that import and the geometry assertions need a type from somewhere.
import type * as THREE from 'three'

/**
 * Behaviour a scenario's fake workers follow. `onConstruct` runs asynchronously, standing in for
 * the worker's module evaluating; `onTask` answers one posted task.
 */
interface FakeWorkerBehaviour {
  onConstruct?: (worker: FakeWorker) => void
  onTask?: (worker: FakeWorker, request: { id: number; kind: string }) => void
}

class FakeWorker {
  static instances: FakeWorker[] = []
  static behaviour: FakeWorkerBehaviour = {}
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  readonly posted: Array<{ id: number; kind: string }> = []
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
    const { onConstruct } = FakeWorker.behaviour
    if (onConstruct) queueMicrotask(() => { if (!this.terminated) onConstruct(this) })
  }

  postMessage(request: { id: number; kind: string }): void {
    this.posted.push(request)
    const { onTask } = FakeWorker.behaviour
    if (onTask) queueMicrotask(() => { if (!this.terminated) onTask(this, request) })
  }

  terminate(): void {
    this.terminated = true
  }

  /** Deliver a worker -> client message, as the real `postMessage` back would. */
  reply(data: unknown): void {
    this.onmessage?.({ data })
  }
}

/** A structurally valid one-triangle binary STL, so the main-thread fallback can parse it. */
function tinyBinaryStl(): Uint8Array {
  const bytes = new Uint8Array(84 + 50)
  const view = new DataView(bytes.buffer)
  view.setUint32(80, 1, true)
  const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0]
  for (let index = 0; index < vertices.length; index += 1) {
    view.setFloat32(84 + 12 + index * 4, vertices[index]!, true)
  }
  return bytes
}

/**
 * Load a fresh copy of the client so each scenario gets its own pool state. The module retires its
 * pool for the session by design, so scenarios cannot share one instance.
 */
let restoreHardwareConcurrency: (() => void) | null = null

async function loadClient(
  scenario: string,
  behaviour: FakeWorkerBehaviour,
  hardwareConcurrency?: number
) {
  FakeWorker.instances = []
  FakeWorker.behaviour = behaviour
  ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
  if (hardwareConcurrency !== undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'hardwareConcurrency')
    Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
      configurable: true,
      value: hardwareConcurrency
    })
    restoreHardwareConcurrency = () => {
      if (descriptor) Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', descriptor)
      else delete (globalThis.navigator as { hardwareConcurrency?: number }).hardwareConcurrency
    }
  }
  return await import(`./meshParseClient.ts?scenario=${scenario}`)
}

/**
 * Let every queued continuation run WITHOUT moving the clock.
 *
 * Only `setTimeout` and `Date` are faked below, so `setImmediate` is still a real macrotask:
 * awaiting one drains the microtask queue and leaves anything genuinely parked on a TIMER
 * unsettled, which is the distinction the readiness assertions turn on.
 */
async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

interface TimedParse<T> {
  /** The parse's result, plus how far the fake clock moved before it settled. */
  readonly settled: Promise<{ value: T; elapsedMs: number }>
  /** Whether it has settled YET, so a test can prove it had not at a given tick. */
  finished: () => boolean
}

/**
 * Run a parse against the fake clock, stamping its duration AS it settles.
 *
 * Reading `Date.now()` after the await cannot work here: a later tick moves the clock under a parse
 * that had already finished, so a re-probing regression would report the same elapsed time as
 * correct behaviour does.
 */
function timedParse<T>(start: () => Promise<T>): TimedParse<T> {
  const startedAt = Date.now()
  let settledYet = false
  const settled = start().then((value) => {
    settledYet = true
    return { value, elapsedMs: Date.now() - startedAt }
  })
  return { settled, finished: () => settledYet }
}

const warnings: string[] = []
const realWarn = console.warn
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }

afterEach(() => {
  delete (globalThis as { Worker?: unknown }).Worker
  restoreHardwareConcurrency?.()
  restoreHardwareConcurrency = null
  warnings.length = 0
})

test.after(() => { console.warn = realWarn })

test('the parse deadline scales with input size above a fixed floor', async () => {
  const { meshParseDeadlineMs, MESH_PARSE_BASE_DEADLINE_MS } = await loadClient('deadline', {})
  assert.equal(meshParseDeadlineMs(0), MESH_PARSE_BASE_DEADLINE_MS)
  // ~1ms per KB: an 11.5MB mesh entry (which really parses in under a second) gets ~11s of slack
  // on top of the floor.
  assert.equal(meshParseDeadlineMs(11_500 * 1024), MESH_PARSE_BASE_DEADLINE_MS + 11_500)
})

test('a pool that never reports ready is retired once, not re-probed per parse', async (t) => {
  // The regression this pins: workers that are constructed successfully and then never execute (a
  // dev module graph that fails to load, an attached-but-never-resumed worker target). `onerror`
  // never fires, so the only symptom is silence. Every mesh entry used to wait out its own 20s
  // deadline before falling back, which is what made opening a project take minutes and then
  // freeze the tab N times over.
  const { parseStlGeometryAsync, POOL_READY_TIMEOUT_MS } = await loadClient('silent', {})
  const bytes = tinyBinaryStl()
  // The clock is FAKED, not slept through: proving this timeout used to cost 5 real seconds, nearly
  // all of the file's runtime. Only the clock changes, so the assertions still measure the wait the
  // production module imposes, and the module keeps its real timeout with no test-only seam in it.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })

  const first = timedParse<THREE.BufferGeometry>(() => parseStlGeometryAsync(bytes))
  await settleMicrotasks()
  assert.equal(first.finished(), false, 'no fallback before the readiness probe has had its time')
  t.mock.timers.tick(POOL_READY_TIMEOUT_MS - 1)
  await settleMicrotasks()
  assert.equal(first.finished(), false, 'still waiting with a millisecond of the probe left')

  t.mock.timers.tick(1)
  const { value: geometry, elapsedMs: firstElapsed } = await first.settled

  assert.ok(geometry.getAttribute('position'), 'the main-thread fallback still produced geometry')
  assert.ok(firstElapsed >= POOL_READY_TIMEOUT_MS, `waited for the readiness probe (${firstElapsed}ms)`)
  assert.ok(
    FakeWorker.instances.every((worker) => worker.posted.length === 0),
    'nothing is dispatched to a worker that has not proved it is running'
  )
  assert.ok(FakeWorker.instances.every((worker) => worker.terminated), 'the dead pool is terminated, not leaked')
  const constructedForFirstParse = FakeWorker.instances.length

  const second = timedParse(() => parseStlGeometryAsync(bytes))
  await settleMicrotasks()
  // Advance a whole probe's worth anyway: a retired session has already settled and keeps its
  // recorded 0ms, while one that re-probed settles HERE and reports the wait, so the regression
  // fails this assertion instead of hanging the run on a timer nobody ticks.
  t.mock.timers.tick(POOL_READY_TIMEOUT_MS)
  const { elapsedMs: secondElapsed } = await second.settled

  assert.ok(secondElapsed < POOL_READY_TIMEOUT_MS / 2, `the second parse does not re-probe (${secondElapsed}ms)`)
  assert.equal(FakeWorker.instances.length, constructedForFirstParse, 'no replacement pool is built')
  assert.equal(
    warnings.filter((line) => line.includes('[meshParse]')).length,
    1,
    'one explanation for the session, not one per mesh entry'
  )
  t.diagnostic(`first parse ${firstElapsed}ms, second ${secondElapsed}ms`)
})

test('a worker result is used as-is, with no main-thread parse behind it', async () => {
  const { parseStlGeometryAsync } = await loadClient('result', {
    onConstruct: (worker) => worker.reply({ kind: 'ready' }),
    onTask: (worker, request) => worker.reply({
      kind: 'result',
      id: request.id,
      entries: [{ objectId: 0, position: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]) }]
    })
  })

  // Bytes the main-thread fallback could not parse, so a silent fallback would fail the test
  // rather than quietly producing the same answer.
  const geometry = await parseStlGeometryAsync(new Uint8Array([1, 2, 3]))
  assert.equal(geometry.getAttribute('position')?.count, 3)
  assert.equal(warnings.length, 0)
})

test('only workers that proved they are running receive tasks, even once the pool is usable', async () => {
  // The gap this closes: every other scenario either has the whole pool report ready or none of it,
  // and in the none case `ensurePool()` never resolves, so nothing is dispatched no matter what
  // `pump()` checks. Removing `pump()`'s readiness guard therefore passed the rest of this file.
  // A MIXED pool is the only shape that can see it: one worker proves the module graph loads, which
  // is enough to make the pool usable, while its siblings are still silent.
  let constructed = 0
  const { parseStlGeometryAsync } = await loadClient('partial-ready', {
    onConstruct: (worker) => {
      // Only the first worker ever answers the handshake; the rest stay silent for the run.
      if (constructed++ === 0) worker.reply({ kind: 'ready' })
    },
    onTask: (worker, request) => worker.reply({
      kind: 'result',
      id: request.id,
      entries: [{ objectId: 0, position: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]) }]
    })
  }, 4)

  // Two at once, so the pool has more work queued than its one proven worker can hold.
  const [first, second] = await Promise.all([
    parseStlGeometryAsync(new Uint8Array([1, 2, 3])),
    parseStlGeometryAsync(new Uint8Array([1, 2, 3]))
  ])

  assert.equal(first.getAttribute('position')?.count, 3, 'the ready worker answered')
  assert.equal(second.getAttribute('position')?.count, 3, 'and answered the queued task too')

  const [readyWorker, ...silentWorkers] = FakeWorker.instances
  assert.equal(readyWorker?.posted.length, 2, 'both tasks went to the one proven worker')
  assert.ok(silentWorkers.length > 0, 'the pool really did build siblings to check')
  for (const worker of silentWorkers) {
    assert.equal(worker.posted.length, 0, 'a worker that never proved it is running is never dispatched to')
  }
  assert.equal(warnings.length, 0, 'a usable pool explains nothing')
})

test('a bad STL is not re-parsed on the main thread: the fallback is the same code', async () => {
  const { parseStlGeometryAsync, MeshParseDataError } = await loadClient('stl-data-error', {
    onConstruct: (worker) => worker.reply({ kind: 'ready' }),
    onTask: (worker, request) => worker.reply({
      kind: 'error',
      id: request.id,
      error: 'Unsupported STL',
      dataError: true
    })
  })

  // Deliberately bytes the main thread COULD parse: if the data error were retried there, this
  // would resolve instead of throwing, and the tab would have frozen to reach the same verdict.
  await assert.rejects(
    () => parseStlGeometryAsync(tinyBinaryStl()),
    (error: unknown) => error instanceof MeshParseDataError && (error as Error).message === 'Unsupported STL'
  )
})

test('a bad 3MF entry IS retried on the main thread, whose reader is a different one', async () => {
  const { parseThreeMfModelEntryAsync, MeshParseDataError } = await loadClient('threemf-data-error', {
    onConstruct: (worker) => worker.reply({ kind: 'ready' }),
    onTask: (worker, request) => worker.reply({
      kind: 'error',
      id: request.id,
      error: 'Invalid 3MF model data.',
      dataError: true
    })
  })

  // The worker reads the entry with regexes; the fallback uses `DOMParser`, so it can read files
  // the worker cannot. Node has no `DOMParser`, so reaching the fallback surfaces as that failure
  // rather than the worker's `MeshParseDataError`, which is exactly the distinction under test.
  await assert.rejects(
    () => parseThreeMfModelEntryAsync(new TextEncoder().encode('<model/>')),
    (error: unknown) => !(error instanceof MeshParseDataError)
  )
})

test('a worker that dies before reporting ready falls back at once, not at the readiness timeout', async (t) => {
  // The regression this pins: `retirePool` dropped `poolReady` without settling it.
  // Callers already awaiting `ensurePool()` are parked on that promise and are not
  // in the queued/in-flight lists yet, so the drain never reached them. They waited
  // out the full readiness timeout and were then told the pool had timed out, rather
  // than falling back the moment the worker error retired it.
  const { parseStlGeometryAsync, POOL_READY_TIMEOUT_MS } = await loadClient('pre-ready-error', {
    onConstruct: (worker) => worker.onerror?.({ message: 'worker graph failed to load' })
  })
  // Faked for the same reason as the test above, and it sharpens the claim: the fallback happens
  // with the clock standing still, rather than merely sooner than a wall-clock half of the probe.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })

  const parse = timedParse<THREE.BufferGeometry>(() => parseStlGeometryAsync(tinyBinaryStl()))
  await settleMicrotasks()
  // Fire whatever readiness timer is outstanding: a caller still parked on the readiness promise
  // would settle only here, and its recorded elapsed time says so.
  t.mock.timers.tick(POOL_READY_TIMEOUT_MS)
  const { value: geometry, elapsedMs: elapsed } = await parse.settled

  assert.ok(geometry.getAttribute('position'), 'the main-thread fallback still produced geometry')
  assert.ok(elapsed < POOL_READY_TIMEOUT_MS / 2, `fell back without waiting out the probe (${elapsed}ms)`)
  const explanation = warnings.find((line) => line.includes('[meshParse]')) ?? ''
  assert.ok(
    explanation.includes('worker graph failed to load'),
    `the reason names the worker error, not the readiness timeout (got: ${explanation})`
  )
  t.diagnostic(`fell back in ${elapsed}ms`)
})
