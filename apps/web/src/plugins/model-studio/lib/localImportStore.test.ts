import assert from 'node:assert/strict'
import test from 'node:test'
import { meshToBinaryStl } from '@printstream/shared/three-mf'
import { LocalImportError, createLocalImportStore } from './localImportStore'

/** A binary STL of one triangle, the smallest thing the parser accepts. */
function triangleStl(): Uint8Array {
  return meshToBinaryStl({
    positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
    indices: [0, 1, 2],
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } }
  })
}

test('generated geometry stages without leaving the browser', async () => {
  const store = createLocalImportStore()
  try {
    const staged = store.stageStlBytes('Cut half.stl', triangleStl())
    assert.equal(staged.triangleCount, 1)
    assert.deepEqual(staged.bounds.max, { x: 10, y: 10, z: 0 })

    // The bake takes the mesh itself, not an id to resolve server-side, which is what removes
    // the upload/download round-trip the api store required.
    const [imported] = await store.importsForBake()
    assert.equal(imported?.importId, staged.importId)
    assert.equal(imported?.mesh.indices.length, 3)
  } finally {
    store.dispose()
  }
})

test('a staged import round-trips through its own bytes', () => {
  const store = createLocalImportStore()
  try {
    const staged = store.stageStlBytes('Bracket.stl', triangleStl())
    // Rendering reads the bytes as staged rather than re-serializing the parsed mesh.
    assert.deepEqual(store.meshBytes(staged.importId), triangleStl())
    assert.throws(() => store.meshBytes('local-999'), LocalImportError)
    assert.throws(() => store.meshBytes(staged.importId, 7), LocalImportError)
  } finally {
    store.dispose()
  }
})

test('a STEP that cannot be tessellated names the format rather than leaking the failure', async () => {
  // STEP staging is real here (the OCCT WASM loads in the tab), so this covers the FAILURE path:
  // the tessellator is unavailable under the test runner, which is exactly the shape of a user
  // hitting a blocked/failed chunk load. What matters is that it arrives as a LocalImportError
  // naming STEP, not an unhandled Emscripten error the import handler cannot present.
  const store = createLocalImportStore()
  try {
    await assert.rejects(
      () => store.stageFile(new File([new Uint8Array()], 'Assembly.step'), 'object'),
      (error: Error) => error instanceof LocalImportError && /STEP/.test(error.message)
    )
    await assert.rejects(
      () => store.stageFile(new File([new Uint8Array()], 'notes.txt'), 'object'),
      LocalImportError
    )
  } finally {
    store.dispose()
  }
})

test('an STL picked from disk is parsed and welded in the tab', async () => {
  const store = createLocalImportStore()
  try {
    const staged = await store.stageFile(new File([new Uint8Array(triangleStl())], 'Picked.stl'), 'object')
    // The extension is dropped, matching the api's `path.parse(originalname).name`. The name is
    // baked into the saved 3MF, so the two hosts naming the same file differently is a real
    // divergence, not cosmetic, and it reached generated geometry too ("cube.stl" vs "cube").
    assert.equal(staged.name, 'Picked')
    assert.equal(staged.triangleCount, 1)
    // The weld is what makes the mesh indexed rather than triangle soup: three distinct corners,
    // not three unshared vertices per triangle. Skipping it mangles small features at slice time.
    assert.equal((await store.importsForBake())[0]?.mesh.positions.length, 9)
  } finally {
    store.dispose()
  }
})

test('only the final extension is dropped from an import name', async () => {
  const store = createLocalImportStore()
  try {
    // A version in the name must survive; the api's path.parse does the same.
    const staged = await store.stageFile(new File([new Uint8Array(triangleStl())], 'Bracket v1.2.stl'), 'object')
    assert.equal(staged.name, 'Bracket v1.2')
  } finally {
    store.dispose()
  }
})

test('ids are unique per staged model so one cannot overwrite another', async () => {
  const store = createLocalImportStore()
  try {
    const first = store.stageStlBytes('a.stl', triangleStl())
    const second = store.stageStlBytes('b.stl', triangleStl())
    assert.notEqual(first.importId, second.importId)
    assert.equal((await store.importsForBake()).length, 2)
  } finally {
    store.dispose()
  }
})

test('meshUrl survives being detached from the store', () => {
  // EditorView passes `importStore.meshUrl` as a bare function reference into
  // `instanceFromStagedImport`, so a `this`-dependent implementation breaks on the first import.
  const store = createLocalImportStore()
  try {
    const staged = store.stageStlBytes('Detached.stl', triangleStl())
    const { meshUrl } = store
    assert.doesNotThrow(() => meshUrl(staged.importId))
  } finally {
    store.dispose()
  }
})

/**
 * The store's half of the worker contract: WHICH failures get a second attempt.
 *
 * A file the worker refused must surface that refusal as-is. Re-parsing it on the main thread would
 * freeze the tab for seconds on the way to the identical message: the exact cost the worker exists
 * to avoid, paid for nothing.
 */
test('a file the staging worker refused is not parsed again on the main thread', async () => {
  let staged = 0
  class RefusingWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null
    postMessage(request: { id: number }) {
      staged += 1
      queueMicrotask(() => this.onmessage?.({
        data: { id: request.id, ok: false, dataError: true, error: 'This 3MF contains no importable model geometry.' }
      }))
    }
    terminate() {}
  }
  ;(globalThis as { Worker?: unknown }).Worker = RefusingWorker
  const store = createLocalImportStore()
  try {
    await assert.rejects(
      () => store.stageFile(new File([new Uint8Array([1, 2, 3])], 'Empty.3mf'), 'object'),
      (error: Error) => error instanceof LocalImportError && /no importable model geometry/.test(error.message)
    )
    assert.equal(staged, 1, 'exactly one attempt: the refusal is final')
  } finally {
    store.dispose()
    delete (globalThis as { Worker?: unknown }).Worker
  }
})
