/**
 * The round trip this file exists for: solids written by `mesh-archive.ts` must come back out of
 * `mesh-extract.ts` as one PART each.
 *
 * It is the load-bearing assumption behind "split to parts". The extractor takes a different code
 * path for a Bambu project than for a vanilla 3MF, and only the vanilla path turns every build item
 * into its own part. So a change on either side that quietly moves this onto the Bambu path -- most
 * obviously, writing a `Metadata/model_settings.config` -- would collapse N solids into one and
 * break the feature with no error anywhere.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildVanillaThreeMfEntries, type ThreeMfArchiveSolid } from './mesh-archive.js'
import { extractThreeMfImportMesh, type ThreeMfImportSource } from './mesh-extract.js'

/** A unit tetrahedron translated to `offset`, as flat triangle coordinates. */
function tetrahedron(offset: { x: number; y: number; z: number }, size = 10): number[] {
  const p = [
    [0, 0, 0], [size, 0, 0], [0, size, 0], [0, 0, size]
  ].map(([x, y, z]) => [x! + offset.x, y! + offset.y, z! + offset.z])
  const faces = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]
  return faces.flatMap(([a, b, c]) => [...p[a!]!, ...p[b!]!, ...p[c!]!])
}

/** Drive the extractor over an in-memory archive, with no Bambu metadata present. */
function sourceFor(entries: Record<string, string>): ThreeMfImportSource {
  return {
    readEntryText: async (entryPath) => entries[entryPath] ?? null,
    readPlateIndexes: async () => [],
    readScene: async () => { throw new Error('a vanilla 3MF has no scene to read') }
  }
}

test('each solid written comes back as its own part', async () => {
  const solids: ThreeMfArchiveSolid[] = [
    { name: 'Shell A', triangles: tetrahedron({ x: 0, y: 0, z: 0 }) },
    { name: 'Shell B', triangles: tetrahedron({ x: 50, y: 0, z: 0 }) },
    { name: 'Shell C', triangles: tetrahedron({ x: 0, y: 40, z: 0 }) }
  ]
  const mesh = await extractThreeMfImportMesh(sourceFor(buildVanillaThreeMfEntries(solids)))

  assert.equal(mesh.parts?.length, 3, 'expected one part per solid')
  assert.deepEqual(mesh.parts?.map((part) => part.name), ['Shell A', 'Shell B', 'Shell C'])
  // Four faces per tetrahedron, and the merged mesh carries all of them.
  assert.equal(mesh.indices.length / 3, 12)
})

test('the solids keep their shared coordinate space', async () => {
  // They were one mesh a moment ago. If the writer or the extractor re-centred them individually,
  // a split assembly would reassemble with every shell stacked on the origin.
  const solids: ThreeMfArchiveSolid[] = [
    { name: 'near', triangles: tetrahedron({ x: 0, y: 0, z: 0 }) },
    { name: 'far', triangles: tetrahedron({ x: 100, y: 0, z: 0 }) }
  ]
  const mesh = await extractThreeMfImportMesh(sourceFor(buildVanillaThreeMfEntries(solids)))

  assert.ok(mesh.bounds.max.x - mesh.bounds.min.x >= 100, `solids collapsed together: width ${mesh.bounds.max.x - mesh.bounds.min.x}`)
})

test('a solid with no usable geometry is skipped, not written malformed', async () => {
  const entries = buildVanillaThreeMfEntries([
    { name: 'real', triangles: tetrahedron({ x: 0, y: 0, z: 0 }) },
    { name: 'empty', triangles: [] },
    { name: 'ragged', triangles: [0, 0, 0, 1, 1] }
  ])
  const mesh = await extractThreeMfImportMesh(sourceFor(entries))
  // One surviving solid comes back as a PLAIN mesh: `parts` is absent for a single-solid import,
  // by the extractor's own contract, so assert on the geometry rather than on a parts array.
  assert.ok(mesh.parts == null || mesh.parts.length === 1)
  assert.equal(mesh.indices.length / 3, 4, 'expected exactly the one tetrahedron to survive')
})

test('an archive with nothing to write throws rather than staging an empty import', () => {
  assert.throws(() => buildVanillaThreeMfEntries([]), /no solid had usable geometry/i)
  assert.throws(() => buildVanillaThreeMfEntries([{ name: 'x', triangles: [] }]), /no solid had usable geometry/i)
})

test('the archive stays VANILLA, so the extractor keeps taking its build-item path', () => {
  // Writing Bambu project metadata would silently switch the extractor to its scene path, where
  // parts come from `model_settings.config` instead of the build items, and this whole transport
  // would start collapsing its solids into one.
  const entries = buildVanillaThreeMfEntries([{ name: 'only', triangles: tetrahedron({ x: 0, y: 0, z: 0 }) }])
  assert.deepEqual(Object.keys(entries).sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'])
  assert.doesNotMatch(entries['3D/3dmodel.model']!, /model_settings/)
})

test('a solid name with XML-hostile characters is escaped', () => {
  const entries = buildVanillaThreeMfEntries([
    { name: 'Ryan\'s "part" <A&B>', triangles: tetrahedron({ x: 0, y: 0, z: 0 }) }
  ])
  const xml = entries['3D/3dmodel.model']!
  assert.doesNotMatch(xml, /name="Ryan's "part"/, 'an unescaped quote would truncate the attribute')
  assert.match(xml, /name="[^"]*&amp;[^"]*"/)
})
