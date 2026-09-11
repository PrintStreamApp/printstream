import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { createArchiveProjectSource } from './editorProjectSource'

/**
 * The library editor's read path: one download of the whole 3MF, then every read served from it.
 *
 * What these pin is the SHARING, not the parsing (`localProjectPipeline.test.ts` covers that): the
 * source is handed to several independent React Query readers that call it concurrently and abort
 * independently, and getting that wrong is expensive in a way types cannot catch, a per-read
 * download would re-fetch a 21MB archive four or five times per open, and a cached rejection would
 * make a project permanently unopenable after one dropped request.
 */

const MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter"><resources>',
  '<object id="3" type="model"><mesh><vertices/><triangles/></mesh></object>',
  '</resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>'
].join('')

const MODEL_SETTINGS_XML = [
  '<config>',
  '<object id="3"><metadata key="name" value="Widget"/><metadata key="extruder" value="1"/></object>',
  '<plate><metadata key="plater_id" value="1"/>',
  '<model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>',
  '</plate></config>'
].join('')

function archiveBytes(): Uint8Array {
  return zipSync({
    '3D/3dmodel.model': strToU8(MODEL_XML),
    'Metadata/model_settings.config': strToU8(MODEL_SETTINGS_XML),
    // A plate thumbnail, because that is the ONLY read served off the source's live archive rather
    // than through the shared open(), and therefore the only one a disposal bug can break.
    'Metadata/plate_1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'Metadata/project_settings.config': strToU8(JSON.stringify({
      filament_type: ['PLA'],
      filament_colour: ['#00FF00'],
      filament_settings_id: ['Bambu PLA Basic']
    }))
  })
}

// jsdom is not loaded here (these tests are pure), so object URLs need a stand-in. Only identity
// matters: the assertions check that a URL is handed out at all, not what it points at.
if (typeof URL.createObjectURL !== 'function') {
  let issued = 0
  URL.createObjectURL = () => `blob:test/${(issued += 1)}`
  URL.revokeObjectURL = () => {}
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Count archive requests and answer them with a real 3MF (or a failure, on demand). */
function stubArchiveFetch(options: { failTimes?: number } = {}) {
  const state = { requests: [] as string[], failuresLeft: options.failTimes ?? 0 }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    state.requests.push(String(input))
    if (state.failuresLeft > 0) {
      state.failuresLeft -= 1
      return new Response('nope', { status: 503 })
    }
    return new Response(archiveBytes() as unknown as BodyInit, { status: 200 })
  }) as typeof globalThis.fetch
  return state
}

test('concurrent reads share ONE archive download', async () => {
  const fetchState = stubArchiveFetch()
  const source = createArchiveProjectSource('/api/library/file-1')
  try {
    const [index, scene, entry] = await Promise.all([
      source.loadIndex(),
      source.loadScene(1, null),
      source.loadEntry('3D/3dmodel.model')
    ])

    assert.equal(fetchState.requests.length, 1)
    assert.match(fetchState.requests[0]!, /\/api\/library\/file-1\/archive$/)
    assert.equal(index.plates.length, 1)
    assert.ok(scene)
    assert.ok(entry.length > 0)
    assert.ok(source.plateThumbnailUrl(1), 'plate thumbnail should resolve once the archive is open')
  } finally {
    source.dispose?.()
  }
})

test('reports download and browser-reading phases for the first open', async () => {
  stubArchiveFetch()
  const phases: string[] = []
  const source = createArchiveProjectSource('/api/library/file-1', 'project.3mf', {
    onOpenPhase: (phase) => phases.push(phase)
  })
  try {
    await source.loadIndex()
    assert.deepEqual(phases, ['loading-file', 'reading-project'])
  } finally {
    source.dispose?.()
  }
})

test('later reads reuse the archive rather than re-downloading it', async () => {
  const fetchState = stubArchiveFetch()
  const source = createArchiveProjectSource('/api/library/file-1')
  try {
    await source.loadIndex()
    await source.loadScene(1, null)
    await source.loadScene(1, 'X1C')

    assert.equal(fetchState.requests.length, 1)
  } finally {
    source.dispose?.()
  }
})

/**
 * React runs effect cleanups spuriously, StrictMode remounts every component in dev, so the
 * caller's `dispose()` fires on a source that is still in use. The first cut latched a permanent
 * `disposed` flag, which broke ONLY plate thumbnails (everything else resolves through the shared
 * open()) and ONLY in dev: the strip showed loading spinners forever on a project whose plates all
 * carry embedded PNGs.
 */
test('dispose leaves the source usable, because React disposes spuriously', async () => {
  const fetchState = stubArchiveFetch()
  const source = createArchiveProjectSource('/api/library/file-1')
  try {
    await source.loadIndex()
    assert.equal(fetchState.requests.length, 1)

    source.dispose?.()

    // Re-opens rather than staying dead. The refetch is the cost of a spurious cleanup.
    const index = await source.loadIndex()
    assert.equal(index.plates.length, 1)
    assert.equal(fetchState.requests.length, 2)

    // The live archive is adopted again. This is the assertion that actually pins the regression:
    // with a latching dispose it stays null forever while every other read still works.
    assert.ok(source.plateThumbnailUrl(1), 'plate thumbnail should resolve after a spurious dispose')
    const scene = await source.loadScene(1, null)
    assert.ok(scene)
  } finally {
    source.dispose?.()
  }
})

test('a failed download does not poison the source', async () => {
  const fetchState = stubArchiveFetch({ failTimes: 1 })
  const source = createArchiveProjectSource('/api/library/file-1')
  try {
    await assert.rejects(source.loadIndex())

    // React Query retries; the retry must re-download rather than replay the cached rejection.
    const index = await source.loadIndex()
    assert.equal(index.plates.length, 1)
    assert.equal(fetchState.requests.length, 2)
  } finally {
    source.dispose?.()
  }
})

test('dispose aborts the shared archive download and a later read can reopen it', async () => {
  let firstSignal: AbortSignal | null = null
  let requests = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1
    if (requests > 1) return new Response(archiveBytes() as unknown as BodyInit, { status: 200 })
    firstSignal = init?.signal ?? null
    return await new Promise<Response>((_resolve, reject) => {
      firstSignal?.addEventListener('abort', () => reject(firstSignal?.reason), { once: true })
    })
  }) as typeof globalThis.fetch

  const source = createArchiveProjectSource('/api/library/file-1')
  const abandonedRead = source.loadIndex()
  await new Promise((resolve) => setTimeout(resolve, 0))
  source.dispose?.()

  assert.equal((firstSignal as AbortSignal | null)?.aborted, true)
  await assert.rejects(abandonedRead, { name: 'AbortError' })
  assert.equal((await source.loadIndex()).plates.length, 1)
  assert.equal(requests, 2)
  source.dispose?.()
})
