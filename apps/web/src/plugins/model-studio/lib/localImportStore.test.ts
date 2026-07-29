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

test('generated geometry stages without leaving the browser', () => {
  const store = createLocalImportStore()
  try {
    const staged = store.stageStlBytes('Cut half.stl', triangleStl())
    assert.equal(staged.triangleCount, 1)
    assert.deepEqual(staged.bounds.max, { x: 10, y: 10, z: 0 })

    // The bake takes the mesh itself, not an id to resolve server-side — which is what removes
    // the upload/download round-trip the api store required.
    const [imported] = store.importsForBake()
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

test('STEP is refused with an explanation, not a parse failure', async () => {
  const store = createLocalImportStore()
  try {
    await assert.rejects(
      () => store.stageFile(new File([new Uint8Array()], 'Assembly.step')),
      (error: Error) => error instanceof LocalImportError && /STEP/.test(error.message)
    )
    await assert.rejects(
      () => store.stageFile(new File([new Uint8Array()], 'notes.txt')),
      LocalImportError
    )
  } finally {
    store.dispose()
  }
})

test('an STL picked from disk is parsed and welded in the tab', async () => {
  const store = createLocalImportStore()
  try {
    const staged = await store.stageFile(new File([new Uint8Array(triangleStl())], 'Picked.stl'))
    assert.equal(staged.name, 'Picked.stl')
    assert.equal(staged.triangleCount, 1)
    // The weld is what makes the mesh indexed rather than triangle soup: three distinct corners,
    // not three unshared vertices per triangle. Skipping it mangles small features at slice time.
    assert.equal(store.importsForBake()[0]?.mesh.positions.length, 9)
  } finally {
    store.dispose()
  }
})

test('ids are unique per staged model so one cannot overwrite another', () => {
  const store = createLocalImportStore()
  try {
    const first = store.stageStlBytes('a.stl', triangleStl())
    const second = store.stageStlBytes('b.stl', triangleStl())
    assert.notEqual(first.importId, second.importId)
    assert.equal(store.importsForBake().length, 2)
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
