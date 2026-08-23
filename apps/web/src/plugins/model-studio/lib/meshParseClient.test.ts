import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

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
async function loadClient(scenario: string, behaviour: FakeWorkerBehaviour) {
  FakeWorker.instances = []
  FakeWorker.behaviour = behaviour
  ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
  return await import(`./meshParseClient.ts?scenario=${scenario}`)
}

const warnings: string[] = []
const realWarn = console.warn
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }

afterEach(() => {
  delete (globalThis as { Worker?: unknown }).Worker
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

  const firstStartedAt = Date.now()
  const geometry = await parseStlGeometryAsync(bytes)
  const firstElapsed = Date.now() - firstStartedAt

  assert.ok(geometry.getAttribute('position'), 'the main-thread fallback still produced geometry')
  assert.ok(firstElapsed >= POOL_READY_TIMEOUT_MS - 250, `waited for the readiness probe (${firstElapsed}ms)`)
  assert.ok(
    FakeWorker.instances.every((worker) => worker.posted.length === 0),
    'nothing is dispatched to a worker that has not proved it is running'
  )
  assert.ok(FakeWorker.instances.every((worker) => worker.terminated), 'the dead pool is terminated, not leaked')
  const constructedForFirstParse = FakeWorker.instances.length

  const secondStartedAt = Date.now()
  await parseStlGeometryAsync(bytes)
  const secondElapsed = Date.now() - secondStartedAt

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

  const startedAt = Date.now()
  const geometry = await parseStlGeometryAsync(tinyBinaryStl())
  const elapsed = Date.now() - startedAt

  assert.ok(geometry.getAttribute('position'), 'the main-thread fallback still produced geometry')
  assert.ok(elapsed < POOL_READY_TIMEOUT_MS / 2, `fell back without waiting out the probe (${elapsed}ms)`)
  const explanation = warnings.find((line) => line.includes('[meshParse]')) ?? ''
  assert.ok(
    explanation.includes('worker graph failed to load'),
    `the reason names the worker error, not the readiness timeout (got: ${explanation})`
  )
  t.diagnostic(`fell back in ${elapsed}ms`)
})
