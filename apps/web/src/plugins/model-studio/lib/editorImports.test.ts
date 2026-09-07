/**
 * The api-backed import store's bake geometry.
 *
 * The store no longer answers "the server has it": the bake runs in the browser on both hosts, so it
 * fetches every import back and rebuilds the mesh. What is worth pinning is the ROUND TRIP, since
 * the geometry leaves as doubles and comes back as float32 STL, and the failure that causes is
 * silent everywhere else.
 */
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { meshToBinaryStl, type ImportedMesh } from '@printstream/shared/three-mf'
import type { StagedImport } from '@printstream/shared'
import { createApiImportStore } from './editorImports'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** One triangle, welded: three corners, three indices. */
function triangle(offset = 0): ImportedMesh {
  return {
    positions: [offset, 0, 0, offset + 10, 0, 0, offset, 10, 0],
    indices: [0, 1, 2],
    bounds: { min: { x: offset, y: 0, z: 0 }, max: { x: offset + 10, y: 10, z: 0 } }
  }
}

function stagedDescriptor(overrides: Partial<StagedImport> = {}): StagedImport {
  return {
    importId: 'import-1',
    name: 'Bracket',
    format: 'stl',
    triangleCount: 1,
    bounds: triangle().bounds,
    parts: [{ name: 'Bracket', triangleCount: 1, bounds: triangle().bounds, subtype: null }],
    ...overrides
  }
}

/**
 * Stub the two calls the store makes: staging (whose response it remembers) and the mesh fetch.
 * `meshFor` returns the STL bytes for a given `part` query, or null to 404.
 */
function stubTransport(descriptor: StagedImport, meshFor: (part: string | null) => Uint8Array | null): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    if (url.pathname.endsWith('/imports')) {
      return new Response(JSON.stringify({ import: descriptor }), {
        status: 201, headers: { 'content-type': 'application/json' }
      })
    }
    const bytes = meshFor(url.searchParams.get('part'))
    if (!bytes) return new Response('gone', { status: 404 })
    return new Response(bytes as BlobPart, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  }) as typeof fetch
}

test('an import staged this session is fetched back and rebuilt for the bake', async () => {
  const descriptor = stagedDescriptor()
  stubTransport(descriptor, () => meshToBinaryStl(triangle()))
  const store = createApiImportStore()

  await store.stageFile(new File([new Uint8Array([1])], 'Bracket.stl'), 'object')
  const imports = await store.importsForBake()

  assert.equal(imports.length, 1)
  assert.equal(imports[0]?.importId, 'import-1')
  assert.equal(imports[0]?.name, 'Bracket')
  assert.equal(imports[0]?.mesh.indices.length, 3)
  // A single-solid import carries NO parts, matching the server's own gate: staging synthesizes a
  // one-entry summary for it, and passing that through sends the bake down its multi-component path
  // for a model that has exactly one.
  assert.equal(imports[0]?.parts, undefined)
})

test('a multi-solid assembly brings each solid back as its own part', async () => {
  const descriptor = stagedDescriptor({
    triangleCount: 2,
    parts: [
      { name: 'Left', triangleCount: 1, bounds: triangle().bounds, subtype: null },
      { name: 'Right', triangleCount: 1, bounds: triangle(20).bounds, subtype: 'negative_part' }
    ]
  })
  const merged: ImportedMesh = {
    positions: [...triangle().positions, ...triangle(20).positions],
    indices: [0, 1, 2, 3, 4, 5],
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 10, z: 0 } }
  }
  stubTransport(descriptor, (part) => meshToBinaryStl(
    part === null ? merged : part === '0' ? triangle() : triangle(20)
  ))
  const store = createApiImportStore()

  await store.stageFile(new File([new Uint8Array([1])], 'Assembly.step'), 'object')
  const [imported] = await store.importsForBake()

  assert.equal(imported?.parts?.length, 2)
  assert.equal(imported?.parts?.[0]?.name, 'Left')
  // The subtype rides the descriptor, not the geometry: an imported helper volume must stay one.
  assert.equal(imported?.parts?.[1]?.subtype, 'negative_part')
})

test('geometry that loses a triangle on the way back is REFUSED, not baked', async () => {
  // The reason the count is checked at all. `weldImportedMeshVertices` merges on an exact coordinate
  // match and drops any triangle whose vertices coincide once merged, so two vertices that were
  // distinct as doubles can quantise to one float32 and collapse a sliver. Every later triangle then
  // shifts down an index, and `importPaint` is keyed BY triangle index, so the user's support and
  // seam painting would move onto different faces with nothing reporting it.
  const descriptor = stagedDescriptor({ triangleCount: 2 })
  stubTransport(descriptor, () => meshToBinaryStl(triangle()))
  const store = createApiImportStore()

  await store.stageFile(new File([new Uint8Array([1])], 'Bracket.stl'), 'object')

  await assert.rejects(
    () => store.importsForBake(),
    (error: Error) => {
      assert.match(error.message, /Bracket/)
      assert.match(error.message, /2 triangles staged, 1 read back/)
      return true
    }
  )
})

test('a disposed store offers the bake nothing, so a closed session cannot resurrect geometry', async () => {
  const descriptor = stagedDescriptor()
  stubTransport(descriptor, () => meshToBinaryStl(triangle()))
  const store = createApiImportStore()

  await store.stageFile(new File([new Uint8Array([1])], 'Bracket.stl'), 'object')
  store.dispose()

  assert.deepEqual(await store.importsForBake(), [])
})
