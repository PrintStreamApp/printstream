/**
 * How a workspace save reaches the library now that the bake runs in the tab.
 *
 * What is worth pinning here is the ADDRESSING, because the failure it prevents is silent: an
 * upload resolves its overwrite target by matching name, folder and bridge, so a project renamed or
 * moved since the session opened it would be saved as a second file rather than as a version, and
 * nothing would report it.
 */
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { buildBuiltinSlicingPresetId, type SaveArrangedThreeMf } from '@printstream/shared'
import { createApiSaveTarget } from './editorSaveTarget'

interface RecordedComplete {
  targetFileId?: string
  snapshot?: boolean
  fileName: string
  folderId: string | null
  bridgeId: string | null
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Stub the whole chunked-upload conversation, recording what the complete step was told. */
function stubUpload(): { completed: RecordedComplete[] } {
  const completed: RecordedComplete[] = []
  let begun: { fileName: string; folderId: string | null; bridgeId: string | null } | null = null
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    if (url.pathname === '/api/slicing/profiles') return json({ profiles: [] })
    if (url.pathname === '/api/library/uploads') {
      begun = {
        fileName: String(body.fileName),
        folderId: (body.folderId ?? null) as string | null,
        bridgeId: (body.bridgeId ?? null) as string | null
      }
      return json({ uploadId: 'up-1', chunkSize: 1024 * 1024, receivedBytes: 0 }, 201)
    }
    if (url.pathname.endsWith('/chunks')) return json({ receivedBytes: 1 })
    if (url.pathname.endsWith('/complete')) {
      completed.push({
        ...(begun ?? { fileName: '', folderId: null, bridgeId: null }),
        ...(body.targetFileId ? { targetFileId: String(body.targetFileId) } : {}),
        ...(body.snapshot ? { snapshot: true } : {})
      })
      return json({ file: { id: 'file-9', name: 'Bracket.3mf' }, archivedVersionId: 'ver-3' }, 201)
    }
    return json({})
  }) as typeof fetch

  return { completed }
}



function target() {
  return createApiSaveTarget({
    archive: () => null,
    importStore: {
      supportsLibrarySource: true,
      importableFormats: ['stl'],
      stageFile: async () => { throw new Error('unused') },
      stageFromLibrary: async () => { throw new Error('unused') },
      meshUrl: () => '',
      fetchMesh: async () => new ArrayBuffer(0),
      importsForBake: async () => [],
      dispose: () => {}
    },
    projectName: () => 'Bracket v2.3mf'
  })
}

function save(overrides: Partial<SaveArrangedThreeMf> = {}): SaveArrangedThreeMf {
  return {
    baseFileId: 'file-1',
    mode: 'newVersion',
    // These cases are about ADDRESSING, not about bytes, so they bake from scratch with no archive.
    // Saying so is what the bake's released-archive guard reads: without it a null archive on a
    // save that names a `baseFileId` is refused, precisely so a released source cannot version an
    // empty project over the user's file.
    ignoreBaseContent: true,
    sceneEdit: { plates: [{ index: 1 }], instances: [], filaments: [{ color: '#00FF00', type: 'PLA' }] },
    ...overrides
  } as SaveArrangedThreeMf
}

test('a new version ADDRESSES its file by id rather than letting the name match one', async () => {
  // The silent failure this prevents: a project renamed or moved since the session opened it would
  // match no row, and the upload would create a second file instead of versioning the real one.
  const { completed } = stubUpload()
  const saved = await target().persist(save())

  assert.equal(completed[0]?.targetFileId, 'file-1')
  assert.equal(completed[0]?.snapshot, undefined)
  assert.equal(saved?.id, 'file-9')
  // Carried back because the caller pins it: it names the bytes this save authored FROM.
  assert.equal(saved?.archivedVersionId, 'ver-3')
})

test('a saveAs names its destination instead, since there is no row to address yet', async () => {
  const { completed } = stubUpload()
  await target().persist(save({
    mode: 'saveAs', name: 'Copy.3mf', folderId: 'folder-2', bridgeId: 'bridge-7'
  }))

  assert.equal(completed[0]?.targetFileId, undefined, 'a new file is not an overwrite of an old one')
  assert.equal(completed[0]?.folderId, 'folder-2')
  assert.equal(completed[0]?.bridgeId, 'bridge-7')
  assert.equal(completed[0]?.fileName, 'Copy.3mf')
})

test('a project name missing its extension still uploads as a 3MF', async () => {
  // The upload classifies the library kind from the name, so a bare one would land as an unknown
  // file rather than as a project.
  const { completed } = stubUpload()
  await target().persist(save({ mode: 'saveAs', name: 'Copy' }))

  assert.equal(completed[0]?.fileName, 'Copy.3mf')
})

test('a cancelled save stops before baking or uploading', async () => {
  const abort = new AbortController()
  abort.abort()

  await assert.rejects(
    () => target().persist(save(), { signal: abort.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
})

test('cancelling save-time catalogue loading aborts the request and the save', async () => {
  const abort = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  let markRequested: (() => void) | undefined
  const requested = new Promise<void>((resolve) => { markRequested = resolve })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    if (url.pathname !== '/api/slicing/profiles') throw new Error(`unexpected request: ${url.pathname}`)
    requestSignal = init?.signal
    markRequested?.()
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  }) as typeof fetch

  const saving = target().persist(save({
    retarget: {
      mode: 'manualProfile',
      printerModel: 'Bambu Lab H2D',
      printerProfileId: buildBuiltinSlicingPresetId('machine', 'Bambu Lab H2D 0.4 nozzle')
    }
  }), { signal: abort.signal })
  await requested
  abort.abort()

  await assert.rejects(
    saving,
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.equal(requestSignal, abort.signal)
})

test('a save against an existing project refuses to bake from a released archive', async () => {
  // The silent version of this wrote an almost-empty 3MF as a NEW VERSION of the addressed row,
  // because a null archive means "from scratch" to the baker and the upload addresses by file id.
  stubUpload()
  const released = createApiSaveTarget({
    archive: () => null,
    importStore: {
      supportsLibrarySource: true, importableFormats: ['stl'],
      stageFile: async () => { throw new Error('unused') },
      stageFromLibrary: async () => { throw new Error('unused') },
      meshUrl: () => '', fetchMesh: async () => new ArrayBuffer(0),
      importsForBake: async () => [], dispose: () => {}
    },
    projectName: () => 'Bracket.3mf'
  })

  await assert.rejects(
    // NOT `ignoreBaseContent`: this is an ordinary save of a project opened from the library, which
    // is the case where a from-scratch bake would be written over it.
    () => released.persist(save({ ignoreBaseContent: false })),
    /no longer available/,
    'it fails loudly rather than versioning an empty project over the user\'s file'
  )
})
